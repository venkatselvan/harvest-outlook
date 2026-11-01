import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { YearPlanOption, YearPlanReview, type ApplyYearPlan, type FarmWorkspace, type HarvestPriceOutlook, type ModelInvocation, type NeighbourhoodSeasonality, type RescoreYearPlan, type YearPlanScenario } from '@harvest/contracts';
import type { Config } from '../../config';
import { withTransaction, type Pool } from '../../db/pool';
import { REPO_ROOT } from '../../catalogue/files';
import { getFarm } from '../farms';
import { getWorkspace, putWorkspace } from '../workspace';
import { enqueue } from '../jobs';
import { ApiError, notFound } from '../errors';
import { payloadHash } from '../hash';
import type { Budget } from '../budget';
import type { TextModelProvider } from '../../agent/provider';
import { harvestPriceOutlook, type HarvestPriceOutlookArgs } from '../price-series';
import { createWeatherSource } from '../../plans/adapters/weather-source';
import type { ClimatologyBundle, WeatherScope } from '../../plans/sources';
import { farmSoilMarkers, planningMeasuredPh } from '../soil-reports';
import * as soilRatings from '../soil-ratings';
import { compareSoil, hasConfirmedMarkers, soilFacts, type RateMarkerFn } from '../crop-fit/soil-compare';
import { neighbourhoodSeasonality } from '../today/ndvi';
import * as data from './data';
import { addDays, monthOf, overlaps } from './dates';
import { buildScenario, HorizonError, MAX_YEAR_INDEX, monthYear, occupancyFor, type AssumedPredecessorInput, type TimelineFn } from './scenario';
import { ASSUMPTIONS, type SoilCheckLite } from './scoring';
import { stageTimeline } from '../today/stage-timeline';
import { enumerateCandidates, shortHash, type CandidateSet } from './candidates';
import { cropSignature, distinctOptions, editInputKeys, rescoreOption, runInputKeys, runYearPlanEngine, type ScoringNorm } from './assemble';
import { emptyInputs, monthlyRainFromDaily, slotPriceKey, type Inputs, type PriceInputKey } from './inputs';
import type { EngineContext } from './types';
import { appendBestProfitOption, appendGreenManureOption, deterministicSelection, labelAdjustedNote, selectionCandidates, selectWithMeta, type LabelAdjustment } from './select';

/**
 * Persisted year-plan review (Stream A packet 2): context hash -> job farm.year-plan -> prefetch inputs -> deterministic
 * engine -> constrained Meta selection (deterministic fallback, status partial) -> rescore and apply.
 *
 * Edited options: a rescore returns the option with optionId "<base optionId>:edit" and stores it (with the edits) under
 * input_context.edits["<base>:edit"]; ApplyYearPlan carries no slots, so apply resolves a ":edit" optionId from that store.
 * Rescoring "<base>:edit" again replaces the stored edit of the same base option.
 */
/** Part of the context hash: reviews stored under an older version are stale and rebuilt on the next ensure. */
export const ENGINE_VERSION = 'year-plan-v5-2026-11-01';
export const JOB_TYPE = 'farm.year-plan';
export const EDIT_SUFFIX = ':edit';
/**
 * Harvest-price lookups per review (bounded 4 at a time). Measured 2026-11-01: Hassan fresh needs 102 keys (2.4 s for
 * 60) and Coimbatore fresh 66; at 60 the cap dropped sowing dates and starved data-poor farms of candidates, so it was
 * raised to 160 (2026-11-01) to cover both measured farms in full.
 */
export const PRICE_LOOKUP_CAP = 160;
const WEIGHTS = { price: 40, yield: 30, soilRotation: 15, water: 10, confidence: 5 } as const;
/** Row columns; horizon_from (migration 0033) is read as text so a date never shifts with the server time zone. */
const COLS = '*, horizon_from::text AS horizon_from_text';

export interface YearPlanDeps {
  pool: Pool;
  config: Config;
  budget: Budget;
  provider?: TextModelProvider | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
  priceLookupCap?: number | undefined;
  /** Stage timeline for the current crop's harvest window (default: the Today view's `stageTimeline`). */
  timeline?: TimelineFn | undefined;
  sources?: {
    priceOutlook?: ((args: HarvestPriceOutlookArgs) => Promise<HarvestPriceOutlook>) | undefined;
    climatology?: ((scope: WeatherScope, range: { start: string; end: string }) => Promise<ClimatologyBundle | null>) | undefined;
    neighbourhood?: ((ownerId: string, farmId: string) => Promise<NeighbourhoodSeasonality>) | undefined;
  } | undefined;
}
type Farm = NonNullable<Awaited<ReturnType<typeof getFarm>>>;
export interface YearPlanContext {
  hash: string; asOf: string; farmId: string; farmVersion: number; workspaceVersion: number;
  ctx: EngineContext; set: CandidateSet; farm: Farm; soilPh: number | undefined; soilSummary: string;
  /** Round 3: null for the current horizon (rows store NULL), else the later horizon's start (horizon_from). */
  horizonFrom: string | null;
  /** Round 3 yield v2: confirmed soil checks per crop at its regional yield (null without a confirmed report). */
  soilChecks: (cropId: string, yieldP50: number | null) => SoilCheckLite[] | null;
  /**
   * Review MEDIUM-2 (2026-11-01): the hash without the IST day. Stored in input_context.chainHash; the next horizon finds
   * its assumed predecessor by it, so a plan year made on an earlier day still anchors the following year while the
   * field's inputs are unchanged.
   */
  chainHash: string;
  /** The previous horizon's first plan this context follows (later horizons only); kept when an apply re-keys the row. */
  assumedInput: AssumedPredecessorInput | null;
}
interface InputsSummary {
  annualMeans: Record<string, number>; climatologyRainByMonth: number[] | null; climatologySource: { sourceId: string; years: { from: number; to: number } } | null;
  soilPh: number | null; neighbourhoodActiveMonths: number[] | null; neighbourhoodObservedMonths: number[] | null;
  priceKeys: { needed: number; looked: number; available: number; failed: number };
}
interface StoredEdit { baseOptionId: string; slots: RescoreYearPlan['slots']; option: YearPlanOption; at: string }
interface StoredContext {
  asOf: string; scenario: YearPlanScenario; candidateIds: string[]; norm: ScoringNorm | null; inputs: InputsSummary | null;
  slotSeasons?: Record<string, string>; meta?: { failure: string | null; dispatched: boolean; model: string | null; costUsd: number | null; usage: { inputTokens: number; outputTokens: number } | null; labelAdjusted?: LabelAdjustment[] } | null;
  edits?: Record<string, StoredEdit>;
  /** YearPlanContext.chainHash at insert (absent on rows written before 2026-11-01 review fixes). */
  chainHash?: string;
}
interface Row {
  id: string; owner_id: string; farm_id: string; mode: string; context_hash: string; input_context: StoredContext; result: YearPlanReview;
  status: YearPlanReview['status']; job_id: string | null; attempt: number; session_id: string | null; updated_at: Date; created_at: Date;
  horizon_from_text: string | null;
}

/** Result summaries written when the farm inputs changed under a plan; a retry cannot help them, so ensure restarts at once. */
export const INPUTS_CHANGED_BEFORE_START = 'Farm inputs changed before this plan began.';
export const INPUTS_CHANGED_WHILE_BUILDING = 'Farm inputs changed while the plan was being built.';
const isContextMismatch = (r: Row): boolean => r.status === 'error' && [INPUTS_CHANGED_BEFORE_START, INPUTS_CHANGED_WHILE_BUILDING].some((s) => r.result.summary.startsWith(s));

export const todayIst = (d: Date): string => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const nowOf = (deps: YearPlanDeps) => (deps.now ?? (() => new Date()))();
const fileHashes = new Map<string, string>();
function fileHash(rel: string): string {
  const p = resolve(REPO_ROOT, rel);
  const st = statSync(p);
  const k = `${p}|${st.mtimeMs}|${st.size}`;
  let h = fileHashes.get(k);
  if (!h) { h = createHash('sha256').update(readFileSync(p)).digest('hex'); fileHashes.set(k, h); }
  return h;
}

type ContextDeps = Pick<YearPlanDeps, 'pool' | 'config'> & { timeline?: TimelineFn | undefined };
interface ContextBase { farm: Farm; workspace: FarmWorkspace; soil: Awaited<ReturnType<typeof farmSoilMarkers>>; soilPh: number | undefined; soilSummary: string }
async function loadBase(deps: ContextDeps, ownerId: string, farmId: string): Promise<ContextBase> {
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const workspace = await getWorkspace(deps.pool, ownerId, farmId);
  const soil = await farmSoilMarkers(deps, ownerId, farmId);
  const soilPh = planningMeasuredPh(soil);
  const n = soil.samples.length;
  const soilSummary = !n ? 'No confirmed soil report for this field.' : soilPh !== undefined ? `Confirmed laboratory soil pH ${soilPh} (${n} confirmed sample${n > 1 ? 's' : ''}).` : `${n} confirmed soil sample${n > 1 ? 's' : ''}; no single compatible laboratory pH.`;
  return { farm, workspace, soil, soilPh, soilSummary };
}
/** The soil ratings module's assumed-pool rater when it exists (same choice as crop fit). */
function rateMarker(): RateMarkerFn {
  const assumed = (soilRatings as Record<string, unknown>).rateMarkerAssumed;
  return (typeof assumed === 'function' ? assumed : soilRatings.rateMarker) as RateMarkerFn;
}
const YIELD_SOIL_KEYS = new Set(['n', 'p', 'k', 'ph']);
/** Yield v2 soil checks (ROUND3_SPEC 4 item 2): compareSoil over the confirmed N, P2O5, K2O and pH facts, memoised per crop and yield. */
export function soilChecksOf(soil: ContextBase['soil']): { fn: (cropId: string, yieldP50: number | null) => SoilCheckLite[] | null; digest: unknown } {
  if (!hasConfirmedMarkers(soil)) return { fn: () => null, digest: null };
  let facts: ReturnType<typeof soilFacts> = [];
  try { facts = soilFacts(soil, rateMarker()).filter((x) => YIELD_SOIL_KEYS.has(x.def.key)); } catch { facts = []; }
  const memo = new Map<string, SoilCheckLite[]>();
  const fn = (cropId: string, yieldP50: number | null): SoilCheckLite[] | null => {
    const k = `${cropId}|${yieldP50 ?? ''}`;
    let v = memo.get(k);
    if (!v) {
      const ph = data.phRange(cropId);
      v = compareSoil(facts, soil, { cropId, cropName: data.cropDisplayName(cropId), yieldKgPerHa: yieldP50, phRange: ph ? { min: ph.min, max: ph.max, source: ph.source ?? 'cited range' } : null }).checks.map((c) => ({ key: c.parameter, label: c.label, verdict: c.verdict }));
      memo.set(k, v);
    }
    return v;
  };
  return { fn, digest: facts.map((x) => [x.def.key, x.marker.id, x.marker.canonical.value, x.rated.rating]) };
}
function fileHashOrAbsent(rel: string): string { try { return fileHash(rel); } catch { return 'absent'; } }

/** The current horizon's start when `from` is a later horizon's start or the current one; HorizonError otherwise. */
function horizonKey(ctx: EngineContext): string | null { return (ctx.yearIndex ?? 0) > 0 ? ctx.horizon.from : null; }

/** Horizon paging for the review (ROUND3_SPEC 1.1 item 1). */
export function navigationOf(ctx: EngineContext): NonNullable<YearPlanReview['navigation']> {
  const hs = ctx.horizonStarts ?? { current: ctx.horizon, futures: [] };
  const starts = [hs.current.from, ...hs.futures];
  const k = ctx.yearIndex ?? 0;
  return { from: ctx.horizon.from, previousFrom: k > 0 ? starts[k - 1]! : null, nextFrom: k < MAX_YEAR_INDEX && starts[k + 1] ? starts[k + 1]! : null, yearIndex: k, maxYearIndex: MAX_YEAR_INDEX };
}

/** "Follows the Best overall plan for Oct 2026 to Oct 2027 (not saved yet; ...)" for a future horizon with an assumed predecessor. */
export function followsSentence(ctx: EngineContext): string | null {
  const a = ctx.scenario.assumedPredecessor;
  if (ctx.scenario.kind !== 'future' || !a || a.basis !== 'year_plan_option' || !a.horizonFrom) return null;
  return `Follows the ${a.optionLabel ?? 'first'} plan for ${monthYear(a.horizonFrom)} to ${monthYear(ctx.horizon.from)} (not saved yet; save a plan to fix the order).`;
}

/**
 * Farm, workspace, confirmed soil, scenario and candidates; the hash covers every material input (spec: cache by context hash).
 * Round 3: `horizonFrom` selects a later horizon (from_1..from_3; the current start or null = current). A later horizon whose
 * previous horizon has nothing recorded or saved follows that horizon's ready (or partial), non-stale review: the last slot
 * of its first option; the review id and that option's crop signature are hashed, so a changed year-1 plan makes year 2 stale.
 * Throws ApiError 400 validation_error for any other `from`.
 */
export async function yearPlanContext(deps: ContextDeps, ownerId: string, farmId: string, asOf: string, horizonFrom: string | null = null, opts: { candidates?: boolean; base?: ContextBase; keepAssumed?: AssumedPredecessorInput | null } = {}): Promise<YearPlanContext> {
  const base = opts.base ?? await loadBase(deps, ownerId, farmId);
  const { farm, workspace, soil, soilPh, soilSummary } = base;
  const facts = Object.fromEntries(Object.entries(farm.facts).map(([k, f]) => [k, { value: f.value, basis: f.basis, confirmed: f.confirmed }]));
  const scenarioArgs = { workspace, farm: { location: { stateCode: farm.location.stateCode, districtId: farm.location.districtId }, areaHectares: farm.areaHectares, facts }, asOf, soilSummary, timeline: deps.timeline ?? stageTimeline };
  let assumedPredecessor: AssumedPredecessorInput | null = null;
  if (horizonFrom) {
    const current = buildScenario(scenarioArgs);
    const starts = current.horizonStarts!;
    const k = starts.futures.indexOf(horizonFrom);
    if (horizonFrom === starts.current.from) horizonFrom = null;
    else if (k < 0) throw new ApiError(400, 'validation_error', `from must be the start of the current or a later plan year: ${[starts.current.from, ...starts.futures].join(', ')}`, { allowed: [starts.current.from, ...starts.futures] });
    else if (opts.keepAssumed !== undefined) {
      // Apply re-key (review MEDIUM-2): the row keeps the predecessor it was built with instead of a fresh lookup.
      assumedPredecessor = opts.keepAssumed;
    } else {
      const prevFrom = k === 0 ? null : starts.futures[k - 1]!;
      const prev = await yearPlanContext(deps, ownerId, farmId, asOf, prevFrom, { candidates: false, base });
      // Matched on the day-free chain hash (rows written before it existed: the full hash), newest first.
      const row = (await deps.pool.query<Row>(`SELECT ${COLS} FROM farm_year_plans WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND (input_context->>'chainHash'=$6 OR context_hash=$4) AND archived_at IS NULL AND horizon_from IS NOT DISTINCT FROM $5::date AND status IN ('ready','partial') ORDER BY created_at DESC LIMIT 1`, [farmId, ownerId, deps.config.RUNTIME_MODE, prev.hash, prevFrom, prev.chainHash])).rows[0];
      const first = row?.result.options[0];
      const last = first ? (first.slots.filter((x) => !x.fixed).at(-1) ?? first.slots.at(-1)) : undefined;
      if (row && first && last) assumedPredecessor = { cropId: last.cropId, cropName: last.cropName, occupancy: { ...last.occupancy }, optionLabel: first.label, horizonFrom: prev.ctx.horizon.from, reviewId: row.id, signature: cropSignature(first) };
    }
  }
  let ctx: EngineContext;
  try { ctx = buildScenario({ ...scenarioArgs, horizonFrom, assumedPredecessor }); }
  catch (e) { if (e instanceof HorizonError) throw new ApiError(400, 'validation_error', e.message, { allowed: e.allowed }); throw e; }
  const set: CandidateSet = opts.candidates === false ? { candidates: [], skipped: [], notes: [] } : enumerateCandidates(ctx);
  const soilChecks = soilChecksOf(soil);
  // Review MEDIUM-2 (2026-11-01): the workspace part covers what this horizon reads, not the workspace version: every cycle
  // and the previous harvest (they fix the current horizon and so every later start), the boundary, and only the saved
  // seasons whose occupancy overlaps this horizon or, for a later horizon, the previous one (the predecessor rule reads
  // seasons ending there). Saving a later year's plan therefore leaves earlier years current.
  const stable = {
    v: ENGINE_VERSION, horizon: horizonKey(ctx), assumed: ctx.assumed ?? null, soilChecks: soilChecks.digest,
    farm: { location: farm.location, area: farm.areaHectares, facts: Object.fromEntries(Object.entries(farm.facts).map(([k, f]) => [k, { value: f.value, unit: f.unit, basis: f.basis, confirmed: f.confirmed }])) },
    workspace: { boundary: workspace.boundary, previousHarvest: workspace.previousHarvest, cycles: workspace.cycles, rotationPlans: relevantSeasons(workspace, ctx) },
    soilPh: soilPh ?? null,
    files: { pool: fileHash(data.DATA_FILES.pool), agronomy: fileHash(data.DATA_FILES.agronomy), yieldCost: fileHash(data.DATA_FILES.yieldCost), greenManure: fileHash(data.DATA_FILES.greenManure), intercropping: fileHashOrAbsent(data.DATA_FILES.intercropping) },
    mode: deps.config.RUNTIME_MODE, model: deps.config.META_TEXT_MODEL, keyAvailable: !!deps.config.MODEL_API_KEY,
  };
  // The IST day stays in the hash of every horizon: the engine reads the harvest-week price outlooks and the yield
  // references as of that day (data vintage), and earliestSowing uses it once it passes a horizon's start. The chain to the
  // next horizon uses the day-free hash instead.
  const material = { ...stable, day: asOf };
  return {
    hash: payloadHash(material), chainHash: payloadHash(stable), asOf, farmId, farmVersion: farm.version, workspaceVersion: workspace.version, ctx, set, farm, soilPh, soilSummary,
    horizonFrom: horizonKey(ctx), soilChecks: soilChecks.fn, assumedInput: ctx.assumed ? assumedPredecessor : null,
  };
}

/** Saved seasons the horizon reads: occupancy overlapping it (later horizons: from the previous horizon's start); undated ones always (they warn). */
function relevantSeasons(workspace: FarmWorkspace, ctx: EngineContext): FarmWorkspace['rotationPlans'] {
  const k = ctx.yearIndex ?? 0;
  const hs = ctx.horizonStarts ?? { current: ctx.horizon, futures: [] };
  const lo = k === 0 ? ctx.horizon.from : k === 1 ? hs.current.from : hs.futures[k - 2] ?? ctx.horizon.from;
  return workspace.rotationPlans.filter((p) => !p.plannedSowingDate || overlaps(p.plannedSowingDate, occupancyFor(p.cropId, p.productId ?? null, null, p.plannedSowingDate, p.plannedHarvestDate ?? null, ctx.stateId).to, lo, ctx.horizon.to));
}

/** Context of a stored row's horizon; a horizon that no longer exists (the field's dates moved) is a stale review. */
async function rowContext(deps: ContextDeps, ownerId: string, farmId: string, asOf: string, row: Pick<Row, 'horizon_from_text'>): Promise<YearPlanContext> {
  try { return await yearPlanContext(deps, ownerId, farmId, asOf, row.horizon_from_text ?? null); }
  catch (e) { if (e instanceof ApiError && e.code === 'validation_error') throw staleError(); throw e; }
}

function blank(c: YearPlanContext): YearPlanReview {
  return {
    reviewId: null, jobId: null, contextHash: c.hash, status: 'unavailable', stale: false, inputVersions: { farm: c.farmVersion, workspace: c.workspaceVersion },
    generatedAt: null, retryAfter: null, modelInvocation: null, scenario: { ...c.ctx.scenario, soilSummary: c.soilSummary }, weights: { ...WEIGHTS }, options: [], navigation: navigationOf(c.ctx),
    // Saved-season follow-up: null until the worker records how the options were chosen.
    modelSelection: null,
    candidatesConsidered: c.set.candidates.length, summary: c.horizonFrom ? 'No plan has been made for this year yet.' : 'No year plan has been made for this field yet.', limitations: c.ctx.warnings.filter((w) => w.startsWith('Nothing is recorded or saved')), appliedOptionIds: [],
  };
}

async function invocation(deps: Pick<YearPlanDeps, 'pool'>, row: Pick<Row, 'id' | 'owner_id' | 'result'>): Promise<ModelInvocation | null> {
  const f = (await deps.pool.query<{ id: string; requested_model: string; model: string | null; status: 'running' | 'succeeded' | 'failed'; started_at: Date; finished_at: Date | null }>(
    'SELECT id,requested_model,model,status,started_at,finished_at FROM ai_invocations WHERE owner_id=$1 AND purpose=$2 ORDER BY started_at DESC LIMIT 1', [row.owner_id, `year_plan_review/${row.id}`])).rows[0];
  return f ? { id: f.id, provider: 'meta', requestedModel: f.requested_model, model: f.model, purpose: 'year_plan_review', status: f.status, startedAt: f.started_at.toISOString(), finishedAt: f.finished_at?.toISOString() ?? null, processing: 'standard', requestedStorage: false, responseDeleted: row.result.modelInvocation?.responseDeleted ?? null } : null;
}

/**
 * Saved-season follow-up, review fix for `noFreeWindow`: true when the field would have at least one crop candidate (a green
 * manure alone can never be a plan) if nothing in `ctx.occupied` took its months: saved seasons, other recorded cycles and an
 * assumed previous-year plan. The fixed slot (growing crop) stays, so its months still count. earliestSowing is kept for the
 * current horizon (buildScenario never derives it from occupied intervals) and recomputed for a later horizon, where
 * futureScenario pushes it past intervals that started before the horizon: max(today, horizon start) without them. A later
 * horizon has no fixed slot; a growing crop that runs into it is one of its occupants and is left out like the others.
 */
export function fitsWithoutOccupants(ctx: EngineContext): boolean {
  const earliestSowing = (ctx.yearIndex ?? 0) > 0
    ? [ctx.asOf, ctx.horizon.from, ...(ctx.fixedSlot ? [ctx.fixedSlot.occupancy.to] : [])].sort().at(-1)!
    : ctx.earliestSowing;
  return enumerateCandidates({ ...ctx, occupied: [], earliestSowing }).candidates.some((x) => x.kind !== 'green_manure');
}

/**
 * Saved-season follow-up (docs/research/YEAR_PLAN_SAVED_SEASONS.md): a stored plan written before `scenario.occupied` existed
 * gets the occupants of the current context, but only while the row is current (a stale row's options were placed around
 * other occupants) and without the saved seasons this review's own apply created (they are the plan's slots, already drawn).
 * `modelSelection` is never invented for such rows; the web falls back to the option origins.
 */
function withOccupants(row: Row, c: YearPlanContext): YearPlanScenario {
  const sc = row.result.scenario;
  if (sc.occupied || row.context_hash !== c.hash) return sc;
  const own = `yearplan:${row.id}:`;
  return { ...sc, occupied: (c.ctx.scenario.occupied ?? []).filter((o) => !o.id.startsWith(own)) };
}

async function view(deps: Pick<YearPlanDeps, 'pool'>, row: Row, c: YearPlanContext): Promise<YearPlanReview> {
  const result = YearPlanReview.parse({ ...row.result, scenario: withOccupants(row, c), reviewId: row.id, jobId: row.job_id, contextHash: row.context_hash, status: row.status, stale: row.context_hash !== c.hash, navigation: navigationOf(c.ctx) });
  result.modelInvocation = (await invocation(deps, row)) ?? result.modelInvocation;
  if ((row.status === 'pending' || row.status === 'running') && row.job_id) {
    const job = (await deps.pool.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1 AND owner_id=$2', [row.job_id, row.owner_id])).rows[0];
    if (!job || ['failed', 'cancelled', 'succeeded'].includes(job.state)) { result.status = 'error'; result.summary = 'The planning job stopped before a plan was saved. Retry after the cooldown.'; }
  }
  return result;
}

export async function readYearPlan(deps: YearPlanDeps, ownerId: string, farmId: string, opts: { from?: string | undefined } = {}): Promise<YearPlanReview> {
  const c = await yearPlanContext(deps, ownerId, farmId, todayIst(nowOf(deps)), opts.from ?? null);
  // Rows written before round 3 have horizon_from NULL and count as the current horizon.
  const row = (await deps.pool.query<Row>(`SELECT ${COLS} FROM farm_year_plans WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND archived_at IS NULL AND horizon_from IS NOT DISTINCT FROM $5::date ORDER BY (context_hash=$4) DESC, created_at DESC LIMIT 1`, [farmId, ownerId, deps.config.RUNTIME_MODE, c.hash, c.horizonFrom])).rows[0];
  return row ? view(deps, row, c) : blank(c);
}

/**
 * Same hash -> the existing review; otherwise a pending review and one job (max_attempts 1). A provider error retries the
 * same row only after 15 minutes, at most 3 attempts. A row that failed because the farm inputs changed under it, or any
 * finished row when `force` is set (Refresh, Try again), is archived and replaced by a fresh review at once; a plan that
 * is still being built is never replaced.
 */
export async function ensureYearPlan(deps: YearPlanDeps, auth: { ownerId: string; sessionId: string | null }, farmId: string, opts: { force?: boolean; from?: string | undefined } = {}): Promise<YearPlanReview> {
  const c = await yearPlanContext(deps, auth.ownerId, farmId, todayIst(nowOf(deps)), opts.from ?? null);
  const mode = deps.config.RUNTIME_MODE;
  const id = await withTransaction(deps.pool, async (tx) => {
    const owned = await tx.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE', [farmId, auth.ownerId]);
    if (!owned.rowCount) throw notFound('Farm');
    let existing: Row | undefined = (await tx.query<Row>(`SELECT ${COLS} FROM farm_year_plans WHERE farm_id=$1 AND mode=$2 AND context_hash=$3 AND archived_at IS NULL FOR UPDATE`, [farmId, mode, c.hash])).rows[0];
    if (existing) {
      const jobState = existing.job_id ? (await tx.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [existing.job_id])).rows[0]?.state : null;
      if (['pending', 'running'].includes(existing.status) && ['failed', 'cancelled', 'succeeded'].includes(jobState ?? '')) existing.status = 'error';
      if (isContextMismatch(existing) || (opts.force === true && !['pending', 'running'].includes(existing.status))) {
        await tx.query('UPDATE farm_year_plans SET archived_at=now() WHERE id=$1', [existing.id]);
        existing = undefined;
      }
    }
    if (existing) {
      const ended = existing.status === 'error' || (existing.status === 'partial' && existing.result.retryAfter !== null);
      if (!(ended && existing.attempt < 3 && Date.now() - existing.updated_at.getTime() > 15 * 60_000)) return existing.id;
      const q = await enqueue(tx, JOB_TYPE, { reviewId: existing.id, farmId, sessionId: auth.sessionId }, auth.ownerId, `yearplan:${existing.id}:${existing.attempt + 1}`);
      await tx.query('UPDATE jobs SET max_attempts=1 WHERE id=$1', [q.job.id]);
      await tx.query("UPDATE farm_year_plans SET status='pending',session_id=$2,job_id=$3,attempt=attempt+1,started_at=NULL,finished_at=NULL WHERE id=$1", [existing.id, auth.sessionId, q.job.id]);
      return existing.id;
    }
    const reviewId = randomUUID();
    const result = { ...blank(c), reviewId, status: 'pending' as const, summary: 'Building crop sequences for this field.' };
    const stored: StoredContext = { asOf: c.asOf, scenario: result.scenario, candidateIds: [], norm: null, inputs: null, chainHash: c.chainHash };
    const ins = await tx.query("INSERT INTO farm_year_plans(id,owner_id,farm_id,session_id,mode,context_hash,input_versions,input_context,result,status,horizon_from) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,'pending',$10::date) ON CONFLICT (farm_id,mode,context_hash) WHERE archived_at IS NULL DO NOTHING RETURNING id",
      [reviewId, auth.ownerId, farmId, auth.sessionId, mode, c.hash, JSON.stringify(result.inputVersions), JSON.stringify(stored), JSON.stringify(result), c.horizonFrom]);
    if (!ins.rowCount) return (await tx.query<{ id: string }>('SELECT id FROM farm_year_plans WHERE farm_id=$1 AND mode=$2 AND context_hash=$3 AND archived_at IS NULL', [farmId, mode, c.hash])).rows[0]!.id;
    const q = await enqueue(tx, JOB_TYPE, { reviewId, farmId, sessionId: auth.sessionId }, auth.ownerId, `yearplan:${reviewId}:1`);
    await tx.query('UPDATE jobs SET max_attempts=1 WHERE id=$1', [q.job.id]);
    await tx.query('UPDATE farm_year_plans SET job_id=$2 WHERE id=$1', [reviewId, q.job.id]);
    return reviewId;
  });
  const row = (await deps.pool.query<Row>(`SELECT ${COLS} FROM farm_year_plans WHERE id=$1 AND owner_id=$2`, [id, auth.ownerId])).rows[0]!;
  return view(deps, row, c);
}

async function mapLimit<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}

/** At most `cap` keys: priority keys first, then a round-robin quota per product with evenly spaced harvest weeks. */
export function spreadKeys(keys: readonly PriceInputKey[], cap: number, priority: readonly string[] = []): PriceInputKey[] {
  if (keys.length <= cap) return [...keys];
  const chosen = keys.filter((k) => priority.includes(k.key)).slice(0, cap);
  const groups = new Map<string, PriceInputKey[]>();
  for (const k of [...keys].sort((a, b) => a.harvestDate.localeCompare(b.harvestDate) || a.key.localeCompare(b.key))) {
    if (chosen.some((c) => c.key === k.key)) continue;
    groups.set(k.productId, [...(groups.get(k.productId) ?? []), k]);
  }
  const names = [...groups.keys()].sort();
  const quota = new Map(names.map((p) => [p, 0]));
  let budget = cap - chosen.length;
  while (budget > 0 && names.some((p) => quota.get(p)! < groups.get(p)!.length)) {
    for (const p of names) { if (budget <= 0) break; if (quota.get(p)! < groups.get(p)!.length) { quota.set(p, quota.get(p)! + 1); budget--; } }
  }
  for (const p of names) {
    const list = groups.get(p)!, q = quota.get(p)!;
    const idx = q === 1 ? [Math.floor((list.length - 1) / 2)] : Array.from({ length: q }, (_, i) => Math.round((i * (list.length - 1)) / (q - 1)));
    for (const i of new Set(idx)) chosen.push(list[i]!);
  }
  return chosen.sort((a, b) => a.key.localeCompare(b.key));
}

async function fetchOutlooks(deps: YearPlanDeps, c: YearPlanContext, keys: readonly PriceInputKey[]): Promise<{ map: Map<string, HarvestPriceOutlook>; failed: number }> {
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

/** Worker body: inputs -> engine -> Meta selection (or deterministic) -> persist. Provider problems never throw. */
export async function generateYearPlan(deps: YearPlanDeps, reviewId: string, ownerId: string, isCancelled: () => Promise<boolean> = async () => false) {
  const row = (await deps.pool.query<Row>(`SELECT ${COLS} FROM farm_year_plans WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL`, [reviewId, ownerId])).rows[0];
  if (!row) return { status: 'cancelled', reason: 'review_missing' };
  if (row.status !== 'pending') return { status: row.status, reason: 'already_claimed' };
  const now = nowOf(deps);
  let c: YearPlanContext;
  try { c = await yearPlanContext(deps, ownerId, row.farm_id, todayIst(now), row.horizon_from_text ?? null); }
  catch (e) {
    if (!(e instanceof ApiError && e.code === 'validation_error')) throw e;
    // The horizon no longer exists for this field (its dates moved): close the row as changed inputs.
    await deps.pool.query("UPDATE farm_year_plans SET status='error',result=jsonb_set(result,'{summary}',to_jsonb($3::text)),finished_at=now() WHERE id=$1 AND owner_id=$2", [reviewId, ownerId, `${INPUTS_CHANGED_BEFORE_START} Ask for a new plan.`]);
    return { status: 'error', reviewId };
  }
  const result: YearPlanReview = { ...blank(c), reviewId: row.id, jobId: row.job_id, contextHash: row.context_hash, status: 'error', appliedOptionIds: row.result.appliedOptionIds ?? [] };
  const stored: StoredContext = { ...row.input_context };
  // Round 2: green-manure-first sequences from the engine run; finish() appends the fourth plan once (ROUND2_SPEC 1.2 item 5).
  let greenManureFirst: YearPlanOption[] | null = null;
  // Round 3: the shortlist the Best profit plan is drawn from (ROUND3_SPEC 6); appended before the green manure plan.
  let bestProfitPool: YearPlanOption[] | null = null;
  const finish = async () => {
    if (bestProfitPool && result.options.length && result.status !== 'error') {
      const bp = appendBestProfitOption(result.options, bestProfitPool);
      result.options = bp.options;
      if (bp.limitation) result.limitations.push(bp.limitation);
      bestProfitPool = null;
    }
    if (greenManureFirst && result.options.length && result.status !== 'error') {
      const fourth = appendGreenManureOption(result.options, greenManureFirst);
      result.options = fourth.options;
      if (fourth.limitation) result.limitations.push(fourth.limitation);
      greenManureFirst = null;
    }
    const follows = followsSentence(c.ctx);
    if (follows && result.status !== 'error' && !result.summary.startsWith(follows)) result.summary = `${follows} ${result.summary}`.slice(0, 1000);
    result.generatedAt = new Date().toISOString();
    await deps.pool.query('UPDATE farm_year_plans r SET status=$3,result=$4::jsonb,input_context=$5::jsonb,finished_at=now() FROM farms f WHERE r.id=$1 AND r.owner_id=$2 AND f.id=r.farm_id AND f.owner_id=$2 AND f.deleted_at IS NULL AND r.archived_at IS NULL',
      [reviewId, ownerId, result.status, JSON.stringify(YearPlanReview.parse(result)), JSON.stringify(stored)]);
    return { status: result.status, reviewId };
  };
  if (c.hash !== row.context_hash) { result.stale = true; result.summary = `${INPUTS_CHANGED_BEFORE_START} Ask for a new plan.`; return finish(); }
  const claimed = await deps.pool.query("UPDATE farm_year_plans SET status='running',started_at=now() WHERE id=$1 AND owner_id=$2 AND status='pending' RETURNING id", [reviewId, ownerId]);
  if (!claimed.rowCount) return { status: 'cancelled', reason: 'already_claimed' };
  if (await isCancelled()) { result.summary = 'The plan was cancelled.'; return finish(); }
  const live = deps.config.RUNTIME_MODE === 'live';
  const limitations: string[] = [];
  try {
    // ---- inputs (code-gathered; a missing input lowers scores and is flagged, never filled in)
    const allKeys = runInputKeys(c.ctx, c.set);
    const cap = deps.priceLookupCap ?? PRICE_LOOKUP_CAP;
    const fixedKey = c.ctx.fixedSlot ? slotPriceKey(c.ctx.fixedSlot) : null;
    const keys = spreadKeys(allKeys, cap, fixedKey ? [fixedKey] : []);
    const inputs: Inputs = emptyInputs(c.asOf, c.ctx.irrigation);
    inputs.soilChecks = c.soilChecks;
    const fetched = await fetchOutlooks(deps, c, keys);
    inputs.priceOutlooks = fetched.map;
    annualMeansOf(fetched.map, inputs.annualMeans);
    const looked = new Set(keys.map((k) => k.key));
    // Green manure candidates need no price lookup and are always kept.
    const set: CandidateSet = keys.length < allKeys.length ? { ...c.set, candidates: c.set.candidates.filter((x) => x.kind === 'green_manure' || looked.has(slotPriceKey(x))) } : c.set;
    if (keys.length < allKeys.length) limitations.push(`Price lookups are capped at ${cap} per plan: ${keys.length} of ${allKeys.length} crop and harvest-week combinations were looked up, spread evenly across crops; sowing dates whose harvest week was not looked up were left out.`);
    if (fetched.failed) limitations.push(`${fetched.failed} harvest-week price lookups failed and score no price.`);
    const point = c.farm.location.lat !== null && c.farm.location.lon !== null ? { lat: c.farm.location.lat, lon: c.farm.location.lon } : null;
    if (point) {
      try {
        const scope: WeatherScope = { farmId: c.farmId, districtId: c.farm.location.districtId, stateId: c.farm.location.stateCode, point: { lon: point.lon, lat: point.lat } };
        const range = { start: c.ctx.horizon.from, end: addDays(c.ctx.horizon.to, -1) };
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
    // ---- engine
    const run = runYearPlanEngine(c.ctx, inputs, { candidateSet: set });
    // Saved-season follow-up: no sequence fits and the growing crop or saved seasons take the horizon (the fixed-slot-only
    // plan, or 'unavailable' when there is no growing crop). Review fix: only when the occupants are the cause, i.e. the
    // field would have a crop candidate without them; a farm with no state, every crop excluded or no matching window is not
    // "full". The counterfactual is checked only when the first two conditions hold (candidates only, no sequences).
    result.noFreeWindow = run.sequencesConsidered === 0 && c.ctx.occupied.length > 0 && fitsWithoutOccupants(c.ctx);
    greenManureFirst = run.greenManureFirst;
    bestProfitPool = run.shortlist;
    const seasons = new Map<string, string>(set.candidates.map((x) => [`slot-${shortHash(x.candidateId)}`, x.season]));
    const slotSeasons: Record<string, string> = {};
    for (const o of run.shortlist) for (const s of o.slots) { const season = seasons.get(s.slotId); if (season) slotSeasons[s.slotId] = season; }
    const available = [...fetched.map.values()].filter((o) => o.status === 'available').length;
    stored.asOf = c.asOf;
    stored.candidateIds = set.candidates.map((x) => x.candidateId);
    stored.norm = run.norm;
    stored.slotSeasons = slotSeasons;
    stored.inputs = {
      annualMeans: Object.fromEntries(inputs.annualMeans), climatologyRainByMonth: inputs.climatologyRainByMonth, climatologySource: inputs.climatologySource ?? null, soilPh: c.soilPh ?? null,
      neighbourhoodActiveMonths: inputs.neighbourhoodActiveMonths, neighbourhoodObservedMonths: inputs.neighbourhoodObservedMonths ?? null,
      priceKeys: { needed: allKeys.length, looked: keys.length, available, failed: fetched.failed },
    };
    result.scenario = { ...c.ctx.scenario, soilSummary: c.soilSummary, neighbourhoodActiveMonths: inputs.neighbourhoodActiveMonths };
    stored.scenario = result.scenario;
    result.candidatesConsidered = set.candidates.length;
    result.limitations = [...run.limitations, ...limitations].map((x) => x.slice(0, 1000));
    if (!run.shortlist.length) { result.status = 'unavailable'; result.summary = 'No crop sequence fits the free months of this field with sourced sowing windows.'; return finish(); }
    // ---- selection
    const candidates = selectionCandidates(run.shortlist);
    result.options = deterministicSelection(candidates);
    result.status = 'partial';
    result.summary = 'Plans picked and labelled by code from the scored crop sequences; every date, range and score is calculated.';
    if (candidates.length < 3) {
      result.status = 'ready';
      result.modelSelection = { outcome: 'not_needed', detail: null };
      const distinct = distinctOptions(run.options).length;
      result.limitations.push(distinct > candidates.length
        ? 'Fewer than three crop sequences keep the field in use for enough of the year (at least 40 percent of the horizon, or a score within 70 percent of the best plan), so fewer plans are shown and no model selection was needed.'
        : 'Fewer than three distinct crop sequences fit this field, so no model selection was needed.');
      return finish();
    }
    if (!live || (!deps.config.MODEL_API_KEY && !deps.provider)) { result.modelSelection = { outcome: live ? 'not_configured' : 'not_used', detail: null }; result.limitations.push(live ? 'Meta is not configured; the plans were picked and labelled by code.' : 'Meta is not used in this runtime mode; the plans were picked and labelled by code.'); return finish(); }
    const session = row.session_id ? (await deps.pool.query('SELECT id FROM sessions WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND expires_at>now()', [row.session_id, ownerId])).rows[0] : null;
    if (!session || (await isCancelled())) { result.modelSelection = { outcome: 'cancelled', detail: null }; result.limitations.push('The requesting session expired or the request was cancelled before the model call; the plans were picked by code.'); return finish(); }
    if ((await yearPlanContext(deps, ownerId, row.farm_id, c.asOf, c.horizonFrom, { candidates: false })).hash !== row.context_hash) { result.status = 'error'; result.stale = true; result.options = []; result.summary = `${INPUTS_CHANGED_WHILE_BUILDING} Ask for a new plan.`; return finish(); }
    const sel = await selectWithMeta(deps, { reviewId, ownerId, sessionId: row.session_id, scenario: result.scenario, candidates });
    stored.meta = { failure: sel.failure, dispatched: sel.dispatched, model: sel.model, costUsd: sel.costUsd, usage: sel.usage, labelAdjusted: sel.labelAdjusted };
    result.modelSelection = sel.origin === 'model' ? { outcome: 'model', detail: null } : { outcome: 'failed', detail: (sel.failure ?? 'unknown').slice(0, 200) };
    if (sel.origin === 'model') {
      result.options = sel.options;
      result.status = 'ready';
      result.summary = sel.labelAdjusted.length
        ? 'Meta chose three of the code-scored crop sequences and wrote one sentence each; code replaced a label Meta proposed that the plan does not support. Every date, range and score is calculated by code.'
        : 'Meta chose and labelled three of the code-scored crop sequences and wrote one sentence each; every date, range and score is calculated by code.';
      const note = labelAdjustedNote(sel.labelAdjusted);
      if (note) result.limitations.push(note.slice(0, 1000));
    } else {
      result.retryAfter = new Date(Date.now() + 15 * 60_000).toISOString();
      result.limitations.push(`Meta selection was unavailable or failed the checks (${sel.failure ?? 'unknown'}); the plans were picked and labelled by code. A retry is allowed after the cooldown.`);
    }
    result.modelInvocation = await invocation(deps, { id: row.id, owner_id: ownerId, result: { ...result, modelInvocation: null } });
    if (result.modelInvocation) result.modelInvocation.responseDeleted = sel.responseDeleted;
    return finish();
  } catch (e) {
    result.status = 'error';
    result.options = [];
    result.retryAfter = new Date(Date.now() + 15 * 60_000).toISOString();
    result.summary = 'The year plan could not be built right now. Retry after the cooldown.';
    result.limitations.push(`Internal error while building the plan (${(e as Error).name}).`);
    return finish();
  }
}

async function loadRow(deps: YearPlanDeps, ownerId: string, farmId: string, reviewId: string): Promise<Row> {
  const row = (await deps.pool.query<Row>(`SELECT ${COLS} FROM farm_year_plans WHERE id=$1 AND farm_id=$2 AND owner_id=$3 AND mode=$4 AND archived_at IS NULL`, [reviewId, farmId, ownerId, deps.config.RUNTIME_MODE])).rows[0];
  if (!row) throw notFound('Year plan');
  if (!['ready', 'partial'].includes(row.status)) throw new ApiError(409, 'review_not_ready', 'Wait for the year plan to finish first');
  return row;
}
const staleError = () => new ApiError(409, 'review_stale', 'Farm inputs changed since this plan was made; refresh the plan first');

function restoreInputs(sc: StoredContext, asOf: string, ctx: EngineContext, soilChecks?: YearPlanContext['soilChecks']): Inputs {
  const i = emptyInputs(asOf, ctx.irrigation);
  i.soilChecks = soilChecks ?? null;
  const s = sc.inputs;
  if (s) {
    i.annualMeans = new Map(Object.entries(s.annualMeans));
    i.climatologyRainByMonth = s.climatologyRainByMonth;
    i.climatologySource = s.climatologySource;
    i.soilPh = s.soilPh ?? undefined;
    i.neighbourhoodActiveMonths = s.neighbourhoodActiveMonths;
    i.neighbourhoodObservedMonths = s.neighbourhoodObservedMonths;
  }
  return i;
}

/**
 * Round 3 (ROUND3_SPEC.md section 7): the engine context, restored inputs and stored normaliser of the farm's current
 * ready (or partial) review, for one-off slot evaluations outside the plan (the season preview). The price outlooks are
 * not restored (the caller fetches the keys it needs); null when no finished review matches the current inputs.
 */
export async function storedEngineInputs(deps: YearPlanDeps, ownerId: string, farmId: string, horizonFrom: string | null = null, opts: { forDate?: string | undefined } = {}): Promise<{ ctx: EngineContext; inputs: Inputs; norm: ScoringNorm | null; reviewId: string; asOf: string; horizonFrom: string | null } | null> {
  const asOf = todayIst(nowOf(deps));
  let c = await yearPlanContext(deps, ownerId, farmId, asOf, opts.forDate ? null : horizonFrom, { candidates: false });
  // Review MEDIUM-4 (2026-11-01): `forDate` (a season's sowing date) picks the horizon whose start is at or before it.
  if (opts.forDate) { const from = horizonStartFor(c.ctx, opts.forDate); if (from) c = await yearPlanContext(deps, ownerId, farmId, asOf, from, { candidates: false }); }
  // Same inputs on an earlier day (chain hash) also count: the stored rain normals, soil pH and price scale do not depend
  // on the day, and the caller looks up the prices it needs as of today.
  const row = (await deps.pool.query<Row>(`SELECT ${COLS} FROM farm_year_plans WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND (context_hash=$4 OR input_context->>'chainHash'=$6) AND archived_at IS NULL AND horizon_from IS NOT DISTINCT FROM $5::date AND status IN ('ready','partial') ORDER BY (context_hash=$4) DESC, created_at DESC LIMIT 1`, [farmId, ownerId, deps.config.RUNTIME_MODE, c.hash, c.horizonFrom, c.chainHash])).rows[0];
  if (!row) return null;
  return { ctx: c.ctx, inputs: restoreInputs(row.input_context, c.asOf, c.ctx, c.soilChecks), norm: row.input_context.norm ?? null, reviewId: row.id, asOf: c.asOf, horizonFrom: c.horizonFrom };
}

/**
 * The start of the latest plan horizon that begins on or before `date`, walking the navigation chain from the current
 * horizon (its `to`, then one-year steps, at most MAX_YEAR_INDEX); null for the current horizon (and for earlier dates).
 */
export function horizonStartFor(ctx: EngineContext, date: string): string | null {
  const futures = (ctx.horizonStarts?.futures ?? []).slice(0, MAX_YEAR_INDEX);
  let out: string | null = null;
  for (const f of futures) if (f <= date) out = f;
  return out;
}

/** Farmer edit: code re-scores on the review's stored norm (no model call); returns "<base>:edit" with origin farmer_edit. */
export async function rescoreYearPlan(deps: YearPlanDeps, ownerId: string, farmId: string, body: RescoreYearPlan): Promise<YearPlanOption> {
  const row = await loadRow(deps, ownerId, farmId, body.reviewId);
  const c = await rowContext(deps, ownerId, farmId, todayIst(nowOf(deps)), row);
  if (c.hash !== row.context_hash) throw staleError();
  const baseId = body.optionId.endsWith(EDIT_SUFFIX) ? body.optionId.slice(0, -EDIT_SUFFIX.length) : body.optionId;
  const base = row.result.options.find((o) => o.optionId === baseId);
  if (!base) throw notFound('Plan option');
  const editId = `${baseId}${EDIT_SUFFIX}`;
  const known = new Set([...base.slots.map((s) => s.slotId), ...(row.input_context.edits?.[editId]?.option.slots.map((s) => s.slotId) ?? [])]);
  // Client slot ids are kept only when they name a slot of this option; others get engine ids (bounded apply ids).
  const edits = body.slots.map(({ slotId, ...rest }) => (slotId && known.has(slotId) ? { slotId, ...rest } : rest));
  const inputs = restoreInputs(row.input_context, c.asOf, c.ctx, c.soilChecks);
  const fetched = await fetchOutlooks(deps, c, editInputKeys(c.ctx, inputs, edits).slice(0, 12));
  inputs.priceOutlooks = fetched.map;
  annualMeansOf(fetched.map, inputs.annualMeans);
  let option: YearPlanOption;
  try { option = rescoreOption(c.ctx, inputs, edits, { norm: row.input_context.norm ?? undefined }); }
  catch (e) { throw new ApiError(400, 'plan_unplaceable', (e as Error).message); }
  const edited = YearPlanOption.parse({ ...option, optionId: editId, label: base.label });
  const entry: StoredEdit = { baseOptionId: baseId, slots: edits, option: edited, at: new Date().toISOString() };
  await deps.pool.query("UPDATE farm_year_plans SET input_context=jsonb_set(input_context || jsonb_build_object('edits', COALESCE(input_context->'edits','{}'::jsonb)), ARRAY['edits',$4::text], $5::jsonb, true) WHERE id=$1 AND owner_id=$2 AND farm_id=$3",
    [row.id, ownerId, farmId, editId, JSON.stringify(entry)]);
  return edited;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function occupiedNow(workspace: FarmWorkspace, stateId: string | null, fixed: { cycleId: string; to: string } | null): { id: string; from: string; to: string; cropId: string }[] {
  const out: { id: string; from: string; to: string; cropId: string }[] = [];
  // The current crop keeps the release date the plan itself used (stage-timeline window when its harvest is not recorded).
  for (const cy of workspace.cycles.filter((x) => x.stage !== 'harvested')) out.push({ id: cy.id, cropId: cy.cropId, from: cy.sowingDate, to: fixed && fixed.cycleId === cy.id ? fixed.to : occupancyFor(cy.cropId, cy.productId ?? null, cy.establishmentMethod ?? null, cy.sowingDate, cy.harvestDate ?? null, stateId).to });
  for (const p of workspace.rotationPlans) if (p.plannedSowingDate) out.push({ id: p.id, cropId: p.cropId, from: p.plannedSowingDate, to: occupancyFor(p.cropId, p.productId ?? null, null, p.plannedSowingDate, p.plannedHarvestDate ?? null, stateId).to });
  return out;
}

/** Appends the option's seasons (fixed slot skipped) as yearplan:{reviewId}:{optionId}:{slotId}; idempotent; existing entries untouched. */
export async function applyYearPlan(deps: YearPlanDeps, ownerId: string, farmId: string, body: ApplyYearPlan): Promise<{ workspace: FarmWorkspace; review: YearPlanReview }> {
  const row = await loadRow(deps, ownerId, farmId, body.reviewId);
  const option = body.optionId.endsWith(EDIT_SUFFIX) ? row.input_context.edits?.[body.optionId]?.option : row.result.options.find((o) => o.optionId === body.optionId);
  if (!option) throw notFound('Plan option');
  let slots = option.slots.filter((s) => !s.fixed);
  if (body.slotIds) {
    const want = new Set(body.slotIds);
    if ([...want].some((id) => !slots.some((s) => s.slotId === id))) throw new ApiError(400, 'validation_error', 'Select only seasons of this plan (the growing crop cannot be added)');
    slots = slots.filter((s) => want.has(s.slotId));
  }
  if (!slots.length) throw new ApiError(400, 'validation_error', 'This plan has no new season to add');
  const key = (slotId: string) => `yearplan:${row.id}:${body.optionId}:${slotId}`;
  const asOf = todayIst(nowOf(deps));
  const workspace = await getWorkspace(deps.pool, ownerId, farmId);
  const c = await rowContext(deps, ownerId, farmId, asOf, row);
  if (slots.every((s) => workspace.rotationPlans.some((p) => p.id === key(s.slotId)))) return { workspace, review: await view(deps, row, c) };
  if (c.hash !== row.context_hash) throw staleError();
  if (workspace.version !== body.expectedWorkspaceVersion) throw new ApiError(409, 'version_conflict', 'Saved seasons changed; reload before applying this plan', { currentVersion: workspace.version });
  const additions = slots.filter((s) => !workspace.rotationPlans.some((p) => p.id === key(s.slotId)));
  const occupied = occupiedNow(workspace, c.ctx.stateId, c.ctx.fixedSlot ? { cycleId: c.ctx.fixedSlot.cycleId, to: c.ctx.fixedSlot.occupancy.to } : null);
  for (const [i, s] of additions.entries()) {
    if (s.sowing < asOf) throw new ApiError(409, 'plan_window_passed', `${s.cropName}: the sowing date ${s.sowing} has passed`);
    const hit = occupied.find((o) => overlaps(s.occupancy.from, s.occupancy.to, o.from, o.to));
    if (hit) throw new ApiError(409, 'plan_overlap', `${s.cropName} overlaps a crop or saved season on this field (${hit.from} to ${hit.to})`);
    for (const t of additions.slice(i + 1)) if (overlaps(s.occupancy.from, s.occupancy.to, t.occupancy.from, t.occupancy.to)) throw new ApiError(409, 'plan_overlap', `${s.cropName} and ${t.cropName} overlap in this plan`);
  }
  const entries = additions.map((s) => {
    const season = row.input_context.slotSeasons?.[s.slotId] ?? data.seasonOfMonth(monthOf(s.sowing));
    const notes = s.kind === 'green_manure' ? [
      `Year plan "${option.label}" (${option.origin}) from review ${row.id}.`,
      `Green manure: sow ${s.sowing}, plough in by ${s.harvest.latest} (${s.durationDays.low}-${s.durationDays.high} days).`,
      s.nitrogenCreditKgPerHa ? `Nitrogen in the biomass about ${s.nitrogenCreditKgPerHa.low}${s.nitrogenCreditKgPerHa.high !== s.nitrogenCreditKgPerHa.low ? `-${s.nitrogenCreditKgPerHa.high}` : ''} kg/ha (provisional source).` : 'Nitrogen not sourced.',
      s.cost?.a2flPerHa ? `Seed cost ${s.cost.a2flPerHa} INR/ha (seed only).` : 'Cost not sourced.',
      'Dates and ranges are calculated references, not predictions.',
    ].join(' ') : [
      `Year plan "${option.label}" (${option.origin}) from review ${row.id}.`,
      ...(s.companion ? [`Intercrop with ${s.companion.cropName.toLowerCase()} (rows ${s.companion.rowRatio}; yield shares ${s.companion.shareBasis}${s.companion.source ? `, ${s.companion.source.title}` : ''}); the yield below is the sole-crop figure before the share.`] : []),
      s.yieldKgPerHa ? `Yield ${s.yieldKgPerHa.low}-${s.yieldKgPerHa.high} kg/ha (${s.yieldBasis ?? 'basis unknown'}).` : 'Yield not sourced.',
      s.price?.range ? `Harvest-week wholesale price ${s.price.range.low}-${s.price.range.high} INR/kg (${s.price.scope.level}).` : 'No harvest-week price range.',
      s.cost?.a2flPerHa ? `Cost A2+FL ${s.cost.a2flPerHa} INR/ha (${s.cost.authority ?? 'source'} ${s.cost.year ?? ''}).` : 'Cost not sourced.',
      'Dates and ranges are calculated references, not predictions.',
    ].join(' ');
    // A green manure has no catalogue product: the season is saved with its crop id only (the product check is skipped).
    const product = s.kind === 'green_manure' ? {} : { productId: s.productId, productName: s.productName };
    // Round 3: the saved season carries its kind and companion; an intercrop whose companion is harvested later keeps the
    // field until the companion harvest (occupancy end minus the land preparation gap).
    const kind = s.kind === 'intercrop' && s.companion ? { kind: 'intercrop' as const, companion: { systemId: s.companion.systemId, cropId: s.companion.cropId, cropName: s.companion.cropName, productId: s.companion.productId, productName: s.companion.productName, rowRatio: s.companion.rowRatio } } : s.kind === 'green_manure' ? { kind: 'green_manure' as const } : {};
    const held = addDays(s.occupancy.to, -ASSUMPTIONS.landPrepGapDays.value);
    const harvestLatest = s.kind === 'intercrop' && held > s.harvest.latest ? held : s.harvest.latest;
    const method = s.kind !== 'green_manure' && s.establishmentMethod ? { establishmentMethod: s.establishmentMethod } : {};
    return { id: key(s.slotId), year: Number(s.sowing.slice(0, 4)), season: capitalise(season), cropId: s.cropId, cropName: s.cropName, ...product, ...kind, ...method, plannedSowingDate: s.sowing, plannedHarvestDate: harvestLatest, notes: notes.slice(0, 2000) };
  });
  let after = c;
  const saved = await putWorkspace(deps.pool, ownerId, farmId, { boundary: workspace.boundary, previousHarvest: workspace.previousHarvest, cycles: workspace.cycles, rotationPlans: [...workspace.rotationPlans, ...entries], expectedVersion: workspace.version }, {
    farmVersion: c.farmVersion,
    afterSave: async (client, savedWs) => {
      after = await yearPlanContext({ ...deps, pool: client as unknown as Pool }, ownerId, farmId, asOf, c.horizonFrom, c.horizonFrom ? { keepAssumed: c.assumedInput } : {});
      const mode = deps.config.RUNTIME_MODE;
      await client.query("UPDATE jobs SET cancel_requested=true WHERE id IN (SELECT job_id FROM farm_year_plans WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND context_hash=$4 AND id<>$5 AND archived_at IS NULL AND horizon_from IS NOT DISTINCT FROM $6::date) AND state IN ('queued','running')", [farmId, ownerId, mode, after.hash, row.id, c.horizonFrom]);
      await client.query('UPDATE farm_year_plans SET archived_at=now() WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND context_hash=$4 AND id<>$5 AND archived_at IS NULL AND horizon_from IS NOT DISTINCT FROM $6::date', [farmId, ownerId, mode, after.hash, row.id, c.horizonFrom]);
      row.result.appliedOptionIds = [...new Set([...row.result.appliedOptionIds, body.optionId])];
      row.result.inputVersions = { farm: after.farmVersion, workspace: savedWs.version };
      row.result.contextHash = after.hash;
      await client.query("UPDATE farm_year_plans SET context_hash=$4,input_versions=$5::jsonb,result=$6::jsonb,input_context=jsonb_set(input_context,'{chainHash}',to_jsonb($7::text),true) WHERE id=$1 AND owner_id=$2 AND farm_id=$3", [row.id, ownerId, farmId, after.hash, JSON.stringify(row.result.inputVersions), JSON.stringify(row.result), after.chainHash]);
      row.context_hash = after.hash;
    },
  });
  return { workspace: saved, review: await view(deps, row, after) };
}
