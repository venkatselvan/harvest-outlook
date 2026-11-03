import { createHash } from "node:crypto";
import { z } from "zod";
import { getJson, type FetchLike } from "../../ingest/http";
import type { CacheStore } from "../../ingest/cache";
import { loadProviderConfig, type ProviderConfig } from "../config";

/**
 * Weather depth (docs/research/WEATHER_DEPTH_SPEC.md): besides rain and temperature the client requests the daily
 * agronomic variables in OPTIONAL_DAILY_VARIABLES on both endpoints. They are optional so a response (or a recorded
 * fixture) that lacks one still parses; REQUIRED_DAILY_VARIABLES is unchanged. Every such value is an Open-Meteo model
 * estimate for the ~9 to 11 km grid cell, not a field reading.
 *
 * Unit conversion: `sunshine_duration` arrives in seconds (`daily_units` says "s"). It is converted to hours at parse
 * time (seconds / 3600, rounded to 2 decimals) and the stored unit is recorded as "h". Every other unit is stored as
 * reported. A unit not listed in ACCEPTED_UNITS on a REQUIRED variable makes the response `unexpected_unit` (nothing is
 * guessed). On an OPTIONAL variable the key is left out as not provided and the parse result's `notes` carries
 * `unexpected_unit:<key>:<unit>`, so one surprising deeper unit never drops rain and temperature. An optional series whose
 * length differs from the time axis is left out the same way (`length_mismatch:<key>`).
 */

export const OPENMETEO_ATTRIBUTION = "Weather data by Open-Meteo.com (https://open-meteo.com/), CC BY 4.0";
export const OPENMETEO_PROVIDER = "open-meteo";

/** Variables requested for both endpoints. Units are read from the response, never assumed. */
export const REQUIRED_DAILY_VARIABLES = [
  "precipitation_sum",
  "temperature_2m_max",
  "temperature_2m_min",
  "et0_fao_evapotranspiration",
  "shortwave_radiation_sum",
] as const;
export const OPTIONAL_FORECAST_VARIABLES = ["precipitation_probability_max"] as const;
/** Deeper daily variables requested on forecast and archive. `precipitation_probability_max` is forecast only (see above). */
export const OPTIONAL_DAILY_VARIABLES = [
  "relative_humidity_2m_mean",
  "relative_humidity_2m_max",
  "relative_humidity_2m_min",
  "dew_point_2m_mean",
  "vapour_pressure_deficit_max",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
  "soil_moisture_0_to_7cm_mean",
  "soil_temperature_0_to_7cm_mean",
  "leaf_wetness_probability_mean",
  "sunshine_duration",
  "precipitation_hours",
] as const;
/** Everything the archive request asks for (forecast-only `precipitation_probability_max` excluded). */
export const ARCHIVE_DAILY_VARIABLES = [...REQUIRED_DAILY_VARIABLES, ...OPTIONAL_DAILY_VARIABLES] as const;

/**
 * 8 hex characters identifying a requested variable set (sha256 of the sorted names). A job key or a run record carrying
 * it changes by itself when a variable is added or removed, so work done with an older set is never taken for current.
 */
export function variableSetId(variables: readonly string[]): string {
  return createHash("sha256").update([...variables].sort().join(",")).digest("hex").slice(0, 8);
}

/** Variable whose response unit is seconds and whose stored value is hours. */
const SECONDS_TO_HOURS_VARIABLE = "sunshine_duration";

/** Units this pipeline knows how to interpret per variable. Anything else is reported unavailable, not guessed. */
const ACCEPTED_UNITS: Record<string, string[]> = {
  precipitation_sum: ["mm"],
  temperature_2m_max: ["°C"],
  temperature_2m_min: ["°C"],
  et0_fao_evapotranspiration: ["mm"],
  shortwave_radiation_sum: ["MJ/m²"],
  precipitation_probability_max: ["%"],
  relative_humidity_2m_mean: ["%"],
  relative_humidity_2m_max: ["%"],
  relative_humidity_2m_min: ["%"],
  dew_point_2m_mean: ["°C"],
  vapour_pressure_deficit_max: ["kPa"],
  wind_speed_10m_max: ["km/h"],
  wind_gusts_10m_max: ["km/h"],
  soil_moisture_0_to_7cm_mean: ["m³/m³"],
  soil_temperature_0_to_7cm_mean: ["°C"],
  leaf_wetness_probability_mean: ["%"],
  sunshine_duration: ["s"], // converted to hours when parsed, stored unit "h"
  precipitation_hours: ["h"],
};

const responseSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  elevation: z.number().nullable().optional(),
  generationtime_ms: z.number().optional(),
  utc_offset_seconds: z.number().optional(),
  timezone: z.string().optional(),
  daily_units: z.record(z.string(), z.string()),
  daily: z.object({ time: z.array(z.string()) }).catchall(z.array(z.number().nullable())),
});

export type OpenMeteoEndpoint = "archive" | "forecast";

export interface WeatherDayRow {
  provider: typeof OPENMETEO_PROVIDER;
  endpoint: OpenMeteoEndpoint;
  /** The Open-Meteo response does not name the underlying model; this is the request's `models` choice. */
  model: string;
  modelBasis: "request_parameter_not_reported_by_response";
  /** archive => reanalysis (gridded model estimate, not a station measurement); forecast => numerical forecast. */
  measurementKind: "reanalysis" | "forecast";
  evidenceState: "observed" | "forecast";
  validDate: string;
  /** Forecasts: time the forecast was obtained (upper bound of model run time). Archive: null. */
  issueTime: string | null;
  issueTimeBasis: "fetch_time_upper_bound" | "not_applicable";
  /** Time this system first had the data (the fetch time, or the original fetch time when cached). */
  availableAt: string;
  /** Forecast horizon requested (forecast_days); null for archive rows. */
  horizonDays: number | null;
  /** validDate minus the local issue date, in days (forecast only). */
  leadDays: number | null;
  values: Record<string, number | null>;
  units: Record<string, string>;
  requestedLat: number;
  requestedLon: number;
  gridLat: number;
  gridLon: number;
  elevationM: number | null;
  timezone: string | null;
  generationTimeMs: number | null;
  attribution: string;
}

/** Successful parse: the rows plus the optional keys that were left out (for example `unexpected_unit:wind_gusts_10m_max:m/s`). */
export type ParsedDaily = { status: "ok"; data: WeatherDayRow[]; notes: string[] };

export interface WeatherSeries {
  endpoint: OpenMeteoEndpoint;
  rows: WeatherDayRow[];
  /** Optional keys omitted from the rows and why; empty when everything requested was usable. */
  notes?: string[];
  fetchedAt: string;
  cached: boolean;
  /** True when a failed refresh fell back to an expired cache entry. */
  stale: boolean;
  /** Request URL; no secrets are part of Open-Meteo calls. */
  sourceUrl: string;
}

export type UnavailableReason =
  | "invalid_request"
  | "network_error"
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "invalid_json"
  | "schema_mismatch"
  | "unexpected_unit"
  | "no_data";

export type Unavailable = { status: "unavailable"; reason: UnavailableReason; detail: string };
export type FetchResult<T> = { status: "ok"; data: T } | Unavailable;

export interface OpenMeteoDeps {
  config?: ProviderConfig | undefined;
  fetchImpl?: FetchLike | undefined;
  cache?: CacheStore | undefined;
  now?: (() => Date) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Requested coordinates are rounded to 0.01 degree (~1 km) before leaving the server: far finer than the
 * provider grid (reanalysis ~0.1-0.25 degree), it improves cache sharing and avoids sending exact farm
 * locations to a third party or into shared cache rows.
 */
export const roundCoord = (x: number): number => Math.round(x * 100) / 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODEL = "best_match";

function validCoord(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function validIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const unavailable = (reason: UnavailableReason, detail: string): Unavailable => ({ status: "unavailable", reason, detail });

function cacheKey(url: string): string {
  return `open-meteo:${createHash("sha256").update(url).digest("hex")}`;
}

/** Local calendar date of an instant in a fixed-offset zone (used only for leadDays). */
function localDate(instant: Date, utcOffsetSeconds: number): string {
  return new Date(instant.getTime() + utcOffsetSeconds * 1000).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

interface CachedPayload {
  url: string;
  fetchedAt: string;
  body: unknown;
}

/** Pure parser: validates a raw response body and builds rows. Exported for tests with recorded fixtures. */
export function parseOpenMeteoDaily(args: {
  endpoint: OpenMeteoEndpoint;
  body: unknown;
  requestedLat: number;
  requestedLon: number;
  fetchedAt: string;
  horizonDays: number | null;
  requested: readonly string[];
}): ParsedDaily | Unavailable {
  const parsed = responseSchema.safeParse(args.body);
  if (!parsed.success) return unavailable("schema_mismatch", "response did not match the expected Open-Meteo daily shape");
  const r = parsed.data;
  const times = r.daily.time;
  const present: string[] = [];
  const notes: string[] = [];
  for (const v of args.requested) {
    const required = (REQUIRED_DAILY_VARIABLES as readonly string[]).includes(v);
    const unit = r.daily_units[v];
    const series = r.daily[v];
    if (unit === undefined || series === undefined) {
      if (required) return unavailable("schema_mismatch", `response lacks required variable ${v}`);
      continue;
    }
    if (series.length !== times.length) {
      if (required) return unavailable("schema_mismatch", `variable ${v} length differs from time axis`);
      notes.push(`length_mismatch:${v}`); // optional key: left out like an unexpected unit, the response still parses
      continue;
    }
    const accepted = ACCEPTED_UNITS[v];
    if (!accepted || !accepted.includes(unit)) {
      if (required) return unavailable("unexpected_unit", `variable ${v} reported unit "${unit}", not interpreted`);
      notes.push(`unexpected_unit:${v}:${unit}`); // optional key: treated as not provided, never guessed
      continue;
    }
    present.push(v);
  }
  const utcOffset = r.utc_offset_seconds ?? 0;
  const issued = args.endpoint === "forecast" ? args.fetchedAt : null;
  const issuedLocalDate = issued ? localDate(new Date(issued), utcOffset) : null;
  const rows: WeatherDayRow[] = [];
  times.forEach((t, i) => {
    const values: Record<string, number | null> = {};
    const units: Record<string, string> = {};
    for (const v of present) {
      const raw = r.daily[v]![i] ?? null;
      if (v === SECONDS_TO_HOURS_VARIABLE) {
        values[v] = raw === null ? null : Math.round((raw / 3600) * 100) / 100;
        units[v] = "h";
      } else {
        values[v] = raw;
        units[v] = r.daily_units[v]!;
      }
    }
    // A day where every REQUIRED variable is null carries no information (e.g. archive days not yet produced), whatever the
    // optional keys hold: a deeper value alone never makes a weather day.
    const requiredPresent = present.filter((v) => (REQUIRED_DAILY_VARIABLES as readonly string[]).includes(v));
    if ((requiredPresent.length ? requiredPresent : present).every((v) => values[v] === null)) return;
    rows.push({
      provider: OPENMETEO_PROVIDER,
      endpoint: args.endpoint,
      model: MODEL,
      modelBasis: "request_parameter_not_reported_by_response",
      measurementKind: args.endpoint === "archive" ? "reanalysis" : "forecast",
      evidenceState: args.endpoint === "archive" ? "observed" : "forecast",
      validDate: t,
      issueTime: issued,
      issueTimeBasis: issued ? "fetch_time_upper_bound" : "not_applicable",
      availableAt: args.fetchedAt,
      horizonDays: args.horizonDays,
      leadDays: issuedLocalDate ? daysBetween(issuedLocalDate, t) : null,
      values,
      units,
      requestedLat: args.requestedLat,
      requestedLon: args.requestedLon,
      gridLat: r.latitude,
      gridLon: r.longitude,
      elevationM: r.elevation ?? null,
      timezone: r.timezone ?? null,
      generationTimeMs: r.generationtime_ms ?? null,
      attribution: OPENMETEO_ATTRIBUTION,
    });
  });
  if (rows.length === 0) return unavailable("no_data", "response contained no non-null daily values");
  return { status: "ok", data: rows, notes };
}

async function run(
  endpoint: OpenMeteoEndpoint,
  url: string,
  ttlSeconds: number,
  req: { lat: number; lon: number; horizonDays: number | null; requested: readonly string[] },
  deps: OpenMeteoDeps,
  config: ProviderConfig,
): Promise<FetchResult<WeatherSeries>> {
  const now = deps.now ?? (() => new Date());
  const key = cacheKey(url);
  const cached = deps.cache ? await deps.cache.get(key).catch(() => null) : null;
  const build = (payload: CachedPayload, isCached: boolean, stale: boolean): FetchResult<WeatherSeries> => {
    const rows = parseOpenMeteoDaily({
      endpoint,
      body: payload.body,
      requestedLat: req.lat,
      requestedLon: req.lon,
      fetchedAt: payload.fetchedAt,
      horizonDays: req.horizonDays,
      requested: req.requested,
    });
    if (rows.status !== "ok") return rows;
    return { status: "ok", data: { endpoint, rows: rows.data, notes: rows.notes, fetchedAt: payload.fetchedAt, cached: isCached, stale, sourceUrl: url } };
  };
  if (cached && cached.expiresAt.getTime() > now().getTime()) {
    return build(cached.payload as CachedPayload, true, false);
  }
  const res = await getJson(url, { fetchImpl: deps.fetchImpl, timeoutMs: config.PROVIDER_TIMEOUT_MS, retries: config.PROVIDER_MAX_RETRIES, sleep: deps.sleep });
  if (!res.ok) {
    if (cached) return build(cached.payload as CachedPayload, true, true); // labelled stale; original fetch time preserved
    const upstream = res.body && typeof res.body === "object" ? (res.body as { reason?: unknown }).reason : undefined;
    const detail = typeof upstream === "string" ? `${res.message}: ${upstream}` : res.message;
    return unavailable(res.reason === "http_error" && res.status === 400 ? "invalid_request" : res.reason, detail);
  }
  const fetchedAt = now();
  const payload: CachedPayload = { url, fetchedAt: fetchedAt.toISOString(), body: res.json };
  const out = build(payload, false, false);
  if (out.status === "ok" && deps.cache) {
    await deps.cache
      .put({ key, provider: OPENMETEO_PROVIDER, fetchedAt, expiresAt: new Date(fetchedAt.getTime() + ttlSeconds * 1000), payload })
      .catch(() => undefined); // cache failure must not fail a good fetch
  }
  return out;
}

export interface ArchiveRequest {
  lat: number;
  lon: number;
  /** Inclusive ISO dates. */
  start: string;
  end: string;
  timezone?: string;
}

/** ERA5-family reanalysis via the Open-Meteo archive API. Rows are `observed` reanalysis, not station data. */
export async function fetchDailyArchive(req: ArchiveRequest, deps: OpenMeteoDeps = {}): Promise<FetchResult<WeatherSeries>> {
  if (!validCoord(req.lat, req.lon)) return unavailable("invalid_request", "latitude/longitude out of range");
  if (!validIsoDate(req.start) || !validIsoDate(req.end) || req.start > req.end) return unavailable("invalid_request", "start/end must be ISO dates with start <= end");
  if (daysBetween(req.start, req.end) > 366) return unavailable("invalid_request", "archive window is limited to 367 days per call");
  const config = deps.config ?? loadProviderConfig();
  const requested = ARCHIVE_DAILY_VARIABLES;
  const lat = roundCoord(req.lat);
  const lon = roundCoord(req.lon);
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: req.start,
    end_date: req.end,
    daily: requested.join(","),
    timezone: req.timezone ?? "Asia/Kolkata",
  });
  return run("archive", `${config.OPENMETEO_ARCHIVE_URL}?${p}`, config.OPENMETEO_ARCHIVE_TTL_SECONDS, { lat, lon, horizonDays: null, requested }, deps, config);
}

export interface ForecastRequest {
  lat: number;
  lon: number;
  /** 1..16 */
  days: number;
  timezone?: string;
}

export async function fetchForecast(req: ForecastRequest, deps: OpenMeteoDeps = {}): Promise<FetchResult<WeatherSeries>> {
  if (!validCoord(req.lat, req.lon)) return unavailable("invalid_request", "latitude/longitude out of range");
  if (!Number.isInteger(req.days) || req.days < 1 || req.days > 16) return unavailable("invalid_request", "forecast days must be an integer 1..16");
  const config = deps.config ?? loadProviderConfig();
  const requested = [...REQUIRED_DAILY_VARIABLES, ...OPTIONAL_DAILY_VARIABLES, ...OPTIONAL_FORECAST_VARIABLES];
  const lat = roundCoord(req.lat);
  const lon = roundCoord(req.lon);
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    forecast_days: String(req.days),
    daily: requested.join(","),
    timezone: req.timezone ?? "Asia/Kolkata",
  });
  return run("forecast", `${config.OPENMETEO_FORECAST_URL}?${p}`, config.OPENMETEO_FORECAST_TTL_SECONDS, { lat, lon, horizonDays: req.days, requested }, deps, config);
}
