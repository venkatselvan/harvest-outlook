import type { Mode } from "@harvest/contracts";
import type { Pool } from "../db/pool";
import { ReplayCutoffRequiredError } from "../ingest/errors";
import { MARKET_PRICE_COLUMNS, READABLE_ROW_MODES, scopedQuery } from "../ingest/scope";
import { MANDI_LABEL, MIN_SEASON_YEARS, MIN_VALID_DAYS, isoWeek, stateNameFor } from "../plans/adapters/market-outlook";
import { canonicalMarketKey } from "../providers/datagovin/market-alias";
import { ApiError } from "./errors";

/**
 * Shared price reads for the Year plan and the Today view.
 *
 * Every number is a WHOLESALE MANDI MODAL price in INR/kg (`price_modal_inr_per_kg`, converted at ingest from the
 * published INR/quintal). It is never a farm-gate price and no commission, transport or grading deduction is applied.
 * All reads go through scopedQuery(mode): live never sees synthetic rows, synthetic sees only synthetic rows, replay
 * sees live+replay vintages with available_at <= the cutoff, and unverified commodity mappings are excluded.
 *
 * Aggregation (docs/FORECASTING.md 1.3, extended to pooled scopes):
 *  - a row is valid when modal is finite and > 0 and min <= modal <= max where bounds exist; invalid rows are counted
 *    in coverage.excludedRows, never repaired;
 *  - a market-day value is the median modal across that market's valid rows on that date (varieties, grades,
 *    sources). Markets are identified by state + canonicalMarketKey(name), so Agmarknet renames such as
 *    "Belur" -> "Belur APMC" are one market (a name-level inference, not a source statement);
 *  - bucket p50/min/max and weekly medians are taken over market-day values pooled across the scope's markets.
 *
 * Outputs mirror packages/contracts/src/price-outlook.ts (PriceSeries, HarvestPriceOutlook, PriceTrend); the test
 * suite parses every output with those schemas.
 */

export const PRICE_OUTLOOK_METHOD = "B_seasonal_reference/pooled-v1" as const;
/** Leave-one-year-out residuals required before an interval is reported (B's minResidualPairs, analytics/harvest_analytics/forecast/replay.py). */
export const MIN_RESIDUALS = 12;
/** Months with data required in each 12-month window before a year-on-year change is reported. */
export const YOY_MIN_MONTHS = 9;
const WEEKS_PER_YEAR = 52;

export type PriceScopeLevel = "market" | "district" | "state" | "national";
export type PriceMissingReasonCode = "price_history_not_ingested" | "price_history_insufficient" | "market_not_in_history" | "price_residuals_insufficient" | "price_interval_crossing";

export interface PriceScope {
  level: PriceScopeLevel;
  requestedLevel: PriceScopeLevel;
  stateName: string | null;
  districtName: string | null;
  marketCount: number;
  marketIds: string[];
  fallbackNote: string | null;
}
export interface PriceCoverage { observations: number; markets: number; firstDate: string | null; lastDate: string | null; validDays: number; excludedRows: number }
export interface PriceBucket { start: string; end: string; p50: number | null; min: number | null; max: number | null; n: number; markets: number }
interface Common {
  productId: string;
  status: "available" | "insufficient";
  missingReason: PriceMissingReasonCode | null;
  scope: PriceScope;
  unit: "INR/kg";
  priceBasis: "wholesale_mandi_modal";
  basisLabel: string;
  limitations: string[];
}
export interface PriceSeries extends Common {
  bucket: "week" | "month";
  from: string;
  to: string;
  buckets: PriceBucket[];
  coverage: PriceCoverage;
  gaps: { from: string; to: string }[];
}
export interface HarvestPriceOutlook extends Common {
  method: typeof PRICE_OUTLOOK_METHOD;
  harvestDate: string;
  harvestWeek: { year: number; week: number };
  asOf: string;
  weekWindow: number;
  yearsRequested: number;
  yearsConsidered: number[];
  yearsUsed: number[];
  perYear: { year: number; weeks: number; median: number }[];
  p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null;
  annualMean: number | null;
  annualWeeks: number;
  weeksUsed: number;
  observations: number;
  marketsUsed: number;
  residualCount: number;
}
export interface PriceTrend extends Common {
  months: number;
  asOf: string;
  from: string;
  to: string;
  series: { month: string; p50: number | null; n: number; markets: number }[];
  yoy: { lastMonthsWithData: number; priorMonthsWithData: number; pairedMonths: number; lastMean: number; priorMean: number; changePct: number } | null;
  yoyMissingReason: string | null;
  coverage: PriceCoverage;
}
export interface ProductHistory { productId: string; validDays: number; observations: number; markets: number; firstDate: string | null; lastDate: string | null; meetsMinValidDays: boolean }

const BASIS = { unit: "INR/kg" as const, priceBasis: "wholesale_mandi_modal" as const, basisLabel: MANDI_LABEL };
const WHOLESALE_NOTE = "Wholesale mandi modal prices in INR/kg, not farm-gate prices; no commission, transport or grading deduction is applied.";
const RENAME_NOTE = "Markets and districts renamed in Agmarknet (for example 'Belur' to 'Belur APMC', 'Mysore' to 'Mysuru') are joined by name; this is an inference, not a source statement.";

// ------------------------------------------------------------------ dates (UTC calendar dates only)
const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(utc(d) + n * DAY);
const mondayOf = (d: string) => addDays(d, 1 - (new Date(utc(d)).getUTCDay() || 7));
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number) as [number, number]; const t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); };
const monthEnd = (ym: string) => addDays(`${addMonths(ym, 1)}-01`, -1);
const todayUtc = () => new Date().toISOString().slice(0, 10);
/** Calendar date (the date part of a date or datetime string); rejects impossible dates such as 2026-02-30. */
function checkDate(name: string, v: string): string {
  const d = String(v).slice(0, 10);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? utc(d) : Number.NaN;
  if (!Number.isFinite(t) || iso(t) !== d) throw new ApiError(400, "validation_failed", `${name} must be a calendar date (YYYY-MM-DD)`);
  return d;
}
function checkInt(name: string, v: number, min: number, max: number): number {
  if (!Number.isInteger(v) || v < min || v > max) throw new ApiError(400, "validation_failed", `${name} must be an integer from ${min} to ${max}`);
  return v;
}

/** Monday of ISO week `week` of ISO year `year`. */
export function isoWeekMonday(year: number, week: number): string {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  return iso(jan4 - (dow - 1) * DAY + (week - 1) * 7 * DAY);
}
/** ISO week 53 is pooled with 52 (FORECASTING.md section 3). */
const weekBucket = (w: number) => (w === 53 ? 52 : w);
/** Circular distance between week buckets 1..52. */
const weekDistance = (a: number, b: number) => { const d = Math.abs(a - b); return Math.min(d, WEEKS_PER_YEAR - d); };

// ------------------------------------------------------------------ statistics
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** Linear-interpolation quantile (numpy default, Hyndman-Fan type 7), as used by the analytics baselines. */
export function quantile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  return lo + 1 < s.length ? s[lo]! + (h - lo) * (s[lo + 1]! - s[lo]!) : s[lo]!;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Display rounding: 2 decimals. Computations keep full precision. */
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

// ------------------------------------------------------------------ names
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Agmarknet district labels observed in stored rows (2002-2026, Karnataka) mapped to the registry spelling
 * (`districts` table). Older 'Bangalore' is deliberately NOT mapped: it covered markets now listed under Bengaluru
 * Urban, Bengaluru Rural and Bengaluru South, so it cannot be assigned to one district. Other states use the
 * published name (case- and space-insensitive) until their renames are verified against rows.
 */
const DISTRICT_ALIASES: Record<string, string> = {
  bengaluru: "bengaluru urban",
  "bangalore urban": "bengaluru urban",
  "bangalore rural": "bengaluru rural",
  "bengaluru south": "ramanagara", // Ramanagara district was renamed Bengaluru South in 2025
  mysore: "mysuru",
  shimoga: "shivamogga",
  tumkur: "tumakuru",
  bellary: "ballari",
  belgaum: "belagavi",
  gulbarga: "kalaburagi",
  bijapur: "vijayapura",
  chikmagalur: "chikkamagaluru",
  chamrajnagar: "chamarajanagar",
  chikkaballapur: "chikkaballapura",
  davangere: "davanagere",
  "madikeri(kodagu)": "kodagu",
  "karwar(uttar kannad)": "uttara kannada",
  "mangalore(dakshin kannad)": "dakshina kannada",
};
export function districtKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = norm(name).replace(/\s*\(\s*/g, "(").replace(/\s*\)\s*/g, ")");
  return DISTRICT_ALIASES[n] ?? n;
}
/** Accepts "Karnataka", "KA" or "IN-KA". */
export function resolveStateName(s: string | null | undefined): string | null {
  if (!s || !s.trim()) return null;
  return stateNameFor(s.trim()) ?? s.trim();
}

// ------------------------------------------------------------------ rows
interface PriceRow { valid: boolean; date: string; modal: number; marketId: string; marketKey: string; stateKey: string | null; districtKey: string | null }
interface MarketDay { date: string; marketKey: string; value: number; rows: number }

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
function dateOf(v: unknown): string {
  // node-postgres parses `date` as local midnight; read the local calendar fields back.
  return v instanceof Date ? iso(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())) : String(v).slice(0, 10);
}
function toRow(r: Record<string, unknown>): PriceRow {
  const modal = num(r.price_modal_inr_per_kg);
  const lo = num(r.price_min_inr_per_kg);
  const hi = num(r.price_max_inr_per_kg);
  const valid = modal !== null && Number.isFinite(modal) && modal > 0 && (lo === null || lo <= modal) && (hi === null || modal <= hi) && (lo === null || hi === null || lo <= hi);
  const stateKey = r.state_name ? norm(String(r.state_name)) : null;
  return {
    valid, date: dateOf(r.observed_on), modal: modal ?? Number.NaN, marketId: String(r.market_id),
    marketKey: `${stateKey ?? ""}|${canonicalMarketKey(String(r.market_name ?? r.market_id))}`,
    stateKey, districtKey: districtKey(r.district_name as string | null),
  };
}

function marketDays(rows: PriceRow[]): MarketDay[] {
  const by = new Map<string, { date: string; marketKey: string; values: number[] }>();
  for (const r of rows) {
    if (!r.valid) continue;
    const k = `${r.marketKey}#${r.date}`;
    const e = by.get(k);
    if (e) e.values.push(r.modal);
    else by.set(k, { date: r.date, marketKey: r.marketKey, values: [r.modal] });
  }
  return [...by.values()].map((e) => ({ date: e.date, marketKey: e.marketKey, value: median(e.values), rows: e.values.length }));
}

function coverageOf(rows: PriceRow[]): PriceCoverage {
  const valid = rows.filter((r) => r.valid);
  const dates = [...new Set(valid.map((r) => r.date))].sort();
  return { observations: valid.length, markets: new Set(valid.map((r) => r.marketKey)).size, firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null, validDays: dates.length, excludedRows: rows.length - valid.length };
}

/** Replay cutoff: a date-only asOf means the end of that UTC day (same convention as market-outlook.ts). Other modes read the latest vintage. */
function cutoffFor(mode: Mode, asOf: string | undefined): Date | undefined {
  if (mode !== "replay") return undefined;
  if (!asOf) throw new ReplayCutoffRequiredError("price series (asOf)");
  return new Date(asOf.length === 10 ? `${asOf}T23:59:59.999Z` : asOf);
}

async function resolveProduct(pool: Pool, productId: string): Promise<{ id: string; slug: string } | null> {
  const r = await pool.query<{ id: string; slug: string }>("SELECT id::text AS id, slug FROM crop_products WHERE slug = $1 OR id::text = $1 LIMIT 1", [productId]);
  return r.rows[0] ?? null;
}

/**
 * Narrowed, shared read (ingest/scope.ts): the seasonal reference of several weeks, the trend and the observed series of
 * one Today view, the market timeline and the briefing read the same product range; identical reads share one query
 * and its rows for up to MARKET_READ_TTL_MS. Replay reads are keyed by their exact cutoff.
 */
async function loadRows(pool: Pool, mode: Mode, productUuid: string, from: string, to: string, cutoff: Date | undefined): Promise<PriceRow[]> {
  const raw = await scopedQuery(mode).marketObservations(pool, { productId: productUuid, from, to, availableBy: cutoff, columns: MARKET_PRICE_COLUMNS, shared: true });
  return raw.map(toRow);
}

/** Whether the product has any readable valid row in this mode (only used to choose a missing-reason code). */
async function productHasRows(pool: Pool, mode: Mode, productUuid: string, cutoff: Date | undefined): Promise<boolean> {
  const params: unknown[] = [productUuid, [...READABLE_ROW_MODES[mode]], mode === "synthetic"];
  let sql = "SELECT EXISTS (SELECT 1 FROM market_observations WHERE product_id = $1 AND mode = ANY($2::text[]) AND is_synthetic = $3 AND validation_status = 'valid'";
  if (cutoff) { params.push(cutoff); sql += ` AND available_at <= $${params.length}`; }
  const r = await pool.query<{ exists: boolean }>(`${sql}) AS exists`, params);
  return r.rows[0]?.exists ?? false;
}

// ------------------------------------------------------------------ scope resolution
interface ScopeRequest { stateName: string | null; districtName: string | null; marketIds: string[] }
interface Candidate { level: PriceScopeLevel; rows: PriceRow[]; stateName: string | null; districtName: string | null; marketIds: string[] }

function candidates(rows: PriceRow[], req: ScopeRequest): Candidate[] {
  const out: Candidate[] = [];
  const sk = req.stateName ? norm(req.stateName) : null;
  const dk = districtKey(req.districtName);
  if (req.marketIds.length) out.push({ level: "market", rows: rows.filter((r) => req.marketIds.includes(r.marketId)), stateName: req.stateName, districtName: null, marketIds: req.marketIds });
  if (sk && dk) out.push({ level: "district", rows: rows.filter((r) => r.stateKey === sk && r.districtKey === dk), stateName: req.stateName, districtName: req.districtName, marketIds: [] });
  if (sk) out.push({ level: "state", rows: rows.filter((r) => r.stateKey === sk), stateName: req.stateName, districtName: null, marketIds: [] });
  out.push({ level: "national", rows, stateName: null, districtName: null, marketIds: [] });
  return out;
}

function describe(c: Candidate): string {
  switch (c.level) {
    case "market": return `the requested market${c.marketIds.length > 1 ? "s" : ""}`;
    case "district": return `${c.districtName} district`;
    case "state": return `${c.stateName} markets`;
    case "national": return "all-India markets";
  }
}

function fallbackNote(requested: Candidate, used: Candidate, why: string): string | null {
  return requested.level === used.level ? null : `${describe(requested)[0]!.toUpperCase()}${describe(requested).slice(1)}: ${why}; showing ${describe(used)}.`;
}

function scopeOf(c: Candidate, requested: Candidate, note: string | null): PriceScope {
  return { level: c.level, requestedLevel: requested.level, stateName: c.stateName, districtName: c.districtName, marketCount: new Set(c.rows.filter((r) => r.valid).map((r) => r.marketKey)).size, marketIds: c.marketIds, fallbackNote: note };
}

const validDays = (rows: PriceRow[]) => new Set(rows.filter((r) => r.valid).map((r) => r.date)).size;

// ------------------------------------------------------------------ price series
export interface PriceSeriesArgs {
  productId: string;
  stateName?: string | null | undefined;
  districtName?: string | null | undefined;
  marketIds?: string[] | undefined;
  from: string;
  to: string;
  bucket: "week" | "month";
  /** Replay cutoff (date or datetime). Defaults to the end of `to` in replay mode; ignored in live and synthetic modes. */
  asOf?: string | undefined;
}

interface BucketRaw { start: string; end: string; values: number[]; markets: Set<string> }

function bucketRanges(from: string, to: string, bucket: "week" | "month"): { start: string; end: string; key: string }[] {
  const out: { start: string; end: string; key: string }[] = [];
  if (bucket === "week") {
    for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) out.push({ key: m, start: m < from ? from : m, end: addDays(m, 6) > to ? to : addDays(m, 6) });
  } else {
    for (let ym = from.slice(0, 7); ym <= to.slice(0, 7); ym = addMonths(ym, 1)) out.push({ key: ym, start: `${ym}-01` < from ? from : `${ym}-01`, end: monthEnd(ym) > to ? to : monthEnd(ym) });
  }
  return out;
}

function bucketize(days: MarketDay[], from: string, to: string, bucket: "week" | "month"): BucketRaw[] {
  const ranges = bucketRanges(from, to, bucket);
  const by = new Map<string, BucketRaw>(ranges.map((r) => [r.key, { start: r.start, end: r.end, values: [], markets: new Set<string>() }]));
  for (const d of days) {
    const b = by.get(bucket === "week" ? mondayOf(d.date) : d.date.slice(0, 7));
    if (!b) continue;
    b.values.push(d.value);
    b.markets.add(d.marketKey);
  }
  return [...by.values()];
}

const toBucket = (b: BucketRaw): PriceBucket => ({
  start: b.start, end: b.end,
  p50: b.values.length ? r2(median(b.values)) : null,
  min: b.values.length ? r2(Math.min(...b.values)) : null,
  max: b.values.length ? r2(Math.max(...b.values)) : null,
  n: b.values.length, markets: b.markets.size,
});

function gapsOf(buckets: BucketRaw[]): { from: string; to: string }[] {
  const gaps: { from: string; to: string }[] = [];
  for (const b of buckets) {
    if (b.values.length) continue;
    const last = gaps[gaps.length - 1];
    if (last && addDays(last.to, 1) === b.start) last.to = b.end;
    else gaps.push({ from: b.start, to: b.end });
  }
  return gaps;
}

/** Scope rule for district/state/national: whether a level qualifies, and the plain reason shown when it does not. */
interface ScopeRule { qualifies: (rows: PriceRow[]) => boolean; why: (rows: PriceRow[]) => string }
const MIN_DAYS_RULE: ScopeRule = {
  qualifies: (rows) => validDays(rows) >= MIN_VALID_DAYS,
  why: (rows) => (validDays(rows) === 0 ? "no quotes in this period" : `too few quotes in this period (${validDays(rows)} trading days)`),
};

/** Shared by priceSeries and priceTrend: load, resolve scope with `rule`, bucket. */
async function seriesCore(pool: Pool, mode: Mode, args: PriceSeriesArgs, rule: ScopeRule): Promise<{ out: PriceSeries; raw: BucketRaw[] }> {
  const cutoff = cutoffFor(mode, args.asOf ?? args.to);
  const product = await resolveProduct(pool, args.productId);
  const rows = product ? await loadRows(pool, mode, product.id, args.from, args.to, cutoff) : [];
  const req: ScopeRequest = { stateName: resolveStateName(args.stateName), districtName: args.districtName?.trim() || null, marketIds: [...new Set(args.marketIds ?? [])] };
  const cands = candidates(rows, req);
  const requested = cands[0]!;
  // Requested markets are used whenever they have rows; every other level needs MIN_VALID_DAYS (or the caller's rule).
  const ok = (c: Candidate) => (c.level === "market" ? c.rows.some((r) => r.valid) : rule.qualifies(c.rows));
  let used = cands.find(ok);
  let status: PriceSeries["status"] = "available";
  let missingReason: PriceMissingReasonCode | null = null;
  if (!used) {
    status = "insufficient";
    used = cands.find((c) => c.rows.some((r) => r.valid)) ?? requested;
    missingReason = rows.some((r) => r.valid) ? "price_history_insufficient" : product && (await productHasRows(pool, mode, product.id, cutoff)) ? "price_history_insufficient" : "price_history_not_ingested";
  }
  const note = fallbackNote(requested, used, requested.level === "market" ? "no quotes in this period" : rule.why(requested.rows));
  const raw = bucketize(marketDays(used.rows), args.from, args.to, args.bucket);
  const limitations = [WHOLESALE_NOTE, "Bucket min and max are the lowest and highest market-day modal values, not mandi min/max prices and not a prediction interval.", RENAME_NOTE];
  if (mode === "replay") limitations.push(`Replay: only rows with a recorded available_at at or before ${cutoff!.toISOString()} are read.`);
  if (mode === "synthetic") limitations.push("Synthetic mode: generated fixtures, not market observations.");
  const out: PriceSeries = {
    productId: product?.slug ?? args.productId, status, missingReason, scope: scopeOf(used, requested, note), ...BASIS, limitations,
    bucket: args.bucket, from: args.from, to: args.to, buckets: raw.map(toBucket), coverage: coverageOf(used.rows), gaps: gapsOf(raw),
  };
  return { out, raw };
}

/**
 * Bucketed wholesale modal price series. Scope: requested markets (when they have rows), else district (at least
 * MIN_VALID_DAYS distinct trading days in the range), else state (same rule), else national (same rule). When no level
 * qualifies, the most specific level with rows is returned with status 'insufficient'.
 */
export async function priceSeries(pool: Pool, mode: Mode, args: PriceSeriesArgs): Promise<PriceSeries> {
  const from = checkDate("from", args.from);
  const to = checkDate("to", args.to);
  if (from > to) throw new ApiError(400, "validation_failed", "from must not be after to");
  return (await seriesCore(pool, mode, { ...args, from, to }, MIN_DAYS_RULE)).out;
}

// ------------------------------------------------------------------ harvest price outlook (B_seasonal_reference, pooled)
export interface HarvestPriceOutlookArgs {
  productId: string;
  stateName: string;
  districtName?: string | null | undefined;
  harvestDate: string;
  /** Reference date; the years used are the `years` complete ISO years before it. Also the replay cutoff. */
  asOf: string;
  weekWindow?: number | undefined;
  years?: number | undefined;
}

interface Weekly { year: number; week: number; bucket: number; median: number; marketKeys: Set<string>; rows: number }
interface SeasonalResult {
  ok: boolean; reason: PriceMissingReasonCode | null;
  yearsUsed: number[]; perYear: { year: number; weeks: number; median: number }[];
  p: { p10: number; p25: number; p50: number; p75: number; p90: number } | null;
  annualMean: number | null; annualWeeks: number; weeksUsed: number; observations: number; marketsUsed: number; residualCount: number;
}

/**
 * Pooled B_seasonal_reference over `rows` (one scope). Mirrors analytics/harvest_analytics/forecast/models.py baseline_b:
 * the point is the median of weekly values whose week bucket is within +/- weekWindow (circular, 53 pooled with 52) of
 * the target bucket; residuals are leave-one-year-out log residuals over every week of the years considered, each
 * measured against the median of the near-bucket weeks of the other years.
 */
function seasonalReference(rows: PriceRow[], yearsConsidered: number[], targetBucket: number, weekWindow: number): SeasonalResult {
  return seasonalAt(prepareSeasonal(rows, yearsConsidered, weekWindow), targetBucket);
}

/** The target-independent half of seasonalReference: weekly medians and the leave-one-year-out residuals. */
interface PreparedSeasonal { weekly: Weekly[]; residuals: number[]; weekWindow: number }
function prepareSeasonal(rows: PriceRow[], yearsConsidered: number[], weekWindow: number): PreparedSeasonal {
  const byWeek = new Map<string, { year: number; week: number; values: number[]; marketKeys: Set<string>; rows: number }>();
  for (const d of marketDays(rows)) {
    const w = isoWeek(d.date);
    if (!yearsConsidered.includes(w.year)) continue;
    const k = `${w.year}-${w.week}`;
    const e = byWeek.get(k) ?? { year: w.year, week: w.week, values: [], marketKeys: new Set<string>(), rows: 0 };
    e.values.push(d.value); e.marketKeys.add(d.marketKey); e.rows += d.rows;
    byWeek.set(k, e);
  }
  const weekly: Weekly[] = [...byWeek.values()].map((e) => ({ year: e.year, week: e.week, bucket: weekBucket(e.week), median: median(e.values), marketKeys: e.marketKeys, rows: e.rows }));
  const near = (a: number, b: number) => weekDistance(a, b) <= weekWindow;
  const residuals: number[] = [];
  for (const w of weekly) {
    const others = weekly.filter((o) => o.year !== w.year && near(o.bucket, w.bucket)).map((o) => o.median);
    if (others.length) residuals.push(Math.log(w.median) - Math.log(median(others)));
  }
  return { weekly, residuals, weekWindow };
}

/** The target-dependent half: pool the weeks near `targetBucket`, take the median and scale it by residual quantiles. */
function seasonalAt(prep: PreparedSeasonal, targetBucket: number): SeasonalResult {
  const { weekly, residuals, weekWindow } = prep;
  const near = (a: number, b: number) => weekDistance(a, b) <= weekWindow;
  const pool = weekly.filter((w) => near(w.bucket, targetBucket));
  const yearsUsed = [...new Set(pool.map((w) => w.year))].sort((a, b) => a - b);
  const perYear = yearsUsed.map((y) => { const v = pool.filter((w) => w.year === y).map((w) => w.median); return { year: y, weeks: v.length, median: r2(median(v)) }; });
  const annual = weekly.filter((w) => yearsUsed.includes(w.year)).map((w) => w.median);
  const base = {
    yearsUsed, perYear, annualWeeks: annual.length, weeksUsed: pool.length, observations: pool.reduce((a, w) => a + w.rows, 0),
    marketsUsed: new Set(pool.flatMap((w) => [...w.marketKeys])).size, residualCount: residuals.length,
  };
  const fail = (reason: PriceMissingReasonCode): SeasonalResult => ({ ok: false, reason, p: null, annualMean: null, ...base });
  if (yearsUsed.length < MIN_SEASON_YEARS) return fail("price_history_insufficient");
  if (residuals.length < MIN_RESIDUALS) return fail("price_residuals_insufficient");
  const p50 = median(pool.map((w) => w.median));
  const at = (q: number) => p50 * Math.exp(quantile(residuals, q));
  const p = { p10: at(0.1), p25: at(0.25), p50, p75: at(0.75), p90: at(0.9) };
  if (!(p.p10 <= p.p25 && p.p25 <= p.p50 && p.p50 <= p.p75 && p.p75 <= p.p90) || !Object.values(p).every(Number.isFinite)) return fail("price_interval_crossing");
  return { ok: true, reason: null, p, annualMean: mean(annual), ...base };
}

const REASON_TEXT: Record<PriceMissingReasonCode, string> = {
  price_history_not_ingested: "price history not ingested",
  price_history_insufficient: `fewer than ${MIN_SEASON_YEARS} years with quotes in these weeks`,
  market_not_in_history: "no quotes in the years considered",
  price_residuals_insufficient: `fewer than ${MIN_RESIDUALS} weeks to measure the year-to-year range`,
  price_interval_crossing: "the range could not be computed consistently",
};

export async function harvestPriceOutlook(pool: Pool, mode: Mode, args: HarvestPriceOutlookArgs): Promise<HarvestPriceOutlook> {
  const weekWindow = checkInt("weekWindow", args.weekWindow ?? 2, 0, 8);
  const years = checkInt("years", args.years ?? 3, 1, 10);
  const asOf = checkDate("asOf", args.asOf);
  const harvestDate = checkDate("harvestDate", args.harvestDate);
  const harvestWeek = isoWeek(harvestDate);
  const y0 = isoWeek(asOf).year;
  // Complete ISO years strictly before asOf's ISO year.
  const yearsConsidered = Array.from({ length: years }, (_, i) => y0 - years + i);
  const from = isoWeekMonday(yearsConsidered[0]!, 1);
  const to = addDays(isoWeekMonday(y0, 1), -1);
  const cutoff = cutoffFor(mode, args.asOf);
  const product = await resolveProduct(pool, args.productId);
  const rows = product ? await loadRows(pool, mode, product.id, from, to, cutoff) : [];
  const req: ScopeRequest = { stateName: resolveStateName(args.stateName), districtName: args.districtName?.trim() || null, marketIds: [] };
  const cands = candidates(rows, req).filter((c) => c.level === "district" || c.level === "state");
  const requested = cands[0]!;
  const state = cands.find((c) => c.level === "state")!;
  const target = weekBucket(harvestWeek.week);

  let used = state;
  let res = seasonalReference(state.rows, yearsConsidered, target, weekWindow);
  let note: string | null = null;
  const district = cands.find((c) => c.level === "district");
  if (district) {
    const d = seasonalReference(district.rows, yearsConsidered, target, weekWindow);
    if (d.ok) { used = district; res = d; }
    else note = fallbackNote(district, state, district.rows.some((r) => r.valid) ? REASON_TEXT[d.reason!] : "no quotes in the years considered");
  }
  let reason = res.reason;
  if (!res.ok && !state.rows.some((r) => r.valid)) {
    reason = product && (await productHasRows(pool, mode, product.id, cutoff)) ? "market_not_in_history" : "price_history_not_ingested";
  }
  const limitations = [
    WHOLESALE_NOTE,
    `Historical seasonal reference, not a forecast: the median of weekly median prices in ISO weeks ${harvestWeek.week}±${weekWindow} of ${yearsConsidered.join(", ")}. The evaluated release baseline (D42) is per market with the exact ISO week; this variant pools the scope's markets and widens the window.`,
    `The p25-p75 and p10-p90 ranges come from leave-one-year-out log residuals over every week of the years used (${res.residualCount} residuals). They describe past year-to-year dispersion and are not separately calibrated for this pooled variant.`,
    RENAME_NOTE,
  ];
  if (res.ok) limitations.push(`The annual mean is the mean of ${res.annualWeeks} weekly medians across ${res.yearsUsed.join(", ")}; weeks without quotes are not filled.`);
  if (mode === "replay") limitations.push(`Replay: only rows with a recorded available_at at or before ${cutoff!.toISOString()} are read.`);
  if (mode === "synthetic") limitations.push("Synthetic mode: generated fixtures, not market observations.");
  const p = res.p;
  return {
    productId: product?.slug ?? args.productId,
    status: res.ok ? "available" : "insufficient", missingReason: res.ok ? null : reason,
    scope: scopeOf(used, requested, note), ...BASIS, limitations,
    method: PRICE_OUTLOOK_METHOD, harvestDate, harvestWeek, asOf, weekWindow, yearsRequested: years, yearsConsidered,
    yearsUsed: res.yearsUsed, perYear: res.perYear,
    p10: p ? r2(p.p10) : null, p25: p ? r2(p.p25) : null, p50: p ? r2(p.p50) : null, p75: p ? r2(p.p75) : null, p90: p ? r2(p.p90) : null,
    annualMean: res.annualMean === null ? null : r2(res.annualMean), annualWeeks: res.annualWeeks,
    weeksUsed: res.weeksUsed, observations: res.observations, marketsUsed: res.marketsUsed, residualCount: res.residualCount,
  };
}

// ------------------------------------------------------------------ seasonal reference for every ISO week (one pass)
export interface SeasonalReferenceByWeekArgs {
  productId: string;
  stateName: string;
  districtName?: string | null | undefined;
  /** Reference date; the years used are the `years` complete ISO years before it. Also the replay cutoff. */
  asOf: string;
  weekWindow?: number | undefined;
  years?: number | undefined;
}
/** One ISO week bucket (1..52, 53 pooled with 52); the fields mean exactly what they mean in HarvestPriceOutlook. */
export interface SeasonalWeekReference {
  week: number;
  status: "available" | "insufficient";
  missingReason: PriceMissingReasonCode | null;
  scope: PriceScope;
  yearsUsed: number[];
  perYear: { year: number; weeks: number; median: number }[];
  p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null;
  annualMean: number | null;
  annualWeeks: number;
  weeksUsed: number;
  observations: number;
  marketsUsed: number;
  residualCount: number;
}
export interface SeasonalReferenceByWeek {
  productId: string;
  method: typeof PRICE_OUTLOOK_METHOD;
  asOf: string;
  weekWindow: number;
  yearsRequested: number;
  yearsConsidered: number[];
  unit: "INR/kg";
  priceBasis: "wholesale_mandi_modal";
  basisLabel: string;
  limitations: string[];
  /** weeks[i] is ISO week bucket i + 1, with harvestPriceOutlook's district-to-state fallback decided per week. */
  weeks: SeasonalWeekReference[];
  /** weeks[i] for the state pool alone: what harvestPriceOutlook returns when no district is requested. */
  stateWeeks: SeasonalWeekReference[];
}

/**
 * harvestPriceOutlook for all 52 ISO week buckets in one pass: the rows are read once, and the weekly medians and the
 * leave-one-year-out residuals (which do not depend on the target week) are computed once per scope; only the +/-
 * weekWindow pooling and the median are repeated per week. Same years, same pooling, same residual intervals, same
 * district-to-state fallback and the same missing-reason codes, so weeks[w - 1] equals harvestPriceOutlook for any
 * harvest date in ISO week w (53 shares 52); the test suite checks this field by field.
 */
export async function seasonalReferenceByWeek(pool: Pool, mode: Mode, args: SeasonalReferenceByWeekArgs): Promise<SeasonalReferenceByWeek> {
  const weekWindow = checkInt("weekWindow", args.weekWindow ?? 2, 0, 8);
  const years = checkInt("years", args.years ?? 3, 1, 10);
  const asOf = checkDate("asOf", args.asOf);
  const y0 = isoWeek(asOf).year;
  const yearsConsidered = Array.from({ length: years }, (_, i) => y0 - years + i);
  const from = isoWeekMonday(yearsConsidered[0]!, 1);
  const to = addDays(isoWeekMonday(y0, 1), -1);
  const cutoff = cutoffFor(mode, args.asOf);
  const product = await resolveProduct(pool, args.productId);
  const rows = product ? await loadRows(pool, mode, product.id, from, to, cutoff) : [];
  const req: ScopeRequest = { stateName: resolveStateName(args.stateName), districtName: args.districtName?.trim() || null, marketIds: [] };
  const cands = candidates(rows, req).filter((c) => c.level === "district" || c.level === "state");
  const state = cands.find((c) => c.level === "state")!;
  const district = cands.find((c) => c.level === "district");
  const statePrep = prepareSeasonal(state.rows, yearsConsidered, weekWindow);
  const districtPrep = district ? prepareSeasonal(district.rows, yearsConsidered, weekWindow) : null;
  const stateHasRows = state.rows.some((r) => r.valid);
  const districtHasRows = district ? district.rows.some((r) => r.valid) : false;
  // Same reason refinement as harvestPriceOutlook; the query runs at most once.
  let noStateRowsReason: PriceMissingReasonCode | null = null;
  if (!stateHasRows) noStateRowsReason = product && (await productHasRows(pool, mode, product.id, cutoff)) ? "market_not_in_history" : "price_history_not_ingested";

  const toWeek = (week: number, res: SeasonalResult, scope: PriceScope): SeasonalWeekReference => {
    const p = res.p;
    return {
      week, status: res.ok ? "available" : "insufficient", missingReason: res.ok ? null : !stateHasRows ? noStateRowsReason : res.reason, scope,
      yearsUsed: res.yearsUsed, perYear: res.perYear,
      p10: p ? r2(p.p10) : null, p25: p ? r2(p.p25) : null, p50: p ? r2(p.p50) : null, p75: p ? r2(p.p75) : null, p90: p ? r2(p.p90) : null,
      annualMean: res.annualMean === null ? null : r2(res.annualMean), annualWeeks: res.annualWeeks,
      weeksUsed: res.weeksUsed, observations: res.observations, marketsUsed: res.marketsUsed, residualCount: res.residualCount,
    };
  };
  const weeks: SeasonalWeekReference[] = [];
  const stateWeeks: SeasonalWeekReference[] = [];
  for (let week = 1; week <= WEEKS_PER_YEAR; week++) {
    const s = seasonalAt(statePrep, week);
    stateWeeks.push(toWeek(week, s, scopeOf(state, state, null)));
    if (!district || !districtPrep) { weeks.push(toWeek(week, s, scopeOf(state, state, null))); continue; }
    const d = seasonalAt(districtPrep, week);
    if (d.ok) weeks.push(toWeek(week, d, scopeOf(district, district, null)));
    else weeks.push(toWeek(week, s, scopeOf(state, district, fallbackNote(district, state, districtHasRows ? REASON_TEXT[d.reason!] : "no quotes in the years considered"))));
  }
  const residualNote = districtPrep ? `${districtPrep.residuals.length} in the district pool, ${statePrep.residuals.length} in the state pool` : `${statePrep.residuals.length} residuals`;
  const limitations = [
    WHOLESALE_NOTE,
    `Historical seasonal reference, not a forecast: for each ISO week, the median of weekly median prices in that week ±${weekWindow} of ${yearsConsidered.join(", ")}. The evaluated release baseline (D42) is per market with the exact ISO week; this variant pools the scope's markets and widens the window.`,
    `The p25-p75 and p10-p90 ranges come from leave-one-year-out log residuals over every week of the years used (${residualNote}). They describe past year-to-year dispersion and are not separately calibrated for this pooled variant.`,
    RENAME_NOTE,
  ];
  if (mode === "replay") limitations.push(`Replay: only rows with a recorded available_at at or before ${cutoff!.toISOString()} are read.`);
  if (mode === "synthetic") limitations.push("Synthetic mode: generated fixtures, not market observations.");
  return {
    productId: product?.slug ?? args.productId, method: PRICE_OUTLOOK_METHOD, asOf, weekWindow, yearsRequested: years, yearsConsidered,
    ...BASIS, limitations, weeks, stateWeeks,
  };
}

// ------------------------------------------------------------------ trend
export interface PriceTrendArgs { productId: string; stateName: string; districtName?: string | null | undefined; months?: number | undefined; asOf: string }

/**
 * Monthly p50 over the `months` complete calendar months before asOf's month (null months kept). Scope as priceSeries,
 * except that a district or state must also have quotes in at least half of the months to be chosen, so a level with
 * a few recent days does not replace a fuller state series. Year-on-year: mean monthly p50 of the last 12 months versus
 * the prior 12, over calendar months present in both windows, only when each window has at least YOY_MIN_MONTHS months.
 */
export async function priceTrend(pool: Pool, mode: Mode, args: PriceTrendArgs): Promise<PriceTrend> {
  const months = checkInt("months", args.months ?? 36, 1, 120);
  const asOf = checkDate("asOf", args.asOf);
  const firstMonth = addMonths(asOf.slice(0, 7), -months);
  const from = `${firstMonth}-01`;
  const to = addDays(`${asOf.slice(0, 7)}-01`, -1);
  const minMonths = Math.ceil(months / 2);
  const monthsWithData = (rows: PriceRow[]) => new Set(rows.filter((r) => r.valid).map((r) => r.date.slice(0, 7))).size;
  const rule: ScopeRule = {
    qualifies: (rows) => validDays(rows) >= MIN_VALID_DAYS && monthsWithData(rows) >= minMonths,
    why: (rows) => (validDays(rows) === 0 ? "no quotes in this period" : `quotes in only ${monthsWithData(rows)} of ${months} months`),
  };
  const { out, raw } = await seriesCore(pool, mode, { productId: args.productId, stateName: args.stateName, districtName: args.districtName, from, to, bucket: "month", asOf: args.asOf }, rule);
  const vals = raw.map((b) => (b.values.length ? median(b.values) : null));
  let yoy: PriceTrend["yoy"] = null;
  let yoyMissingReason: string | null = null;
  if (months < 24) yoyMissingReason = "Fewer than 24 months requested.";
  else {
    const last = vals.slice(-12);
    const prior = vals.slice(-24, -12);
    const lastN = last.filter((v) => v !== null).length;
    const priorN = prior.filter((v) => v !== null).length;
    const paired = last.map((v, i) => [v, prior[i] ?? null] as const).filter((x): x is readonly [number, number] => x[0] !== null && x[1] !== null);
    if (lastN < YOY_MIN_MONTHS || priorN < YOY_MIN_MONTHS) yoyMissingReason = `Year-on-year needs at least ${YOY_MIN_MONTHS} months with quotes in each 12-month window (last ${lastN}, prior ${priorN}).`;
    else {
      const lastMean = mean(paired.map((x) => x[0]));
      const priorMean = mean(paired.map((x) => x[1]));
      yoy = { lastMonthsWithData: lastN, priorMonthsWithData: priorN, pairedMonths: paired.length, lastMean: r2(lastMean), priorMean: r2(priorMean), changePct: Math.round((lastMean / priorMean - 1) * 1000) / 10 };
    }
  }
  const limitations = [...out.limitations];
  if (yoy) limitations.push(`Year-on-year compares the mean monthly median over the ${yoy.pairedMonths} calendar months present in both 12-month windows.`);
  return {
    productId: out.productId, status: out.status, missingReason: out.missingReason, scope: out.scope, unit: out.unit, priceBasis: out.priceBasis, basisLabel: out.basisLabel, limitations,
    months, asOf, from, to,
    series: out.buckets.map((b) => ({ month: b.start.slice(0, 7), p50: b.p50, n: b.n, markets: b.markets })),
    yoy, yoyMissingReason, coverage: out.coverage,
  };
}

// ------------------------------------------------------------------ crop pool helper

/**
 * Products with valid quotes in `stateName` over the last `years` years before asOf (default 3), with their distinct
 * trading days. Reads per product through scopedQuery; a cheap pre-filter finds candidate products.
 */
export async function productsWithHistory(pool: Pool, mode: Mode, stateName: string, opts: { asOf?: string | undefined; years?: number | undefined } = {}): Promise<ProductHistory[]> {
  const asOf = checkDate("asOf", opts.asOf ?? todayUtc());
  const years = checkInt("years", opts.years ?? 3, 1, 10);
  const [y, m, d] = asOf.split("-").map(Number) as [number, number, number];
  const from = iso(Date.UTC(y - years, m - 1, d) + DAY);
  const cutoff = cutoffFor(mode, opts.asOf ?? asOf);
  const state = resolveStateName(stateName);
  if (!state) return [];
  const params: unknown[] = [[...READABLE_ROW_MODES[mode]], mode === "synthetic", state, from, asOf];
  let filter = "m.mode = ANY($1::text[]) AND m.is_synthetic = $2 AND m.validation_status = 'valid' AND lower(m.state_name) = lower($3) AND m.observed_on BETWEEN $4 AND $5";
  if (cutoff) { params.push(cutoff); filter += ` AND m.available_at <= $${params.length}`; }
  const cands = await pool.query<{ id: string; slug: string }>(`SELECT p.id::text AS id, p.slug FROM crop_products p WHERE EXISTS (SELECT 1 FROM market_observations m WHERE m.product_id = p.id AND ${filter}) ORDER BY p.slug`, params);
  const out: ProductHistory[] = [];
  const sk = norm(state);
  for (const c of cands.rows) {
    const rows = (await loadRows(pool, mode, c.id, from, asOf, cutoff)).filter((r) => r.stateKey === sk);
    const cov = coverageOf(rows);
    if (cov.validDays === 0) continue;
    out.push({ productId: c.slug, validDays: cov.validDays, observations: cov.observations, markets: cov.markets, firstDate: cov.firstDate, lastDate: cov.lastDate, meetsMinValidDays: cov.validDays >= MIN_VALID_DAYS });
  }
  return out.sort((a, b) => b.validDays - a.validDays || a.productId.localeCompare(b.productId));
}
