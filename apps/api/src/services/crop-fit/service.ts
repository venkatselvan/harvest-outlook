import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CropFitReview, type BasisRef, type CropFitCandidate, type CropFitRequest, type CropSeason, type HarvestPriceOutlook, type ModelInvocation, type NeighbourhoodSeasonality, type PriceEstimate } from '@harvest/contracts';
import type { Config } from '../../config';
import { withTransaction, type Pool } from '../../db/pool';
import { REPO_ROOT } from '../../catalogue/files';
import type { TextModelProvider } from '../../agent/provider';
import { createWeatherSource } from '../../plans/adapters/weather-source';
import type { ClimatologyBundle, WeatherScope } from '../../plans/sources';
import type { Budget } from '../budget';
import { ApiError, notFound } from '../errors';
import { getFarm } from '../farms';
import { focusedResearch } from '../focused-crops';
import { payloadHash } from '../hash';
import { enqueue } from '../jobs';
import { harvestPriceOutlook, type HarvestPriceOutlookArgs } from '../price-series';
import { farmSoilMarkers, planningMeasuredPh } from '../soil-reports';
import { neighbourhoodSeasonality } from '../today/ndvi';
import { stageTimeline } from '../today/stage-timeline';
import { getWorkspace } from '../workspace';
import * as data from '../year-plan/data';
import { ENGINE_LIMITATIONS } from '../year-plan/assemble';
import { addDays, isoWeek } from '../year-plan/dates';
import { collectInputKeys, emptyInputs, monthlyRainFromDaily, priceHarvestDate, slotPriceKey, type Inputs, type PriceInputKey } from '../year-plan/inputs';
import { buildScenario, type TimelineFn } from '../year-plan/scenario';
import type { RotationRule } from '../year-plan/scoring';
import { ENGINE_VERSION as YEAR_PLAN_ENGINE_VERSION, todayIst } from '../year-plan/service';
import type { EngineContext } from '../year-plan/types';
import { marketNow as readMarketNow, type MarketNowArgs } from './market-now';
import { estimateProfit } from '../estimate';
import * as soilRatings from '../soil-ratings';
import { normaliseRequest, placeCandidates, rankCandidates, resolveMode } from './rank';
import { picksWithMeta, pickPool, deterministicPicks, type PickField } from './select';
import { compareSoil, hasConfirmedMarkers, soilFacts, type PhRange, type RateMarkerFn } from './soil-compare';
import { CROP_FIT_ENGINE_VERSION, CROP_FIT_JOB_TYPE, type RankedCandidate, type ResolvedMode, type Unplaced } from './types';

/**
 * Persisted crop fit review (ROUND2_SPEC.md 4.1): context hash -> GET returns the ready review for the hash or inserts
 * a pending row and enqueues farm.crop-fit once -> the job ranks every pool crop by code (year-plan slot scoring), adds
 * price now, the simulated profit and the soil comparison, writes the code ranking (status running), then asks Meta for
 * three picks (gate, deterministic fallback) and stores a ready review even when Meta is unavailable.
 */
export const PRICE_LOOKUP_CAP = 120;
export const WEIGHTS = { price: 40, yield: 30, soilRotation: 15, water: 10, confidence: 5 } as const;
/** Prefix of the limitation the UI keys on for the "Model unavailable, showing calculated picks" chip. */
export const MODEL_UNAVAILABLE = 'Model unavailable';

export interface CropFitDeps {
  pool: Pool;
  config: Config;
  budget: Budget;
  provider?: TextModelProvider | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
  timeline?: TimelineFn | undefined;
  /** Soil marker rating (default soil-ratings.ts rateMarker); null lists markers as not rated (tests). */
  rateMarker?: RateMarkerFn | null | undefined;
  /** Version of the ratings file in the context hash (default SOIL_RATINGS_VERSION). */
  ratingsVersion?: string | null | undefined;
  sources?: {
    priceOutlook?: ((args: HarvestPriceOutlookArgs) => Promise<HarvestPriceOutlook>) | undefined;
    climatology?: ((scope: WeatherScope, range: { start: string; end: string }) => Promise<ClimatologyBundle | null>) | undefined;
    neighbourhood?: ((ownerId: string, farmId: string) => Promise<NeighbourhoodSeasonality>) | undefined;
    marketNow?: ((args: MarketNowArgs) => Promise<CropFitCandidate['marketNow']>) | undefined;
  } | undefined;
}

export interface RawRequest { mode?: CropFitRequest['mode'] | undefined; season?: CropSeason | undefined; sowing?: string | undefined }
type Farm = NonNullable<Awaited<ReturnType<typeof getFarm>>>;
type Soil = Awaited<ReturnType<typeof farmSoilMarkers>>;
export interface FitContext {
  hash: string; asOf: string; farmId: string; request: CropFitRequest; requestKey: string; resolved: ResolvedMode;
  ctx: EngineContext; farm: Farm; workspaceVersion: number; soil: Soil; soilPh: number | undefined; soilReportStatus: CropFitReview['soilReportStatus'];
}
interface Row {
  id: string; owner_id: string; farm_id: string; mode: string; fit_mode: string; request_key: string; context_hash: string; request: CropFitRequest;
  input_context: Record<string, unknown>; result: CropFitReview; status: CropFitReview['status']; job_id: string | null; session_id: string | null;
  invocation: ModelInvocation | null; started_at: Date | null; updated_at: Date; created_at: Date;
}

/**
 * soil-ratings.ts rateMarkerAssumed when it exists (it also rates kg/ha nitrogen without a printed pool, total P and total
 * K as the available forms, with an assumption string), else rateMarker.
 */
export function defaultRateMarker(): RateMarkerFn {
  const assumed = (soilRatings as Record<string, unknown>).rateMarkerAssumed;
  return (typeof assumed === 'function' ? assumed : soilRatings.rateMarker) as RateMarkerFn;
}
const nowOf = (deps: Pick<CropFitDeps, 'now'>) => (deps.now ?? (() => new Date()))();
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fileHashes = new Map<string, string>();
function fileHash(rel: string): string {
  const p = resolve(REPO_ROOT, rel);
  const st = statSync(p);
  const k = `${p}|${st.mtimeMs}|${st.size}`;
  let h = fileHashes.get(k);
  if (!h) { h = createHash('sha256').update(readFileSync(p)).digest('hex'); fileHashes.set(k, h); }
  return h;
}
export const requestKey = (r: CropFitRequest): string => `${r.mode}:${r.season ?? ''}:${r.sowing ?? ''}`;

/**
 * Farm, workspace, confirmed soil, scenario and the normalised request. The hash covers the request, the IST day, the
 * workspace version, the confirmed soil marker ids and canonical values, the farm location, area, irrigation and
 * excluded crops, the research files, the engine versions (crop fit and year plan) and the runtime mode and model.
 */
export async function fitContext(deps: Pick<CropFitDeps, 'pool' | 'config' | 'now' | 'timeline' | 'ratingsVersion'>, ownerId: string, farmId: string, raw: RawRequest): Promise<FitContext> {
  const asOf = todayIst(nowOf(deps));
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const workspace = await getWorkspace(deps.pool, ownerId, farmId);
  const soil = await farmSoilMarkers(deps, ownerId, farmId);
  const soilPh = planningMeasuredPh(soil);
  const n = soil.samples.length;
  const soilSummary = !n ? 'No confirmed soil report for this field.' : soilPh !== undefined ? `Confirmed laboratory soil pH ${soilPh} (${n} confirmed sample${n > 1 ? 's' : ''}).` : `${n} confirmed soil sample${n > 1 ? 's' : ''}; no single compatible laboratory pH.`;
  const facts = Object.fromEntries(Object.entries(farm.facts).map(([k, f]) => [k, { value: f.value, basis: f.basis, confirmed: f.confirmed }]));
  const ctx = buildScenario({ workspace, farm: { location: { stateCode: farm.location.stateCode, districtId: farm.location.districtId }, areaHectares: farm.areaHectares, facts }, asOf, soilSummary, timeline: deps.timeline ?? stageTimeline });
  let request: CropFitRequest;
  try { request = normaliseRequest(raw, ctx.fixedSlot !== null, asOf); }
  catch (e) { throw new ApiError(400, 'validation_error', (e as Error).message); }
  const reports = await deps.pool.query<{ n: string }>("SELECT count(*) AS n FROM soil_reports WHERE farm_id=$1 AND owner_id=$2 AND kind='field_report' AND mode=$3", [farmId, ownerId, deps.config.RUNTIME_MODE]);
  const soilReportStatus: CropFitReview['soilReportStatus'] = hasConfirmedMarkers(soil) ? 'confirmed' : Number(reports.rows[0]?.n ?? 0) > 0 ? 'unconfirmed' : 'none';
  const markers = soil.samples.flatMap((s) => s.markers.filter((m) => m.reviewStatus === 'confirmed').map((m) => ({ sample: s.id, id: m.id, parameter: m.parameter, value: m.canonical.value, unit: m.canonical.unit })))
    .sort((a, b) => a.sample.localeCompare(b.sample) || a.id.localeCompare(b.id));
  const material = {
    v: CROP_FIT_ENGINE_VERSION, yearPlan: YEAR_PLAN_ENGINE_VERSION, ratings: deps.ratingsVersion ?? soilRatings.SOIL_RATINGS_VERSION,
    request, day: asOf, workspace: workspace.version, soil: markers,
    farm: { location: { stateCode: farm.location.stateCode, districtId: farm.location.districtId, districtName: farm.location.districtName ?? null }, area: farm.areaHectares, irrigation: ctx.scenario.irrigationCategory, excluded: ctx.excludedCropIds },
    files: { pool: fileHash(data.DATA_FILES.pool), agronomy: fileHash(data.DATA_FILES.agronomy), yieldCost: fileHash(data.DATA_FILES.yieldCost) },
    runtime: { mode: deps.config.RUNTIME_MODE, model: deps.config.META_TEXT_MODEL, keyAvailable: !!deps.config.MODEL_API_KEY },
  };
  return {
    hash: payloadHash(material), asOf, farmId, request, requestKey: requestKey(request), resolved: resolveMode(ctx, request),
    ctx, farm, workspaceVersion: workspace.version, soil, soilPh, soilReportStatus,
  };
}

function blank(c: FitContext): CropFitReview {
  return {
    reviewId: null, jobId: null, contextHash: c.hash, status: 'pending', stale: false, request: c.request,
    resolvedSowing: c.resolved.target, previousCropId: c.resolved.previousCropId, currentCycleId: c.ctx.scenario.currentCycleId, fieldAreaHa: c.farm.areaHectares,
    generatedAt: null, modelInvocation: null, picks: [], pickOrigin: null, candidates: [], weights: { ...WEIGHTS }, soilReportStatus: c.soilReportStatus,
    summary: 'Scoring every pool crop for this sowing date.', limitations: [],
  };
}

async function view(deps: Pick<CropFitDeps, 'pool'>, row: Row, c: FitContext | null): Promise<CropFitReview> {
  const result = CropFitReview.parse({ ...row.result, reviewId: row.id, jobId: row.job_id, contextHash: row.context_hash, status: row.status, stale: c ? row.context_hash !== c.hash : row.result.stale });
  if (row.invocation) result.modelInvocation = row.invocation;
  if ((row.status === 'pending' || row.status === 'running') && row.job_id) {
    const job = (await deps.pool.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1 AND owner_id=$2', [row.job_id, row.owner_id])).rows[0];
    if (!job || ['failed', 'cancelled', 'succeeded'].includes(job.state)) { result.status = 'error'; result.summary = 'The crop fit job stopped before a review was saved. Ask again to retry.'; }
  }
  return result;
}

const ACTIVE = ['pending', 'running'];
const RETRY_AFTER_MS = 15 * 60_000;

/**
 * GET (and POST with force): same hash -> the stored review; otherwise a pending row and one farm.crop-fit job (dedupe
 * key cropfit:<farm>:<hash>, max_attempts 1), archiving older rows of the same request. An error row is replaced after
 * 15 minutes on GET and at once on POST; a review that is still being built is never replaced.
 */
export async function ensureCropFit(deps: CropFitDeps, auth: { ownerId: string; sessionId: string | null }, farmId: string, raw: RawRequest, opts: { force?: boolean } = {}): Promise<CropFitReview> {
  const c = await fitContext(deps, auth.ownerId, farmId, raw);
  const mode = deps.config.RUNTIME_MODE;
  if (!opts.force) {
    // Lock-free fast path for polling: a settled review, or one whose job is still queued or running.
    const row = (await deps.pool.query<Row>('SELECT * FROM crop_fit_reviews WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND context_hash=$4 AND archived_at IS NULL', [farmId, auth.ownerId, mode, c.hash])).rows[0];
    if (row && (row.status === 'ready' || row.status === 'unavailable')) return view(deps, row, c);
    if (row && ACTIVE.includes(row.status) && row.job_id) {
      const job = (await deps.pool.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1 AND owner_id=$2', [row.job_id, auth.ownerId])).rows[0];
      if (job && ['queued', 'running'].includes(job.state)) return view(deps, row, c);
    }
  }
  const id = await withTransaction(deps.pool, async (tx) => {
    const owned = await tx.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE', [farmId, auth.ownerId]);
    if (!owned.rowCount) throw notFound('Farm');
    let existing: Row | undefined = (await tx.query<Row>('SELECT * FROM crop_fit_reviews WHERE farm_id=$1 AND mode=$2 AND context_hash=$3 AND archived_at IS NULL FOR UPDATE', [farmId, mode, c.hash])).rows[0];
    if (existing) {
      const jobState = existing.job_id ? (await tx.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [existing.job_id])).rows[0]?.state : null;
      const stopped = ACTIVE.includes(existing.status) && ['failed', 'cancelled', 'succeeded', undefined, null].includes(jobState as string | null | undefined);
      const active = ACTIVE.includes(existing.status) && !stopped;
      const failed = stopped || existing.status === 'error';
      if (!active && (opts.force === true || (failed && Date.now() - existing.updated_at.getTime() > RETRY_AFTER_MS))) {
        await tx.query('UPDATE crop_fit_reviews SET archived_at=now() WHERE id=$1', [existing.id]);
        existing = undefined;
      }
    }
    if (existing) return existing.id;
    const older = await tx.query<{ job_id: string | null }>('UPDATE crop_fit_reviews SET archived_at=now() WHERE farm_id=$1 AND mode=$2 AND request_key=$3 AND archived_at IS NULL RETURNING job_id', [farmId, mode, c.requestKey]);
    const oldJobs = older.rows.map((r) => r.job_id).filter((x): x is string => !!x);
    if (oldJobs.length) await tx.query("UPDATE jobs SET cancel_requested=true WHERE id=ANY($1::uuid[]) AND state IN ('queued','running')", [oldJobs]);
    const before = Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM crop_fit_reviews WHERE farm_id=$1 AND mode=$2 AND context_hash=$3', [farmId, mode, c.hash])).rows[0]!.n);
    const reviewId = randomUUID();
    const result = { ...blank(c), reviewId };
    const ins = await tx.query("INSERT INTO crop_fit_reviews(id,owner_id,farm_id,mode,fit_mode,request_key,context_hash,request,result,status,session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'pending',$10) ON CONFLICT (farm_id,mode,context_hash) WHERE archived_at IS NULL DO NOTHING RETURNING id",
      [reviewId, auth.ownerId, farmId, mode, c.request.mode, c.requestKey, c.hash, JSON.stringify(c.request), JSON.stringify(result), auth.sessionId]);
    if (!ins.rowCount) return (await tx.query<{ id: string }>('SELECT id FROM crop_fit_reviews WHERE farm_id=$1 AND mode=$2 AND context_hash=$3 AND archived_at IS NULL', [farmId, mode, c.hash])).rows[0]!.id;
    const key = before === 0 ? `cropfit:${farmId}:${c.hash}` : `cropfit:${farmId}:${c.hash}:r${before + 1}`;
    const q = await enqueue(tx, CROP_FIT_JOB_TYPE, { reviewId, farmId, sessionId: auth.sessionId }, auth.ownerId, key);
    await tx.query('UPDATE jobs SET max_attempts=1 WHERE id=$1', [q.job.id]);
    await tx.query('UPDATE crop_fit_reviews SET job_id=$2 WHERE id=$1', [reviewId, q.job.id]);
    return reviewId;
  });
  const row = (await deps.pool.query<Row>('SELECT * FROM crop_fit_reviews WHERE id=$1 AND owner_id=$2', [id, auth.ownerId])).rows[0]!;
  return view(deps, row, c);
}

// ------------------------------------------------------------------ the job

async function mapLimit<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}

async function fetchOutlooks(deps: CropFitDeps, c: FitContext, keys: readonly PriceInputKey[]): Promise<{ map: Map<string, HarvestPriceOutlook>; failed: number }> {
  const get = deps.sources?.priceOutlook ?? (async (args: HarvestPriceOutlookArgs) => (await harvestPriceOutlook(deps.pool, deps.config.RUNTIME_MODE, args)) as unknown as HarvestPriceOutlook);
  const map = new Map<string, HarvestPriceOutlook>();
  let failed = 0;
  if (!c.farm.location.stateCode) return { map, failed };
  await mapLimit(keys, 4, async (k) => {
    try { map.set(k.key, await get({ productId: k.productId, stateName: c.farm.location.stateCode!, districtName: c.farm.location.districtName ?? null, harvestDate: k.harvestDate, asOf: c.asOf })); }
    catch { failed++; }
  });
  return { map, failed };
}

function annualMeansOf(map: Map<string, HarvestPriceOutlook>, into: Map<string, number>) {
  const best = new Map<string, HarvestPriceOutlook>();
  for (const k of [...map.keys()].sort()) {
    const o = map.get(k)!;
    if (o.status !== 'available' || o.annualMean === null || into.has(o.productId)) continue;
    const cur = best.get(o.productId);
    if (!cur || o.yearsUsed.length > cur.yearsUsed.length) best.set(o.productId, o);
  }
  for (const [p, o] of best) into.set(p, o.annualMean!);
}

function priceEstimate(rc: RankedCandidate): PriceEstimate | null {
  const o = rc.ev.outlook;
  if (!o) return null;
  const w = isoWeek(priceHarvestDate(rc.plan.harvest));
  const available = o.status === 'available';
  return {
    status: o.status, unit: 'INR/kg', p50: available ? o.p50 : null, range: available && o.p25 !== null && o.p75 !== null ? { low: o.p25, high: o.p75 } : null,
    harvestWeek: `${w.year}-W${String(w.week).padStart(2, '0')}`, yearsUsed: o.yearsUsed, observations: o.observations,
    scope: { level: o.scope.level, stateName: o.scope.stateName, districtName: o.scope.districtName, marketCount: o.scope.marketCount }, reason: o.missingReason ? o.missingReason.slice(0, 80) : null,
  };
}

const RULE_TEXT: Record<RotationRule, string> = {
  avoid_after: 'a source advises against this order', same_family: 'same crop family as the previous crop', legume_after_heavy_feeder: 'legume after a heavy feeder',
  heavy_feeder_after_legume: 'heavy feeder after a legume', cited_succession: 'a cited recommended succession', lighter_after_heavy_feeder: 'lighter feeder after a heavy feeder',
  same_role: 'same nutrient demand as the previous crop', family_break: 'different crop family', no_rule: 'no rotation evidence either way', unknown_previous: 'previous crop not recorded',
};
function rotationNote(rc: RankedCandidate): string | null {
  const prev = rc.previousCropId;
  if (!prev) return 'Previous crop not recorded; the rotation part is neutral.';
  const t = rc.rotation;
  let text = `After ${data.cropDisplayName(prev).toLowerCase()}: ${RULE_TEXT[t.rule]}`;
  const credit = t.rule === 'legume_after_heavy_feeder' ? data.legumeCredit(rc.plan.cropId) : t.rule === 'heavy_feeder_after_legume' ? data.legumeCredit(prev) : null;
  if (credit) text += `; cited residual nitrogen ${credit.min === credit.max ? credit.min : `${credit.min}-${credit.max}`} kg N/ha (${credit.source})`;
  if (t.sources.length && !credit) text += `; ${t.sources.join('; ')}`;
  if (t.phMismatch) text += '; confirmed soil pH is outside the cited range';
  return `${text}.`.slice(0, 600);
}
function waterVerdict(rc: RankedCandidate): string {
  const w = rc.ev.water;
  if (!w.known || w.rainMm === null || w.needMm === null) return 'Rain normals or the crop water need are missing; water fit is neutral.';
  return `Usual rain ${Math.round(w.rainMm)} mm${w.allowanceMm ? ` plus ${w.allowanceMm} mm irrigation` : ''} against a need of ${Math.round(w.needMm)} mm${w.capped ? '; rainfed cap applies' : ''}.`.slice(0, 160);
}
function dedupeBasis(xs: BasisRef[]): BasisRef[] {
  const seen = new Set<string>();
  return xs.filter((b) => { const k = `${b.kind}|${b.sourceId}|${b.note}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
}

const PROFIT_BASIS: BasisRef = { kind: 'model', label: 'Profit simulation (yield x harvest-week price)', sourceId: 'crop-fit:profit-simulation', url: null, scope: null, note: 'Independent lognormal yield and price (median p50, sigma ln(p75/p25)/1.349), 2,000 seeded draws, cost deducted as a fixed figure; likely = p25 to p75, possible = p10 to p90; rounded to INR 100.' };
const NEED_BASIS: BasisRef = { kind: 'soil', label: 'Crop nutrient uptake (FAO plant nutrition guide, crop-agronomy.json nutrientUptake)', sourceId: 'crop-fit:nutrient-need', url: null, scope: null, note: 'Uptake scaled by the regional p50 yield; N < 60 low, 60-120 medium, > 120 high kg/ha; P2O5 30/60; K2O 60/120 (ROUND2_SPEC 4.1). A need class, not a fertiliser dose.' };

export interface Extras { marketNow: CropFitCandidate['marketNow']; facts: ReturnType<typeof soilFacts>; phRange: PhRange | null; seed: string; areaHa: number | null; soil: Soil }
/** Contract candidate from a ranked placement plus price now, the soil facts and the profit simulation (exported for scripts). */
export function toCandidate(rc: RankedCandidate, rank: number, x: Extras): CropFitCandidate {
  const ev = rc.ev;
  const plan = rc.plan;
  const uncertainties = [...rc.uncertainties];
  const basis: BasisRef[] = [...ev.basis];
  const o = ev.outlook;
  const yieldP50 = ev.yield.localKgPerHa;
  let profitPerHa: CropFitCandidate['profitPerHa'] = null;
  let profitForField: CropFitCandidate['profitForField'] = null;
  if (yieldP50 !== null && o && o.status === 'available' && o.p50 !== null && ev.cost) {
    const est = estimateProfit({
      seed: `${x.seed}|${plan.cropId}|${plan.productId}|${plan.sowing}`,
      yieldKgPerHa: { p25: ev.yieldRange?.low ?? yieldP50, p50: yieldP50, p75: ev.yieldRange?.high ?? yieldP50 },
      pricePerKg: { p25: o.p25 ?? o.p50, p50: o.p50, p75: o.p75 ?? o.p50 }, keep: 1 - (ev.loss?.pct ?? 0) / 100, costPerHa: ev.cost.deductionPerHa, areaHa: x.areaHa,
    });
    profitPerHa = est.profitPerHa;
    profitForField = est.profitForField;
    basis.unshift(PROFIT_BASIS);
    if (est.yieldSigmaAssumed) uncertainties.push('The yield has no year-to-year range; the profit simulation assumes a spread (sigma 0.15).');
  }
  const soil = compareSoil(x.facts, x.soil, { cropId: plan.cropId, cropName: data.cropDisplayName(plan.cropId), yieldKgPerHa: yieldP50 ?? ev.yieldRef?.p50 ?? null, phRange: x.phRange });
  if (soil.checks.some((s) => s.need)) basis.push(NEED_BASIS);
  if (rc.shiftedDays !== 0) basis.push({ kind: 'model', label: 'Crop fit: nearest sourced window day', sourceId: 'crop-fit:window-shift', url: null, scope: null, note: 'A requested date outside every sourced window is moved to the nearest window day within 21 days (ROUND2_SPEC 4.1); farther away the crop is not ranked.' });
  return {
    cropId: plan.cropId, productId: plan.productId, cropName: data.cropDisplayName(plan.cropId).slice(0, 120), productName: data.productDisplayName(plan.cropId, plan.productId).slice(0, 120),
    establishmentMethod: plan.method ? plan.method.slice(0, 80) : null, rank, score: rc.score, components: rc.components,
    sowing: plan.sowing, harvest: { ...plan.harvest }, durationDays: { ...plan.durationDays },
    window: plan.window ? { scope: plan.window.scope, season: plan.window.season, fit: plan.windowFit, shiftedDays: rc.shiftedDays } : null,
    yieldKgPerHa: ev.yieldRange, yieldBasis: ev.yieldBasis, price: priceEstimate(rc), marketNow: x.marketNow, cost: ev.cost?.estimate ?? null,
    profitPerHa, profitForField, soil, water: { fit: rc.components.water, needMm: ev.water.needMm, rainMm: ev.water.rainMm === null ? null : Math.round(ev.water.rainMm), verdict: waterVerdict(rc) },
    rotation: { previousCropId: rc.previousCropId, rule: rc.rotation.rule, note: rotationNote(rc) },
    confidence: ev.confidence.label, reasonCodes: rc.reasonCodes.slice(0, 10), uncertainties: [...new Set(uncertainties)].slice(0, 10).map((u) => u.slice(0, 600)), basis: dedupeBasis(basis),
  };
}

/** Cited pH ranges: the year-plan agronomy range when present, else the focused crop care research (sourced, method unstated). */
export async function phRanges(cropIds: readonly string[]): Promise<Map<string, PhRange>> {
  const out = new Map<string, PhRange>();
  let research: Awaited<ReturnType<typeof focusedResearch>> | null = null;
  try { research = await focusedResearch(); } catch { research = null; }
  for (const id of cropIds) {
    const a = data.phRange(id);
    if (a) { out.set(id, { min: a.min, max: a.max, source: a.source ?? 'crop agronomy research' }); continue; }
    const crop = research?.crops.find((c) => c.cropId === id);
    const req = crop?.soilEnvironment.find((r) => ['ph', 'soil_ph'].includes(r.parameter.toLowerCase()));
    const v = req?.value as { min?: unknown; max?: unknown } | undefined;
    if (req && v && typeof v.min === 'number' && typeof v.max === 'number' && v.min < v.max) {
      const ref = req.sourceRefs[0];
      const src = ref ? research!.sources.find((s) => s.id === ref.sourceId) : undefined;
      out.set(id, { min: v.min, max: v.max, source: `${src?.title ?? ref?.sourceId ?? 'focused crop research'}${ref?.locator ? `, ${ref.locator}` : ''}` });
    }
  }
  return out;
}

function unplacedNote(unplaced: readonly Unplaced[]): string[] {
  const by = new Map<string, string[]>();
  for (const u of unplaced) by.set(u.reason, [...new Set([...(by.get(u.reason) ?? []), data.cropDisplayName(u.cropId).toLowerCase()])]);
  return [...by.entries()].map(([reason, crops]) => `Not ranked (${crops.join(', ')}): ${reason}`.slice(0, 600));
}

async function invocationFor(deps: Pick<CropFitDeps, 'pool'>, ownerId: string, farmId: string, since: Date, responseDeleted: boolean | null): Promise<ModelInvocation | null> {
  const f = (await deps.pool.query<{ id: string; requested_model: string; model: string | null; status: 'running' | 'succeeded' | 'failed'; started_at: Date; finished_at: Date | null }>(
    'SELECT id,requested_model,model,status,started_at,finished_at FROM ai_invocations WHERE owner_id=$1 AND purpose=$2 AND started_at>=$3 ORDER BY started_at DESC LIMIT 1', [ownerId, `crop_fit/${farmId}`, since])).rows[0];
  return f ? { id: f.id, provider: 'meta', requestedModel: f.requested_model, model: f.model, purpose: `crop_fit/${farmId}`, status: f.status, startedAt: f.started_at.toISOString(), finishedAt: f.finished_at?.toISOString() ?? null, processing: 'standard', requestedStorage: false, responseDeleted } : null;
}

/** Worker body: rank -> store the code ranking (running) -> Meta picks (or deterministic) -> ready. Provider problems never throw. */
export async function generateCropFit(deps: CropFitDeps, reviewId: string, ownerId: string, isCancelled: () => Promise<boolean> = async () => false) {
  const row = (await deps.pool.query<Row>('SELECT * FROM crop_fit_reviews WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL', [reviewId, ownerId])).rows[0];
  if (!row) return { status: 'cancelled', reason: 'review_missing' };
  if (row.status !== 'pending') return { status: row.status, reason: 'already_claimed' };
  const c = await fitContext(deps, ownerId, row.farm_id, { mode: row.request.mode, season: row.request.season ?? undefined, sowing: row.request.sowing ?? undefined });
  const result: CropFitReview = { ...blank(c), reviewId: row.id, jobId: row.job_id, contextHash: row.context_hash, status: 'error' };
  const stored: Record<string, unknown> = { asOf: c.asOf };
  let invocation: ModelInvocation | null = null;
  const save = async (status: CropFitReview['status'], final: boolean) => {
    result.status = status;
    if (final) result.generatedAt = new Date().toISOString();
    await deps.pool.query(`UPDATE crop_fit_reviews r SET status=$3,result=$4::jsonb,input_context=$5::jsonb,invocation=$6::jsonb${final ? ',finished_at=now()' : ''} FROM farms f WHERE r.id=$1 AND r.owner_id=$2 AND f.id=r.farm_id AND f.owner_id=$2 AND f.deleted_at IS NULL AND r.archived_at IS NULL`,
      [reviewId, ownerId, status, JSON.stringify(CropFitReview.parse(result)), JSON.stringify(stored), invocation ? JSON.stringify(invocation) : null]);
  };
  const finish = async (status: CropFitReview['status']) => { await save(status, true); return { status, reviewId }; };
  if (c.hash !== row.context_hash) { result.stale = true; result.summary = 'Farm inputs changed before this review began. Ask again for a fresh review.'; return finish('error'); }
  const claimed = await deps.pool.query<{ started_at: Date }>("UPDATE crop_fit_reviews SET status='running',started_at=now() WHERE id=$1 AND owner_id=$2 AND status='pending' RETURNING started_at", [reviewId, ownerId]);
  if (!claimed.rowCount) return { status: 'cancelled', reason: 'already_claimed' };
  const startedAt = claimed.rows[0]!.started_at;
  if (await isCancelled()) { result.summary = 'The review was cancelled.'; return finish('error'); }
  const live = deps.config.RUNTIME_MODE === 'live';
  const limitations: string[] = [];
  try {
    // ---- placement and inputs (code-gathered; a missing input lowers scores and is flagged, never filled in)
    const { placed, unplaced } = placeCandidates(c.ctx, c.resolved);
    const allKeys = collectInputKeys(placed.map((p) => p.plan));
    const keys = allKeys.slice(0, PRICE_LOOKUP_CAP);
    const looked = new Set(keys.map((k) => k.key));
    if (keys.length < allKeys.length) limitations.push(`Price lookups are capped at ${PRICE_LOOKUP_CAP}: ${allKeys.length - keys.length} crop and harvest-week combinations score no price.`);
    const inputs: Inputs = emptyInputs(c.asOf, c.ctx.irrigation);
    const fetched = await fetchOutlooks(deps, c, keys);
    inputs.priceOutlooks = fetched.map;
    annualMeansOf(fetched.map, inputs.annualMeans);
    if (fetched.failed) limitations.push(`${fetched.failed} harvest-week price lookups failed and score no price.`);
    const point = c.farm.location.lat !== null && c.farm.location.lon !== null ? { lat: c.farm.location.lat, lon: c.farm.location.lon } : null;
    if (point) {
      try {
        const scope: WeatherScope = { farmId: c.farmId, districtId: c.farm.location.districtId, stateId: c.farm.location.stateCode, point: { lon: point.lon, lat: point.lat } };
        const range = { start: c.asOf, end: addDays(c.asOf, 364) };
        const clim = deps.sources?.climatology ? await deps.sources.climatology(scope, range)
          : await createWeatherSource({ pool: deps.pool, mode: deps.config.RUNTIME_MODE, autoIngest: live, climatologyYears: deps.config.WEATHER_CLIMATOLOGY_YEARS, climatologyEndYear: deps.config.WEATHER_CLIMATOLOGY_END_YEAR, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }).getClimatology(scope, range);
        inputs.climatologyRainByMonth = clim ? monthlyRainFromDaily(clim.days) : null;
        inputs.climatologySource = clim && inputs.climatologyRainByMonth ? { sourceId: clim.sourceId, years: clim.years } : null;
      } catch { inputs.climatologyRainByMonth = null; }
    }
    if (!inputs.climatologyRainByMonth) limitations.push(point ? 'Rain normals for the field point are not available yet; water fit is neutral.' : 'The farm has no map point, so rain normals cannot be read; water fit is neutral.');
    inputs.soilPh = c.soilPh;
    if (live) {
      try {
        const nb = deps.sources?.neighbourhood ? await deps.sources.neighbourhood(ownerId, row.farm_id) : await neighbourhoodSeasonality({ config: deps.config, pool: deps.pool }, ownerId, row.farm_id);
        if (nb.status === 'available') { inputs.neighbourhoodActiveMonths = nb.activeMonths; inputs.neighbourhoodObservedMonths = [...new Set(nb.months.filter((m) => m.meanNdvi !== null).map((m) => m.monthOfYear))]; }
      } catch { limitations.push('Neighbourhood vegetation activity (Sentinel-2) was unavailable; no NDVI adjustment was applied.'); }
    }
    // ---- ranking (year-plan slot scoring), price now, profit, soil
    const usable = keys.length === allKeys.length ? placed : placed.filter((p) => looked.has(slotPriceKey(p.plan)));
    const ranked = rankCandidates(c.ctx, inputs, usable).slice(0, 30);
    const rate = deps.rateMarker === undefined ? defaultRateMarker() : deps.rateMarker;
    const facts = soilFacts(c.soil, rate);
    if (hasConfirmedMarkers(c.soil) && !rate) limitations.push('Soil ratings are not available; confirmed markers are listed without a rating.');
    const ph = await phRanges([...new Set(ranked.map((r) => r.plan.cropId))]);
    const getNow = deps.sources?.marketNow ?? ((a: MarketNowArgs) => readMarketNow(deps.pool, deps.config.RUNTIME_MODE, a));
    const products = [...new Set(ranked.map((r) => r.plan.productId))];
    const nowByProduct = new Map<string, CropFitCandidate['marketNow']>();
    await mapLimit(products, 4, async (productId) => {
      try { nowByProduct.set(productId, (await getNow({ productId, stateCode: c.farm.location.stateCode, districtName: c.farm.location.districtName ?? null, asOf: c.asOf })) ?? null); }
      catch { nowByProduct.set(productId, null); }
    });
    const seed = `${row.farm_id}|${row.context_hash}`;
    result.candidates = ranked.map((rc, i) => toCandidate(rc, i + 1, { marketNow: nowByProduct.get(rc.plan.productId) ?? null, facts, phRange: ph.get(rc.plan.cropId) ?? null, seed, areaHa: c.farm.areaHectares, soil: c.soil }));
    if (c.request.mode === 'season') {
      const first = [...result.candidates].sort((a, b) => a.sowing.localeCompare(b.sowing))[0];
      result.resolvedSowing = first?.sowing ?? null;
      result.previousCropId = first ? first.rotation.previousCropId : null;
    }
    const sowingText = c.request.mode === 'season' ? `${c.request.season} sowing windows${result.resolvedSowing ? ` from ${fmt(result.resolvedSowing)}` : ''}` : `sowing from ${fmt(c.resolved.target!)}${c.resolved.previousCropId ? `, after ${data.cropDisplayName(c.resolved.previousCropId).toLowerCase()}` : ''}`;
    result.limitations = [
      ...ENGINE_LIMITATIONS,
      'Crop fit scores one season on its own; idle months and later crops are scored by the year plan.',
      'Profit is simulated from the yield range and the harvest-week price range (2,000 seeded draws): likely = middle half of the simulated outcomes, possible = 10th to 90th percentile; the cost of cultivation is a fixed published figure.',
      'Price now is the median wholesale mandi modal price over the last 14 trading days of stored quotes, not a farm-gate offer.',
      'Soil need classes come from published crop nutrient uptake scaled by the regional yield; they are comparisons, not fertiliser doses.',
      ...c.resolved.notes, ...c.ctx.warnings, ...unplacedNote(unplaced), ...limitations,
    ].map((x) => x.slice(0, 600));
    stored.unplaced = unplaced;
    stored.priceKeys = { needed: allKeys.length, looked: keys.length, available: [...fetched.map.values()].filter((o) => o.status === 'available').length, failed: fetched.failed };
    stored.climatology = inputs.climatologySource ?? null;
    if (!result.candidates.length) {
      result.summary = c.request.mode === 'season' ? `No pool crop has a sourced ${c.request.season} sowing window on this field.` : `No pool crop has a sourced sowing window within 21 days of ${fmt(c.resolved.target!)} on this field.`;
      return finish('unavailable');
    }
    const pool = pickPool(result.candidates);
    result.picks = deterministicPicks(pool);
    result.pickOrigin = 'deterministic';
    result.summary = `${result.candidates.length} crops scored by code for ${sowingText}; the top three are picked by score. Every date, range and score is calculated.`.slice(0, 600);
    await save('running', false);
    // ---- Meta picks
    if (pool.length <= 3) { result.limitations.push('Three or fewer crops fit this date, so no model selection was needed; the picks are calculated.'); return finish('ready'); }
    if (!live) { result.limitations.push('Meta is not used in this runtime mode; the picks are calculated.'); return finish('ready'); }
    if (!deps.config.MODEL_API_KEY && !deps.provider) { result.limitations.push(`${MODEL_UNAVAILABLE}: Meta is not configured on this server; the picks are calculated.`); return finish('ready'); }
    const session = row.session_id ? (await deps.pool.query('SELECT id FROM sessions WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND expires_at>now()', [row.session_id, ownerId])).rows[0] : null;
    if (!session || (await isCancelled())) { result.limitations.push(`${MODEL_UNAVAILABLE}: the requesting session expired before the model call; the picks are calculated.`); return finish('ready'); }
    if ((await fitContext(deps, ownerId, row.farm_id, { mode: c.request.mode, season: c.request.season ?? undefined, sowing: c.request.sowing ?? undefined })).hash !== row.context_hash) {
      result.stale = true; result.picks = []; result.candidates = []; result.summary = 'Farm inputs changed while the review was being built. Ask again for a fresh review.';
      return finish('error');
    }
    const field: PickField = { stateId: c.ctx.stateId, districtId: c.ctx.districtId, irrigation: c.ctx.scenario.irrigationCategory, previousCropId: result.previousCropId, mode: c.request.mode, resolvedSowing: result.resolvedSowing, soilReportStatus: c.soilReportStatus };
    const sel = await picksWithMeta(deps, { farmId: row.farm_id, reviewId, ownerId, sessionId: row.session_id, field, pool });
    stored.meta = { failure: sel.failure, dispatched: sel.dispatched, model: sel.model, costUsd: sel.costUsd, usage: sel.usage };
    result.picks = sel.picks;
    result.pickOrigin = sel.origin;
    if (sel.origin === 'model') result.summary = `Meta picked three of ${result.candidates.length} crops scored by code for ${sowingText} and explained each from the code facts; every date, range and score is calculated by code.`.slice(0, 600);
    else result.limitations.push(`${MODEL_UNAVAILABLE} (${sel.failure ?? 'unknown'}); showing the calculated top three. Ask again later for model picks.`);
    invocation = await invocationFor(deps, ownerId, row.farm_id, startedAt, sel.responseDeleted);
    result.modelInvocation = invocation;
    return finish('ready');
  } catch (e) {
    result.picks = [];
    result.candidates = [];
    result.pickOrigin = null;
    result.summary = 'Crop fit could not be calculated right now. Ask again to retry.';
    result.limitations.push(`Internal error while scoring crops (${(e as Error).name}).`);
    return finish('error');
  }
}
