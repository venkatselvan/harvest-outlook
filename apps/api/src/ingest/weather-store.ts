import type { Pool } from "../db/pool";
import type { WeatherDayRow, WeatherSeries } from "../providers/openmeteo/client";
import { ensureSource, OPENMETEO_SOURCES } from "./sources";
import { emptyVintageCounts, insertVintage, tally, type VintageCounts } from "./vintage";

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
    // optional keys left out of the rows (for example an unexpected unit), so the gap is explained in the stored row's meta
    ...(series.notes?.length ? { notes: series.notes } : {}),
  };
}

export interface StoreCounts extends VintageCounts {
  rows: number;
  locationKey: string;
}

/**
 * Observed (reanalysis) days -> weather_observations, vintage-preserving (see ./vintage.ts).
 * A re-fetch with changed values adds a new vintage with its own available_at; nothing is overwritten.
 */
export async function storeArchive(pool: Pool, series: WeatherSeries): Promise<StoreCounts> {
  const sourceId = await ensureSource(pool, OPENMETEO_SOURCES.archive.manifestId, OPENMETEO_SOURCES.archive.fallback);
  const counts = emptyVintageCounts();
  const first = series.rows[0]!;
  const key = locationKey(first.provider, first.gridLat, first.gridLon);
  for (const r of series.rows) {
    const o = await insertVintage(pool, {
      table: "weather_observations",
      identity: { location_key: key, observed_on: r.validDate, source_id: sourceId },
      values: { variables: JSON.stringify(r.values) },
      other: {
        lon: r.gridLon, lat: r.gridLat, is_synthetic: false, mode: "live", evidence_state: "observed",
        measurement_kind: r.measurementKind, available_at: r.availableAt, meta: JSON.stringify(metaOf(r, series)),
      },
      hasRevisedAt: true,
    });
    tally(counts, o);
  }
  return { rows: series.rows.length, ...counts, locationKey: key };
}

/**
 * Forecast days -> weather_forecasts. issued_at is part of the identity, so each issue is retained; a
 * re-fetch of the same issue with different values becomes a new vintage of that issue.
 */
export async function storeForecast(pool: Pool, series: WeatherSeries): Promise<StoreCounts> {
  const sourceId = await ensureSource(pool, OPENMETEO_SOURCES.forecast.manifestId, OPENMETEO_SOURCES.forecast.fallback);
  const counts = emptyVintageCounts();
  const first = series.rows[0]!;
  const key = locationKey(first.provider, first.gridLat, first.gridLon);
  for (const r of series.rows) {
    if (!r.issueTime) throw new Error("forecast row without issue time");
    const o = await insertVintage(pool, {
      table: "weather_forecasts",
      identity: { location_key: key, issued_at: r.issueTime, valid_on: r.validDate, source_id: sourceId },
      values: { variables: JSON.stringify(r.values) },
      other: {
        lon: r.gridLon, lat: r.gridLat, is_synthetic: false, mode: "live", evidence_state: "forecast",
        available_at: r.availableAt, horizon_days: r.horizonDays, meta: JSON.stringify(metaOf(r, series)),
      },
    });
    tally(counts, o);
  }
  return { rows: series.rows.length, ...counts, locationKey: key };
}
