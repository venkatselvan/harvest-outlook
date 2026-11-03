import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CropFitReview, IntercropCompanion, type BasisRef, type CropFitCandidate, type YearPlanOption, type CropFitRequest, type CropSeason, type HarvestPriceOutlook, type ModelInvocation, type NeighbourhoodSeasonality, type PriceEstimate } from '@harvest/contracts';
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
import { fieldAreaHa, fieldView, getWorkspace } from '../workspace';
import * as data from '../year-plan/data';
import { enumerateCandidates, type CandidateSet } from '../year-plan/candidates';
import { ENGINE_LIMITATIONS, marginNormaliser, runInputKeys, type ScoringNorm } from '../year-plan/assemble';
import { ASSUMPTIONS } from '../year-plan/scoring';
import { addDays, isoWeek } from '../year-plan/dates';
import { collectInputKeys, emptyInputs, monthlyRainFromDaily, priceHarvestDate, slotPriceKey, type Inputs, type PriceInputKey } from '../year-plan/inputs';
import { buildScenario, type TimelineFn } from '../year-plan/scenario';
import type { RotationRule } from '../year-plan/scoring';
import { ENGINE_VERSION as YEAR_PLAN_ENGINE_VERSION, PRICE_LOOKUP_CAP as YEAR_PLAN_PRICE_LOOKUP_CAP, soilChecksOf, spreadKeys, todayIst, yearPlanContext } from '../year-plan/service';
import type { EngineContext } from '../year-plan/types';
import type { EvaluatedSlot } from '../year-plan/assemble';
import { marketNow as readMarketNow, type MarketNowArgs } from './market-now';
import { estimateProfit } from '../estimate';
import * as soilRatings from '../soil-ratings';
import { intercropSystemOf, normaliseRequest, placeCandidates, planCandidates, rankCandidates, resolveMode, seasonContext, type PlacedPlan, type RankOptions } from './rank';
import { picksWithMeta, pickPool, deterministicPicks, isPrunedOrder, POOL_SIZE, type PickField } from './select';
import { compareSoil, hasConfirmedMarkers, soilFacts, type PhRange, type RateMarkerFn } from './soil-compare';
import { CROP_FIT_ENGINE_VERSION, CROP_FIT_JOB_TYPE, type RankedCandidate, type ResolvedMode, type Unplaced } from './types';

/**
 * Persisted crop fit review (ROUND2_SPEC.md 4.1): context hash -> GET returns the ready review for the hash or inserts
 * a pending row and enqueues farm.crop-fit once -> the job ranks every pool crop by code (year-plan slot scoring), adds
 * price now, the simulated profit and the soil comparison, writes the code ranking (status running), then asks Meta for
 * three picks (gate, deterministic fallback) and stores a ready review even when Meta is unavailable.
 */
export const PRICE_LOOKUP_CAP = 120;
/** Candidates kept in a review (contract maximum). */
export const MAX_CANDIDATES = 40;
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

export interface RawRequest {
  mode?: CropFitRequest['mode'] | undefined; season?: CropSeason | undefined; sowing?: string | undefined; after?: string | undefined;
  /** 2026-11-03 (12.3): rank for this field (its cycles, saved seasons, year plan and area); not part of CropFitRequest. */
  fieldId?: string | undefined;
}
type Farm = NonNullable<Awaited<ReturnType<typeof getFarm>>>;
type Soil = Awaited<ReturnType<typeof farmSoilMarkers>>;
type Workspace = Awaited<ReturnType<typeof getWorkspace>>;
export interface FitContext {
  hash: string; asOf: string; farmId: string; request: CropFitRequest; requestKey: string; resolved: ResolvedMode;
  ctx: EngineContext; farm: Farm; workspaceVersion: number; soil: Soil; soilPh: number | undefined; soilReportStatus: CropFitReview['soilReportStatus'];
  /** Yield v2 soil checks (year-plan soilChecksOf over the confirmed N, P2O5, K2O and pH), the plan's Inputs.soilChecks. */
  soilChecks: NonNullable<Inputs['soilChecks']>;
  /** Recorded cycles and the previous harvest (grownBefore). */
  history: Pick<Workspace, 'cycles' | 'previousHarvest'>;
  /** buildScenario arguments, to read the next horizon's occupied intervals for the widened season context. */
  scenarioArgs: Parameters<typeof buildScenario>[0];
  /** 2026-11-03 (12.3): the field ranked for (null = the whole farm) and the area used (the field's, else the farm fact). */
  fieldId: string | null;
  areaHa: number | null;
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
/** The intercropping file is optional in the year plan (absent: no intercrop candidates); hashed as 'absent' then. */
function fileHashOrAbsent(rel: string): string { try { return fileHash(rel); } catch { return 'absent'; } }
/** 12.3: a field's reviews have their own key (`:field=<id>`), so refreshing one field never archives another field's review. */
export const requestKey = (r: CropFitRequest, fieldId: string | null = null): string => `${r.mode}:${r.season ?? ''}:${r.sowing ?? ''}${r.after ? `:after=${r.after}` : ''}${fieldId ? `:field=${fieldId}` : ''}`;

/**
 * Farm, workspace, confirmed soil, scenario and the normalised request. The hash covers the request, the IST day, the
 * workspace version, the confirmed soil marker ids and canonical values, the farm location, area, irrigation and
 * excluded crops, the research files, the engine versions (crop fit and year plan) and the runtime mode and model.
 * Round 3 review: also the yield v2 soil check digest (the year plan's soilChecksOf, so a re-rated marker re-runs crop
 * fit as it re-runs the plan), the green manure and intercropping files, and only current-horizon ready plans.
 */
export async function fitContext(deps: Pick<CropFitDeps, 'pool' | 'config' | 'now' | 'timeline' | 'ratingsVersion'>, ownerId: string, farmId: string, raw: RawRequest): Promise<FitContext> {
  const asOf = todayIst(nowOf(deps));
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const stored = await getWorkspace(deps.pool, ownerId, farmId);
  // 12.3: with a field, the field view (its cycles and saved seasons plus farm-wide legacy ones; 404 field_not_found when
  // unknown) and the field's own area. Without one the whole farm is ranked as before, also on a farm with fields.
  const fieldId = raw.fieldId ?? null;
  const workspace = fieldView(stored, fieldId);
  const areaHa = fieldId ? fieldAreaHa(stored, fieldId) : farm.areaHectares;
  const soil = await farmSoilMarkers(deps, ownerId, farmId);
  const soilPh = planningMeasuredPh(soil);
  const n = soil.samples.length;
  const soilSummary = !n ? 'No confirmed soil report for this field.' : soilPh !== undefined ? `Confirmed laboratory soil pH ${soilPh} (${n} confirmed sample${n > 1 ? 's' : ''}).` : `${n} confirmed soil sample${n > 1 ? 's' : ''}; no single compatible laboratory pH.`;
  const facts = Object.fromEntries(Object.entries(farm.facts).map(([k, f]) => [k, { value: f.value, basis: f.basis, confirmed: f.confirmed }]));
  const scenarioArgs: Parameters<typeof buildScenario>[0] = { workspace, farm: { location: { stateCode: farm.location.stateCode, districtId: farm.location.districtId }, areaHectares: areaHa, facts }, asOf, soilSummary, timeline: deps.timeline ?? stageTimeline };
  const ctx = buildScenario(scenarioArgs);
  let request: CropFitRequest;
  try { request = normaliseRequest(raw, ctx.fixedSlot !== null, asOf); }
  catch (e) { throw new ApiError(400, 'validation_error', (e as Error).message); }
  const reports = await deps.pool.query<{ n: string }>("SELECT count(*) AS n FROM soil_reports WHERE farm_id=$1 AND owner_id=$2 AND kind='field_report' AND mode=$3", [farmId, ownerId, deps.config.RUNTIME_MODE]);
  const soilReportStatus: CropFitReview['soilReportStatus'] = hasConfirmedMarkers(soil) ? 'confirmed' : Number(reports.rows[0]?.n ?? 0) > 0 ? 'unconfirmed' : 'none';
  // Round 3: a newly ready year plan changes the hash, so yearPlanLabels follow the plan (checked for staleness in the job).
  // Only the current horizon (horizon_from NULL) counts: crop fit reads that plan alone, so generating later plan years
  // must not make the review stale.
  // 12.3: only the year plans of the same field (or farm-wide ones when no field is named).
  const yearPlans = (await deps.pool.query<{ id: string }>("SELECT id FROM farm_year_plans WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND archived_at IS NULL AND horizon_from IS NULL AND status='ready' AND input_context->>'fieldId' IS NOT DISTINCT FROM $4::text ORDER BY created_at DESC, id LIMIT 5", [farmId, ownerId, deps.config.RUNTIME_MODE, fieldId])).rows.map((r) => r.id);
  const soilChecks = soilChecksOf(soil);
  const markers = soil.samples.flatMap((s) => s.markers.filter((m) => m.reviewStatus === 'confirmed').map((m) => ({ sample: s.id, id: m.id, parameter: m.parameter, value: m.canonical.value, unit: m.canonical.unit })))
    .sort((a, b) => a.sample.localeCompare(b.sample) || a.id.localeCompare(b.id));
  const material = {
    v: CROP_FIT_ENGINE_VERSION, yearPlan: YEAR_PLAN_ENGINE_VERSION, ratings: deps.ratingsVersion ?? soilRatings.SOIL_RATINGS_VERSION,
    request, day: asOf, workspace: workspace.version, soil: markers, soilChecks: soilChecks.digest, yearPlans,
    // Only with a field, so a farm-wide review keeps its hash.
    ...(fieldId ? { field: { id: fieldId, areaHa } } : {}),
    farm: { location: { stateCode: farm.location.stateCode, districtId: farm.location.districtId, districtName: farm.location.districtName ?? null }, area: farm.areaHectares, irrigation: ctx.scenario.irrigationCategory, excluded: ctx.excludedCropIds },
    files: { pool: fileHash(data.DATA_FILES.pool), agronomy: fileHash(data.DATA_FILES.agronomy), yieldCost: fileHash(data.DATA_FILES.yieldCost), greenManure: fileHashOrAbsent(data.DATA_FILES.greenManure), intercropping: fileHashOrAbsent(data.DATA_FILES.intercropping) },
    runtime: { mode: deps.config.RUNTIME_MODE, model: deps.config.META_TEXT_MODEL, keyAvailable: !!deps.config.MODEL_API_KEY },
  };
  return {
    hash: payloadHash(material), asOf, farmId, request, requestKey: requestKey(request, fieldId), resolved: resolveMode(ctx, request),
    ctx, farm, workspaceVersion: workspace.version, soil, soilPh, soilReportStatus, soilChecks: soilChecks.fn, history: { cycles: workspace.cycles, previousHarvest: workspace.previousHarvest }, scenarioArgs,
    fieldId, areaHa,
  };
}

function blank(c: FitContext): CropFitReview {
  return {
    reviewId: null, jobId: null, contextHash: c.hash, status: 'pending', stale: false, request: c.request,
    resolvedSowing: c.resolved.target, previousCropId: c.resolved.previousCropId, currentCycleId: c.ctx.scenario.currentCycleId, fieldAreaHa: c.areaHa,
    generatedAt: null, modelInvocation: null, picks: [], pickOrigin: null, candidates: [], yearPlanReviewId: null, weights: { ...WEIGHTS }, soilReportStatus: c.soilReportStatus,
    summary: c.request.mode === 'date' ? 'Scoring every pool crop for this sowing date.' : 'Scoring the year plan\'s crops and sowing weeks for this field.', limitations: [],
    ...(c.fieldId ? { fieldId: c.fieldId } : {}),
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

function priceEstimate(rc: Pick<RankedCandidate, 'ev' | 'plan'>): PriceEstimate | null {
  return priceFromOutlook(rc.ev.outlook, rc.plan.harvest);
}
function priceFromOutlook(o: HarvestPriceOutlook | null | undefined, harvest: { earliest: string; latest: string }): PriceEstimate | null {
  if (!o) return null;
  const w = isoWeek(priceHarvestDate(harvest));
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

export interface Extras {
  marketNow: CropFitCandidate['marketNow']; facts: ReturnType<typeof soilFacts>; phRange: PhRange | null; seed: string; areaHa: number | null; soil: Soil;
  yearPlanLabels?: string[] | undefined; grownBefore?: CropFitCandidate['grownBefore'] | undefined;
}

// ------------------------------------------------------------------ round 3: the year plan cross-reference

/** Shared sentence of the summary and limitations (ROUND3_SPEC 5 item 5). */
export const PLAN_LABELS_NOTE = 'the plan\'s labels pick three different plans, not the three highest scores';

export interface CurrentYearPlan { id: string; options: YearPlanOption[]; norm: ScoringNorm | null }
/**
 * The farm's ready year plan for the current inputs and horizon (its context hash equals the year plan's current hash,
 * so a stale plan is never used), with its options and stored normaliser; null when none. Never throws.
 */
export async function currentYearPlan(deps: Pick<CropFitDeps, 'pool' | 'config' | 'timeline'>, ownerId: string, farmId: string, asOf: string, fieldId: string | null = null): Promise<CurrentYearPlan | null> {
  try {
    // 12.3: the field's own plan (its context hash includes the field); a farm with fields has no farm-wide plan (null).
    const yp = await yearPlanContext({ pool: deps.pool, config: deps.config, timeline: deps.timeline }, ownerId, farmId, asOf, null, { fieldId });
    const row = (await deps.pool.query<{ id: string; result: { options?: unknown }; input_context: { norm?: ScoringNorm | null } | null }>(
      "SELECT id,result,input_context FROM farm_year_plans WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND context_hash=$4 AND archived_at IS NULL AND horizon_from IS NULL AND status='ready' ORDER BY created_at DESC LIMIT 1",
      [farmId, ownerId, deps.config.RUNTIME_MODE, yp.hash])).rows[0];
    if (!row) return null;
    return { id: row.id, options: Array.isArray(row.result?.options) ? (row.result.options as YearPlanOption[]) : [], norm: row.input_context?.norm ?? null };
  } catch { return null; }
}

type PlanSlot = YearPlanOption['slots'][number];
const firstSuggested = (o: YearPlanOption): PlanSlot | null => o.slots?.find((s) => !s.fixed) ?? null;
const slotSystemId = (s: PlanSlot): string | null => (s as { kind?: string; companion?: { systemId?: unknown } | null }).kind === 'intercrop' ? String((s as { companion?: { systemId?: unknown } | null }).companion?.systemId ?? '') || null : null;

/** Labels of the plan options whose first suggested slot is this crop and product (and intercrop system), at most five. */
export function yearPlanLabelsFor(options: readonly YearPlanOption[], cropId: string, productId: string, systemId: string | null): string[] {
  const out: string[] = [];
  for (const o of options) {
    const s = firstSuggested(o);
    if (s && s.cropId === cropId && s.productId === productId && slotSystemId(s) === systemId && typeof o.label === 'string') out.push(o.label.slice(0, 60));
  }
  return [...new Set(out)].slice(0, 5);
}

/** The farm's own history with a crop: recorded cycles plus a known previous harvest not already among them; null when none. */
export function grownBeforeOf(history: FitContext['history'], cropId: string): CropFitCandidate['grownBefore'] {
  const mine = history.cycles.filter((x) => x.cropId === cropId);
  const sowings = mine.map((x) => x.sowingDate).sort();
  const harvests = mine.map((x) => x.harvestDate).filter((d): d is string => !!d);
  let cycles = mine.length;
  const ph = history.previousHarvest;
  if (ph.status === 'known' && ph.cropId === cropId && !harvests.includes(ph.harvestDate)) { cycles++; harvests.push(ph.harvestDate); }
  harvests.sort();
  return cycles ? { cycles, lastSowing: sowings.at(-1) ?? null, lastHarvest: harvests.at(-1) ?? null } : null;
}

/** "Name the rank of the plan's Best overall crop" (ROUND3_SPEC 5 item 5). */
export function planComparison(plan: CurrentYearPlan | null, ranked: readonly RankedCandidate[], candidates: readonly CropFitCandidate[], mode: CropFitRequest['mode']): string {
  if (!plan) return 'No current year plan to compare with; the year plan labels appear once a plan for these inputs is ready.';
  const best = plan.options.find((o) => o.label === 'Best overall' || (o.secondaryLabels ?? []).includes('Best overall'));
  const s = best ? firstSuggested(best) : null;
  if (!s) return 'The current year plan has no Best overall crop to compare with.';
  const i = ranked.findIndex((r) => r.plan.cropId === s.cropId && r.plan.productId === s.productId && intercropSystemOf(r.plan) === slotSystemId(s));
  const name = (s.cropName || data.cropDisplayName(s.cropId)).toLowerCase();
  return i >= 0
    ? `The year plan's Best overall starts with ${name} (sown ${fmt(s.sowing)}), ranked ${candidates[i]!.rank} of ${candidates.length} here.`
    : `The year plan's Best overall starts with ${name} (sown ${fmt(s.sowing)}), which is not ranked here${mode === 'date' ? ' for this date' : ''}.`;
}

/**
 * Contract companion of an intercrop candidate from SlotPlan.intercrop (the system) and EvaluatedSlot.companion (the
 * companion's yield, price outlook and harvest), built as the year plan builds its slot companion (assemble.ts
 * buildOption); null for a sole crop or when either part is missing or does not parse.
 */
export function companionOf(rc: Pick<RankedCandidate, 'plan' | 'ev'>): IntercropCompanion | null {
  const ic = rc.plan.intercrop;
  const ev = rc.ev.companion;
  if (intercropSystemOf(rc.plan) === null || !ic?.system || !ev) return null;
  const sys = ic.system;
  const built = IntercropCompanion.safeParse({
    systemId: ic.systemId.slice(0, 120), cropId: ev.cropId.slice(0, 120), productId: ev.productId.slice(0, 200),
    cropName: data.cropDisplayName(ev.cropId).slice(0, 120), productName: data.productDisplayName(ev.cropId, ev.productId).slice(0, 120),
    rowRatio: sys.rowRatio.slice(0, 20), arrangement: sys.arrangement,
    yieldShare: { main: { low: sys.yieldShare.main.min, high: sys.yieldShare.main.max }, companion: { low: sys.yieldShare.companion.min, high: sys.yieldShare.companion.max } },
    shareBasis: sys.shareBasis, yieldKgPerHa: ev.yieldRange, yieldBasis: ev.yieldBasis, price: priceFromOutlook(ev.outlook, ev.harvest),
    nitrogenCreditKgPerHa: sys.nitrogenCredit ? { low: sys.nitrogenCredit.min, high: sys.nitrogenCredit.max } : null,
    ...('costPerHa' in ev ? { costPerHa: (ev as { costPerHa?: number | null }).costPerHa ?? null } : {}),
    source: sys.source ? { id: sys.source.id.slice(0, 80), title: (sys.source.title ?? sys.source.id).slice(0, 200), url: sys.source.url, locator: sys.source.locator ? sys.source.locator.slice(0, 200) : null } : null,
  });
  return built.success ? built.data : null;
}
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
  // Intercrop: the year plan's own two-product estimate (estimateProfitMulti: both products at their yield shares, the
  // seed-share cost, seeded by the slot key), so the candidate's profit and field yield equal the plan slot's. The
  // single-product simulation below is the fallback only when the evaluation carries no estimate.
  const icShare = intercropSystemOf(plan) !== null ? plan.intercrop?.system.yieldShare.main ?? null : null;
  const planEstimate = icShare ? (ev as { estimate?: EvaluatedSlot['estimate'] }).estimate : undefined;
  if (planEstimate) {
    profitPerHa = planEstimate.profitPerHa;
    profitForField = planEstimate.profitForField;
    if (planEstimate.yieldSigmaAssumed) uncertainties.push('The yield has no year-to-year range; the profit simulation assumes a spread (sigma 0.15).');
  } else if (yieldP50 !== null && o && o.status === 'available' && o.p50 !== null && ev.cost) {
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
  const intercrop = intercropSystemOf(plan) !== null;
  const companion = intercrop ? companionOf(rc) : null;
  if (intercrop && !companion) uncertainties.push('Intercrop: the companion crop details could not be read; the scores include it.');
  if (rc.waitPenalty > 0) basis.push({ kind: 'model', label: 'Crop fit: wait penalty (year-plan idle penalty)', sourceId: 'crop-fit:wait-penalty', url: null, scope: null, note: `rankScore = score - ${rc.waitPenalty} points for ${rc.waitDays} idle days before sowing (ROUND3_SPEC 5; ASSUMPTIONS.idlePenalty, an engine assumption).` });
  if (rc.shiftedDays !== 0) basis.push({ kind: 'model', label: 'Crop fit: nearest sourced window day', sourceId: 'crop-fit:window-shift', url: null, scope: null, note: 'A requested date outside every sourced window is moved to the nearest window day within 21 days (ROUND2_SPEC 4.1); farther away the crop is not ranked.' });
  return {
    cropId: plan.cropId, productId: plan.productId, cropName: data.cropDisplayName(plan.cropId).slice(0, 120), productName: data.productDisplayName(plan.cropId, plan.productId).slice(0, 120),
    establishmentMethod: plan.method ? plan.method.slice(0, 80) : null, kind: intercrop ? 'intercrop' : 'crop', ...(intercrop ? { companion } : {}),
    rank, score: rc.score, rankScore: rc.rankScore, waitDays: rc.waitDays, waitPenalty: rc.waitPenalty, yearPlanLabels: x.yearPlanLabels ?? [], grownBefore: x.grownBefore ?? null, components: rc.components,
    sowing: plan.sowing, harvest: { ...plan.harvest }, durationDays: { ...plan.durationDays },
    // Saved-season swap (docs/research/YEAR_PLAN_SAVED_SEASONS.md): the engine's occupancy (sowing to the later of the main
    // and companion harvest plus the land-preparation gap; makeIntercropSlotPlan extends it for a later companion) and the
    // companion's harvest, so a swapped saved season holds the field until the companion is in, as applyYearPlan does.
    occupancy: { from: plan.occupancy.from, to: plan.occupancy.to },
    companionHarvest: intercrop && plan.intercrop?.companionHarvest ? { earliest: plan.intercrop.companionHarvest.earliest, latest: plan.intercrop.companionHarvest.latest } : null,
    window: plan.window ? { scope: plan.window.scope, season: plan.window.season, fit: plan.windowFit, shiftedDays: rc.shiftedDays } : null,
    yieldKgPerHa: ev.yieldRange, yieldBasis: ev.yieldBasis,
    // The main crop's harvest on this field; an intercrop scales the sole-crop range by the main yield share (low by the
    // smaller share, high by the larger), as the year plan slot does.
    yieldForFieldKg: ev.yieldRange && x.areaHa !== null && Number.isFinite(x.areaHa) && x.areaHa > 0 ? { low: Math.round(ev.yieldRange.low * (icShare?.min ?? 1) * x.areaHa), high: Math.round(ev.yieldRange.high * (icShare?.max ?? 1) * x.areaHa) } : null,
    price: priceEstimate(rc), marketNow: x.marketNow, cost: ev.cost?.estimate ?? null,
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

const rawOf = (r: CropFitRequest, fieldId?: string | null): RawRequest => ({ mode: r.mode, season: r.season ?? undefined, sowing: r.sowing ?? undefined, after: r.after ?? undefined, ...(fieldId ? { fieldId } : {}) });

/** Worker body: rank -> store the code ranking (running) -> Meta picks (or deterministic) -> ready. Provider problems never throw. */
export async function generateCropFit(deps: CropFitDeps, reviewId: string, ownerId: string, isCancelled: () => Promise<boolean> = async () => false) {
  const row = (await deps.pool.query<Row>('SELECT * FROM crop_fit_reviews WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL', [reviewId, ownerId])).rows[0];
  if (!row) return { status: 'cancelled', reason: 'review_missing' };
  if (row.status !== 'pending') return { status: row.status, reason: 'already_claimed' };
  // 12.3: the review's field travels on its stored result (absent = whole farm). A field deleted since is changed inputs.
  let c: FitContext;
  try { c = await fitContext(deps, ownerId, row.farm_id, rawOf(row.request, row.result.fieldId)); }
  catch (e) {
    if (!(e instanceof ApiError && e.code === 'field_not_found')) throw e;
    await deps.pool.query("UPDATE crop_fit_reviews SET status='error',result=jsonb_set(jsonb_set(result,'{status}','\"error\"'),'{summary}',to_jsonb($3::text)),finished_at=now() WHERE id=$1 AND owner_id=$2", [reviewId, ownerId, 'The field of this review no longer exists. Ask again for a fresh review.']);
    return { status: 'error', reviewId };
  }
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
    // ---- candidates (round 3, ROUND3_SPEC 5): next and season use the year plan's own candidate set and price keys
    // (runInputKeys spread to the plan's lookup cap, unlooked sowing weeks left out as the plan does); date keeps the
    // 21-day placement. Every mode scores on the year plan's normaliser (marginNormaliser over that set).
    const mode = c.request.mode;
    const plan = await currentYearPlan(deps, ownerId, row.farm_id, c.asOf, c.fieldId);
    // Season covers 12 months from the floor (orchestrator decision): the plan context widened past the plan horizon.
    let ectx: EngineContext = c.ctx;
    if (mode === 'season') {
      let next: EngineContext | null = null;
      try { next = buildScenario({ ...c.scenarioArgs, horizonFrom: c.ctx.horizon.to }); }
      catch { limitations.push('Saved seasons after the year plan horizon could not be read; season candidates there may overlap them.'); }
      ectx = seasonContext(c.ctx, c.resolved.floor, next);
    }
    const planSet: CandidateSet = enumerateCandidates(ectx);
    const planKeys = runInputKeys(ectx, planSet);
    const fixedKey = c.ctx.fixedSlot ? slotPriceKey(c.ctx.fixedSlot) : null;
    const planLooked = spreadKeys(planKeys, YEAR_PLAN_PRICE_LOOKUP_CAP, fixedKey ? [fixedKey] : []);
    const planLookedSet = new Set(planLooked.map((k) => k.key));
    const normSet: CandidateSet = planLooked.length < planKeys.length ? { ...planSet, candidates: planSet.candidates.filter((x) => x.kind === 'green_manure' || planLookedSet.has(slotPriceKey(x))) } : planSet;
    const storedNorm = plan?.norm && (plan.norm.maxMarginRate !== null || (plan.norm.maxRevenueRate ?? null) !== null) ? plan.norm : null;
    let placed: PlacedPlan[];
    let unplaced: Unplaced[];
    let keys: PriceInputKey[];
    let needed: number;
    if (mode === 'date') {
      ({ placed, unplaced } = placeCandidates(c.ctx, c.resolved));
      const own = collectInputKeys(placed.map((p) => p.plan));
      const ownKeys = own.slice(0, PRICE_LOOKUP_CAP);
      if (ownKeys.length < own.length) limitations.push(`Price lookups are capped at ${PRICE_LOOKUP_CAP}: ${own.length - ownKeys.length} crop and harvest-week combinations score no price.`);
      const ownLooked = new Set(ownKeys.map((k) => k.key));
      if (ownKeys.length < own.length) placed = placed.filter((p) => ownLooked.has(slotPriceKey(p.plan)));
      // The plan's keys are needed for its normaliser unless the current plan's stored normaliser is used.
      keys = storedNorm ? ownKeys : [...ownKeys, ...planLooked.filter((k) => !ownLooked.has(k.key))];
      needed = own.length + (storedNorm ? 0 : planKeys.length);
    } else {
      ({ placed, unplaced } = planCandidates(ectx, c.resolved, normSet));
      keys = planLooked;
      needed = planKeys.length;
      if (planLooked.length < planKeys.length) limitations.push(`Price lookups are capped at ${YEAR_PLAN_PRICE_LOOKUP_CAP} as in the year plan: ${planLooked.length} of ${planKeys.length} crop and harvest-week combinations were looked up, spread evenly across crops; sowing weeks whose harvest week was not looked up were left out.`);
      // Next crop after saved seasons that fill the plan horizon (orchestrator, 2026-11-01): widen to 12 months from the
      // first free day exactly as season mode does, so the farmer still sees the next crop rather than an empty list.
      if (mode === 'next' && !placed.length && ectx.occupied.length) {
        let next: EngineContext | null = null;
        try { next = buildScenario({ ...c.scenarioArgs, horizonFrom: c.ctx.horizon.to }); } catch { /* no later horizon: widen without its intervals */ }
        const wide = seasonContext(c.ctx, c.resolved.floor, next);
        if (wide !== c.ctx) {
          const wideSet = enumerateCandidates(wide);
          const wideKeys = spreadKeys(runInputKeys(wide, wideSet), YEAR_PLAN_PRICE_LOOKUP_CAP, fixedKey ? [fixedKey] : []);
          const wideLooked = new Set(wideKeys.map((k) => k.key));
          const wideNorm: CandidateSet = wideKeys.length < wideSet.candidates.length ? { ...wideSet, candidates: wideSet.candidates.filter((x) => x.kind === 'green_manure' || wideLooked.has(slotPriceKey(x))) } : wideSet;
          const again = planCandidates(wide, c.resolved, wideNorm);
          if (again.placed.length) {
            ectx = wide; placed = again.placed; unplaced = again.unplaced; keys = wideKeys; needed = wideKeys.length;
            limitations.push(`Saved seasons fill the free months up to the end of the year plan horizon (${fmt(addDays(c.ctx.horizon.to, -1))}); windows after it are scored on the same basis.`);
          }
        }
      }
    }
    const inputs: Inputs = emptyInputs(c.asOf, c.ctx.irrigation);
    const fetched = await fetchOutlooks(deps, c, keys);
    inputs.priceOutlooks = fetched.map;
    annualMeansOf(fetched.map, inputs.annualMeans);
    if (fetched.failed) limitations.push(`${fetched.failed} harvest-week price lookups failed and score no price.`);
    const point = c.farm.location.lat !== null && c.farm.location.lon !== null ? { lat: c.farm.location.lat, lon: c.farm.location.lon } : null;
    if (point) {
      try {
        const scope: WeatherScope = { farmId: c.farmId, districtId: c.farm.location.districtId, stateId: c.farm.location.stateCode, point: { lon: point.lon, lat: point.lat } };
        const range = { start: c.ctx.horizon.from, end: addDays(c.ctx.horizon.to, -1) }; // the year plan's range
        const clim = deps.sources?.climatology ? await deps.sources.climatology(scope, range)
          : await createWeatherSource({ pool: deps.pool, mode: deps.config.RUNTIME_MODE, autoIngest: live, climatologyYears: deps.config.WEATHER_CLIMATOLOGY_YEARS, climatologyEndYear: deps.config.WEATHER_CLIMATOLOGY_END_YEAR, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }).getClimatology(scope, range);
        inputs.climatologyRainByMonth = clim ? monthlyRainFromDaily(clim.days) : null;
        inputs.climatologySource = clim && inputs.climatologyRainByMonth ? { sourceId: clim.sourceId, years: clim.years } : null;
      } catch { inputs.climatologyRainByMonth = null; }
    }
    if (!inputs.climatologyRainByMonth) limitations.push(point ? 'Rain normals for the field point are not available yet; water fit is neutral.' : 'The farm has no map point, so rain normals cannot be read; water fit is neutral.');
    inputs.soilPh = c.soilPh;
    // Yield v2 soil factor (ROUND3_SPEC 4 item 2), the same function the year plan job sets, so the scores stay equal.
    inputs.soilChecks = c.soilChecks;
    if (live) {
      try {
        const nb = deps.sources?.neighbourhood ? await deps.sources.neighbourhood(ownerId, row.farm_id) : await neighbourhoodSeasonality({ config: deps.config, pool: deps.pool }, ownerId, row.farm_id);
        if (nb.status === 'available') { inputs.neighbourhoodActiveMonths = nb.activeMonths; inputs.neighbourhoodObservedMonths = [...new Set(nb.months.filter((m) => m.meanNdvi !== null).map((m) => m.monthOfYear))]; }
      } catch { limitations.push('Neighbourhood vegetation activity (Sentinel-2) was unavailable; no NDVI adjustment was applied.'); }
    }
    // ---- normaliser: the current plan's stored one, else marginNormaliser over the plan's candidate set
    let norm: ScoringNorm = storedNorm ?? marginNormaliser(ectx, normSet.candidates, inputs);
    let normSource = storedNorm ? 'year_plan_review' : 'year_plan_candidates';
    if (norm.maxMarginRate === null && (norm.maxRevenueRate ?? null) === null && mode === 'date' && placed.length) {
      norm = marginNormaliser(c.ctx, placed.map((p) => p.plan), inputs);
      normSource = 'date_placements';
      limitations.push('No year plan candidate has a priced margin on this field, so prices are normalised over the crops placed on this date instead.');
    }
    // ---- ranking (year-plan slot scoring), price now, profit, soil
    const opts: RankOptions = mode === 'next' ? { norm, waitFrom: c.ctx.earliestSowing, penaliseWait: true }
      : mode === 'season' ? { norm, waitFrom: c.resolved.floor }
      : { norm, waitFrom: c.resolved.target, previousOverride: c.resolved.previousOverride ?? null };
    const ranked = rankCandidates(ectx, inputs, placed, opts).slice(0, MAX_CANDIDATES);
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
    result.candidates = ranked.map((rc, i) => toCandidate(rc, i + 1, {
      marketNow: nowByProduct.get(rc.plan.productId) ?? null, facts, phRange: ph.get(rc.plan.cropId) ?? null, seed, areaHa: c.areaHa, soil: c.soil,
      yearPlanLabels: plan ? yearPlanLabelsFor(plan.options, rc.plan.cropId, rc.plan.productId, intercropSystemOf(rc.plan)) : [],
      grownBefore: grownBeforeOf(c.history, rc.plan.cropId),
    }));
    result.yearPlanReviewId = plan?.id ?? null;
    if (mode === 'season') {
      const first = [...result.candidates].sort((a, b) => a.sowing.localeCompare(b.sowing))[0];
      result.resolvedSowing = first?.sowing ?? null;
      result.previousCropId = first ? first.rotation.previousCropId : null;
    }
    const prevText = c.resolved.previousCropId ? `, after ${data.cropDisplayName(c.resolved.previousCropId).toLowerCase()}` : '';
    const sowingText = mode === 'season' ? `${c.request.season} sowing weeks${result.resolvedSowing ? ` from ${fmt(result.resolvedSowing)}` : ''}`
      : mode === 'next' ? `every sowing week from ${fmt(c.resolved.target!)}, when the field is free${prevText}` : `sowing from ${fmt(c.resolved.target!)}${prevText}`;
    const { perMonth, freeMonths } = ASSUMPTIONS.idlePenalty.value;
    const sameAsPlan = mode === 'date'
      ? `Same scoring and normaliser as the year plan for one sowing date (each crop on that date or moved at most 21 days into a sourced window); ${PLAN_LABELS_NOTE}`
      : `Same candidates, dates and scoring as the year plan; ${PLAN_LABELS_NOTE}`;
    const comparison = planComparison(plan, ranked, result.candidates, mode);
    result.limitations = [
      ...ENGINE_LIMITATIONS,
      `${sameAsPlan}.`,
      ...(mode === 'next' ? [`Ranked by score less a wait penalty for the idle time after the field is free: ${Math.round(perMonth * 10000) / 100} points per idle month beyond the first ${freeMonths} month (the year plan's idle penalty, an engine assumption: ${ASSUMPTIONS.idlePenalty.text})`] : []),
      ...(mode === 'season' ? ['Each crop shows its best-scoring sowing week of that season within 12 months of the first free day; the wait before it is shown, not deducted.'] : []),
      ...(mode === 'season' && ranked.some((r) => r.plan.harvest.latest >= c.ctx.horizon.to) ? [`Windows after the plan horizon are scored on the same basis; the year plan itself stops at ${fmt(addDays(c.ctx.horizon.to, -1))}.`] : []),
      ...(normSource === 'year_plan_review' ? ['Prices are normalised with the current year plan\'s normaliser (highest margin per month among its candidates).'] : []),
      comparison,
      'Profit is simulated from the yield range and the harvest-week price range (2,000 seeded draws): likely = middle half of the simulated outcomes, possible = 10th to 90th percentile; the cost of cultivation is a fixed published figure.',
      'Price now is the median wholesale mandi modal price over the last 14 trading days of stored quotes, not a farm-gate offer.',
      'Soil need classes come from published crop nutrient uptake scaled by the regional yield; they are comparisons, not fertiliser doses.',
      ...c.resolved.notes, ...c.ctx.warnings, ...unplacedNote(unplaced), ...limitations,
    ].map((x) => x.slice(0, 600));
    stored.unplaced = unplaced;
    stored.priceKeys = { needed, looked: keys.length, available: [...fetched.map.values()].filter((o) => o.status === 'available').length, failed: fetched.failed };
    stored.climatology = inputs.climatologySource ?? null;
    stored.norm = { source: normSource, value: norm };
    stored.yearPlanReviewId = plan?.id ?? null;
    stored.planCandidates = planSet.candidates.length;
    if (!result.candidates.length) {
      result.summary = mode === 'season' ? `No pool crop has a sourced ${c.request.season} sowing week on this field between ${fmt(c.resolved.floor)} and ${fmt(addDays(ectx.horizon.to, -1))} that is harvested by then.`
        : mode === 'next' ? `No pool crop has a sourced sowing week between ${fmt(c.resolved.target!)} and the end of the year plan horizon (${fmt(c.ctx.horizon.to)}) on this field${c.ctx.occupied.length ? `; saved seasons (${c.ctx.occupied.map((o) => `${data.cropDisplayName(o.cropId).toLowerCase()} ${fmt(o.from)} to ${fmt(o.to)}`).join(', ')}) take the free months` : ''}.`
        : `No pool crop has a sourced sowing window within 21 days of ${fmt(c.resolved.target!)} on this field.`;
      return finish('unavailable');
    }
    const rankedBy = mode === 'next' ? 'score less the wait penalty' : 'score';
    const tail = ` ${sameAsPlan}. ${comparison}`;
    const pool = pickPool(result.candidates);
    const pruned = result.candidates.slice(0, POOL_SIZE).filter((x) => isPrunedOrder(x) && !pool.includes(x)).length;
    if (pruned) result.limitations.push(`The picks leave out ${pruned} of the eight best-ranked crop${pruned > 1 ? 's' : ''} whose order after the previous crop a source advises against or repeats its crop family, as the year plan does; ${pruned > 1 ? 'they stay' : 'it stays'} in the ranking.`);
    result.picks = deterministicPicks(pool);
    result.pickOrigin = 'deterministic';
    result.summary = `${result.candidates.length} crops scored by code for ${sowingText}, ranked by ${rankedBy}; the top three are picked by rank.${tail}`.slice(0, 600);
    await save('running', false);
    // ---- Meta picks
    if (pool.length <= 3) { result.limitations.push(`${pruned ? 'Three or fewer crops are eligible for the picks' : 'Three or fewer crops fit this date'}, so no model selection was needed; the picks are calculated.`); return finish('ready'); }
    if (!live) { result.limitations.push('Meta is not used in this runtime mode; the picks are calculated.'); return finish('ready'); }
    if (!deps.config.MODEL_API_KEY && !deps.provider) { result.limitations.push(`${MODEL_UNAVAILABLE}: Meta is not configured on this server; the picks are calculated.`); return finish('ready'); }
    const session = row.session_id ? (await deps.pool.query('SELECT id FROM sessions WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND expires_at>now()', [row.session_id, ownerId])).rows[0] : null;
    if (!session || (await isCancelled())) { result.limitations.push(`${MODEL_UNAVAILABLE}: the requesting session expired before the model call; the picks are calculated.`); return finish('ready'); }
    if ((await fitContext(deps, ownerId, row.farm_id, rawOf(c.request, c.fieldId))).hash !== row.context_hash) {
      result.stale = true; result.picks = []; result.candidates = []; result.summary = 'Farm inputs changed while the review was being built. Ask again for a fresh review.';
      return finish('error');
    }
    const field: PickField = { stateId: c.ctx.stateId, districtId: c.ctx.districtId, irrigation: c.ctx.scenario.irrigationCategory, previousCropId: result.previousCropId, mode: c.request.mode, resolvedSowing: result.resolvedSowing, soilReportStatus: c.soilReportStatus };
    const sel = await picksWithMeta(deps, { farmId: row.farm_id, reviewId, ownerId, sessionId: row.session_id, field, pool });
    stored.meta = { failure: sel.failure, dispatched: sel.dispatched, model: sel.model, costUsd: sel.costUsd, usage: sel.usage };
    result.picks = sel.picks;
    result.pickOrigin = sel.origin;
    if (sel.origin === 'model') result.summary = `Meta picked three of the top eight of ${result.candidates.length} crops scored by code for ${sowingText} (ranked by ${rankedBy}) and explained each from the code facts.${tail}`.slice(0, 600);
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
