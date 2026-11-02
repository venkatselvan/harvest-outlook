/**
 * Today view aggregator (Stream B, docs/research/TODAY_VIEW_SPEC.md, UI_BRIEF section 3.1): one owner-scoped read that
 * composes the stage timeline, satellite scenes and health, price and weather tracks along the slider, alerts, upcoming
 * steps and monitoring state into `TodayView`. Every number comes from the composed code modules; nothing is generated here.
 *
 * Composition order: farm (404 for a foreign or deleted farm, before anything else) -> workspace -> current cycle ->
 * product identity -> stage timeline (pure) -> then in parallel: NDVI series + ready illustrations, price track, weather
 * track, alerts, care schedule, monitoring -> scenes, health and upcoming steps are assembled from those results.
 *
 * Resilience: every composed call runs inside `guard`, so a provider or read failure degrades only its section (no
 * scenes and no health, no price track, an `unavailable` weather track, no alerts, no care tasks) and adds a limitation
 * naming the section. Only a farm 404 (including a farm deleted mid-request) or an auth error propagates.
 *
 * Mode separation: synthetic and replay make no network call. NDVI and illustrations are live-only by their own modules;
 * the weather source may ingest (bounded) only when `autoIngest` is true, which is set in live mode only; prices and
 * alerts are stored-data reads scoped by mode.
 *
 * Documented choices that change results (all named in the output limitations when they apply):
 * - "today" is the Asia/Kolkata calendar date of `asOf`, like the rest of the API;
 * - the current cycle is the not-harvested cycle with the latest establishment (else sowing) date;
 * - observed scenes are only the usable readings (clear, plausible field view); unusable scenes are not offered;
 * - health compares the latest usable field mean with the 1 km neighbourhood mean on the same scene: above/below when
 *   they differ by at least NEIGHBOURHOOD_MARGIN (0.05, a design threshold), `no_reference` without a usable
 *   neighbourhood or when the field is too small for a field-only reading. No stage-typical NDVI range exists, so
 *   `typicalRange` is always null;
 * - price: the harvest-window midpoint outlook decides the scope (district when the seasonal reference resolves there,
 *   else the state pool); observed weekly medians from sowing to today use the same scope; future weeks get the
 *   historical seasonal reference for that week's Monday, at most MAX_OUTLOOK_CALLS distinct ISO-week outlooks;
 * - weather covers the slider window (at most 400 days, kept around today), else today-7 to today+sliderWindowDays;
 * - upcoming care tasks: due within the next 14 days, overdue within the last 14 days, completed only when completed today;
 * - upcoming steps v2 (ROUND2_SPEC.md 2.1), all windowed and filtered by the same 14-day horizon and lookback:
 *   - stage checks: observed-stage guidance dated from the stage timeline. The guidance `stage` text (else its title) is
 *     matched to a timeline stage by case-insensitive substring in either direction (stage name or id), then by
 *     STAGE_KEYWORDS (orchestrator table 2026-11-01: grain fill|milk|dough|maturity|ripening|harvest -> late season;
 *     panicle|booting|heading|flowering|silking|tasselling|pod -> mid-season; tiller|vegetative|branching -> development;
 *     germination|emergence|seedling|establishment|transplant -> initial). The first keyword class that fits the guidance
 *     decides; a stage matches a class by its name or id (for example ginger "Maturation" for late season). A check
 *     phrased "at <stage>" gets the first AT_STAGE_DAYS (14) days of the matched stage, other matched checks the whole
 *     stage. Only when nothing matches: the remaining cycle (today or the cycle start, whichever is later, to the
 *     harvest window end) with detail "Any time this season". A future window is 'upcoming'. Stage checks are
 *     calendar estimates and cannot be marked done (the completion endpoint accepts only scheduled care task ids);
 *   - other-region references: only when the field's region has no matched care schedule for the crop (no care task),
 *     the referenceGuidance actions are dated from their own startDay/endDay (and repeat) on the recorded establishment
 *     (else sowing) date, as care_task steps whose detail starts "Guidance from <state> sources (no local schedule for
 *     <district>)" and ends with the source name and locator (UpcomingStep has no sourceRefs field). They carry
 *     careTask null because completeCareTask only accepts ids of careSchedule().careTasks, which never include them;
 *   - order: overdue, due, upcoming (by dueFrom), completed; `nextAction` is the first open step, preferring care tasks
 *     and alert steps over stage checks and stage transitions as a whole tier (so an always-due "any time this season"
 *     check never outranks a concrete care task);
 * - outlook note (ROUND2_SPEC.md 2.2): facts from the harvest-week reference and the 24-month trend in the same scope;
 *   the stored note is returned when its facts hash matches, else the job is queued (see outlook-note.ts);
 * - index stage (open-source comparison 2026-11-01): the field's own NDVI curve read by code (index-stage.ts) beside the
 *   calendar stage, only for a current cycle. It never moves the stage timeline; when it is insufficient or unavailable
 *   one limitation names its reason.
 * - economics and footprint (TODAY_ECONOMICS_FOOTPRINT_SPEC.md, 2026-11-02): for a current cycle only, after the price
 *   section resolves: the expected profit at the harvest midpoint from the price headline already fetched (economics.ts),
 *   then residue income, energy and carbon on the economics' yield for the field (footprint.ts over
 *   data/research/footprint/crop-footprint.json). Pure stored-data arithmetic, no network or model call in any mode; each
 *   block runs under its own guard and its limitations are appended to the view's, deduplicated.
 * - Today overview (spec section 9): after every other block, overview.ts builds facts from the composed view and
 *   ensureTodayOverview returns the stored, pending or code-written overview (synthetic and replay: code-written inline,
 *   no job, no Meta call); null without a current cycle or when it fails (a limitation names it).
 */
import type {Config} from '../../config';
import type {Pool} from '../../db/pool';
import type {FetchLike} from '../../ingest/http';
import type {CatalogueSnapshot} from '../../catalogue/snapshot';
import type {ProviderConfig} from '../../providers/config';
import type {Sentinel2Fetch} from '../../providers/sentinel2';
import type {WeatherSource} from '../../plans/sources';
import {isoWeek} from '../../plans/adapters/market-outlook';
import type {CarbonFootprint, CareTask, EnergyFootprint, FarmAlert, FarmWorkspace, HarvestEconomics, HealthReading, NdviReading, NdviSeries, OutlookNote, PricePoint, ResidueIncome, SceneRef, StageTimeline, TodayOverview, TodayView, UpcomingStep, WeatherPoint} from '@harvest/contracts';
import {ApiError, notFound} from '../errors';
import {getFarm} from '../farms';
import {boundaryMetrics, getWorkspace} from '../workspace';
import {careSchedule} from '../command-center';
import {focusedResearch, type FocusedResearch} from '../focused-crops';
import {readMonitorSettings} from '../monitor-schedule';
import {harvestPriceOutlook, priceSeries, priceTrend, resolveStateName, type HarvestPriceOutlook, type PriceTrend} from '../price-series';
import {stateNameFor} from '../../plans/adapters/market-outlook';
import type {FocusedCareCrop} from '../focused-crops';
import {OUTLOOK_TREND_MONTHS, ensureOutlookNote, outlookFacts} from './outlook-note';
import {listAlerts} from './alerts';
import {listReadyFutureLooks} from './future-look';
import {ndviSeries} from './ndvi';
import {STAGE_READER_ASSUMPTIONS, readIndexStage} from './index-stage';
import {stageAt, stageTimeline, timelineSpan} from './stage-timeline';
import {unavailableTrack, weatherTrack, type WeatherTrack} from './weather-track';
import {harvestEconomics as harvestEconomicsOf} from './economics';
import {carbonFootprint as carbonFootprintOf, energyFootprint as energyFootprintOf, irrigationCategoryOf, residueIncome as residueIncomeOf, type FootprintInput} from './footprint';
import {cropDisplayName} from '../year-plan/data';
import {ensureTodayOverview, overviewFacts} from './overview';

// ------------------------------------------------------------------ constants (design choices, see the header)

export const UPCOMING_HORIZON_DAYS = 14;
export const OVERDUE_LOOKBACK_DAYS = 14;
/** Shared with the index stage reader, so its window never precedes the fetched series (index-stage.ts windowLeadDays). */
export const NDVI_LEAD_DAYS = STAGE_READER_ASSUMPTIONS.windowLeadDays.value;
export const NDVI_MAX_SCENES = 12;
export const NEIGHBOURHOOD_MARGIN = 0.05;
export const MAX_OUTLOOK_CALLS = 40;
export const DEFAULT_WINDOW_DAYS = 14;
const NO_TIMELINE_PAST_DAYS = 7;
const MAX_TRACK_POINTS = 400;
const MAX_SCENES = 120;
const MAX_UPCOMING = 30;
const NDVI_MAX_WINDOW_DAYS = 400;
const STALE_HEALTH_DAYS = 30;
const OUTLOOK_CONCURRENCY = 4;

// ------------------------------------------------------------------ deps

type Cycle = FarmWorkspace['cycles'][number];
type ReadyFutureLook = Awaited<ReturnType<typeof listReadyFutureLooks>>[number];

/** Replaceable providers. Production leaves them unset; tests inject fakes (no network). */
export interface TodayProviders {
  ndviSeries: typeof ndviSeries;
  priceSeries: typeof priceSeries;
  harvestPriceOutlook: typeof harvestPriceOutlook;
  /** Monthly trend for the outlook note's year-on-year fact (stored data only). */
  priceTrend: typeof priceTrend;
  /** Default: the stored-data source built inside weatherTrack (bounded live ingest only when autoIngest). */
  weatherSource: WeatherSource | undefined;
  readyFutureLooks: typeof listReadyFutureLooks;
  focusedResearch: () => Promise<FocusedResearch>;
}

export interface TodayViewDeps {
  config: Pick<Config, 'RUNTIME_MODE'> & Partial<Pick<Config, 'WEATHER_CLIMATOLOGY_YEARS' | 'WEATHER_CLIMATOLOGY_END_YEAR'>>;
  pool: Pool;
  now?: (() => Date) | undefined;
  /** Planetary Computer fetch for NDVI (live mode only). */
  sentinelFetch?: Sentinel2Fetch | undefined;
  /** Open-Meteo fetch for the weather source's bounded live ingest. */
  weatherFetch?: FetchLike | undefined;
  providerConfig?: ProviderConfig | undefined;
  /** Catalogue stage models; default data/curated/stages. */
  snapshot?: Pick<CatalogueSnapshot, 'stages'> | undefined;
  providers?: Partial<TodayProviders> | undefined;
}

export interface TodayViewOptions {
  /** Instant the view is computed for (default now). Its IST calendar date is "today". */
  asOf?: string | Date | undefined;
  /** Days after today in the weather track when there is no crop timeline (default 14, 1 to 60). */
  sliderWindowDays?: number | undefined;
}

// ------------------------------------------------------------------ date helpers (calendar dates, UTC arithmetic)

const DAY_MS = 86_400_000;
const istDate = (d: Date) => new Date(d.getTime() + 19_800_000).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const mondayOf = (d: string) => addDays(d, 1 - (new Date(`${d}T00:00:00Z`).getUTCDay() || 7));
const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** ISO week 53 is pooled with 52 by the seasonal reference, so both share one outlook. */
const weekBucket = (date: string) => Math.min(52, isoWeek(date).week);

/** A window of at most `maxDays` inside [from, to], kept around `today` when the full range is longer. */
export function boundedWindow(from: string, to: string, today: string, maxDays: number): {from: string; to: string; clipped: boolean} {
  if (dayDiff(from, to) + 1 <= maxDays) return {from, to, clipped: false};
  let start = maxDate(from, addDays(today, -Math.floor(maxDays / 2)));
  let end = addDays(start, maxDays - 1);
  if (end > to) { end = to; start = addDays(to, -(maxDays - 1)); }
  return {from: start, to: end, clipped: true};
}

/** Start of the NDVI window for a cycle: NDVI_LEAD_DAYS before its anchor, at most NDVI_MAX_WINDOW_DAYS back, never after today. */
export const ndviWindowFrom = (anchor: string, today: string): string => minDate(today, maxDate(addDays(anchor, -NDVI_LEAD_DAYS), addDays(today, -(NDVI_MAX_WINDOW_DAYS - 1))));

/** Acquisition date encoded in a Sentinel-2 item id (`..._20261027T052231_...`), or null. */
function itemDate(itemId: string): string | null {
  const m = /_(\d{4})(\d{2})(\d{2})T\d{6}/.exec(itemId);
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isFinite(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : null;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

// ------------------------------------------------------------------ resilience

/** Errors that must reach the caller: the farm vanished (404) or the request is not authorised. */
function mustPropagate(e: unknown): boolean {
  return e instanceof ApiError && ((e.statusCode === 404 && e.message === 'Farm not found') || e.statusCode === 401 || e.statusCode === 403);
}
/** Short, non-sensitive failure code for a limitation (never the raw message, which may carry internals). */
function failureCode(e: unknown): string {
  if (e instanceof ApiError) return e.code;
  if (e instanceof RangeError) return 'invalid_range';
  return 'internal_error';
}

/**
 * Wraps one section. Failure notes are reported in the order the sections were started (code order), not the order in
 * which parallel calls happened to fail, so the output is deterministic.
 */
function makeGuard() {
  const notes: {i: number; text: string}[] = [];
  let started = 0;
  const guard = async <T>(section: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    const i = started++;
    try {
      return await fn();
    } catch (e) {
      if (mustPropagate(e)) throw e;
      notes.push({i, text: `${section} could not be read now (${failureCode(e)}); that part of the view is left empty.`});
      return fallback;
    }
  };
  return {guard, failures: () => [...notes].sort((a, b) => a.i - b.i).map((n) => n.text)};
}

// ------------------------------------------------------------------ small readers

export function currentCycle(workspace: FarmWorkspace): Cycle | null {
  const anchorOf = (c: Cycle) => c.establishmentDate ?? c.sowingDate;
  return [...workspace.cycles].filter((c) => c.stage !== 'harvested').sort((a, b) => anchorOf(b).localeCompare(anchorOf(a)))[0] ?? null;
}

/** First readable name in crop_identities.names ({en: "x"}, {en: ["x"]} or {en: [{text}]}), English first. */
function nameFrom(names: unknown): string | null {
  if (!names || typeof names !== 'object' || Array.isArray(names)) return null;
  const entries = Object.entries(names as Record<string, unknown>).sort(([a], [b]) => (a === 'en' ? -1 : b === 'en' ? 1 : 0));
  for (const [, v] of entries) {
    for (const item of Array.isArray(v) ? v : [v]) {
      const text = typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as {text?: unknown}).text === 'string' ? (item as {text: string}).text : null;
      if (text && text.trim()) return text.trim();
    }
  }
  return null;
}

export async function productIdentity(pool: Pool, cycle: Pick<Cycle, 'productId' | 'cropId' | 'cropName'>): Promise<TodayView['product']> {
  if (!cycle.productId) return null;
  const row = (await pool.query<{slug: string; name: string; crop_slug: string; names: unknown}>(
    `SELECT p.slug, p.name, c.slug AS crop_slug, c.names FROM crop_products p JOIN crop_identities c ON c.id = p.crop_id
      WHERE (p.slug = $1 OR p.id::text = $1) AND c.slug = $2 LIMIT 1`, [cycle.productId, cycle.cropId])).rows[0];
  if (!row) return null;
  return {productId: row.slug, productName: row.name, cropName: nameFrom(row.names) ?? cycle.cropName ?? row.crop_slug.replace(/[-_]+/g, ' ')};
}

/** Midpoint of the harvest window: the date the headline harvest price (and the outlook note) is computed for. */
export const harvestMidpoint = (harvest: NonNullable<StageTimeline['harvest']>) => addDays(harvest.earliest, Math.floor(dayDiff(harvest.earliest, harvest.latest) / 2));

const sceneImagePath = (farmId: string, itemId: string, kind: 'visual' | 'ndvi') => `/api/v1/farms/${farmId}/ndvi/${itemId}/image?kind=${kind}`;

// ------------------------------------------------------------------ satellite: scenes and health

function observedScenes(farmId: string, series: NdviSeries | null, timeline: StageTimeline | null): SceneRef[] {
  return (series?.readings ?? []).filter((r) => r.usable).map((r) => ({
    date: r.date, kind: 'observed', itemId: r.itemId, acquisitionDate: r.date, cloudPct: r.sceneCloudPct,
    imagePath: sceneImagePath(farmId, r.itemId, 'visual'), ndviImagePath: sceneImagePath(farmId, r.itemId, 'ndvi'),
    derivedFromItemId: null, stageId: timeline ? stageAt(timeline, r.date).stage?.id ?? null : null,
  }));
}

/** One illustration per stage (newest asset wins), dated at the stage start of the current timeline. */
function illustrationScenes(looks: ReadyFutureLook[], cycle: Cycle, timeline: StageTimeline | null, readings: Map<string, NdviReading>): {scenes: SceneRef[]; skipped: number} {
  if (!timeline) return {scenes: [], skipped: looks.length};
  const byStage = new Map<string, ReadyFutureLook>();
  let skipped = 0;
  for (const l of looks) {
    if (l.cropId !== cycle.cropId || !timeline.stages.some((s) => s.id === l.stageId)) { skipped++; continue; }
    const prev = byStage.get(l.stageId);
    if (!prev || prev.createdAt < l.createdAt) byStage.set(l.stageId, l);
  }
  const scenes = [...byStage.values()].map((l): SceneRef => {
    const stage = timeline.stages.find((s) => s.id === l.stageId)!;
    const src = readings.get(l.sourceItemId);
    return {
      date: stage.from, kind: 'illustration', itemId: null, acquisitionDate: src?.date ?? itemDate(l.sourceItemId), cloudPct: src?.sceneCloudPct ?? null,
      imagePath: l.imagePath, ndviImagePath: null, derivedFromItemId: l.sourceItemId, stageId: l.stageId,
    };
  });
  return {scenes, skipped};
}

export function healthFrom(series: NdviSeries | null): HealthReading | null {
  const r = series?.latestUsable;
  if (!series || !r || r.field.mean === null) return null;
  const nb = r.neighbourhood && r.neighbourhood.usable && r.neighbourhood.mean !== null ? r.neighbourhood.mean : null;
  const diff = nb === null ? null : Math.round((r.field.mean - nb) * 1e4) / 1e4;
  const verdict: HealthReading['verdict'] = series.smallField || diff === null ? 'no_reference'
    : diff >= NEIGHBOURHOOD_MARGIN ? 'above_typical' : diff <= -NEIGHBOURHOOD_MARGIN ? 'below_typical' : 'near_typical';
  const note = [
    `No typical NDVI range is sourced for this crop stage, so the reading is compared with the neighbourhood only: above or below when the field mean differs from the neighbourhood mean by at least ${NEIGHBOURHOOD_MARGIN} (a design threshold, not a validated agronomic one).`,
    nb === null && 'No usable neighbourhood reading exists for this scene, so there is no reference.',
    series.smallField && `The field covers fewer than 12 Sentinel-2 pixels, so the field-only value is unreliable; rely on the neighbourhood value (${nb ?? 'not available'}).`,
    'The neighbourhood is all land within about 1 km of the field, not cropland only.',
  ].filter((x): x is string => !!x).join(' ');
  return {
    date: r.date, ndviMean: r.field.mean, neighbourhoodMean: nb, typicalRange: null, verdict, clearFraction: r.field.clearFraction,
    basis: {
      kind: 'ndvi', label: 'Sentinel-2 L2A NDVI: field mean compared with the 1 km neighbourhood mean on the same scene', sourceId: r.itemId, url: null,
      scope: series.polygonBasis === 'boundary' ? 'drawn field boundary' : series.polygonBasis === 'farm_point_square' ? '1 ha square around the farm point' : null,
      note: cap(note, 1000),
    },
  };
}

// ------------------------------------------------------------------ price track

interface PriceInputs {
  mode: Config['RUNTIME_MODE'];
  pool: Pool;
  providers: Pick<TodayProviders, 'priceSeries' | 'harvestPriceOutlook' | 'priceTrend'>;
  productId: string | null;
  productName: string;
  stateCode: string | null;
  districtName: string | null;
  sowing: string;
  today: string;
  harvest: StageTimeline['harvest'];
  sliderEnd: string | null;
}
interface PriceSection {
  track: PricePoint[]; harvestPrice: NonNullable<TodayView['harvestPrice']>; limitations: string[];
  /** The harvest-midpoint reference behind harvestPrice (null without a product, state or harvest window). */
  headline: HarvestPriceOutlook | null;
  /** 24-month trend in the headline's scope, for the outlook note; null when unavailable or unreadable. */
  trend: PriceTrend | null;
}

const NO_SERIES: ReadonlySet<string> = new Set(['price_history_not_ingested', 'market_not_in_history']);
const REASON_TEXT: Record<string, string> = {
  price_history_not_ingested: 'no verified mandi price series is stored for this product',
  market_not_in_history: 'no quotes for this product in these markets in the years considered',
  price_history_insufficient: 'too few years with quotes in the harvest weeks',
  price_residuals_insufficient: 'too few weeks to measure the year-to-year range',
  price_interval_crossing: 'the range could not be computed consistently',
};

function placeOf(o: HarvestPriceOutlook): string {
  return o.scope.level === 'district' && o.scope.districtName ? `${o.scope.districtName} district` : o.scope.stateName ?? 'state';
}
function scopeLabelOf(o: HarvestPriceOutlook, productName: string): string {
  if (o.status === 'available') {
    return cap(`${o.yearsUsed.length} years of ${placeOf(o)} mandi prices (${o.scope.level} pool, ${o.scope.marketCount} markets)`, 160);
  }
  const why = REASON_TEXT[o.missingReason ?? ''] ?? 'price reference not available';
  return cap(`${productName} in ${placeOf(o)}: ${why}`, 160);
}
const insufficient = (reason: string, scopeLabel: string): PriceSection['harvestPrice'] => ({p50: null, range: null, status: 'insufficient', reason: cap(reason, 80), scopeLabel: cap(scopeLabel, 160)});

async function priceSection(i: PriceInputs): Promise<PriceSection> {
  const limitations: string[] = [];
  if (!i.productId) return {track: [], harvestPrice: insufficient('no_product_recorded', 'No product is recorded for this crop cycle, so no mandi price series applies'), limitations, headline: null, trend: null};
  const stateName = resolveStateName(i.stateCode);
  if (!stateName) return {track: [], harvestPrice: insufficient('farm_state_unknown', 'The farm state is not recorded, so no state mandi price series applies'), limitations, headline: null, trend: null};

  const productId = i.productId;
  // Seasonal-reference outlooks, cached per ISO week bucket and requested district (same asOf => same numbers).
  const cache = new Map<string, Promise<HarvestPriceOutlook>>();
  const keyOf = (date: string, districtName: string | null) => `${weekBucket(date)}|${districtName ?? ''}`;
  const outlook = (date: string, districtName: string | null) => {
    const key = keyOf(date, districtName);
    let hit = cache.get(key);
    if (!hit) {
      hit = i.providers.harvestPriceOutlook(i.pool, i.mode, {productId, stateName, districtName, harvestDate: date, asOf: i.today});
      cache.set(key, hit);
    }
    return hit;
  };

  let headline: HarvestPriceOutlook | null = null;
  let harvestPrice: PriceSection['harvestPrice'];
  if (i.harvest) {
    headline = await outlook(harvestMidpoint(i.harvest), i.districtName);
    if (headline.status === 'insufficient' && NO_SERIES.has(headline.missingReason ?? '')) {
      return {track: [], harvestPrice: insufficient(headline.missingReason!, scopeLabelOf(headline, i.productName)), limitations: [`${i.productName} has no official mandi price series for ${stateName} in the stored data; no price track is shown.`], headline, trend: null};
    }
    harvestPrice = {
      p50: headline.p50, range: headline.p25 !== null && headline.p75 !== null ? {low: headline.p25, high: headline.p75} : null,
      status: headline.status, reason: headline.missingReason, scopeLabel: scopeLabelOf(headline, i.productName),
    };
    limitations.push(...headline.limitations);
    if (headline.scope.fallbackNote) limitations.push(headline.scope.fallbackNote);
  } else {
    harvestPrice = insufficient('harvest_window_unknown', 'No harvest window is known for this crop, so no harvest-week price applies');
  }
  // The district is used for observed and future weeks only when the harvest-week reference itself resolved to it,
  // so the whole track comes from one market pool where the data allow.
  const district = headline?.scope.level === 'district' ? i.districtName : null;
  const points: PricePoint[] = [];
  // The outlook note's year-on-year fact: same scope as the headline, stored data only; a failure only drops that fact.
  const trendTask: Promise<PriceTrend | null> = headline?.status === 'available'
    ? i.providers.priceTrend(i.pool, i.mode, {productId, stateName, districtName: district, months: OUTLOOK_TREND_MONTHS, asOf: i.today}).catch(() => null)
    : Promise.resolve(null);

  if (i.sowing <= i.today) {
    const series = await i.providers.priceSeries(i.pool, i.mode, {productId, stateName, districtName: district, from: i.sowing, to: i.today, bucket: 'week', asOf: i.today});
    if (series.scope.level === 'district' || series.scope.level === 'state') {
      for (const b of series.buckets) points.push({date: b.start, kind: 'observed', p50: b.p50, range: b.min !== null && b.max !== null ? {low: b.min, high: b.max} : null, unit: 'INR/kg'});
      limitations.push('Observed points are the weekly median of market-day modal prices since sowing; their range is the lowest to highest market-day value that week, not a forecast interval. Weeks without quotes have no value.');
      if (series.status === 'insufficient') limitations.push(`Observed weekly prices since sowing come from few trading days (${series.coverage.validDays}); treat single weeks with care.`);
      if (series.scope.fallbackNote) limitations.push(series.scope.fallbackNote);
    } else {
      limitations.push(`No ${stateName} mandi quotes for this product since sowing; observed weekly prices from other states are not shown.`);
    }
    limitations.push(...series.limitations);
  }

  if (headline && i.sliderEnd) {
    const mondays: string[] = [];
    for (let m = addDays(mondayOf(i.today), 7); m <= i.sliderEnd; m = addDays(m, 7)) mondays.push(m);
    // Bound: at most MAX_OUTLOOK_CALLS distinct outlooks per view (the headline included); later weeks are left out.
    const planned = new Set<string>();
    const kept = mondays.filter((m) => {
      const key = keyOf(m, district);
      if (cache.has(key) || planned.has(key)) return true;
      if (cache.size + planned.size >= MAX_OUTLOOK_CALLS) return false;
      planned.add(key);
      return true;
    });
    const omitted = mondays.length - kept.length;
    let failed = 0, otherScope = 0;
    const results = await mapLimit(kept, OUTLOOK_CONCURRENCY, async (m) => {
      try { return {m, o: await outlook(m, district)}; } catch (e) { if (mustPropagate(e)) throw e; failed++; return null; }
    });
    for (const r of results) {
      if (!r) continue;
      if (r.o.scope.level !== headline.scope.level) otherScope++;
      const ok = r.o.status === 'available';
      points.push({date: r.m, kind: 'reference', p50: ok ? r.o.p50 : null, range: ok && r.o.p25 !== null && r.o.p75 !== null ? {low: r.o.p25, high: r.o.p75} : null, unit: 'INR/kg'});
    }
    if (mondays.length) limitations.push(`Future weeks show the historical seasonal reference (median of past years' weekly mandi prices near that week, P25 to P75 range), not a forecast; dated on each week's Monday.`);
    if (otherScope) limitations.push(`${otherScope} future week${otherScope > 1 ? 's use' : ' uses'} a different market pool than the harvest-week price because the preferred pool had too few quotes in those weeks.`);
    if (failed) limitations.push(`${failed} future week${failed > 1 ? 's' : ''} could not be priced now and ${failed > 1 ? 'are' : 'is'} left out.`);
    if (omitted) limitations.push(`${omitted} later week${omitted > 1 ? 's are' : ' is'} not priced: at most ${MAX_OUTLOOK_CALLS} weekly references are computed per view.`);
  }
  points.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  return {track: points.slice(-MAX_TRACK_POINTS), harvestPrice, limitations, headline, trend: await trendTask};
}

// ------------------------------------------------------------------ weather track

const toWeatherPoint = (d: WeatherTrack['days'][number]): WeatherPoint => ({
  date: d.date, kind: d.kind, rainMm: d.rainMm, tMinC: d.tMinC, tMaxC: d.tMaxC,
  basis: {source: cap(d.basis.source ?? 'none', 120), issuedAt: d.basis.issuedAt ? new Date(d.basis.issuedAt).toISOString() : null, years: d.basis.years},
});

// ------------------------------------------------------------------ upcoming steps

interface Completion { cycle_id: string; action_key: string; completed_on: string; journal_entry_id: string }

function careSteps(tasks: CareTask[], today: string): {steps: UpcomingStep[]; olderOverdue: number} {
  const horizon = addDays(today, UPCOMING_HORIZON_DAYS), lookback = addDays(today, -OVERDUE_LOOKBACK_DAYS);
  let olderOverdue = 0;
  const steps: UpcomingStep[] = [];
  for (const t of tasks) {
    if (t.status === 'completed' && t.completedOn !== today) continue;
    if (t.status === 'overdue' && t.dueTo < lookback) { olderOverdue++; continue; }
    if (t.status !== 'completed' && t.dueFrom > horizon) continue;
    steps.push({id: cap(t.id, 160), kind: 'care_task', title: cap(t.title, 160), detail: cap(t.action, 1000), dueFrom: t.dueFrom, dueTo: t.dueTo, status: t.status, careTask: t, alertId: null});
  }
  return {steps, olderOverdue};
}

function stageStep(cycle: Cycle, timeline: StageTimeline | null, today: string): UpcomingStep | null {
  if (!timeline) return null;
  const next = timeline.stages.find((s) => s.from > today);
  const detail = cap(`Calendar estimate from the recorded ${cycle.establishmentDate ? 'establishment' : 'sowing'} date (${timeline.basis.label}); not an observation.`, 1000);
  if (next) return {id: `stage:${cycle.id.slice(0, 60)}:${next.id.slice(0, 80)}`, kind: 'stage_transition', title: cap(`${next.name} expected to start`, 160), detail, dueFrom: next.from, dueTo: next.from, status: 'upcoming', careTask: null, alertId: null};
  if (timeline.harvest && timeline.harvest.earliest > today) {
    return {id: `stage:${cycle.id.slice(0, 60)}:harvest`, kind: 'stage_transition', title: 'Harvest window opens', detail, dueFrom: timeline.harvest.earliest, dueTo: timeline.harvest.latest, status: 'upcoming', careTask: null, alertId: null};
  }
  return null;
}

const alertSteps = (alerts: FarmAlert[], today: string): UpcomingStep[] => alerts.filter((a) => a.suggestedStep).map((a) => ({
  id: `alert:${a.id}`, kind: 'alert_step', title: cap(a.title, 160), detail: cap(a.suggestedStep!, 1000), dueFrom: a.validFrom, dueTo: a.validTo,
  status: a.validFrom > today ? 'upcoming' : 'due', careTask: null, alertId: a.id,
}));

// ------------------------------------------------------------------ upcoming steps v2 (ROUND2_SPEC.md 2.1)

type CareItem = FocusedCareCrop['care'][number];
type TimelineStage = StageTimeline['stages'][number];
type CareSchedule = ReturnType<typeof careSchedule>;
type SourceList = readonly {id: string; publisher: string}[];
export interface StepLocation { stateId: string | null; districtId: string | null; districtName: string | null }

const normStage = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Window of a check phrased "at <stage>": the first 14 days of the matched stage (orchestrator decision 2026-11-01). */
export const AT_STAGE_DAYS = 14;
/** Keyword classes, tried in this order; the first class whose `guidance` pattern fits decides (see the header). */
export const STAGE_KEYWORDS: readonly {label: string; guidance: RegExp; stages: readonly RegExp[]}[] = [
  {label: 'late season', guidance: /grain fill|milk|dough|matur|ripen|harvest/, stages: [/late season|matur|ripen|harvest/]},
  {label: 'mid-season', guidance: /panicle|boot|heading|flower|silk|tassel|\bpod/, stages: [/mid season|flower|reproductive/]},
  {label: 'development', guidance: /tiller|vegetative|branch/, stages: [/develop|vegetative|tiller|branch/]},
  {label: 'initial', guidance: /germinat|emergence|seedling|establish|transplant/, stages: [/initial|establish|seedling|sprout|germinat|emergence/]},
];

/** The timeline stage a stage-guidance text refers to: substring in either direction, then the keyword table. */
export function matchStage(text: string | null | undefined, timeline: Pick<StageTimeline, 'stages'>): {stage: TimelineStage; rule: 'substring' | 'keyword'} | null {
  const g = normStage(text ?? '');
  if (!g) return null;
  for (const st of timeline.stages) {
    for (const cand of [normStage(st.name), normStage(st.id)]) if (cand && (cand.includes(g) || g.includes(cand))) return {stage: st, rule: 'substring'};
  }
  const k = STAGE_KEYWORDS.find((x) => x.guidance.test(g));
  if (!k) return null;
  for (const target of k.stages) {
    const st = timeline.stages.find((x) => target.test(`${normStage(x.name)} ${normStage(x.id)}`));
    if (st) return {stage: st, rule: 'keyword'};
  }
  return null;
}

const statusOf = (from: string, to: string, today: string): UpcomingStep['status'] => (to < today ? 'overdue' : from > today ? 'upcoming' : 'due');
const geoMatched = (ids: readonly string[], loc: StepLocation) => ids.some((id) => id === 'IN' || (!!loc.stateId && id === loc.stateId) || (!!loc.districtId && id === loc.districtId));
/** "Tamil Nadu" for IN-TN (also for district ids such as IN-KA-hassan -> Karnataka); "India" for IN. */
export function geographyNames(ids: readonly string[]): string {
  const names = [...new Set(ids.map((id) => {
    if (id.toUpperCase() === 'IN') return 'India';
    const code = /^IN-([A-Za-z]{2})/.exec(id)?.[1];
    return (code && stateNameFor(`IN-${code}`)) ?? id;
  }))];
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? 'other-region';
}
/** "Guidance from Tamil Nadu sources (no local schedule for Hassan)." for guidance outside the field's region, else null. */
export function regionPrefix(ids: readonly string[], loc: StepLocation): string | null {
  if (geoMatched(ids, loc)) return null;
  if (!loc.stateId) return `Guidance from ${geographyNames(ids)} sources (the field location is not matched to a local schedule).`;
  return `Guidance from ${geographyNames(ids)} sources (no local schedule for ${loc.districtName ?? 'this district'}).`;
}
function sourceText(refs: CareItem['sourceRefs'], sources: SourceList): string | null {
  const parts = [...new Set(refs.map((r) => `${sources.find((x) => x.id === r.sourceId)?.publisher ?? r.sourceId} (${r.locator})`))];
  return parts.length ? `Source: ${parts.join('; ')}.` : null;
}
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const joinDetail = (parts: (string | null | undefined)[]) => cap(parts.filter((x): x is string => !!x && !!x.trim()).map(sentence).join(' '), 1000);

/** Observed-stage guidance for this cycle (same filter as the command center's stageGuidance). */
function stageGuidanceItems(crop: FocusedCareCrop | undefined, cycle: Cycle): CareItem[] {
  return (crop?.care ?? []).filter((a) => a.anchor === 'observed_stage'
    && (!a.productIds?.length || (!!cycle.productId && a.productIds.includes(cycle.productId)))
    && (!a.establishmentMethods?.length || (!!cycle.establishmentMethod && a.establishmentMethods.includes(cycle.establishmentMethod))));
}

/** Stage checks dated from the stage timeline; `undated` counts guidance that has no timeline to be dated from. */
export function stageCheckSteps(args: {crop: FocusedCareCrop | undefined; cycle: Cycle; timeline: StageTimeline | null; today: string; location: StepLocation; sources?: SourceList | undefined}): {steps: UpcomingStep[]; undated: number; itemIds: string[]} {
  const items = stageGuidanceItems(args.crop, args.cycle);
  const tl = args.timeline;
  if (!tl || !tl.stages.length) return {steps: [], undated: items.length, itemIds: []};
  const start = tl.stages[0]!.from;
  const end = tl.harvest?.latest ?? tl.stages.reduce((m, st) => maxDate(m, st.to), tl.stages[0]!.to);
  const steps: UpcomingStep[] = [];
  const itemIds: string[] = [];
  for (const item of items) {
    const m = matchStage(item.stage ?? item.title, tl);
    // A check phrased "at <stage>" belongs to the start of that stage: its first 14 days (AT_STAGE_DAYS), not the whole stage.
    const atStage = !!m && /\bat\s+\S/i.test(item.title);
    const from = m ? m.stage.from : maxDate(args.today, start);
    const to = m ? (atStage ? minDate(addDays(m.stage.from, AT_STAGE_DAYS - 1), m.stage.to) : m.stage.to) : end;
    if (to < from) continue; // the cycle is over: nothing left to window
    const when = m ? `Dated from the calendar estimate of ${atStage ? 'the start of ' : ''}the ${m.stage.name} stage; check the actual crop stage first` : 'Any time this season';
    steps.push({
      id: cap(`check:${args.cycle.id.slice(0, 60)}:${item.id.slice(0, 80)}`, 160), kind: 'stage_check', title: cap(`Check: ${item.title}`, 160),
      detail: joinDetail([regionPrefix(item.geographyIds, args.location), when, item.action, ...item.conditions, sourceText(item.sourceRefs, args.sources ?? [])]),
      dueFrom: from, dueTo: to, status: statusOf(from, to, args.today), careTask: null, alertId: null,
    });
    itemIds.push(item.id);
  }
  return {steps, undated: 0, itemIds};
}

/**
 * Other-region care references dated on the recorded establishment (else sowing) date, only when the field's region has
 * no matched care schedule for the crop. Observed-stage references are stage checks instead. Never completable here.
 */
export function referenceCareSteps(args: {schedule: CareSchedule | null; crop: FocusedCareCrop | undefined; cycle: Cycle; today: string; location: StepLocation; sources?: SourceList | undefined}): UpcomingStep[] {
  const refs = args.schedule?.referenceGuidance ?? [];
  if (!args.schedule || args.schedule.careTasks.length || !refs.length || !args.crop) return [];
  const anchorDate = args.cycle.establishmentDate ?? args.cycle.sowingDate;
  const steps: UpcomingStep[] = [];
  for (const ref of refs) {
    const item = args.crop.care.find((c) => c.id === ref.actionId);
    if (!item || item.anchor === 'observed_stage' || item.endDay < item.startDay) continue;
    // Recurrence stays within the source's end window, as in careSchedule.
    const stepDays = item.repeatEveryDays;
    const occurrences = stepDays ? Math.min(60, Math.floor((item.endDay - item.startDay) / stepDays) + 1) : 1;
    for (let n = 0; n < occurrences; n++) {
      const startDay = item.startDay + (stepDays ? n * stepDays : 0);
      const endDay = stepDays ? Math.min(item.endDay, startDay + stepDays - 1) : item.endDay;
      const dueFrom = addDays(anchorDate, startDay), dueTo = addDays(anchorDate, endDay);
      steps.push({
        id: cap(`ref:${args.cycle.id.slice(0, 60)}:${item.id.slice(0, 80)}:${startDay}`, 160), kind: 'care_task', title: cap(item.title, 160),
        detail: joinDetail([regionPrefix(item.geographyIds, args.location) ?? `Guidance from ${geographyNames(item.geographyIds)} sources`, item.action, ...item.conditions, sourceText(item.sourceRefs, args.sources ?? [])]),
        dueFrom, dueTo, status: statusOf(dueFrom, dueTo, args.today), careTask: null, alertId: null,
      });
    }
  }
  return steps;
}

/** Same window rule as care tasks: overdue within the lookback, due, or starting within the horizon. */
function horizonFilter(steps: UpcomingStep[], today: string): {kept: UpcomingStep[]; older: number; later: number} {
  const horizon = addDays(today, UPCOMING_HORIZON_DAYS), lookback = addDays(today, -OVERDUE_LOOKBACK_DAYS);
  let older = 0, later = 0;
  const kept = steps.filter((st) => {
    if (st.status === 'overdue' && st.dueTo < lookback) { older++; return false; }
    if (st.status !== 'completed' && st.dueFrom > horizon) { later++; return false; }
    return true;
  });
  return {kept, older, later};
}

const STATUS_RANK: Record<UpcomingStep['status'], number> = {overdue: 0, due: 1, upcoming: 2, completed: 3};
const preferredTier = (st: UpcomingStep) => (st.kind === 'care_task' || st.kind === 'alert_step' ? 0 : 1);
const byStatusThenDate = (a: UpcomingStep, b: UpcomingStep) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.dueFrom.localeCompare(b.dueFrom) || preferredTier(a) - preferredTier(b) || a.dueTo.localeCompare(b.dueTo) || a.id.localeCompare(b.id);
/** List order: overdue, due, upcoming by dueFrom, completed (care tasks and alert steps first on ties). */
export const orderSteps = (steps: readonly UpcomingStep[]): UpcomingStep[] => [...steps].sort(byStatusThenDate);
/** The step to do next: the first open care task or alert step in list order, else the first open stage check or transition. */
export function pickNextAction(steps: readonly UpcomingStep[]): UpcomingStep | null {
  return [...steps].filter((st) => st.status !== 'completed').sort((a, b) => preferredTier(a) - preferredTier(b) || byStatusThenDate(a, b))[0] ?? null;
}

// ------------------------------------------------------------------ the view

export async function todayView(deps: TodayViewDeps, ownerId: string, farmId: string, opts: TodayViewOptions = {}): Promise<TodayView> {
  const mode = deps.config.RUNTIME_MODE;
  const at = opts.asOf !== undefined ? new Date(opts.asOf) : (deps.now ?? (() => new Date()))();
  if (Number.isNaN(at.getTime())) throw new ApiError(400, 'validation_error', 'asOf must be a valid instant');
  const windowDays = Math.max(1, Math.min(60, Math.trunc(opts.sliderWindowDays ?? DEFAULT_WINDOW_DAYS)));
  const asOf = at.toISOString();
  const today = istDate(at);
  const now = () => at; // every composed module sees the same instant

  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const workspace = await getWorkspace(deps.pool, ownerId, farmId);
  const o = deps.providers ?? {};
  const p: TodayProviders = {
    ndviSeries: o.ndviSeries ?? ndviSeries, priceSeries: o.priceSeries ?? priceSeries, harvestPriceOutlook: o.harvestPriceOutlook ?? harvestPriceOutlook, priceTrend: o.priceTrend ?? priceTrend,
    weatherSource: o.weatherSource, readyFutureLooks: o.readyFutureLooks ?? listReadyFutureLooks, focusedResearch: o.focusedResearch ?? focusedResearch,
  };
  const {guard, failures} = makeGuard();

  // ---- cycle, product, timeline
  const cycle = currentCycle(workspace);
  const anchor = cycle ? cycle.establishmentDate ?? cycle.sowingDate : null;
  const product = cycle ? await guard('The crop product name', () => productIdentity(deps.pool, cycle), null) : null;
  const timelineNotes: string[] = [];
  let timeline: StageTimeline | null = null;
  if (cycle && anchor) {
    timeline = await guard('The stage timeline', async () => stageTimeline({
      cropId: cycle.cropId, productId: cycle.productId ?? null, establishmentMethod: cycle.establishmentMethod ?? null, anchorDate: anchor,
      stateId: farm.location.stateCode, districtId: farm.location.districtId, snapshot: deps.snapshot,
    }), null);
    timelineNotes.push('Stage dates are a calendar estimate from the recorded establishment date. A stage is never marked reached by an observation.');
    if (!cycle.establishmentMethod) timelineNotes.push('The establishment method was not recorded, so durations for every method were considered.');
    if (timeline && !timeline.stages.length) timelineNotes.push('No sourced stage data exists for this crop, so there is no slider or harvest window.');
    if (cycle.productId && !product) timelineNotes.push('The recorded product is not in the crop catalogue, so product names are not shown.');
  } else {
    timelineNotes.push('This farm has no current crop cycle.');
  }
  const span = timeline ? timelineSpan(timeline) : null;
  const slider = timeline && span ? {from: span.start, to: span.end, todayProgress: stageAt(timeline, today).progress} : null;
  const harvest = timeline?.harvest ?? null;
  const daysToHarvest = harvest ? {earliest: dayDiff(today, harvest.earliest), latest: dayDiff(today, harvest.latest)} : null;

  // ---- weather point and window
  let point: {lat: number; lon: number} | null = null;
  if (workspace.boundary) { const m = boundaryMetrics(workspace.boundary); point = {lat: m.lat, lon: m.lon}; }
  else if (farm.location.lat !== null && farm.location.lon !== null) point = {lat: farm.location.lat, lon: farm.location.lon};
  const weatherWindow = slider ? boundedWindow(slider.from, slider.to, today, MAX_TRACK_POINTS) : {from: addDays(today, -NO_TIMELINE_PAST_DAYS), to: addDays(today, windowDays), clipped: false};

  // ---- independent sections in parallel
  const ndviTask = cycle && anchor ? guard('Satellite readings', () => {
    const from = ndviWindowFrom(anchor, today);
    return p.ndviSeries({config: deps.config, pool: deps.pool, fetchImpl: deps.sentinelFetch, now}, ownerId, farmId, {from, to: today, maxScenes: NDVI_MAX_SCENES});
  }, null) : Promise.resolve(null);
  const looksTask = cycle && mode === 'live' ? guard('Stage illustrations', () => p.readyFutureLooks({config: deps.config, pool: deps.pool, now}, ownerId, farmId, cycle.id), []) : Promise.resolve([]);
  const priceTask = cycle && anchor ? guard('Mandi prices', () => priceSection({
    mode, pool: deps.pool, providers: p, productId: cycle.productId ?? null, productName: product?.productName ?? cycle.productName ?? cycle.productId ?? cycle.cropId,
    stateCode: farm.location.stateCode, districtName: farm.location.districtName, sowing: anchor, today, harvest, sliderEnd: slider?.to ?? null,
  }), null) : Promise.resolve(null);
  const weatherTask = guard('Weather', async () => {
    if (!point) return unavailableTrack(weatherWindow.from, weatherWindow.to, 'No field boundary or farm point is recorded, so no weather can be located.');
    return weatherTrack({
      pool: deps.pool, source: p.weatherSource, autoIngest: mode === 'live', fetchImpl: deps.weatherFetch, providerConfig: deps.providerConfig, now,
      climatologyYears: deps.config.WEATHER_CLIMATOLOGY_YEARS, climatologyEndYear: deps.config.WEATHER_CLIMATOLOGY_END_YEAR,
    }, {point, from: weatherWindow.from, to: weatherWindow.to, asOf, mode, farmId});
  }, unavailableTrack(weatherWindow.from, weatherWindow.to, 'Weather could not be read now.'));
  const alertsTask = guard('Alerts', () => listAlerts(deps.pool, ownerId, farmId, mode, asOf), null);
  const careTask = cycle ? guard('The care schedule', async () => {
    const [research, completed] = await Promise.all([
      p.focusedResearch(),
      deps.pool.query<Completion>('SELECT cycle_id,action_key,completed_on::text completed_on,journal_entry_id FROM farm_cycle_actions WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND mode=$4', [ownerId, farmId, cycle.id, mode]),
    ]);
    const crop = research.crops.find((c) => c.cropId === cycle.cropId);
    return {schedule: careSchedule(cycle, crop, today, completed.rows, {stateId: farm.location.stateCode, districtId: farm.location.districtId}), crop, sources: research.sources};
  }, null) : Promise.resolve(null);
  const monitorTask = guard('Monitoring status', () => readMonitorSettings(deps.pool, ownerId, farmId, mode), null);
  const [ndvi, looks, price, weather, alerts, care, monitor] = await Promise.all([ndviTask, looksTask, priceTask, weatherTask, alertsTask, careTask, monitorTask]);

  // ---- scenes and health
  const satelliteNotes: string[] = [];
  const readingsById = new Map((ndvi?.readings ?? []).map((r) => [r.itemId, r]));
  const illustrations = cycle ? illustrationScenes(looks, cycle, timeline, readingsById) : {scenes: [], skipped: 0};
  const scenes = [...observedScenes(farmId, ndvi, timeline), ...illustrations.scenes]
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind)).slice(-MAX_SCENES);
  if (illustrations.skipped) satelliteNotes.push(`${illustrations.skipped} stage illustration${illustrations.skipped > 1 ? 's are' : ' is'} not shown because the stage is no longer in this cycle's timeline.`);
  if (illustrations.scenes.length) satelliteNotes.push('Stage illustrations are generated edits of a real satellite image showing a typical look of that stage; they are not observations of this field or predictions.');
  if (ndvi && ndvi.status === 'unavailable' && ndvi.reason) satelliteNotes.push(`Satellite readings are unavailable (${ndvi.reason}).`);
  const health = healthFrom(ndvi);
  if (health && dayDiff(health.date, today) > STALE_HEALTH_DAYS) satelliteNotes.push(`The latest clear satellite reading of the field is from ${health.date} (${dayDiff(health.date, today)} days ago).`);
  if (ndvi && ndvi.status === 'available' && !health) satelliteNotes.push('No clear satellite reading of the field exists in this window, so no vegetation health is shown.');
  // The field's own NDVI curve beside the calendar stage: evidence only, the timeline above is not changed by it.
  const indexStage = cycle ? readIndexStage({
    readings: ndvi?.readings ?? [], today, timeline, cycle, smallField: ndvi?.smallField ?? false, polygonBasis: ndvi?.polygonBasis ?? null,
    series: ndvi ? {status: ndvi.status, reason: ndvi.reason, window: ndvi.window} : {status: 'unavailable', reason: 'satellite_readings_unavailable'},
  }) : null;
  if (indexStage && indexStage.status !== 'available') satelliteNotes.push(`The satellite greenness curve is not read beside the stage estimate (${indexStage.reason ?? indexStage.status}).`);

  // ---- upcoming steps
  const schedule = care?.schedule ?? null;
  const care14 = schedule ? careSteps(schedule.careTasks, today) : {steps: [], olderOverdue: 0};
  const location: StepLocation = {stateId: farm.location.stateCode, districtId: farm.location.districtId, districtName: farm.location.districtName};
  const checks = cycle ? stageCheckSteps({crop: care?.crop, cycle, timeline, today, location, sources: care?.sources}) : {steps: [], undated: 0, itemIds: []};
  const references = cycle ? referenceCareSteps({schedule, crop: care?.crop, cycle, today, location, sources: care?.sources}) : [];
  const extra = horizonFilter([...references, ...checks.steps], today);
  // careSchedule says observed-stage actions get no calendar date; the ones dated here as stage checks drop that line.
  const checkedTitles = new Set((care?.crop?.care ?? []).filter((c) => checks.itemIds.includes(c.id)).map((c) => `${c.title}: requires an observed stage; no calendar date was inferred.`));
  const careNotes = schedule ? schedule.limitations.filter((l) => !checkedTitles.has(l)) : [];
  if (care14.olderOverdue) careNotes.push(`${care14.olderOverdue} care action${care14.olderOverdue > 1 ? 's' : ''} overdue by more than ${OVERDUE_LOOKBACK_DAYS} days ${care14.olderOverdue > 1 ? 'are' : 'is'} not listed under upcoming steps.`);
  const refCount = schedule?.referenceGuidance?.length ?? 0;
  if (refCount && !references.length) careNotes.push(`${refCount} care action${refCount > 1 ? 's come' : ' comes'} from sources for other regions and ${refCount > 1 ? 'are' : 'is'} not dated for this field, because this region has its own care schedule for the crop.`);
  if (references.length) careNotes.push(`No care schedule for ${location.districtName ?? 'this district'} is sourced for this crop, so steps marked "Guidance from ... sources" are dated from another region's published timing on the recorded ${cycle?.establishmentDate ? 'establishment' : 'sowing'} date. Confirm they apply locally. They cannot be marked done here: the completion endpoint accepts only care actions scheduled for this field's region.`);
  if (checks.steps.length) careNotes.push('Stage checks are dated from the calendar estimate of the matching crop stage, or span the rest of the season when no stage matches. Check the actual crop stage before acting; stage checks cannot be marked done here.');
  if (checks.undated) careNotes.push(`${checks.undated} stage check${checks.undated > 1 ? 's are' : ' is'} not listed because this crop has no stage timeline to date ${checks.undated > 1 ? 'them' : 'it'} from.`);
  if (extra.older) careNotes.push(`${extra.older} dated guidance step${extra.older > 1 ? 's' : ''} that ended more than ${OVERDUE_LOOKBACK_DAYS} days ago ${extra.older > 1 ? 'are' : 'is'} not listed.`);
  if (extra.later) careNotes.push(`${extra.later} later guidance step${extra.later > 1 ? 's appear' : ' appears'} when ${extra.later > 1 ? 'their' : 'its'} window is within ${UPCOMING_HORIZON_DAYS} days.`);
  const transition = cycle ? stageStep(cycle, timeline, today) : null;
  const ordered = orderSteps([...alertSteps(alerts?.alerts ?? [], today), ...(transition ? [transition] : []), ...care14.steps, ...extra.kept]);
  const nextAction = pickNextAction(ordered);
  // Truncation keeps the next action and the stage transition in the list.
  const pinned = new Set([nextAction, transition].filter((x): x is UpcomingStep => !!x));
  const upcoming = ordered.length <= MAX_UPCOMING ? ordered
    : orderSteps([...ordered.filter((st) => !pinned.has(st)).slice(0, MAX_UPCOMING - pinned.size), ...pinned]);
  if (ordered.length > MAX_UPCOMING) careNotes.push(`${ordered.length - MAX_UPCOMING} further steps are not listed (at most ${MAX_UPCOMING}).`);

  // ---- harvest outlook in words (stored note, else queued; code sentence inline in synthetic and replay)
  let outlookNote: OutlookNote | null = null;
  const noteNotes: string[] = [];
  const facts = cycle && harvest && price?.headline && cycle.productId
    ? outlookFacts({productId: cycle.productId, productName: product?.productName ?? cycle.productName ?? cycle.productId ?? cycle.cropId, harvest, outlook: price.headline, trend: price.trend})
    : null;
  if (facts) {
    outlookNote = await guard('The harvest outlook note', () => ensureOutlookNote({pool: deps.pool, config: deps.config, now}, {
      ownerId, farmId, facts, productName: product?.productName ?? cycle?.productName ?? facts.productId, districtName: farm.location.districtName, stateName: resolveStateName(farm.location.stateCode),
    }), null);
    if (outlookNote?.origin === 'model' || outlookNote?.status === 'pending') noteNotes.push('The harvest outlook sentence is written by Meta muse-spark from the code facts listed with it; every number in it must appear in those facts, otherwise a code-written sentence is shown.');
  } else if (price?.headline?.status === 'available') {
    outlookNote = {status: 'unavailable', text: null, facts: [], origin: null, generatedAt: null, modelInvocation: null};
  }

  // ---- economics and footprint (pure stored-data arithmetic on the price headline fetched above; no network)
  let harvestEconomics: HarvestEconomics | null = null;
  let residueIncome: ResidueIncome | null = null;
  let energyFootprint: EnergyFootprint | null = null;
  let carbonFootprint: CarbonFootprint | null = null;
  if (cycle && anchor) {
    const harvestDate = harvest ? harvestMidpoint(harvest) : null;
    const headline = price?.headline ?? null;
    harvestEconomics = await guard('The harvest economics', async () => harvestEconomicsOf({
      cycle: {id: cycle.id, cropId: cycle.cropId, productId: cycle.productId ?? null, sowingDate: cycle.sowingDate},
      farm: {stateId: farm.location.stateCode, districtId: farm.location.districtId, areaHa: farm.areaHectares},
      harvest, harvestDate, headline, today,
      priceScopeLabel: price?.harvestPrice.scopeLabel ?? 'No harvest-week price reference',
      priceMissingText: headline?.missingReason ? REASON_TEXT[headline.missingReason] ?? null : null,
    }), null);
    const fp: FootprintInput = {
      cropId: cycle.cropId, cropName: product?.cropName ?? cycle.cropName ?? cropDisplayName(cycle.cropId), productId: cycle.productId ?? null,
      stateId: farm.location.stateCode, districtId: farm.location.districtId, areaHa: farm.areaHectares,
      yieldForFieldKg: harvestEconomics?.yieldForFieldKg ?? null, irrigationCategory: irrigationCategoryOf(farm.facts),
      seasonDays: harvest ? dayDiff(anchor, harvest.earliest) : null, establishmentMethod: cycle.establishmentMethod ?? null,
    };
    residueIncome = await guard('The residue income', async () => residueIncomeOf(fp), null);
    energyFootprint = await guard('The energy footprint', async () => energyFootprintOf(fp), null);
    carbonFootprint = await guard('The carbon footprint', async () => carbonFootprintOf(fp), null);
  }
  const footprintNotes = [harvestEconomics, residueIncome, energyFootprint, carbonFootprint].flatMap((b) => b?.limitations ?? []);

  const composed: TodayView = {
    farmId, asOf, today, cycle, product, timeline, slider, daysToHarvest, scenes, ndvi, health,
    priceTrack: price?.track ?? [], harvestPrice: price?.harvestPrice ?? null,
    weatherTrack: weather.days.slice(0, MAX_TRACK_POINTS).map(toWeatherPoint),
    alerts: alerts?.alerts ?? [], newsReview: alerts?.newsReview ?? null, imdStatus: 'not_connected',
    upcoming, nextAction, outlookNote, indexStage, harvestEconomics, residueIncome, energyFootprint, carbonFootprint,
    // When the monitor row cannot be read, the documented default (on) is reported and the failure is a limitation.
    monitoring: monitor ? {enabled: monitor.enabled, lastCheckedAt: monitor.lastCheckedAt, nextCheckAt: monitor.nextCheckAt} : {enabled: true, lastCheckedAt: null, nextCheckAt: null},
    limitations: [],
  };

  // ---- Today overview (spec section 9): facts from every block above, after all of them; stored, queued or code-written
  let overview: TodayOverview | null = null;
  const overviewNotes: string[] = [];
  if (cycle) {
    overview = await guard('The Today overview', async () => {
      const set = overviewFacts(composed);
      if (!set) return null;
      return ensureTodayOverview({pool: deps.pool, config: deps.config, now}, {ownerId, farmId, set, districtName: farm.location.districtName, stateName: resolveStateName(farm.location.stateCode)});
    }, null);
    if (overview?.origin === 'model' || overview?.status === 'pending') overviewNotes.push('The Today overview is written by Meta muse-spark from the code facts listed with it; every number in it must appear in the facts each point cites, otherwise a code-written overview is shown.');
  }

  // ---- limitations, failures first, deduplicated
  const weatherNotes = [...weather.limitations];
  if (weatherWindow.clipped) weatherNotes.push(`The crop cycle is longer than ${MAX_TRACK_POINTS} days; weather covers ${weatherWindow.from} to ${weatherWindow.to}.`);
  const limitations = [...new Set([
    ...failures(), ...timelineNotes, ...satelliteNotes, ...(ndvi?.limitations ?? []), ...(price?.limitations ?? []), ...weatherNotes,
    ...(alerts?.limitations ?? []), ...careNotes, ...noteNotes, ...footprintNotes, ...overviewNotes,
  ].map((s) => cap(s, 1000)))];

  return {...composed, overview, limitations};
}
