import type { Mode } from "@harvest/contracts";
import type { Pool } from "../db/pool";

/**
 * Which stored row modes a runtime mode may read. Live reads never see synthetic rows: the mode column
 * is filtered AND is_synthetic must be false (both are also tied together by a DB check constraint).
 * Replay reads real rows, restricted by an availability cutoff supplied by the caller.
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
  /** Only rows first available at or before this instant (required for replay-grade reads). */
  availableBy?: Date;
}

export interface MarketFilter {
  marketId?: string;
  productId?: string;
  from?: string;
  to?: string;
  availableBy?: Date;
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

/** Mode-scoped read helper. Callers cannot widen the mode: it is fixed at construction (server-controlled). */
export function scopedQuery(mode: Mode): ScopedQuery {
  const weather = (table: "weather_observations" | "weather_forecasts", dateCol: "observed_on" | "valid_on") =>
    async (pool: Pool, f: ScopeFilter = {}) => {
      const params: unknown[] = [];
      const where = [modeClause(mode, params)];
      if (f.locationKey) { params.push(f.locationKey); where.push(`location_key = $${params.length}`); }
      if (f.from) { params.push(f.from); where.push(`${dateCol} >= $${params.length}`); }
      if (f.to) { params.push(f.to); where.push(`${dateCol} <= $${params.length}`); }
      if (f.availableBy) { params.push(f.availableBy); where.push(`available_at <= $${params.length}`); }
      const r = await pool.query(`SELECT * FROM ${table} WHERE ${where.join(" AND ")} ORDER BY ${dateCol}`, params);
      return r.rows as Record<string, unknown>[];
    };
  return {
    mode,
    weatherObservations: weather("weather_observations", "observed_on"),
    weatherForecasts: weather("weather_forecasts", "valid_on"),
    async marketObservations(pool, f = {}) {
      const params: unknown[] = [];
      const where = [modeClause(mode, params)];
      if (f.marketId) { params.push(f.marketId); where.push(`market_id = $${params.length}`); }
      if (f.productId) { params.push(f.productId); where.push(`product_id = $${params.length}`); }
      if (f.from) { params.push(f.from); where.push(`observed_on >= $${params.length}`); }
      if (f.to) { params.push(f.to); where.push(`observed_on <= $${params.length}`); }
      if (f.availableBy) { params.push(f.availableBy); where.push(`available_at <= $${params.length}`); }
      const r = await pool.query(`SELECT * FROM market_observations WHERE ${where.join(" AND ")} ORDER BY observed_on, market_id`, params);
      return r.rows as Record<string, unknown>[];
    },
  };
}
