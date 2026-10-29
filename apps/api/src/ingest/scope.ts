import type { Mode } from "@harvest/contracts";
import type { Pool } from "../db/pool";
import { ReplayCutoffRequiredError } from "./errors";

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
function latestVintageSql(table: string, identity: string[], where: string[], order: string, post = "true"): string {
  return `SELECT * FROM (
      SELECT DISTINCT ON (${identity.join(", ")}) * FROM ${table}
      WHERE ${where.join(" AND ")}
      ORDER BY ${identity.join(", ")}, available_at DESC NULLS LAST, vintage_seq DESC
    ) v WHERE ${post} ORDER BY ${order}`;
}

const IDENTITY = {
  weather_observations: ["location_key", "observed_on", "source_id"],
  weather_forecasts: ["location_key", "issued_at", "valid_on", "source_id"],
  market_observations: ["market_id", "product_id", "observed_on", "source_id", "variety_key", "grade_key"],
} as const;

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
      const r = await pool.query(latestVintageSql(table, [...IDENTITY[table]], where, order), params);
      return r.rows as Record<string, unknown>[];
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
      const r = await pool.query(latestVintageSql("market_observations", [...IDENTITY.market_observations], where, "observed_on, market_id", post), params);
      return r.rows as Record<string, unknown>[];
    },
  };
}
