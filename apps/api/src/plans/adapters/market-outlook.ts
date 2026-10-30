import { Decimal } from "@harvest/domain";
import type { DateRange, Mode, ValueRecord } from "@harvest/contracts";
import type { Pool } from "../../db/pool";
import { READABLE_ROW_MODES, scopedQuery } from "../../ingest/scope";
import type { MarketOutlookSource, MarketReference, MarketReferenceMarket, OutlookResult, OutlookScopeHint, PriceMissingReason } from "../sources";

/**
 * Historical price REFERENCE over stored market_observations (BUILD_SPEC 8.1 baselines A and B). It is never a
 * forecast: no model is fitted, nothing is extrapolated. Reads go through scopedQuery(mode): live reads never see
 * synthetic rows, replay reads see only vintages with available_at <= the cutoff, and rows from unverified
 * commodity mappings are excluded (validation_status is applied after vintage selection).
 *
 * Per market it returns (all INR/kg, converted by ingest from the published INR/quintal; the source unit is kept in sourceUnit):
 *  - the last valid modal quote (observed) with its date, variety and grade;
 *  - the range of weekly medians over the last 52 weeks (derived). This is NOT a prediction interval and mandi
 *    min/max prices are not used for it;
 *  - per harvest window, the corresponding-season reference: the median of weekly medians in the same ISO weeks of
 *    prior years, only when at least two prior years contribute (derived).
 * Modal price is a wholesale mandi reference, not a farm-gate price.
 */

export const MARKET_REFERENCE_METHOD = "market-historical-reference/1";
/** Minimum valid trading days (distinct dates with a positive modal quote) in the last 365 days for a market to be used. */
export const MIN_VALID_DAYS = 8;
/** Minimum distinct ISO weeks in the last 52 weeks before a range of weekly medians is shown. */
export const MIN_RANGE_WEEKS = 4;
export const MIN_SEASON_YEARS = 2;
const HISTORY_YEARS = 6;
export const MANDI_LABEL = "Mandi reference (wholesale), not a farm-gate price";
export const RANGE_LABEL = "Range of weekly medians (last 52 weeks); not a prediction interval";

const STATE_NAMES: Record<string, string> = {
  AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar", CG: "Chhattisgarh", GA: "Goa", GJ: "Gujarat", HR: "Haryana",
  HP: "Himachal Pradesh", JH: "Jharkhand", KA: "Karnataka", KL: "Kerala", MP: "Madhya Pradesh", MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya",
  MZ: "Mizoram", NL: "Nagaland", OD: "Odisha", OR: "Odisha", PB: "Punjab", RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu", TS: "Telangana",
  TG: "Telangana", TR: "Tripura", UP: "Uttar Pradesh", UK: "Uttarakhand", UT: "Uttarakhand", WB: "West Bengal", DL: "Delhi", JK: "Jammu and Kashmir",
  LA: "Ladakh", PY: "Puducherry", CH: "Chandigarh",
};

/** "IN-KA" or "KA" -> "Karnataka"; null when unknown. */
export function stateNameFor(stateId: string | null | undefined): string | null {
  if (!stateId) return null;
  const code = stateId.toUpperCase().replace(/^IN-/, "");
  return STATE_NAMES[code] ?? null;
}

/** Plain-language rendering shared by the API and the tool binding. */
export function missingReasonText(reason: string, state?: string | null): string {
  switch (reason) {
    case "price_access_key_gated": return "Price access pending: no data.gov.in key is configured, so no price history can be retrieved";
    case "price_history_not_ingested": return "Price history not ingested yet";
    case "price_history_insufficient": return `Too few recent quotes (fewer than ${MIN_VALID_DAYS} valid trading days in the last 365 days)`;
    case "market_not_in_history": return `No quotes for this market${state ? `; showing ${state} markets` : ""}`;
    default: return reason;
  }
}

/** Reason when no row exists for the product at all: depends on whether a key could ever have fetched them. */
export function noRowsReason(keyConfigured: boolean): PriceMissingReason {
  return keyConfigured ? "price_history_not_ingested" : "price_access_key_gated";
}

// ------------------------------------------------------------------ date helpers (UTC, calendar dates only)
const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** ISO-8601 week-year and week number of a calendar date. */
export function isoWeek(date: string): { year: number; week: number } {
  const t = new Date(utc(date));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // Thursday of this ISO week decides the ISO year
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return { year, week };
}

function median(values: Decimal[]): Decimal {
  const s = [...values].sort((a, b) => a.cmp(b));
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : s[m - 1]!.add(s[m]!).div(2);
}

interface Quote { date: string; modal: Decimal; marketId: string; marketName: string; stateName: string | null; districtName: string | null; variety: string | null; grade: string | null; arrivals: Decimal | null; sourceId: string; unit: string }

function toQuote(r: Record<string, unknown>): Quote | null {
  const raw = r.price_modal_inr_per_kg;
  if (raw === null || raw === undefined) return null;
  const modal = new Decimal(String(raw));
  if (!modal.isFinite() || modal.lte(0)) return null;
  const d = r.observed_on;
  const date = d instanceof Date ? iso(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) : String(d).slice(0, 10);
  return {
    date, modal, marketId: String(r.market_id), marketName: String(r.market_name ?? r.market_id),
    stateName: (r.state_name as string | null) ?? null, districtName: (r.district_name as string | null) ?? null,
    variety: (r.variety as string | null) || null, grade: (r.grade as string | null) || null,
    arrivals: r.arrivals === null || r.arrivals === undefined ? null : new Decimal(String(r.arrivals)),
    sourceId: String(r.source_id), unit: String(r.unit ?? "INR/quintal"),
  };
}

function weeklyMedians(quotes: Quote[]): Map<string, { year: number; week: number; median: Decimal; days: number }> {
  const byWeek = new Map<string, Quote[]>();
  for (const q of quotes) {
    const w = isoWeek(q.date);
    const k = `${w.year}-${String(w.week).padStart(2, "0")}`;
    byWeek.set(k, [...(byWeek.get(k) ?? []), q]);
  }
  const out = new Map<string, { year: number; week: number; median: Decimal; days: number }>();
  for (const [k, qs] of byWeek) {
    const [y, w] = k.split("-").map(Number) as [number, number];
    out.set(k, { year: y, week: w, median: median(qs.map((q) => q.modal)), days: new Set(qs.map((q) => q.date)).size });
  }
  return out;
}

/** ISO (year, week) pairs touched by a date range. */
function windowWeeks(w: DateRange): { year: number; week: number }[] {
  const seen = new Map<string, { year: number; week: number }>();
  for (let t = utc(w.start); t <= utc(w.end) && seen.size < 60; t += DAY) {
    const x = isoWeek(iso(t));
    seen.set(`${x.year}-${x.week}`, x);
  }
  return [...seen.values()];
}

const dec = (d: Decimal) => d.toDecimalPlaces(2).toFixed(2);

export interface PgMarketOutlookOptions {
  pool: Pool;
  mode: Mode;
  /** Whether a data.gov.in key is configured; decides the missing reason when no rows exist. */
  keyConfigured: boolean | (() => boolean);
  now?: () => Date;
}

export class PgMarketOutlookSource implements MarketOutlookSource {
  readonly modes: readonly Mode[] = ["live", "replay", "synthetic"];
  constructor(private readonly o: PgMarketOutlookOptions) {}

  private key(): boolean {
    return typeof this.o.keyConfigured === "function" ? this.o.keyConfigured() : this.o.keyConfigured;
  }

  async getOutlook(productId: string, marketIds: string[], harvestWindows: DateRange[], issueDate: string, hint: OutlookScopeHint = {}): Promise<OutlookResult> {
    const mode = this.o.mode;
    const now = (this.o.now ?? (() => new Date()))();
    const issueDay = issueDate.slice(0, 10);
    const availableBy = mode === "replay" ? new Date(issueDate.length === 10 ? `${issueDate}T23:59:59.999Z` : issueDate) : now;
    const from = iso(utc(issueDay) - HISTORY_YEARS * 366 * DAY);
    // Stored rows reference crop_products.id (uuid); callers may pass the product slug.
    const resolved = await this.o.pool.query<{ id: string }>("SELECT id FROM crop_products WHERE slug = $1 OR id::text = $1 LIMIT 1", [productId]);
    const rows = resolved.rows[0] ? await scopedQuery(mode).marketObservations(this.o.pool, { productId: resolved.rows[0].id, from, to: issueDay, availableBy }) : [];
    const quotes = rows.map(toQuote).filter((q): q is Quote => q !== null);
    const unavailable = (missingReason: PriceMissingReason): OutlookResult => ({ state: "unavailable", missingReason });
    if (quotes.length === 0) return unavailable(noRowsReason(this.key()));

    const byMarket = new Map<string, Quote[]>();
    for (const q of quotes) byMarket.set(q.marketId, [...(byMarket.get(q.marketId) ?? []), q]);

    // ---- choose candidate markets
    let candidates: string[];
    let fallback: MarketReference["fallback"] = null;
    const stateName = hint.stateName ?? stateNameFor(hint.stateId);
    const inState = (id: string) => !!stateName && byMarket.get(id)![0]!.stateName?.toLowerCase() === stateName.toLowerCase();
    const stateMarkets = [...byMarket.keys()].filter(inState);
    const present = marketIds.filter((m) => byMarket.has(m));
    if (marketIds.length > 0 && present.length > 0) candidates = present;
    else if (marketIds.length > 0) {
      if (stateMarkets.length === 0) return unavailable("market_not_in_history");
      candidates = stateMarkets;
      fallback = { reason: "market_not_in_history", requestedMarketIds: marketIds, scope: "state", stateName, note: missingReasonText("market_not_in_history", stateName) };
    } else {
      const districtName = hint.districtName?.toLowerCase();
      const inDistrict = districtName ? stateMarkets.filter((id) => byMarket.get(id)![0]!.districtName?.toLowerCase().includes(districtName)) : [];
      if (inDistrict.length > 0) candidates = inDistrict;
      else if (stateMarkets.length > 0) {
        candidates = stateMarkets;
        if (districtName) fallback = { reason: "market_not_in_history", requestedMarketIds: [], scope: "state", stateName, note: missingReasonText("market_not_in_history", stateName) };
      } else if (stateName) return unavailable("market_not_in_history");
      else candidates = [...byMarket.keys()];
    }

    // ---- per-market sufficiency: valid trading days in the last 365 days
    const since = iso(utc(issueDay) - 364 * DAY);
    const usable = candidates.filter((id) => new Set(byMarket.get(id)!.filter((q) => q.date >= since).map((q) => q.date)).size >= MIN_VALID_DAYS);
    if (usable.length === 0) return unavailable("price_history_insufficient");

    const markets = usable.map((id) => this.marketReference(id, byMarket.get(id)!, harvestWindows, issueDay, since, mode)).sort((a, b) => (b.lastQuote.validTo ?? "").localeCompare(a.lastQuote.validTo ?? "") || a.marketId.localeCompare(b.marketId));
    return {
      kind: "historical_reference",
      mode, productId, issueDate: issueDay,
      label: MANDI_LABEL,
      notForecast: true,
      methodVersion: MARKET_REFERENCE_METHOD,
      primaryMarketId: markets[0]!.marketId,
      fallback,
      markets,
      skippedMarkets: candidates.filter((c) => !usable.includes(c)).map((marketId) => ({ marketId, reason: "price_history_insufficient" as const })),
    };
  }

  private marketReference(id: string, all: Quote[], windows: DateRange[], issueDay: string, since: string, mode: Mode): MarketReferenceMarket {
    const sorted = [...all].sort((a, b) => a.date.localeCompare(b.date));
    const lastDate = sorted[sorted.length - 1]!.date;
    const onLast = sorted.filter((q) => q.date === lastDate);
    // Several grades can trade on the last day: report the highest-arrivals row (ties: variety then grade), never an average.
    const last = [...onLast].sort((a, b) => (b.arrivals ?? new Decimal(-1)).cmp(a.arrivals ?? new Decimal(-1)) || `${a.variety}|${a.grade}`.localeCompare(`${b.variety}|${b.grade}`))[0]!;
    const scope = { level: "market" as const, ids: [id] };
    const common = { schemaVersion: "1.0" as const, scope, issuedAt: null, assumptionIds: [] as string[], methodVersion: MARKET_REFERENCE_METHOD, validationStatus: "pending" as const, sourceUnit: last.unit.replace(/^INR\/quintal$/i, "INR/quintal") };
    const evidenceIds = [...new Set(onLast.map((q) => q.sourceId))];
    const lastQuote: ValueRecord = { ...common, kind: "quantity", unit: "INR/kg", value: dec(last.modal), evidenceState: "observed", validFrom: last.date, validTo: last.date, evidenceIds, missingReason: null };

    // 52-week range of weekly medians
    const recent = sorted.filter((q) => q.date >= since);
    const wk = [...weeklyMedians(recent).values()];
    const allIds = [...new Set(recent.map((q) => q.sourceId))];
    let weeklyRange: ValueRecord;
    let weeks = wk.length;
    if (wk.length >= MIN_RANGE_WEEKS) {
      const lo = wk.reduce((m, x) => (x.median.lt(m) ? x.median : m), wk[0]!.median);
      const hi = wk.reduce((m, x) => (x.median.gt(m) ? x.median : m), wk[0]!.median);
      weeklyRange = { ...common, kind: "range", unit: "INR/kg", value: { low: dec(lo), high: dec(hi) }, evidenceState: "derived", validFrom: since, validTo: lastDate, evidenceIds: allIds, missingReason: null };
    } else {
      weeklyRange = { ...common, kind: "range", unit: "INR/kg", value: null, evidenceState: "unavailable", validFrom: null, validTo: null, evidenceIds: [], missingReason: "fewer_than_4_weeks_with_quotes" };
    }

    // corresponding-season reference per harvest window
    const byWeekAll = weeklyMedians(sorted);
    const seasonal = windows.map((w) => {
      const wy = windowWeeks(w);
      const pooled: Decimal[] = [];
      const years = new Set<number>();
      const ids = new Set<string>();
      for (const k of Array.from({ length: HISTORY_YEARS }, (_, i) => i + 1)) {
        for (const x of wy) {
          const y = x.year - k;
          if (y >= Number(issueDay.slice(0, 4))) continue;
          const m = byWeekAll.get(`${y}-${String(x.week).padStart(2, "0")}`);
          if (m) { pooled.push(m.median); years.add(y); }
        }
      }
      for (const q of sorted) { const qw = isoWeek(q.date); if (years.has(qw.year) && wy.some((x) => x.week === qw.week)) ids.add(q.sourceId); }
      const base = { ...common, kind: "quantity" as const, unit: "INR/kg" as const };
      if (years.size < MIN_SEASON_YEARS) {
        const value: ValueRecord = { ...base, value: null, evidenceState: "unavailable", validFrom: w.start, validTo: w.end, evidenceIds: [], missingReason: "fewer_than_2_prior_years_for_these_iso_weeks" };
        return { window: w, reference: value, yearsUsed: [...years].sort(), weeklyMedianRange: null as { low: string; high: string } | null };
      }
      const value: ValueRecord = { ...base, value: dec(median(pooled)), evidenceState: "derived", validFrom: w.start, validTo: w.end, evidenceIds: [...ids], missingReason: null };
      return { window: w, reference: value, yearsUsed: [...years].sort(), weeklyMedianRange: { low: dec(Decimal.min(...pooled)), high: dec(Decimal.max(...pooled)) } };
    });
    void mode;
    return {
      marketId: id, marketName: last.marketName, stateName: last.stateName, districtName: last.districtName,
      lastQuote, lastQuoteMeta: { date: last.date, marketName: last.marketName, variety: last.variety, grade: last.grade, rowsOnDate: onLast.length },
      weeklyRange, weeklyRangeLabel: RANGE_LABEL, weeksInRange: weeks, validDaysLast365: new Set(recent.map((q) => q.date)).size,
      seasonal,
    };
  }
}

/** All ValueRecords of a reference, flattened in a stable order (tool binding `references`). */
export function referenceRecords(ref: MarketReference): ValueRecord[] {
  return ref.markets.flatMap((m) => [m.lastQuote, m.weeklyRange, ...m.seasonal.map((s) => s.reference)]);
}

// ------------------------------------------------------------------ comparison-card block

/** What a comparison card shows for price. Never a forecast; the mandi label is always present when a value is shown. */
export type PriceReferenceBlock =
  | { state: "unavailable"; label: string; missingReason: string; text: string }
  | {
      state: "historical_reference";
      /** observed = the last quote is a stored observation; the range is derived from it. */
      evidenceState: "observed";
      label: string;
      notForecast: true;
      marketId: string;
      marketName: string;
      stateName: string | null;
      lastQuote: { inrPerKg: string; date: string; variety: string | null; grade: string | null; sourceUnit: string | null; evidenceState: "observed"; evidenceIds: string[] };
      weeklyRange: { lowInrPerKg: string; highInrPerKg: string; label: string; weeks: number; evidenceState: "derived" } | null;
      fallbackNote: string | null;
      otherMarkets: number;
    };

/** Wiring bundle passed to routes and tool bindings. */
export interface PriceDeps {
  source: MarketOutlookSource;
  /** True when a data.gov.in key is configured (decides price_access_key_gated vs price_history_not_ingested). */
  keyConfigured: boolean;
  /** Clock for the comparison endpoint (tests); the source has its own. */
  now?: () => Date;
}

export function toPriceReferenceBlock(result: OutlookResult, keyConfigured: boolean): PriceReferenceBlock {
  if ("state" in result) {
    const reason = result.missingReason;
    return { state: "unavailable", label: reason === "price_access_key_gated" ? "Unavailable — price access pending" : `Unavailable — ${missingReasonText(reason)}`, missingReason: reason, text: missingReasonText(reason) };
  }
  if (!("kind" in result) || result.kind !== "historical_reference") {
    // A forecast artifact is not a historical reference; never relabel one as such.
    return { state: "unavailable", label: "Unavailable", missingReason: noRowsReason(keyConfigured), text: missingReasonText(noRowsReason(keyConfigured)) };
  }
  const m = result.markets.find((x) => x.marketId === result.primaryMarketId) ?? result.markets[0]!;
  const q = m.lastQuote;
  const r = m.weeklyRange;
  return {
    state: "historical_reference", evidenceState: "observed", label: MANDI_LABEL, notForecast: true,
    marketId: m.marketId, marketName: m.marketName, stateName: m.stateName,
    lastQuote: { inrPerKg: String(q.value), date: m.lastQuoteMeta.date, variety: m.lastQuoteMeta.variety, grade: m.lastQuoteMeta.grade, sourceUnit: q.sourceUnit ?? null, evidenceState: "observed", evidenceIds: q.evidenceIds },
    weeklyRange: r.kind === "range" && r.value ? { lowInrPerKg: String(r.value.low), highInrPerKg: String(r.value.high), label: RANGE_LABEL, weeks: m.weeksInRange, evidenceState: "derived" } : null,
    fallbackNote: result.fallback?.note ?? null,
    otherMarkets: result.markets.length - 1,
  };
}

/** Distinct product ids that have any readable valid row in this mode (cheap pre-check before per-product reads). */
export async function productsWithMarketRows(pool: Pool, mode: Mode): Promise<Set<string>> {
  const r = await pool.query<{ id: string; slug: string }>(
    `SELECT p.id::text AS id, p.slug FROM crop_products p WHERE EXISTS (
       SELECT 1 FROM market_observations m WHERE m.product_id = p.id AND m.mode = ANY($1::text[]) AND m.is_synthetic = $2 AND m.validation_status = 'valid')`,
    [[...READABLE_ROW_MODES[mode]], mode === "synthetic"],
  );
  // Both the uuid and the slug identify the product to callers.
  return new Set(r.rows.flatMap((x) => [x.id, x.slug]));
}

export async function priceReferencesFor(
  source: MarketOutlookSource, pool: Pool, mode: Mode,
  args: { productIds: string[]; issueDate: string; stateId: string | null; districtName: string | null; keyConfigured: boolean },
): Promise<Record<string, PriceReferenceBlock>> {
  const have = await productsWithMarketRows(pool, mode);
  const out: Record<string, PriceReferenceBlock> = {};
  const todo = [...new Set(args.productIds)];
  const hint = { stateId: args.stateId, districtName: args.districtName };
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async (id) => {
      const res: OutlookResult = have.has(id)
        ? await source.getOutlook(id, [], [], args.issueDate, hint)
        : { state: "unavailable", missingReason: noRowsReason(args.keyConfigured) };
      out[id] = toPriceReferenceBlock(res, args.keyConfigured);
    }));
  }
  return out;
}
