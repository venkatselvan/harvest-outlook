import type { Pool } from "../db/pool";
import type { WeatherDayRow, WeatherSeries } from "../providers/openmeteo/client";
import { ensureSource, OPENMETEO_SOURCES } from "./sources";

/** Stable location key from the GRID cell actually used by the provider (Open-Meteo snaps coordinates). */
export function locationKey(provider: string, gridLat: number, gridLon: number): string {
  return `${provider}:${gridLat.toFixed(3)},${gridLon.toFixed(3)}`;
}

function metaOf(r: WeatherDayRow, series: WeatherSeries) {
  return {
    provider: r.provider,
    endpoint: r.endpoint,
    model: r.model,
    modelBasis: r.modelBasis,
    measurementKind: r.measurementKind,
    units: r.units,
    // requested coordinates are intentionally not stored in shared tables (private farm locations)
    gridLat: r.gridLat,
    gridLon: r.gridLon,
    elevationM: r.elevationM,
    timezone: r.timezone,
    generationTimeMs: r.generationTimeMs,
    issueTime: r.issueTime,
    issueTimeBasis: r.issueTimeBasis,
    leadDays: r.leadDays,
    attribution: r.attribution,
    cached: series.cached,
    stale: series.stale,
  };
}

export interface StoreCounts {
  rows: number;
  inserted: number;
  updated: number;
  locationKey: string;
}

/** Observed (reanalysis) days -> weather_observations. Re-fetches update values and stamp revised_at when they differ. */
export async function storeArchive(pool: Pool, series: WeatherSeries): Promise<StoreCounts> {
  const sourceId = await ensureSource(pool, OPENMETEO_SOURCES.archive.manifestId, OPENMETEO_SOURCES.archive.fallback);
  let inserted = 0;
  let updated = 0;
  const first = series.rows[0]!;
  const key = locationKey(first.provider, first.gridLat, first.gridLon);
  for (const r of series.rows) {
    const res = await pool.query<{ inserted: boolean }>(
      `INSERT INTO weather_observations
         (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, evidence_state, measurement_kind, available_at, meta)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,false,'live','observed',$7,$8,$9::jsonb)
       ON CONFLICT (location_key, observed_on, source_id) DO UPDATE SET
         variables = EXCLUDED.variables,
         revised_at = CASE WHEN weather_observations.variables IS DISTINCT FROM EXCLUDED.variables THEN now() ELSE weather_observations.revised_at END,
         meta = EXCLUDED.meta
         -- available_at is deliberately not overwritten: it records first availability
       RETURNING (xmax = 0) AS inserted`,
      [key, r.gridLon, r.gridLat, r.validDate, JSON.stringify(r.values), sourceId, r.measurementKind, r.availableAt, JSON.stringify(metaOf(r, series))],
    );
    res.rows[0]!.inserted ? inserted++ : updated++;
  }
  return { rows: series.rows.length, inserted, updated, locationKey: key };
}

/** Forecast days -> weather_forecasts. issued_at is the fetch time, so each vintage is retained separately. */
export async function storeForecast(pool: Pool, series: WeatherSeries): Promise<StoreCounts> {
  const sourceId = await ensureSource(pool, OPENMETEO_SOURCES.forecast.manifestId, OPENMETEO_SOURCES.forecast.fallback);
  let inserted = 0;
  let updated = 0;
  const first = series.rows[0]!;
  const key = locationKey(first.provider, first.gridLat, first.gridLon);
  for (const r of series.rows) {
    if (!r.issueTime) throw new Error("forecast row without issue time");
    const res = await pool.query<{ inserted: boolean }>(
      `INSERT INTO weather_forecasts
         (location_key, lon, lat, issued_at, valid_on, variables, source_id, is_synthetic, mode, evidence_state, available_at, horizon_days, meta)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,false,'live','forecast',$8,$9,$10::jsonb)
       ON CONFLICT (location_key, issued_at, valid_on, source_id) DO UPDATE SET meta = EXCLUDED.meta
       RETURNING (xmax = 0) AS inserted`,
      [key, r.gridLon, r.gridLat, r.issueTime, r.validDate, JSON.stringify(r.values), sourceId, r.availableAt, r.horizonDays, JSON.stringify(metaOf(r, series))],
    );
    res.rows[0]!.inserted ? inserted++ : updated++;
  }
  return { rows: series.rows.length, inserted, updated, locationKey: key };
}
