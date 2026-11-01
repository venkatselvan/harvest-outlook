/**
 * Market timeline (docs/research/ROUND2_SPEC.md section 3.1): one weekly timeline per product for a farm, from
 * `monthsBack` months before today to `monthsAhead` months after, with price, weather and events per ISO week, plus
 * "years with similar rain" (analogues), a selection of history and never a forecast. Every number is computed here
 * or in the composed code modules; no model is called.
 *
 * Composition: farm (404 for a foreign or deleted farm, first) -> workspace -> current cycle -> product identity ->
 * stage timeline (harvest window, only for the cycle growing the selected product) -> in parallel: the seasonal
 * reference for all 52 ISO weeks (price-series.ts `seasonalReferenceByWeek`), the weather track (weather-track.ts,
 * in chunks of at most 798 days, one shared weather source), monsoon observations, alerts -> the weekly price series
 * (one `priceSeries` read covering the timeline and the analogue years) -> points, events, analogues.
 *
 * Documented choices that change results (each also stated in `limitations` when it applies):
 * - "today" is the Asia/Kolkata calendar date of `asOf`, like the Today view; weeks are ISO weeks starting Monday;
 * - price scope: when the seasonal reference for the headline week (harvest-window midpoint of the matching cycle, else
 *   today's week) is available, its level decides: district when it resolved to the district, else the state pool, and
 *   the observed weeks use the same pool (as the Today view does). When the headline reference is not available, the
 *   observed series asks for the district and `priceSeries` falls back by its own trading-day rule. Observed prices
 *   from other states (national fallback) are never shown;
 * - weeks up to and including the one that contains today are observed (or empty); later weeks carry the reference;
 * - a week's weather takes the kind that covers most of its days (ties go to the less certain kind: typical, then
 *   forecast) and summarises those days only, with `days` = how many; the weather track never labels a day after the
 *   stored forecast's horizon as forecast, so no week starting after the horizon can be a forecast week;
 * - price moves: a week's observed median at least PRICE_MOVE_PCT above or below the median of the previous four weekly
 *   medians, when at least three of those four weeks have quotes;
 * - analogues: a past crop year (July to June, named by its monsoon year) qualifies when all 122 days of its 1 June to
 *   30 September rain are stored at the field point and its crop year has at least MIN_ANALOGUE_WEEKS weekly medians.
 *   This season's total is the stored observed days plus typical (climatology) values for the days not yet observed.
 */
import {MarketTimeline, type FarmWorkspace, type MarketAnalogueYear, type MarketAnalogues, type MarketEvent, type MarketPricePoint, type MarketTimelinePoint, type MarketWeatherPoint} from '@harvest/contracts';
import type {CatalogueSnapshot} from '../catalogue/snapshot';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import type {FetchLike} from '../ingest/http';
import {READABLE_ROW_MODES} from '../ingest/scope';
import {isoWeek} from '../plans/adapters/market-outlook';
import {createWeatherSource} from '../plans/adapters/weather-source';
import type {DailyWeather, WeatherScope, WeatherSource} from '../plans/sources';
import type {ProviderConfig} from '../providers/config';
import {ApiError, notFound} from './errors';
import {enqueue} from './jobs';
import {roundCoord} from '../providers/openmeteo/client';
import {normalizeIngestPayload} from '../worker/handlers/ingest';
import {getFarm} from './farms';
import {median, priceSeries, resolveStateName, seasonalReferenceByWeek, type PriceBucket, type PriceSeries, type SeasonalReferenceByWeek, type SeasonalWeekReference} from './price-series';
import {stageTimeline} from './today/stage-timeline';
import {weatherTrack, type WeatherTrack, type WeatherTrackDay} from './today/weather-track';
import {boundaryMetrics, getWorkspace} from './workspace';

// ------------------------------------------------------------------ constants (design choices, see the header)

export const MAX_POINTS = 400;
export const PRICE_MOVE_PCT = 15;
export const PRICE_MOVE_LOOKBACK_WEEKS = 4;
export const PRICE_MOVE_MIN_PRIOR_WEEKS = 3;
export const MONSOON_DAYS = 122; // 1 June to 30 September
export const MIN_ANALOGUE_WEEKS = 13;
export const ANALOGUE_MAX_YEARS = 15;
export const MAX_ANALOGUES = 6;
const MAX_EVENTS_PER_WEEK = 20;
const WEATHER_CHUNK_DAYS = 798;
const MAX_ALERT_ROWS = 500;

/** Archive rows usually lag a few days; days this close to today are not counted as missing for the season backfill. */
export const ARCHIVE_LAG_DAYS = 5;
export const SEASON_FETCHING_REASON = "This season's rain is being fetched for the field; check again in a few minutes.";

export const ANALOGUE_LIMITATION = 'Years with similar rain are a selection of history, not a forecast: they show how mandi prices moved in past crop years whose 1 June to 30 September rain at this field was closest to this season\'s.';

// ------------------------------------------------------------------ deps and options

export interface MarketTimelineDeps {
  config: Pick<Config, 'RUNTIME_MODE'> & Partial<Pick<Config, 'WEATHER_CLIMATOLOGY_YEARS' | 'WEATHER_CLIMATOLOGY_END_YEAR'>>;
  pool: Pool;
  now?: (() => Date) | undefined;
  /** Open-Meteo fetch for the weather source's bounded live ingest. */
  weatherFetch?: FetchLike | undefined;
  providerConfig?: ProviderConfig | undefined;
  /** Injected weather source (tests). Default: `createWeatherSource` over the pool, auto-ingest in live mode only. */
  weatherSource?: WeatherSource | undefined;
  /** Catalogue stage models for the harvest window; default data/curated/stages. */
  snapshot?: Pick<CatalogueSnapshot, 'stages'> | undefined;
}

export interface MarketTimelineOptions {
  /** Product slug or id; default the current cycle's product. */
  productId?: string | undefined;
  monthsBack?: number | undefined;
  monthsAhead?: number | undefined;
  /** Instant the timeline is computed for (default now). Its IST calendar date is "today". */
  asOf?: string | Date | undefined;
}

// ------------------------------------------------------------------ dates (calendar dates, UTC arithmetic)

const DAY_MS = 86_400_000;
const istDate = (d: Date) => new Date(d.getTime() + 19_800_000).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
export const mondayOf = (d: string) => addDays(d, 1 - (new Date(`${d}T00:00:00Z`).getUTCDay() || 7));
const minDate = (a: string, b: string) => (a < b ? a : b);
/** Same day of month `n` months later (clamped to the month's last day). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
/** Same month and day `n` years earlier or later (29 February becomes 28 February). */
export function shiftYears(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y + n, m - 1, m === 2 && d === 29 ? 28 : d)).toISOString().slice(0, 10);
}
export const isoWeekLabel = (monday: string) => { const w = isoWeek(monday); return `${w.year}-W${String(w.week).padStart(2, '0')}`; };
/** ISO week 53 shares the seasonal reference of week 52. */
const weekBucket = (date: string) => Math.min(52, isoWeek(date).week);
/** Monsoon year of the crop year (July to June) that contains `date`. */
export const cropYearOf = (date: string) => { const y = Number(date.slice(0, 4)); return Number(date.slice(5, 7)) >= 7 ? y : y - 1; };
export const cropYearLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const r1 = (x: number) => Math.round((x + Number.EPSILON) * 10) / 10;
const r3 = (x: number) => Math.round((x + Number.EPSILON) * 1000) / 1000;
const fmtInr = (x: number) => (x >= 100 ? String(Math.round(x)) : x.toFixed(1));

function checkInt(name: string, v: number, min: number, max: number): number {
  if (!Number.isInteger(v) || v < min || v > max) throw new ApiError(400, 'validation_failed', `${name} must be an integer from ${min} to ${max}`);
  return v;
}

// ------------------------------------------------------------------ weeks

export interface Week { weekStart: string; weekEnd: string; isoWeek: string }

/** Monday-start ISO weeks covering [first, last]; at most `max` weeks, the oldest dropped first. */
export function weekRange(first: string, last: string, max = MAX_POINTS): {weeks: Week[]; trimmedFrom: string | null} {
  const to = addDays(mondayOf(last), 6);
  let from = mondayOf(first);
  let trimmedFrom: string | null = null;
  if (dayDiff(from, to) + 1 > max * 7) { trimmedFrom = from; from = addDays(to, -(max * 7 - 1)); }
  const weeks: Week[] = [];
  for (let m = from; m <= to; m = addDays(m, 7)) weeks.push({weekStart: m, weekEnd: addDays(m, 6), isoWeek: isoWeekLabel(m)});
  return {weeks, trimmedFrom};
}

// ------------------------------------------------------------------ weather per week

const KIND_ORDER = ['observed', 'forecast', 'typical'] as const;

/** One week of daily track values -> one weekly point (rule in the header). */
export function weeklyWeather(days: Pick<WeatherTrackDay, 'kind' | 'rainMm' | 'tMaxC' | 'tMinC'>[]): MarketWeatherPoint {
  const counts = KIND_ORDER.map((k) => days.filter((d) => d.kind === k).length);
  let best = -1;
  for (let i = 0; i < KIND_ORDER.length; i++) if (counts[i]! > 0 && (best < 0 || counts[i]! >= counts[best]!)) best = i;
  if (best < 0) return {kind: 'unavailable', rainMm: null, tMaxC: null, tMinC: null, days: 0};
  const kind = KIND_ORDER[best]!;
  const sel = days.filter((d) => d.kind === kind);
  const vals = (pick: (d: (typeof sel)[number]) => number | null) => sel.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
  const rain = vals((d) => d.rainMm), tMax = vals((d) => d.tMaxC), tMin = vals((d) => d.tMinC);
  const avg = (xs: number[]) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {kind, rainMm: rain.length ? r1(rain.reduce((a, b) => a + b, 0)) : null, tMaxC: avg(tMax), tMinC: avg(tMin), days: Math.min(7, sel.length)};
}

// ------------------------------------------------------------------ price moves

export interface WeeklyPrice { weekStart: string; weekEnd: string; p50: number | null }
export interface PriceMoveStat { weekStart: string; weekEnd: string; p50: number; priorMedian: number; priorWeeks: number; changePct: number }

/** Weeks whose median moved at least PRICE_MOVE_PCT against the median of the previous four weekly medians. */
export function priceMoves(weeks: WeeklyPrice[]): PriceMoveStat[] {
  const sorted = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const byStart = new Map(sorted.map((w) => [w.weekStart, w]));
  const out: PriceMoveStat[] = [];
  for (const w of sorted) {
    if (w.p50 === null) continue;
    const prior: number[] = [];
    for (let k = 1; k <= PRICE_MOVE_LOOKBACK_WEEKS; k++) { const p = byStart.get(addDays(w.weekStart, -7 * k))?.p50; if (p !== null && p !== undefined) prior.push(p); }
    if (prior.length < PRICE_MOVE_MIN_PRIOR_WEEKS) continue;
    const m = median(prior);
    if (!(m > 0)) continue;
    const pct = ((w.p50 - m) / m) * 100;
    if (Math.abs(pct) >= PRICE_MOVE_PCT - 1e-9) out.push({weekStart: w.weekStart, weekEnd: w.weekEnd, p50: w.p50, priorMedian: Math.round(m * 100) / 100, priorWeeks: prior.length, changePct: r1(pct)});
  }
  return out;
}

// ------------------------------------------------------------------ analogues

export interface MonsoonYear { year: number; rainMm: number }

/** Complete monsoon totals (all 122 days stored with rain) per year from daily observations. */
export function monsoonTotals(days: Pick<DailyWeather, 'date' | 'rainMm'>[], years: number[]): MonsoonYear[] {
  const byDate = new Map(days.filter((d) => d.rainMm !== null && Number.isFinite(d.rainMm)).map((d) => [d.date, d.rainMm!]));
  const out: MonsoonYear[] = [];
  for (const y of years) {
    let sum = 0, n = 0;
    for (let d = `${y}-06-01`; d <= `${y}-09-30`; d = addDays(d, 1)) { const v = byDate.get(d); if (v !== undefined) { sum += v; n++; } }
    if (n === MONSOON_DAYS) out.push({year: y, rainMm: r1(sum)});
  }
  return out;
}

/** 1 - |rain_year - rain_now| / max(rain_now, 1), clipped to 0..1. */
export function rainSimilarity(rainYear: number, rainNow: number): number {
  return Math.min(1, Math.max(0, 1 - Math.abs(rainYear - rainNow) / Math.max(rainNow, 1)));
}

export interface AnalogueInput {
  monsoon: MonsoonYear[];
  rainNow: number;
  /** Observed weekly medians keyed by the Monday of the week. */
  weekly: Map<string, number>;
  /** The current crop year (monsoon year). */
  currentYear: number;
  /** Matching cycle: sowing date and harvest-window midpoint. */
  cycle: {sowing: string; harvestMid: string} | null;
}

/** Qualifying years (rain and at least MIN_ANALOGUE_WEEKS weekly medians), sorted by similarity, then most recent. */
export function analogueYears(i: AnalogueInput): MarketAnalogueYear[] {
  const out: (MarketAnalogueYear & {year: number})[] = [];
  for (const m of i.monsoon) {
    if (m.year >= i.currentYear) continue;
    const path: {isoWeek: number; p50: number}[] = [];
    const seen = new Set<number>();
    const july = `${m.year}-07-01`;
    // Weeks whose Monday falls inside the crop year (1 July to 30 June).
    for (let monday = mondayOf(july) < july ? addDays(mondayOf(july), 7) : july; monday <= `${m.year + 1}-06-30`; monday = addDays(monday, 7)) {
      const p = i.weekly.get(monday);
      const wk = isoWeek(monday).week;
      if (p === undefined || seen.has(wk)) continue;
      seen.add(wk);
      path.push({isoWeek: wk, p50: p});
    }
    if (path.length < MIN_ANALOGUE_WEEKS) continue;
    let harvestChangePct: number | null = null;
    if (i.cycle) {
      const k = i.currentYear - m.year;
      const s = i.weekly.get(mondayOf(shiftYears(i.cycle.sowing, -k)));
      const h = i.weekly.get(mondayOf(shiftYears(i.cycle.harvestMid, -k)));
      if (s !== undefined && h !== undefined && s > 0) harvestChangePct = r1((h / s - 1) * 100);
    }
    out.push({year: m.year, cropYear: cropYearLabel(m.year), rainMm: m.rainMm, similarity: r3(rainSimilarity(m.rainMm, i.rainNow)), pricePath: path.slice(0, 60), harvestChangePct});
  }
  return out.sort((a, b) => b.similarity - a.similarity || b.year - a.year).map(({year: _year, ...rest}) => rest);
}

// ------------------------------------------------------------------ small readers

type Cycle = FarmWorkspace['cycles'][number];

/** Same rule as the Today view: the not-harvested cycle with the latest establishment (else sowing) date. */
function currentCycle(workspace: FarmWorkspace): Cycle | null {
  const anchorOf = (c: Cycle) => c.establishmentDate ?? c.sowingDate;
  return [...workspace.cycles].filter((c) => c.stage !== 'harvested').sort((a, b) => anchorOf(b).localeCompare(anchorOf(a)))[0] ?? null;
}

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

interface ProductIdentity { slug: string; name: string; cropSlug: string | null; cropName: string; known: boolean }
const humanize = (s: string) => s.replace(/[-_]+/g, ' ').trim();

async function productIdentity(pool: Pool, productId: string): Promise<ProductIdentity> {
  const row = (await pool.query<{slug: string; name: string; crop_slug: string; names: unknown}>(
    `SELECT p.slug, p.name, c.slug AS crop_slug, c.names FROM crop_products p JOIN crop_identities c ON c.id = p.crop_id
      WHERE p.slug = $1 OR p.id::text = $1 LIMIT 1`, [productId])).rows[0];
  if (!row) return {slug: productId, name: cap(humanize(productId), 120), cropSlug: null, cropName: cap(humanize(productId.split(/[-_]/)[0] ?? productId), 120), known: false};
  return {slug: row.slug, name: cap(row.name, 120), cropSlug: row.crop_slug, cropName: cap(nameFrom(row.names) ?? humanize(row.crop_slug), 120), known: true};
}

interface AlertRow { id: string; type: MarketEvent['type'] & string; severity: MarketEvent['severity']; title: string; detail: string; source: {name?: string; url?: string; date?: string}; valid_from: string; valid_to: string; dismissed: boolean }

/** Every alert of this farm and mode whose validity overlaps [from, to], dismissed and expired rows included. Owner-scoped through the parent farm. */
async function loadAlerts(pool: Pool, ownerId: string, farmId: string, mode: string, from: string, to: string): Promise<AlertRow[]> {
  const r = await pool.query<AlertRow>(
    `SELECT a.id, a.type, a.severity, a.title, a.detail, a.source, to_char(a.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(a.valid_to, 'YYYY-MM-DD') AS valid_to,
            (a.dismissed_at IS NOT NULL) AS dismissed
       FROM farm_alerts a JOIN farms f ON f.id = a.farm_id AND f.owner_id = a.owner_id
      WHERE a.farm_id = $1 AND a.owner_id = $2 AND a.mode = $3 AND a.valid_to >= $4::date AND a.valid_from <= $5::date AND f.deleted_at IS NULL
      ORDER BY a.valid_from, a.id LIMIT ${MAX_ALERT_ROWS}`, [farmId, ownerId, mode, from, to]);
  return r.rows;
}

/** Most-used source document of the product's stored quotes in the window (for price-move links). */
async function priceSource(pool: Pool, mode: Config['RUNTIME_MODE'], productSlug: string, from: string, to: string): Promise<{name: string; url: string | null} | null> {
  const r = await pool.query<{title: string | null; url: string | null}>(
    `SELECT sd.title, sd.url FROM (
        SELECT m.source_id, count(*) AS n FROM market_observations m JOIN crop_products p ON p.id = m.product_id
         WHERE (p.slug = $1 OR p.id::text = $1) AND m.mode = ANY($2::text[]) AND m.is_synthetic = $3 AND m.observed_on BETWEEN $4 AND $5
         GROUP BY m.source_id ORDER BY n DESC LIMIT 1) s
       JOIN source_documents sd ON sd.id = s.source_id`, [productSlug, [...READABLE_ROW_MODES[mode]], mode === 'synthetic', from, to]);
  const row = r.rows[0];
  if (!row) return null;
  const url = row.url && /^https?:\/\//.test(row.url) ? row.url : null;
  // Only a data.gov.in resource is named as such; synthetic fixtures keep their own title.
  return {name: cap(url && /^https:\/\/(api\.)?data\.gov\.in\//.test(url) ? `data.gov.in: ${row.title ?? 'daily mandi prices'}` : row.title ?? 'Stored mandi quotes', 200), url};
}

const SEVERITY_RANK: Record<MarketEvent['severity'], number> = {warning: 0, watch: 1, info: 2};

function scopeLabel(level: 'market' | 'district' | 'state' | 'national', stateName: string | null, districtName: string | null, markets: number): string {
  const n = `${markets} market${markets === 1 ? '' : 's'}`;
  if (level === 'district' && districtName) return `${districtName} district mandis, ${n}`;
  if (level === 'state' && stateName) return `${stateName} mandis, ${n}`;
  if (level === 'market') return `Selected mandis, ${n}`;
  return `All-India mandis, ${n}`;
}

// ------------------------------------------------------------------ the timeline

export async function marketTimeline(deps: MarketTimelineDeps, ownerId: string, farmId: string, opts: MarketTimelineOptions = {}): Promise<MarketTimeline> {
  const mode = deps.config.RUNTIME_MODE;
  const at = opts.asOf !== undefined ? new Date(opts.asOf) : (deps.now ?? (() => new Date()))();
  if (Number.isNaN(at.getTime())) throw new ApiError(400, 'validation_failed', 'asOf must be a valid instant');
  const monthsBack = checkInt('monthsBack', opts.monthsBack ?? 36, 1, 60);
  const monthsAhead = checkInt('monthsAhead', opts.monthsAhead ?? 12, 0, 18);
  const asOf = at.toISOString();
  const today = istDate(at);
  const now = () => at;

  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const workspace = await getWorkspace(deps.pool, ownerId, farmId);
  const cycle = currentCycle(workspace);
  const requested = opts.productId?.trim() || cycle?.productId || null;
  if (!requested) throw new ApiError(400, 'validation_failed', 'productId is required: the farm has no current crop with a recorded product');
  const product = await productIdentity(deps.pool, requested);
  const limitations: string[] = [];

  // ---- weeks
  const {weeks, trimmedFrom} = weekRange(addMonths(today, -monthsBack), addMonths(today, monthsAhead));
  const from = weeks[0]!.weekStart, to = weeks.at(-1)!.weekEnd;
  const todayIndex = Math.max(0, Math.min(weeks.length - 1, dayDiff(from, mondayOf(today)) / 7));
  if (trimmedFrom) limitations.push(`The timeline holds at most ${MAX_POINTS} weeks, so it starts on ${from} instead of ${trimmedFrom}.`);

  // ---- harvest window: only for the cycle that grows the selected product
  const cycleMatches = !!cycle && (cycle.productId ? cycle.productId === product.slug || cycle.productId === requested : !!product.cropSlug && cycle.cropId === product.cropSlug);
  let harvestWindow: MarketTimeline['harvestWindow'] = null;
  let sowing: string | null = null;
  if (cycle && cycleMatches) {
    sowing = cycle.establishmentDate ?? cycle.sowingDate;
    try {
      const t = stageTimeline({cropId: cycle.cropId, productId: cycle.productId ?? null, establishmentMethod: cycle.establishmentMethod ?? null, anchorDate: sowing, stateId: farm.location.stateCode, districtId: farm.location.districtId, snapshot: deps.snapshot});
      harvestWindow = t.harvest ? {earliest: t.harvest.earliest, latest: t.harvest.latest} : null;
      if (!t.harvest) limitations.push('No sourced crop duration gives a harvest window for the current crop, so none is shaded.');
      else limitations.push(`The harvest window is a calendar estimate from the recorded ${cycle.establishmentDate ? 'establishment' : 'sowing'} date (${t.basis.label}); not an observation.`);
    } catch {
      limitations.push('The harvest window could not be computed for the current crop.');
    }
  } else if (cycle) {
    limitations.push('The current crop grows a different product, so no harvest window is shaded for this product.');
  }
  const harvestMid = harvestWindow ? addDays(harvestWindow.earliest, Math.floor(dayDiff(harvestWindow.earliest, harvestWindow.latest) / 2)) : null;

  // ---- weather source (shared by the track and the monsoon reads)
  let point: {lat: number; lon: number} | null = null;
  if (workspace.boundary) { const m = boundaryMetrics(workspace.boundary); point = {lat: m.lat, lon: m.lon}; }
  else if (farm.location.lat !== null && farm.location.lon !== null) point = {lat: farm.location.lat, lon: farm.location.lon};
  const source: WeatherSource = deps.weatherSource ?? createWeatherSource({
    pool: deps.pool, mode, autoIngest: mode === 'live', now,
    ...(deps.weatherFetch ? {fetchImpl: deps.weatherFetch} : {}),
    ...(deps.providerConfig ? {providerConfig: deps.providerConfig} : {}),
    ...(deps.config.WEATHER_CLIMATOLOGY_YEARS !== undefined ? {climatologyYears: deps.config.WEATHER_CLIMATOLOGY_YEARS} : {}),
    ...(deps.config.WEATHER_CLIMATOLOGY_END_YEAR !== undefined ? {climatologyEndYear: deps.config.WEATHER_CLIMATOLOGY_END_YEAR} : {}),
  });
  const scope: WeatherScope = {farmId, districtId: null, stateId: null, point: point ? {lon: point.lon, lat: point.lat} : null};
  const currentYear = cropYearOf(today);
  const yesterday = addDays(today, -1);

  const stateName = resolveStateName(farm.location.stateCode);
  const districtName = farm.location.districtName?.trim() || null;

  // ---- this season's observations first: 1 June of the current crop year to yesterday (at most 366 days). In live mode
  // an empty range lets the weather source backfill it (bounded, once per 15 minutes per point), before the wider reads
  // below could use up that attempt on older data.
  const seasonStart = `${currentYear}-06-01`;
  const seasonDays: DailyWeather[] = point && seasonStart <= yesterday ? await source.getDailyObservations(scope, {start: seasonStart, end: yesterday}, {availableBy: asOf}) : [];

  // ---- parallel reads
  const weatherTask = (async (): Promise<WeatherTrack | null> => {
    if (!point) return null;
    const days: WeatherTrackDay[] = [];
    const notes: string[] = [];
    let horizon: string | null = null;
    for (let start = from; start <= to; start = addDays(start, WEATHER_CHUNK_DAYS)) {
      const end = minDate(to, addDays(start, WEATHER_CHUNK_DAYS - 1));
      const t = await weatherTrack({source}, {point, from: start, to: end, asOf, mode, farmId});
      days.push(...t.days);
      notes.push(...t.limitations);
      horizon = t.forecastHorizonEnd ?? horizon;
    }
    return {days, forecastHorizonEnd: horizon, limitations: [...new Set(notes)]};
  })();
  const monsoonTask = (async (): Promise<DailyWeather[]> => {
    if (!point) return [];
    const start = `${currentYear - ANALOGUE_MAX_YEARS}-06-01`;
    const end = `${currentYear - 1}-09-30`;
    return source.getDailyObservations(scope, {start, end}, {availableBy: asOf});
  })();
  const refTask: Promise<SeasonalReferenceByWeek | null> = stateName ? seasonalReferenceByWeek(deps.pool, mode, {productId: product.slug, stateName, districtName, asOf: today}) : Promise.resolve(null);
  const alertsTask = loadAlerts(deps.pool, ownerId, farmId, mode, from, to);
  const [track, pastMonsoonDays, ref, alerts] = await Promise.all([weatherTask, monsoonTask, refTask, alertsTask]);

  // ---- monsoon: past complete years and this season (observed + typical remainder)
  const pastYears = Array.from({length: ANALOGUE_MAX_YEARS}, (_, i) => currentYear - ANALOGUE_MAX_YEARS + i);
  const monsoon = monsoonTotals(pastMonsoonDays, pastYears);
  let thisSeason: MarketAnalogues['thisSeason'] = null;
  let rainNow: number | null = null;
  let seasonNote: string | null = null;
  if (point) {
    const observed = new Map(seasonDays.filter((d) => d.date >= `${currentYear}-06-01` && d.date <= `${currentYear}-09-30` && d.rainMm !== null && Number.isFinite(d.rainMm)).map((d) => [d.date, d.rainMm!]));
    const missing: string[] = [];
    for (let d = `${currentYear}-06-01`; d <= `${currentYear}-09-30`; d = addDays(d, 1)) if (!observed.has(d)) missing.push(d);
    const observedSum = [...observed.values()].reduce((a, b) => a + b, 0);
    const observedThrough = observed.size ? [...observed.keys()].sort().at(-1)! : null;
    let remainder: number | null = 0;
    if (missing.length) {
      const clim = await source.getClimatology(scope, {start: missing[0]!, end: missing.at(-1)!}, mode === 'replay' ? {availableBy: asOf} : undefined).catch(() => null);
      const typical = new Map((clim?.days ?? []).filter((d) => d.rainMm !== null).map((d) => [d.date, d.rainMm!]));
      remainder = missing.every((d) => typical.has(d)) ? missing.reduce((a, d) => a + typical.get(d)!, 0) : null;
      if (remainder === null) seasonNote = 'typical rain is not available for the days of this season not yet observed';
    }
    if (!observed.size) seasonNote = 'no rain observations are stored for this season at the field';
    rainNow = observed.size && remainder !== null ? r1(observedSum + remainder) : null;
    thisSeason = {cropYear: cropYearLabel(currentYear), rainMm: rainNow, observedThrough, typicalRemainderMm: remainder === null ? null : r1(remainder)};
    if (observed.size && missing.length && remainder !== null) limitations.push(`This season's rain is ${observed.size} observed days to ${observedThrough} plus typical values for the ${missing.length} remaining day${missing.length > 1 ? 's' : ''} of 1 June to 30 September.`);
  }

  // ---- live only: when this season's monsoon days (up to the archive lag) are missing at the field point, queue one
  // archive job for 1 January of the monsoon year to yesterday (same enqueue and dedupe key as the climatology backfill;
  // one attempt per point and year, no network in this request). The worker stores the rows; a later read uses them.
  let seasonFetching = false;
  if (mode === 'live' && point) {
    const lagEnd = minDate(`${currentYear}-09-30`, addDays(today, -(ARCHIVE_LAG_DAYS + 1)));
    const expected = lagEnd >= `${currentYear}-06-01` ? dayDiff(`${currentYear}-06-01`, lagEnd) + 1 : 0;
    const have = seasonDays.filter((d) => d.date >= `${currentYear}-06-01` && d.date <= lagEnd && d.rainMm !== null).length;
    if (expected > 0 && have < expected) {
      const key = `clim:${roundCoord(point.lat)},${roundCoord(point.lon)}:${currentYear}`;
      const end = minDate(yesterday, `${currentYear}-12-31`);
      await enqueue(deps.pool, 'ingest.weather_archive', normalizeIngestPayload('ingest.weather_archive', {lat: point.lat, lon: point.lon, start: `${currentYear}-01-01`, end}), null, key).catch(() => undefined);
      const job = (await deps.pool.query<{state: string}>('SELECT state FROM jobs WHERE owner_id IS NULL AND idempotency_key = $1', [key])).rows[0];
      seasonFetching = job?.state === 'queued' || job?.state === 'running';
    }
  }

  // ---- price scope and observed weekly series (timeline and analogue years in one read)
  const headlineDate = harvestMid ?? today;
  const headline: SeasonalWeekReference | null = ref ? ref.weeks[weekBucket(headlineDate) - 1]! : null;
  const useDistrict = !!headline && (headline.status === 'available' ? headline.scope.level === 'district' : true);
  const refWeeks: SeasonalWeekReference[] | null = ref ? (headline && headline.status === 'available' && headline.scope.level !== 'district' ? ref.stateWeeks : ref.weeks) : null;
  const earliestRain = monsoon[0]?.year;
  const histFrom = minDate(addDays(from, -7 * PRICE_MOVE_LOOKBACK_WEEKS), earliestRain !== undefined ? mondayOf(`${earliestRain}-07-01`) : from);
  let series: PriceSeries | null = null;
  if (stateName && histFrom <= today) series = await priceSeries(deps.pool, mode, {productId: product.slug, stateName, districtName: useDistrict ? districtName : null, from: histFrom, to: today, bucket: 'week', asOf: today});
  const seriesUsable = !!series && (series.scope.level === 'district' || series.scope.level === 'state') && series.coverage.validDays > 0;
  const bucketByWeek = new Map<string, PriceBucket>();
  if (series && seriesUsable) for (const b of series.buckets) bucketByWeek.set(mondayOf(b.start), b);
  const weeklyP50 = new Map<string, number>();
  for (const [k, b] of bucketByWeek) if (b.p50 !== null && b.n > 0) weeklyP50.set(k, b.p50);

  // ---- scope label
  let scopeOut: MarketTimeline['scope'];
  const notIngested = (series?.missingReason === 'price_history_not_ingested') || (ref?.weeks.every((w) => w.missingReason === 'price_history_not_ingested') ?? false);
  if (!stateName) {
    scopeOut = {level: 'state', stateName: null, districtName: null, marketCount: 0, label: 'The farm state is not recorded, so no mandi price series applies'};
  } else if (series && seriesUsable) {
    scopeOut = {level: series.scope.level, stateName: series.scope.stateName, districtName: series.scope.districtName, marketCount: series.scope.marketCount, label: cap(scopeLabel(series.scope.level, series.scope.stateName, series.scope.districtName, series.scope.marketCount), 160)};
  } else if (headline && headline.status === 'available') {
    scopeOut = {level: headline.scope.level, stateName: headline.scope.stateName, districtName: headline.scope.districtName, marketCount: headline.scope.marketCount, label: cap(scopeLabel(headline.scope.level, headline.scope.stateName, headline.scope.districtName, headline.scope.marketCount), 160)};
  } else {
    scopeOut = {level: 'state', stateName, districtName: null, marketCount: 0, label: cap(`${product.name} in ${stateName}: ${notIngested ? 'no verified mandi price series is stored' : 'no mandi quotes in this state'}`, 160)};
  }
  const noneReason = !stateName ? 'farm_state_unknown' : notIngested ? 'price_history_not_ingested' : !seriesUsable ? 'no_state_quotes' : 'no_quotes_this_week';

  // ---- price moves (observed weeks inside the timeline, using up to four earlier weeks)
  const weeklyList: WeeklyPrice[] = [...bucketByWeek.entries()].map(([k, b]) => ({weekStart: k, weekEnd: addDays(k, 6), p50: b.n > 0 ? b.p50 : null}));
  const moves = priceMoves(weeklyList).filter((m) => m.weekStart >= from && m.weekStart <= today);
  const moveSource = moves.length && series ? await priceSource(deps.pool, mode, product.slug, from, today).catch(() => null) : null;
  const movesByWeek = new Map(moves.map((m) => [m.weekStart, m]));

  // ---- points
  let otherScopeWeeks = 0;
  const points: MarketTimelinePoint[] = weeks.map((w): MarketTimelinePoint => {
    let price: MarketPricePoint;
    if (w.weekStart <= today) {
      const b = bucketByWeek.get(w.weekStart);
      price = b && b.n > 0 && b.p50 !== null && b.min !== null && b.max !== null
        ? {kind: 'observed', p50: b.p50, min: b.min, max: b.max, n: b.n, markets: b.markets}
        : {kind: 'none', reason: noneReason};
    } else {
      const r = refWeeks?.[weekBucket(w.weekStart) - 1];
      if (r && r.status === 'available' && r.p50 !== null && r.p10 !== null && r.p25 !== null && r.p75 !== null && r.p90 !== null) {
        price = {kind: 'reference', p50: r.p50, likely: {low: r.p25, high: r.p75}, possible: {low: r.p10, high: r.p90}, yearsUsed: r.yearsUsed.slice(-6), observations: r.observations};
        if (scopeOut.level !== r.scope.level) otherScopeWeeks++;
      } else {
        price = {kind: 'none', reason: cap(!stateName ? 'farm_state_unknown' : r?.missingReason ?? 'price_history_not_ingested', 80)};
      }
    }

    const dayRows = track ? track.days.filter((d) => d.date >= w.weekStart && d.date <= w.weekEnd) : [];
    const weather = weeklyWeather(dayRows);

    const events: MarketEvent[] = [];
    for (const a of alerts) {
      if (a.valid_to < w.weekStart || a.valid_from > w.weekEnd) continue;
      const src = a.source ?? {};
      events.push({
        id: cap(a.id, 160), kind: 'alert', type: a.type, severity: a.severity, title: cap(a.title, 120), detail: cap(a.detail, 600), date: a.valid_from,
        source: src.name ? {name: cap(src.name, 200), url: src.url && /^https?:\/\//.test(src.url) ? src.url : null, date: src.date && /^\d{4}-\d{2}-\d{2}$/.test(src.date) ? src.date : null} : null,
        alertId: a.id, dismissed: a.dismissed, validTo: a.valid_to,
      });
    }
    const mv = movesByWeek.get(w.weekStart);
    if (mv) {
      const up = mv.changePct > 0;
      const date = minDate(mv.weekEnd, today);
      events.push({
        id: `price_move:${w.weekStart}`, kind: 'price_move', type: 'price', severity: 'info',
        title: cap(`Mandi price ${up ? 'up' : 'down'} ${Math.abs(Math.round(mv.changePct))}% this week`, 120),
        detail: cap(`Weekly median ₹${fmtInr(mv.p50)}/kg against ₹${fmtInr(mv.priorMedian)}/kg, the median of the previous ${mv.priorWeeks} weekly medians (${scopeOut.label}). Wholesale modal prices, not farm-gate prices; computed from stored quotes.`, 600),
        date, source: moveSource ? {name: moveSource.name, url: moveSource.url, date} : null, alertId: null, dismissed: false,
      });
    }
    events.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    return {weekStart: w.weekStart, weekEnd: w.weekEnd, isoWeek: w.isoWeek, price, weather, events: events.slice(0, MAX_EVENTS_PER_WEEK)};
  });

  // ---- analogues
  let analogues: MarketAnalogues;
  if (!point) {
    analogues = {status: 'insufficient', reason: 'No field location is recorded, so rain at the field cannot be read.', thisSeason: null, years: []};
  } else if (rainNow === null && seasonFetching) {
    analogues = {status: 'insufficient', reason: SEASON_FETCHING_REASON, thisSeason, years: []};
  } else if (rainNow === null) {
    analogues = {status: 'insufficient', reason: cap(`This season's 1 June to 30 September rain total is not known: ${seasonNote ?? 'rain observations are missing'}.`, 200), thisSeason, years: []};
  } else {
    const years = analogueYears({monsoon, rainNow, weekly: weeklyP50, currentYear, cycle: sowing && harvestMid ? {sowing, harvestMid} : null});
    analogues = years.length >= 2
      ? {status: 'available', reason: null, thisSeason, years: years.slice(0, MAX_ANALOGUES)}
      : {status: 'insufficient', reason: cap(`Fewer than two past crop years have both complete June to September rain at the field and mandi prices (found ${years.length}).`, 200), thisSeason, years: []};
  }

  // ---- limitations (deduplicated, capped)
  limitations.push(ANALOGUE_LIMITATION);
  limitations.push(`Monsoon rain is the 1 June to 30 September total at the field point from stored Open-Meteo archive reanalysis (a gridded model estimate, not station measurements); a past year counts only when all ${MONSOON_DAYS} days are stored and its crop year (July to June) has at least ${MIN_ANALOGUE_WEEKS} weeks with mandi quotes. Similarity is 1 minus the rain difference as a share of this season's rain.`);
  if (seriesUsable) limitations.push('Observed points are the weekly median of market-day modal prices; the shaded range is the lowest to highest market-day value that week, not a forecast interval. Weeks without quotes have no value.');
  else if (stateName && !notIngested) limitations.push(`No ${stateName} mandi quotes are stored for this product in this period; observed prices from other states are not shown.`);
  if (refWeeks?.some((w) => w.status === 'available')) limitations.push('Future weeks show the historical seasonal reference for that ISO week (median of past years\' weekly prices within two weeks of it): the likely band is P25 to P75 and the possible band P10 to P90 of past year-to-year dispersion. It is not a forecast.');
  if (otherScopeWeeks) limitations.push(`${otherScopeWeeks} future week${otherScopeWeeks > 1 ? 's use' : ' uses'} a different market pool than the observed prices because the preferred pool had too few quotes near those weeks.`);
  if (headline?.scope.fallbackNote) limitations.push(headline.scope.fallbackNote);
  if (series?.scope.fallbackNote && seriesUsable) limitations.push(series.scope.fallbackNote);
  limitations.push(`Price moves are computed in code: a week whose median is at least ${PRICE_MOVE_PCT} percent above or below the median of the previous ${PRICE_MOVE_LOOKBACK_WEEKS} weekly medians (at least ${PRICE_MOVE_MIN_PRIOR_WEEKS} with quotes).`);
  if (alerts.length) limitations.push('Events include alerts that were later dismissed or have expired, marked as such.');
  if (alerts.length >= MAX_ALERT_ROWS) limitations.push(`Only the first ${MAX_ALERT_ROWS} alerts in this period are shown.`);
  if (track) {
    limitations.push('Each week\'s weather carries the label that covers most of its days (observed, forecast or typical) and summarises those days only; the day count says how many.');
    limitations.push(...track.limitations);
  } else {
    limitations.push('No field boundary or farm point is recorded, so no weather can be located.');
  }
  if (ref) limitations.push(...ref.limitations);
  if (series && seriesUsable) limitations.push(...series.limitations);

  return MarketTimeline.parse({
    farmId, productId: cap(product.slug, 200), productName: product.name, cropName: cycleMatches && cycle?.cropName ? cap(cycle.cropName, 120) : product.cropName,
    asOf, today, from, to, todayIndex, scope: scopeOut, unit: 'INR/kg',
    forecastHorizonEnd: track?.forecastHorizonEnd ?? null, harvestWindow, points, analogues,
    band: {likely: 'p25_p75', possible: 'p10_p90'},
    limitations: [...new Set(limitations.map((s) => cap(s, 600)))],
  });
}
