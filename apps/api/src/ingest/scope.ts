import type { Mode } from "@harvest/contracts";
import type { Pool } from "../db/pool";
import { ReplayCutoffRequiredError } from "./errors";
import { databaseKey, ReadMemo } from "./read-memo";

/**
 * Which stored row modes a runtime mode may read. Live reads never see synthetic rows: the mode column
 * is filtered AND is_synthetic must be false (both are also tied together by a DB check constraint).
 * Replay reads real rows and REQUIRES an availability cutoff (`availableBy`); a missing or invalid cutoff
 * throws ReplayCutoffRequiredError.
 *
 * Vintages (docs/DATA_PIPELINE.md): rows are vintages of an identity. Every read returns one row per
 * identity: the latest vintage (by available_at, then vintage_seq) among rows with
 * available_at <= availableBy when a cutoff is given, else the latest vintage overall. Rows with
 * unknown available_at are never returned under a cutoff.
 */
export const READABLE_ROW_MODES: Record<Mode, readonly string[]> = {
  live: ["live"],
  replay: ["live", "replay"],
  synthetic: ["synthetic"],
};

export interface ScopeFilter {
  locationKey?: string;
  from?: string;
  to?: string;
  /** Latest vintage available at or before this instant. Required in replay mode. */
  availableBy?: Date | undefined;
  /** Serve from the shared weather memo (WEATHER_READ_TTL_MS); same key and cutoff rules as MarketFilter.shared. */
  shared?: boolean | undefined;
}

export interface MarketFilter {
  marketId?: string;
  productId?: string;
  from?: string;
  to?: string;
  /** Latest vintage available at or before this instant. Required in replay mode. */
  availableBy?: Date | undefined;
  /** Include rows from unverified commodity mappings (flagged validation_status='unverified_mapping'). Default false. */
  includeUnverified?: boolean | undefined;
  /**
   * Columns to return (default: every column). The price readers pass MARKET_PRICE_COLUMNS: the `raw` and `flags`
   * JSON (about 300 of the 755 bytes of a row) are then neither sorted by Postgres nor parsed by Node. The identity
   * and validation_status are always selected; vintage selection, filters and row order are unchanged.
   */
  columns?: readonly MarketColumn[] | undefined;
  /**
   * Serve this read from the shared in-process memo (see read-memo.ts and MARKET_READ_TTL_MS): identical concurrent
   * reads share one query and a result is reused for at most MARKET_READ_TTL_MS. Only for read paths that accept that
   * staleness bound; replay reads stay exact (the cutoff is part of the key).
   */
  shared?: boolean | undefined;
}

/** Selectable market_observations columns (an allow-list: column names are interpolated into SQL). */
export const MARKET_COLUMNS = [
  "id", "market_id", "product_id", "observed_on", "source_id", "variety_key", "grade_key", "validation_status",
  "price_min", "price_modal", "price_max", "arrivals", "unit", "is_synthetic", "created_at", "updated_at", "mode",
  "evidence_state", "market_name", "state_name", "district_name", "variety", "grade", "price_min_inr_per_kg",
  "price_modal_inr_per_kg", "price_max_inr_per_kg", "arrivals_unit", "flags", "raw", "available_at", "vintage_seq",
  "revision_of", "revised_at",
] as const;
export type MarketColumn = (typeof MARKET_COLUMNS)[number];

/**
 * The columns read by the price readers: services/price-series.ts (toRow), services/crop-fit/market-now.ts,
 * services/today/alerts.ts (loadPriceMoves) and plans/adapters/market-outlook.ts (toQuote).
 */
export const MARKET_PRICE_COLUMNS: readonly MarketColumn[] = [
  "market_id", "product_id", "observed_on", "source_id", "variety_key", "grade_key", "validation_status",
  "market_name", "state_name", "district_name", "variety", "grade", "unit", "arrivals",
  "price_min_inr_per_kg", "price_modal_inr_per_kg", "price_max_inr_per_kg",
];

/**
 * How long a shared market read is reused (15 minutes). Staleness bound: mandi rows ingested by another process (the
 * worker's daily data.gov.in ingest) become visible to this API process within 15 minutes; an ingest in this process
 * (storeMarketRows, insertVintage) clears the memo and is visible at once. Mandi data is ingested at most daily.
 */
export const MARKET_READ_TTL_MS = 15 * 60_000;
/** Rows kept in the shared memo across all entries (about 400 bytes each once parsed). */
const MARKET_READ_MAX_ROWS = 300_000;
const marketReads = new ReadMemo<Record<string, unknown>>({ ttlMs: MARKET_READ_TTL_MS, maxWeight: MARKET_READ_MAX_ROWS });

/** Forget shared market reads. Called after an in-process market ingest (ingest/market-store.ts) and by tests. */
export function clearSharedMarketReads(): void {
  marketReads.clear();
}
/**
 * Another read-only market_observations query served from the same memo (same TTL, cleared by the same ingest hook).
 * `name` and `params` must identify the result completely; never use it for a replay cutoff that is not in `params`.
 */
export function sharedMarketQuery<T extends object>(pool: Pool, name: string, params: readonly unknown[], load: () => Promise<T[]>): Promise<T[]> {
  return marketReads.get(JSON.stringify([databaseKey(pool), name, params]), load as () => Promise<Record<string, unknown>[]>) as unknown as Promise<T[]>;
}

/**
 * Shared weather reads (2026-11-05, second pass): every demo visitor's farm has the same point, so the grid-cell lookup
 * and the observation/forecast reads are identical across visitors. Staleness bound: rows the worker writes (archive
 * and climatology backfill jobs) become visible within WEATHER_READ_TTL_MS; an in-process ingest (weather-store.ts via
 * insertVintage) clears the memo at once.
 */
export const WEATHER_READ_TTL_MS = 5 * 60_000;
const weatherReads = new ReadMemo<Record<string, unknown>>({ ttlMs: WEATHER_READ_TTL_MS, maxWeight: 200_000 });
export function clearSharedWeatherReads(): void {
  weatherReads.clear();
}
/** A read-only weather query served from the weather memo. `name` and `params` must identify the result completely. */
export function sharedWeatherQuery<T extends object>(pool: Pool, name: string, params: readonly unknown[], load: () => Promise<T[]>): Promise<T[]> {
  return weatherReads.get(JSON.stringify([databaseKey(pool), name, params]), load as () => Promise<Record<string, unknown>[]>) as unknown as Promise<T[]>;
}
/** Clears the memo that holds reads of `table` (insertVintage calls this after every write). */
export function clearSharedReadsFor(table: string): void {
  if (table === "market_observations") marketReads.clear();
  else if (table === "weather_observations" || table === "weather_forecasts") weatherReads.clear();
}

/** Hit/miss counters of the shared market memo (tests and diagnostics). */
export function sharedMarketReadStats(): { hits: number; misses: number; entries: number } {
  return { hits: marketReads.hits, misses: marketReads.misses, entries: marketReads.size };
}

function modeClause(mode: Mode, params: unknown[]): string {
  params.push([...READABLE_ROW_MODES[mode]]);
  const synthetic = mode === "synthetic" ? "is_synthetic = true" : "is_synthetic = false";
  return `mode = ANY($${params.length}::text[]) AND ${synthetic}`;
}

export interface ScopedQuery {
  mode: Mode;
  weatherObservations(pool: Pool, f?: ScopeFilter): Promise<Record<string, unknown>[]>;
  weatherForecasts(pool: Pool, f?: ScopeFilter): Promise<Record<string, unknown>[]>;
  marketObservations(pool: Pool, f?: MarketFilter): Promise<Record<string, unknown>[]>;
}

function cutoff(mode: Mode, availableBy: Date | undefined, what: string): Date | undefined {
  if (availableBy !== undefined && !(availableBy instanceof Date && Number.isFinite(availableBy.getTime()))) {
    throw new ReplayCutoffRequiredError(`${what} (invalid availableBy)`);
  }
  if (mode === "replay" && availableBy === undefined) throw new ReplayCutoffRequiredError(what);
  return availableBy;
}

/** One row per identity: latest vintage among the filtered rows (filters, including the cutoff, apply before selection). */
function latestVintageSql(table: string, identity: string[], where: string[], order: string, post = "true", select = "*"): string {
  return `SELECT * FROM (
      SELECT DISTINCT ON (${identity.join(", ")}) ${select} FROM ${table}
      WHERE ${where.join(" AND ")}
      ORDER BY ${identity.join(", ")}, available_at DESC NULLS LAST, vintage_seq DESC
    ) v WHERE ${post} ORDER BY ${order}`;
}

const IDENTITY = {
  weather_observations: ["location_key", "observed_on", "source_id"],
  weather_forecasts: ["location_key", "issued_at", "valid_on", "source_id"],
  market_observations: ["market_id", "product_id", "observed_on", "source_id", "variety_key", "grade_key"],
} as const;

function selectList(columns: readonly MarketColumn[] | undefined): string {
  if (!columns) return "*";
  const allowed = new Set<string>(MARKET_COLUMNS);
  for (const c of columns) if (!allowed.has(c)) throw new Error(`Unknown market_observations column: ${c}`);
  // Identity (DISTINCT ON) and validation_status (post filter) are always selected; order is fixed for a stable key.
  const want = new Set<string>([...IDENTITY.market_observations, "validation_status", ...columns]);
  return MARKET_COLUMNS.filter((c) => want.has(c)).join(", ");
}

/** Mode-scoped read helper. Callers cannot widen the mode: it is fixed at construction (server-controlled). */
export function scopedQuery(mode: Mode): ScopedQuery {
  const weather = (table: "weather_observations" | "weather_forecasts", dateCol: "observed_on" | "valid_on") =>
    async (pool: Pool, f: ScopeFilter = {}) => {
      const by = cutoff(mode, f.availableBy, table);
      const params: unknown[] = [];
      const where = [modeClause(mode, params)];
      if (f.locationKey) { params.push(f.locationKey); where.push(`location_key = $${params.length}`); }
      if (f.from) { params.push(f.from); where.push(`${dateCol} >= $${params.length}`); }
      if (f.to) { params.push(f.to); where.push(`${dateCol} <= $${params.length}`); }
      if (by) { params.push(by); where.push(`available_at <= $${params.length}`); }
      const order = table === "weather_forecasts" ? `${dateCol}, issued_at, location_key` : `${dateCol}, location_key`;
      const sql = latestVintageSql(table, [...IDENTITY[table]], where, order);
      const run = async () => (await pool.query(sql, params)).rows as Record<string, unknown>[];
      if (!f.shared) return run();
      const exact = mode === "replay" ? by?.toISOString() ?? null : null;
      const window = mode !== "replay" && by ? by.getTime() : null;
      return weatherReads.get(JSON.stringify([databaseKey(pool), table, mode, f.locationKey ?? null, f.from ?? null, f.to ?? null, exact, by ? "cutoff" : "latest"]), run, window);
    };
  return {
    mode,
    weatherObservations: weather("weather_observations", "observed_on"),
    weatherForecasts: weather("weather_forecasts", "valid_on"),
    async marketObservations(pool, f = {}) {
      const by = cutoff(mode, f.availableBy, "market_observations");
      const params: unknown[] = [];
      const where = [modeClause(mode, params)];
      if (f.marketId) { params.push(f.marketId); where.push(`market_id = $${params.length}`); }
      if (f.productId) { params.push(f.productId); where.push(`product_id = $${params.length}`); }
      if (f.from) { params.push(f.from); where.push(`observed_on >= $${params.length}`); }
      if (f.to) { params.push(f.to); where.push(`observed_on <= $${params.length}`); }
      if (by) { params.push(by); where.push(`available_at <= $${params.length}`); }
      // Validation is applied AFTER vintage selection, so hiding a vintage can never resurface an older one.
      const post = f.includeUnverified ? "true" : "validation_status = 'valid'";
      const select = selectList(f.columns);
      const sql = latestVintageSql("market_observations", [...IDENTITY.market_observations], where, "observed_on, market_id", post, select);
      const run = async () => (await pool.query(sql, params)).rows as Record<string, unknown>[];
      if (!f.shared) return run();
      // Replay: the exact cutoff is part of the key. Live/synthetic: a cutoff (callers pass "now") matches an entry made
      // with an earlier cutoff within the TTL window, which is the same staleness bound as the TTL itself.
      const exact = mode === "replay" ? by?.toISOString() ?? null : null;
      const window = mode !== "replay" && by ? by.getTime() : null;
      const key = JSON.stringify([databaseKey(pool), mode, f.marketId ?? null, f.productId ?? null, f.from ?? null, f.to ?? null, exact, by ? "cutoff" : "latest", !!f.includeUnverified, select]);
      return marketReads.get(key, run, window);
    },
  };
}
