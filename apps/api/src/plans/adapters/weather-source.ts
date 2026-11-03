import type { DateRange, Mode } from "@harvest/contracts";
import { addDays, contentHash } from "@harvest/domain";
import type { Pool } from "../../db/pool";
import { scopedQuery, READABLE_ROW_MODES } from "../../ingest/scope";
import { pgCache } from "../../ingest/cache";
import { storeArchive, storeForecast } from "../../ingest/weather-store";
import { enqueue } from "../../services/jobs";
import { normalizeIngestPayload } from "../../worker/handlers/ingest";
import { loadProviderConfig, type ProviderConfig } from "../../providers/config";
import { ARCHIVE_DAILY_VARIABLES, fetchDailyArchive, fetchForecast, OPENMETEO_ATTRIBUTION, roundCoord, variableSetId } from "../../providers/openmeteo/client";
import type { FetchLike } from "../../ingest/http";
import type { ClimatologyBundle, DailyWeather, DailyWeatherAgro, ForecastBundle, WeatherScope, WeatherSource } from "../sources";
import { eachDate, regionDate } from "../weather";

/** Farm-to-grid-cell tolerance. Provider grids are 0.1-0.25 degree, so a stored cell is within ~0.18 degree of any farm in it. */
export const MAX_GRID_OFFSET_DEG = 0.3;
/** A climatology year needs near-complete daily data, and at least this many such years. */
export const MIN_CLIMATOLOGY_YEARS = 5;
const MIN_ROWS_PER_CLIMATOLOGY_YEAR = 300;
const MIN_SAMPLES_PER_DAY = 5;
const ARCHIVE_MAX_DAYS = 366;

export interface WeatherSourceAdapterOptions {
  pool: Pool;
  mode: Mode;
  /** Number of complete past years used for climatology. */
  climatologyYears?: number;
  /** Last climatology year; default is the year before `now`. Replay clamps it below the season's start year. */
  climatologyEndYear?: number | undefined;
  /** Live mode only: fetch missing archive/forecast data directly (bounded) when nothing is stored for the farm. */
  autoIngest?: boolean;
  ingestTimeoutMs?: number;
  providerConfig?: ProviderConfig;
  fetchImpl?: FetchLike | undefined;
  now?: () => Date;
}

export interface AttributedWeatherSource extends WeatherSource {
  /** Attribution text that must accompany live data derived from this source (empty for synthetic rows). */
  attribution(): string;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** node-postgres parses a `date` column as local midnight, so read local components (UTC would shift the day on hosts east of UTC). */
const dateStr = (v: unknown): string =>
  v instanceof Date ? `${String(v.getFullYear()).padStart(4, "0")}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : String(v).slice(0, 10);

/** Stored `variables` key behind each `DailyWeatherAgro` field. `sunshine_duration` is already stored in hours (client converts). */
const AGRO_KEYS: Record<keyof DailyWeatherAgro, string> = {
  et0Mm: "et0_fao_evapotranspiration",
  rhMeanPct: "relative_humidity_2m_mean",
  rhMinPct: "relative_humidity_2m_min",
  rhMaxPct: "relative_humidity_2m_max",
  dewPointC: "dew_point_2m_mean",
  vpdMaxKpa: "vapour_pressure_deficit_max",
  windMaxKmh: "wind_speed_10m_max",
  gustMaxKmh: "wind_gusts_10m_max",
  soilMoisture0to7: "soil_moisture_0_to_7cm_mean",
  soilTemp0to7C: "soil_temperature_0_to_7cm_mean",
  leafWetnessPct: "leaf_wetness_probability_mean",
  sunshineHours: "sunshine_duration",
  rainHours: "precipitation_hours",
  rainProbabilityPct: "precipitation_probability_max",
};

/**
 * `agro` is present only when the stored row carries at least one deeper variable besides ET0 (rows stored before the
 * weather-depth request have none, and stay exactly as they were). Missing keys are null, never filled.
 */
function agroOf(vars: Record<string, unknown>): DailyWeatherAgro | undefined {
  const agro = Object.fromEntries(Object.entries(AGRO_KEYS).map(([field, key]) => [field, num(vars[key])])) as unknown as DailyWeatherAgro;
  return Object.entries(agro).some(([field, v]) => field !== "et0Mm" && v !== null) ? agro : undefined;
}

function toDaily(date: string, vars: Record<string, unknown>, sourceId: string): DailyWeather {
  const agro = agroOf(vars);
  return {
    date,
    rainMm: num(vars.precipitation_sum),
    et0Mm: num(vars.et0_fao_evapotranspiration),
    tMaxC: num(vars.temperature_2m_max),
    tMinC: num(vars.temperature_2m_min),
    ...(agro ? { agro } : {}),
    sourceId,
  };
}

/** Day-of-year on a fixed non-leap calendar; 29 February maps to 28 February. */
function ordinal(date: string): number {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(2001, m - 1, m === 2 && d === 29 ? 28 : d) - Date.UTC(2001, 0, 1)) / 86_400_000);
}

/** Mean over a window; null below MIN_SAMPLES_PER_DAY samples. `decimals` 3 keeps soil moisture (m³/m³) shown to 0.1 %. */
/**
 * Idempotency key of one climatology archive job: `clim:<variable-set id>:<lat>,<lon>:<year>`. The id is derived from the
 * variables the archive request asks for, so adding a variable re-triggers the (bounded, once per key) backfill by itself.
 * A hand-bumped version would let a stale worker spend the one-shot keys with an older request (2026-11-03 incident).
 */
export function climatologyJobKey(lat: number, lon: number, year: number, variables: readonly string[] = ARCHIVE_DAILY_VARIABLES): string {
  return `clim:${variableSetId(variables)}:${roundCoord(lat)},${roundCoord(lon)}:${year}`;
}

const mean = (xs: number[], decimals = 2): number | null => {
  if (xs.length < MIN_SAMPLES_PER_DAY) return null;
  const f = 10 ** decimals;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * f) / f;
};

/** Deeper daily variables with a typical-day mean (others stay null on typical days). */
const TYPICAL_AGRO = ["rhMeanPct", "soilMoisture0to7", "leafWetnessPct", "vpdMaxKpa"] as const;
type TypicalAgroKey = (typeof TYPICAL_AGRO)[number];

/** WeatherSource over the T05a stores. Never fabricates: a missing day stays missing. */
export function createWeatherSource(o: WeatherSourceAdapterOptions): AttributedWeatherSource {
  const { pool, mode } = o;
  const q = scopedQuery(mode);
  const now = o.now ?? (() => new Date());
  const climYears = o.climatologyYears ?? 10;
  const timeoutMs = o.ingestTimeoutMs ?? 20_000;
  const auto = (o.autoIngest ?? true) && mode === "live";
  const sourceLabels = new Map<string, string>();
  const attempted = new Map<string, number>();

  const label = async (id: string): Promise<string> => {
    const hit = sourceLabels.get(id);
    if (hit) return hit;
    const r = await pool.query<{ manifest_id: string | null }>("SELECT manifest_id FROM source_documents WHERE id=$1", [id]);
    const v = r.rows[0]?.manifest_id ?? id;
    sourceLabels.set(id, v);
    return v;
  };

  /** Nearest stored grid cell for the farm point within tolerance, restricted to this mode's readable rows. */
  async function nearestKey(table: "weather_observations" | "weather_forecasts", p: { lon: number; lat: number }): Promise<string | null> {
    const r = await pool.query<{ location_key: string }>(
      `SELECT location_key FROM ${table}
        WHERE mode = ANY($1::text[]) AND is_synthetic = $2
          AND lat BETWEEN $3 AND $4 AND lon BETWEEN $5 AND $6
        GROUP BY location_key, lat, lon
        ORDER BY (lat - $7)^2 + (lon - $8)^2, location_key
        LIMIT 1`,
      [[...READABLE_ROW_MODES[mode]], mode === "synthetic", p.lat - MAX_GRID_OFFSET_DEG, p.lat + MAX_GRID_OFFSET_DEG, p.lon - MAX_GRID_OFFSET_DEG, p.lon + MAX_GRID_OFFSET_DEG, p.lat, p.lon],
    );
    return r.rows[0]?.location_key ?? null;
  }

  /** Bounded, at most one attempt per (kind, rounded point) per 15 minutes so a provider outage is not hammered. */
  async function bounded(kind: string, p: { lon: number; lat: number }, run: () => Promise<void>): Promise<void> {
    if (!auto) return;
    const k = `${kind}:${roundCoord(p.lat)},${roundCoord(p.lon)}`;
    const last = attempted.get(k);
    if (last !== undefined && now().getTime() - last < 15 * 60_000) return;
    attempted.set(k, now().getTime());
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([run(), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("ingest_timeout")), timeoutMs)))]);
    } catch {
      // Provider unavailable or slow: the caller reads whatever is stored (possibly nothing).
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const providerCfg = () => o.providerConfig ?? loadProviderConfig();
  const deps = () => ({ config: providerCfg(), fetchImpl: o.fetchImpl, now, cache: pgCache(pool) });

  async function ingestArchive(p: { lon: number; lat: number }, start: string, end: string) {
    const res = await fetchDailyArchive({ lat: p.lat, lon: p.lon, start, end }, deps());
    if (res.status === "ok" && res.data.rows.length > 0) await storeArchive(pool, res.data);
  }

  async function observationRows(scope: WeatherScope, range: DateRange, availableBy: Date): Promise<Row[]> {
    if (!scope.point) return [];
    const read = async () => {
      const key = await nearestKey("weather_observations", scope.point!);
      return key ? q.weatherObservations(pool, { locationKey: key, from: range.start, to: range.end, availableBy }) : [];
    };
    let rows = await read();
    if (rows.length === 0 && auto) {
      const end = [range.end, addDays(regionDate(now()), -1)].sort()[0]!;
      const start = [range.start, addDays(end, -(ARCHIVE_MAX_DAYS - 1))].sort().at(-1)!;
      if (start <= end) {
        await bounded("archive", scope.point, () => ingestArchive(scope.point!, start, end));
        rows = await read();
      }
    }
    return rows;
  }

  async function forecastRows(scope: WeatherScope, issuedAtOrBefore: string): Promise<Row[]> {
    if (!scope.point) return [];
    const asOf = new Date(issuedAtOrBefore);
    const from = addDays(regionDate(asOf), -20);
    const read = async () => {
      const key = await nearestKey("weather_forecasts", scope.point!);
      if (!key) return [];
      const rows = await q.weatherForecasts(pool, { locationKey: key, from, availableBy: asOf });
      const eligible = rows.filter((r) => (r.issued_at as Date).getTime() <= asOf.getTime());
      if (eligible.length === 0) return [];
      const latest = Math.max(...eligible.map((r) => (r.issued_at as Date).getTime()));
      return eligible.filter((r) => (r.issued_at as Date).getTime() === latest);
    };
    let rows = await read();
    if (rows.length === 0 && auto) {
      await bounded("forecast", scope.point, async () => {
        const res = await fetchForecast({ lat: scope.point!.lat, lon: scope.point!.lon, days: 16 }, deps());
        if (res.status === "ok" && res.data.rows.length > 0) await storeForecast(pool, res.data);
      });
      rows = await read();
    }
    return rows;
  }

  function climatologyYears(range: DateRange): { from: number; to: number } {
    let to = o.climatologyEndYear ?? now().getUTCFullYear() - 1;
    // Replay: reference years must end before the season starts so they cannot contain post-cutoff data.
    if (mode === "replay") to = Math.min(to, Number(range.start.slice(0, 4)) - 1);
    return { from: to - climYears + 1, to };
  }

  async function climatologyRows(scope: WeatherScope, years: { from: number; to: number }, range: DateRange, availableBy?: string): Promise<Row[]> {
    if (!scope.point) return [];
    const key = await nearestKey("weather_observations", scope.point);
    if (!key) return [];
    return q.weatherObservations(pool, { locationKey: key, from: `${years.from}-01-01`, to: `${years.to}-12-31`, ...(mode === "replay" ? { availableBy: new Date(availableBy ?? `${range.start}T00:00:00Z`) } : {}) });
  }

  /**
   * Queues one archive job per missing year (bounded, deduplicated by key) so normals appear on a later read.
   * `depth` is the weather-depth re-fetch for a cell whose stored years predate the deeper variables (same attempt rule,
   * its own 15-minute slot). Jobs are deduplicated for good by the idempotency key (a finished job keeps its key), so the
   * key carries the requested variable set (`climatologyJobKey`): once per point, year and variable set.
   */
  async function queueClimatologyBackfill(scope: WeatherScope, years: number[], depth = false) {
    if (!auto || !scope.point || years.length === 0) return;
    const p = scope.point;
    await bounded(depth ? "climatology_depth" : "climatology", p, async () => {
      for (const y of years) {
        await enqueue(pool, "ingest.weather_archive", normalizeIngestPayload("ingest.weather_archive", { lat: p.lat, lon: p.lon, start: `${y}-01-01`, end: `${y}-12-31` }), null, climatologyJobKey(p.lat, p.lon, y)).catch(() => undefined);
      }
    });
  }

  return {
    modes: ["live", "replay", "synthetic"],

    attribution: () => (mode === "synthetic" ? "" : OPENMETEO_ATTRIBUTION),

    async getDailyObservations(scope, range, opts) {
      const rows = await observationRows(scope, range, new Date(opts.availableBy));
      const byDate = new Map<string, DailyWeather>();
      for (const r of rows) {
        const d = dateStr(r.observed_on);
        byDate.set(d, toDaily(d, (r.variables ?? {}) as Record<string, unknown>, await label(String(r.source_id))));
      }
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    },

    async getForecast(scope, opts): Promise<ForecastBundle | null> {
      const rows = await forecastRows(scope, opts.issuedAtOrBefore);
      if (rows.length === 0) return null;
      const sourceId = await label(String(rows[0]!.source_id));
      const days = rows.map((r) => toDaily(dateStr(r.valid_on), (r.variables ?? {}) as Record<string, unknown>, sourceId));
      return { issuedAt: (rows[0]!.issued_at as Date).toISOString(), sourceId, days };
    },

    /** `opts.availableBy` is the replay decision cutoff; the plan engine passes it in replay mode (the default is the range start). Reference years named in the result are only those with >= 300 rows. */
    async getClimatology(scope, range, opts?: { availableBy?: string }): Promise<ClimatologyBundle | null> {
      const years = climatologyYears(range);
      const rows = await climatologyRows(scope, years, range, opts?.availableBy);
      const perYear = new Map<number, number>();
      for (const r of rows) perYear.set(Number(dateStr(r.observed_on).slice(0, 4)), (perYear.get(Number(dateStr(r.observed_on).slice(0, 4))) ?? 0) + 1);
      const qualifying = [...perYear.entries()].filter(([, n]) => n >= MIN_ROWS_PER_CLIMATOLOGY_YEAR).map(([y]) => y).sort((a, b) => a - b);
      if (qualifying.length < MIN_CLIMATOLOGY_YEARS) {
        if (rows.length === 0) await queueClimatologyBackfill(scope, Array.from({ length: years.to - years.from + 1 }, (_, i) => years.from + i));
        return null; // scenario unavailable; never substituted
      }
      type Slot = { rain: number[]; et0: number[]; tmax: number[]; tmin: number[] } & Record<TypicalAgroKey, number[]>;
      const newSlot = (): Slot => ({ rain: [], et0: [], tmax: [], tmin: [], rhMeanPct: [], soilMoisture0to7: [], leafWetnessPct: [], vpdMaxKpa: [] });
      // A year "carries" a deeper field when MIN_ROWS_PER_CLIMATOLOGY_YEAR of its rows have it, like a qualifying year.
      const qset = new Set(qualifying);
      const carried: Record<TypicalAgroKey, Map<number, number>> = { rhMeanPct: new Map(), soilMoisture0to7: new Map(), leafWetnessPct: new Map(), vpdMaxKpa: new Map() };
      for (const r of rows) {
        const y = Number(dateStr(r.observed_on).slice(0, 4));
        if (!qset.has(y)) continue;
        const a = agroOf((r.variables ?? {}) as Record<string, unknown>);
        for (const k of TYPICAL_AGRO) if (a && a[k] !== null) carried[k].set(y, (carried[k].get(y) ?? 0) + 1);
      }
      const yearsWith = (k: TypicalAgroKey) => qualifying.filter((y) => (carried[k].get(y) ?? 0) >= MIN_ROWS_PER_CLIMATOLOGY_YEAR);
      // Per field: a typical value needs MIN_CLIMATOLOGY_YEARS years that carry it; fewer is no normal (null), never a one-year "typical".
      const agroYears: NonNullable<ClimatologyBundle["agroYears"]> = {};
      for (const k of TYPICAL_AGRO) {
        const ys = yearsWith(k);
        if (ys.length >= MIN_CLIMATOLOGY_YEARS) agroYears[k] = ys;
      }
      // Live cell: every qualifying year that lacks the humidity series is refetched once per variable set (per year, so a
      // failed or stale year is retried when the set changes, and an older complete year is not refetched for nothing).
      const lacking = qualifying.filter((y) => !yearsWith("rhMeanPct").includes(y));
      if (lacking.length) await queueClimatologyBackfill(scope, lacking, true);
      const byOrdinal = new Map<number, Slot>();
      let sourceId = "";
      for (const r of rows) {
        if (!qset.has(Number(dateStr(r.observed_on).slice(0, 4)))) continue; // partial years are neither used nor named
        const v = (r.variables ?? {}) as Record<string, unknown>;
        const o2 = ordinal(dateStr(r.observed_on));
        const slot = byOrdinal.get(o2) ?? newSlot();
        const d = toDaily(dateStr(r.observed_on), v, "");
        if (d.rainMm !== null) slot.rain.push(d.rainMm);
        if (d.et0Mm !== null) slot.et0.push(d.et0Mm);
        if (d.tMaxC !== null) slot.tmax.push(d.tMaxC);
        if (d.tMinC !== null) slot.tmin.push(d.tMinC);
        for (const k of TYPICAL_AGRO) if (d.agro && d.agro[k] !== null && agroYears[k]?.includes(Number(dateStr(r.observed_on).slice(0, 4)))) slot[k].push(d.agro[k]!); // only the years that carry the field
        byOrdinal.set(o2, slot);
        sourceId = String(r.source_id);
      }
      const window = (ord: number, pick: "rain" | "et0" | "tmax" | "tmin" | TypicalAgroKey) => {
        const xs: number[] = [];
        for (let k = -3; k <= 3; k++) xs.push(...(byOrdinal.get((ord + k + 365) % 365)?.[pick] ?? []));
        return mean(xs, pick === "soilMoisture0to7" ? 3 : 2);
      };
      const days: DailyWeather[] = [];
      const src = await label(sourceId);
      for (const date of eachDate(range.start, range.end)) {
        const ord = ordinal(date);
        const d: DailyWeather = { date, rainMm: window(ord, "rain"), et0Mm: window(ord, "et0"), tMaxC: window(ord, "tmax"), tMinC: window(ord, "tmin"), sourceId: src };
        // Same MIN_SAMPLES_PER_DAY rule per field; agro is attached only when a deeper normal exists.
        const typical = Object.fromEntries(TYPICAL_AGRO.map((k) => [k, window(ord, k)])) as Record<TypicalAgroKey, number | null>;
        if (TYPICAL_AGRO.some((k) => typical[k] !== null)) {
          d.agro = {
            et0Mm: d.et0Mm, rhMeanPct: typical.rhMeanPct, rhMinPct: null, rhMaxPct: null, dewPointC: null, vpdMaxKpa: typical.vpdMaxKpa, windMaxKmh: null, gustMaxKmh: null,
            soilMoisture0to7: typical.soilMoisture0to7, soilTemp0to7C: null, leafWetnessPct: typical.leafWetnessPct, sunshineHours: null, rainHours: null, rainProbabilityPct: null,
          };
        }
        if (d.rainMm !== null || d.et0Mm !== null || d.tMaxC !== null || d.tMinC !== null) days.push(d);
      }
      return { years: { from: qualifying[0]!, to: qualifying[qualifying.length - 1]! }, qualifyingYears: qualifying, ...(Object.keys(agroYears).length ? { agroYears } : {}), sourceId: src, days };
    },

    /** Cheap token: counts and newest availability of what the reads above would see. No network, no ingest. */
    async dataVersion(scope, range, asOf) {
      if (!scope.point) return "no_point";
      const asOfDate = new Date(asOf);
      const years = climatologyYears(range);
      const [okey, fkey] = await Promise.all([nearestKey("weather_observations", scope.point), nearestKey("weather_forecasts", scope.point)]);
      const modes = [...READABLE_ROW_MODES[mode]];
      const synth = mode === "synthetic";
      const obs = okey
        ? (
            await pool.query<{ n: string; m: Date | null; r: Date | null }>(
              `SELECT count(*) n, max(available_at) m, max(revised_at) r FROM weather_observations
                WHERE location_key=$1 AND mode = ANY($2::text[]) AND is_synthetic=$3 AND observed_on BETWEEN $4 AND $5 AND available_at <= $6`,
              [okey, modes, synth, range.start, range.end, asOfDate],
            )
          ).rows[0]!
        : null;
      const fc = fkey
        ? (
            await pool.query<{ n: string; latest: Date | null; m: Date | null }>(
              `SELECT count(*) n, max(issued_at) latest, max(available_at) m FROM weather_forecasts
                WHERE location_key=$1 AND mode = ANY($2::text[]) AND is_synthetic=$3 AND issued_at <= $4 AND available_at <= $4 AND valid_on >= $5`,
              [fkey, modes, synth, asOfDate, addDays(regionDate(asOfDate), -20)],
            )
          ).rows[0]!
        : null;
      const clim = okey
        ? (
            await pool.query<{ n: string; m: Date | null }>(
              `SELECT count(*) n, max(available_at) m FROM weather_observations
                WHERE location_key=$1 AND mode = ANY($2::text[]) AND is_synthetic=$3 AND observed_on BETWEEN $4 AND $5`,
              [okey, modes, synth, `${years.from}-01-01`, `${years.to}-12-31`],
            )
          ).rows[0]!
        : null;
      return contentHash({
        v: 1,
        obs: obs && { n: Number(obs.n), m: obs.m?.toISOString() ?? null, r: obs.r?.toISOString() ?? null },
        fc: fc && { n: Number(fc.n), latest: fc.latest?.toISOString() ?? null, m: fc.m?.toISOString() ?? null },
        clim: clim && { n: Number(clim.n), m: clim.m?.toISOString() ?? null, years },
      });
    },
  };
}
