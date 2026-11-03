import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { climatologyJobKey, createWeatherSource } from "../src/plans/adapters/weather-source";
import { ARCHIVE_DAILY_VARIABLES, variableSetId } from "../src/providers/openmeteo/client";
import { climatologyAssumptionId } from "../src/plans/weather";
import { loadProviderConfig } from "../src/providers/config";
import { OPENMETEO_SOURCES, SYNTHETIC_SOURCE_ID, ensureSource } from "../src/ingest/sources";
import { enqueue } from "../src/services/jobs";
import { setupHarness, type Harness } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => JSON.parse(readFileSync(resolve(here, "fixtures/openmeteo", n), "utf8")) as { body: unknown };
const scope = { farmId: "f", districtId: null, stateId: null, point: { lon: 76.1004, lat: 13.0033 } };
const range = { start: "2026-10-15", end: "2026-10-21" };
const NOW = new Date("2026-10-30T02:00:00Z");

let h: Harness;
beforeAll(async () => {
  h = await setupHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.pool.query("TRUNCATE weather_observations, weather_forecasts, provider_cache");
});

const okFetch = (calls: string[]) => async (url: string) => {
  calls.push(url);
  const body = url.includes("archive-api") ? fx("archive_hassan.json").body : fx("forecast_hassan.json").body;
  return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() } as never;
};

describe("weather source adapter", () => {
  it("live mode with nothing stored fetches once (bounded), stores live rows, and returns them with observed values", async () => {
    const calls: string[] = [];
    const src = createWeatherSource({ pool: h.pool, mode: "live", now: () => NOW, fetchImpl: okFetch(calls), providerConfig: loadProviderConfig({}) });
    const obs = await src.getDailyObservations(scope, range, { availableBy: NOW.toISOString() });
    expect(obs.map((o) => o.date)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(obs[0]!.rainMm).not.toBeNull();
    expect(calls.filter((u) => u.includes("archive-api"))).toHaveLength(1);
    await src.getDailyObservations(scope, range, { availableBy: NOW.toISOString() });
    expect(calls).toHaveLength(1); // stored rows are reused
    expect(src.attribution()).toMatch(/Open-Meteo/);
    const rows = await h.pool.query("SELECT DISTINCT mode, is_synthetic FROM weather_observations");
    expect(rows.rows).toEqual([{ mode: "live", is_synthetic: false }]);
  });

  it("an unavailable provider yields no data rather than invented values", async () => {
    const src = createWeatherSource({ pool: h.pool, mode: "live", now: () => NOW, fetchImpl: async () => { throw new Error("down"); }, providerConfig: loadProviderConfig({ PROVIDER_MAX_RETRIES: "0" }) });
    expect(await src.getDailyObservations(scope, range, { availableBy: NOW.toISOString() })).toEqual([]);
    expect(await src.getForecast(scope, { issuedAtOrBefore: NOW.toISOString() })).toBeNull();
  });

  it("modes never cross: live never reads synthetic rows, synthetic never calls the network, replay respects availableBy", async () => {
    const sid = await ensureSource(h.pool, SYNTHETIC_SOURCE_ID, { title: "s", publisher: "s", url: "local:x", licence: "synthetic" });
    await h.pool.query(
      `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, available_at)
       VALUES ('synthetic:t', 76.1, 13.0, '2026-10-16', '{"precipitation_sum": 5}', $1, true, 'synthetic', '2026-10-17T00:00:00Z')`,
      [sid],
    );
    const calls: string[] = [];
    const live = createWeatherSource({ pool: h.pool, mode: "live", autoIngest: false, now: () => NOW, fetchImpl: okFetch(calls) });
    expect(await live.getDailyObservations(scope, range, { availableBy: NOW.toISOString() })).toEqual([]);
    const synth = createWeatherSource({ pool: h.pool, mode: "synthetic", now: () => NOW, fetchImpl: okFetch(calls) });
    expect((await synth.getDailyObservations(scope, range, { availableBy: NOW.toISOString() })).map((d) => [d.date, d.rainMm])).toEqual([["2026-10-16", 5]]);
    expect(await synth.getDailyObservations(scope, range, { availableBy: "2026-10-16T12:00:00Z" })).toEqual([]); // not yet available
    expect(calls).toHaveLength(0);
    // A farm 1 degree away does not borrow the cell.
    expect(await synth.getDailyObservations({ ...scope, point: { lon: 77.5, lat: 14.5 } }, range, { availableBy: NOW.toISOString() })).toEqual([]);
  });

  it("climatology needs at least five near-complete years; otherwise null; dataVersion changes when rows arrive", async () => {
    const sid = await ensureSource(h.pool, SYNTHETIC_SOURCE_ID, { title: "s", publisher: "s", url: "local:x", licence: "synthetic" });
    const src = createWeatherSource({ pool: h.pool, mode: "synthetic", now: () => NOW, climatologyYears: 10, climatologyEndYear: 2025 });
    const seed = (from: number, to: number) =>
      h.pool.query(
        `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, available_at)
         SELECT 'synthetic:c', 76.1, 13.0, d::date, '{"precipitation_sum": 2, "et0_fao_evapotranspiration": 3}'::jsonb, $1, true, 'synthetic', now() - interval '1 day'
           FROM generate_series($2::date, $3::date, interval '1 day') d ON CONFLICT DO NOTHING`,
        [sid, `${from}-01-01`, `${to}-12-31`],
      );
    await seed(2022, 2025); // 4 years
    const v1 = await src.dataVersion(scope, range, NOW.toISOString());
    expect(await src.getClimatology(scope, range)).toBeNull();
    await seed(2021, 2021);
    const v2 = await src.dataVersion(scope, range, NOW.toISOString());
    expect(v2).not.toBe(v1);
    const c = await src.getClimatology(scope, range);
    expect(c?.years).toEqual({ from: 2021, to: 2025 }); // only the five qualifying years inside the 10-year window are named
    expect(c?.qualifyingYears).toEqual([2021, 2022, 2023, 2024, 2025]);
    expect(climatologyAssumptionId(c!.years, c!.qualifyingYears)).toBe("climatology_2021-2025");
    expect(c?.days).toHaveLength(7);
    expect(c?.days[0]).toMatchObject({ rainMm: 2, et0Mm: 3, tMaxC: null });
  });

  it("non-contiguous qualifying years and partial years: label names only the years used", async () => {
    const sid = await ensureSource(h.pool, SYNTHETIC_SOURCE_ID, { title: "s", publisher: "s", url: "local:x", licence: "synthetic" });
    const src = createWeatherSource({ pool: h.pool, mode: "synthetic", now: () => NOW, climatologyYears: 10, climatologyEndYear: 2025 });
    const seed = (from: string, to: string, rain: number) =>
      h.pool.query(
        `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, available_at)
         SELECT 'synthetic:c', 76.1, 13.0, d::date, jsonb_build_object('precipitation_sum', $4::numeric), $1, true, 'synthetic', now() - interval '1 day'
           FROM generate_series($2::date, $3::date, interval '1 day') d ON CONFLICT DO NOTHING`,
        [sid, from, to, rain],
      );
    for (const y of [2017, 2018, 2021, 2022, 2025]) await seed(`${y}-01-01`, `${y}-12-31`, 2);
    await seed("2023-01-01", "2023-03-01", 900); // partial year (60 rows): excluded, must not skew normals
    const c = await src.getClimatology(scope, range);
    expect(c?.qualifyingYears).toEqual([2017, 2018, 2021, 2022, 2025]);
    expect(c?.years).toEqual({ from: 2017, to: 2025 });
    expect(climatologyAssumptionId(c!.years, c!.qualifyingYears)).toBe("climatology_5y_2017-2025");
    expect(c?.days[0]?.rainMm).toBe(2);
  });

  describe("weather depth: DailyWeather.agro", () => {
    const sid = () => ensureSource(h.pool, SYNTHETIC_SOURCE_ID, { title: "s", publisher: "s", url: "local:x", licence: "synthetic" });

    it("live forecast with the deeper keys carries agro (sunshine in hours); the plain recorded forecast carries only its rain probability", async () => {
      const fetchWith = (name: string) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(fx(name).body), headers: new Headers() }) as never;
      const withAgro = createWeatherSource({ pool: h.pool, mode: "live", now: () => NOW, fetchImpl: fetchWith("forecast_hassan_agro.json"), providerConfig: loadProviderConfig({}) });
      const f = await withAgro.getForecast(scope, { issuedAtOrBefore: NOW.toISOString() });
      expect(f?.days[0]?.agro).toEqual({
        et0Mm: 4, rhMeanPct: 78, rhMinPct: 52, rhMaxPct: 95, dewPointC: 19.4, vpdMaxKpa: 1.21, windMaxKmh: 14.8, gustMaxKmh: 31.3,
        soilMoisture0to7: 0.318, soilTemp0to7C: 23.6, leafWetnessPct: 61, sunshineHours: 7.1, rainHours: 3, rainProbabilityPct: 16,
      });
      await h.pool.query("TRUNCATE weather_observations, weather_forecasts, provider_cache");
      const plain = createWeatherSource({ pool: h.pool, mode: "live", now: () => NOW, fetchImpl: fetchWith("forecast_hassan.json"), providerConfig: loadProviderConfig({}) });
      const g = await plain.getForecast(scope, { issuedAtOrBefore: NOW.toISOString() });
      expect(g?.days.length).toBeGreaterThan(0);
      // the recorded fixture predates the deeper keys: only the rain probability it always had; nothing else is invented
      expect(g!.days[0]!.agro).toEqual({
        et0Mm: 4, rhMeanPct: null, rhMinPct: null, rhMaxPct: null, dewPointC: null, vpdMaxKpa: null, windMaxKmh: null, gustMaxKmh: null,
        soilMoisture0to7: null, soilTemp0to7C: null, leafWetnessPct: null, sunshineHours: null, rainHours: null, rainProbabilityPct: 16,
      });
    });

    it("typical days: means for ET0, humidity, soil moisture (0.001), leaf wetness and VPD; a field below MIN_SAMPLES_PER_DAY stays null; the rest are null", async () => {
      const source = await sid();
      const src = createWeatherSource({ pool: h.pool, mode: "synthetic", now: () => NOW, climatologyYears: 10, climatologyEndYear: 2025 });
      const seed = (from: string, to: string, vars: string) =>
        h.pool.query(
          `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, available_at)
           SELECT 'synthetic:c', 76.1, 13.0, d::date, ${vars}::jsonb, $1, true, 'synthetic', now() - interval '1 day'
             FROM generate_series($2::date, $3::date, interval '1 day') d ON CONFLICT DO NOTHING`,
          [source, from, to],
        );
      for (let y = 2021; y <= 2025; y++) await seed(`${y}-01-01`, `${y}-12-31`, `'{"precipitation_sum": 2, "et0_fao_evapotranspiration": 3, "relative_humidity_2m_mean": 80, "soil_moisture_0_to_7cm_mean": 0.2735, "vapour_pressure_deficit_max": 1.5, "wind_gusts_10m_max": 40}'`);
      // leaf wetness exists on four days of one year only: every 7-day window holds at most four samples (< 5), so it stays null.
      await h.pool.query(`UPDATE weather_observations SET variables = variables || '{"leaf_wetness_probability_mean": 70}'::jsonb WHERE observed_on BETWEEN '2021-10-15' AND '2021-10-18'`);
      const c = await src.getClimatology(scope, range);
      expect(c?.days[3]?.agro).toEqual({
        et0Mm: 3, rhMeanPct: 80, rhMinPct: null, rhMaxPct: null, dewPointC: null, vpdMaxKpa: 1.5, windMaxKmh: null, gustMaxKmh: null, // gusts are stored but have no typical value
        soilMoisture0to7: 0.274, soilTemp0to7C: null, leafWetnessPct: null, sunshineHours: null, rainHours: null, rainProbabilityPct: null,
      });
    });

    it("a deeper typical value needs MIN_CLIMATOLOGY_YEARS (5) years that carry the field: one year gives null, five give a value, and the bundle names the years behind it", async () => {
      const source = await sid();
      const src = createWeatherSource({ pool: h.pool, mode: "synthetic", now: () => NOW, climatologyYears: 10, climatologyEndYear: 2025 });
      await h.pool.query(
        `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, available_at)
         SELECT 'synthetic:c', 76.1, 13.0, d::date, '{"precipitation_sum": 2, "et0_fao_evapotranspiration": 3}'::jsonb, $1, true, 'synthetic', now() - interval '1 day'
           FROM generate_series('2021-01-01'::date, '2025-12-31'::date, interval '1 day') d ON CONFLICT DO NOTHING`,
        [source],
      );
      const addHumidity = (from: number, to: number) => h.pool.query(`UPDATE weather_observations SET variables = variables || '{"relative_humidity_2m_mean": 80}'::jsonb WHERE observed_on BETWEEN $1 AND $2`, [`${from}-01-01`, `${to}-12-31`]);
      await addHumidity(2025, 2025);
      const one = await src.getClimatology(scope, range);
      expect(one?.qualifyingYears).toHaveLength(5);
      expect(one!.days.every((d) => !("agro" in d))).toBe(true); // one year is not a 10-year (or 5-year) normal
      expect(one?.agroYears).toBeUndefined();
      await addHumidity(2022, 2024); // four years: still short
      expect((await src.getClimatology(scope, range))!.days.every((d) => !("agro" in d))).toBe(true);
      await addHumidity(2021, 2021);
      const five = await src.getClimatology(scope, range);
      expect(five?.days[3]?.agro).toMatchObject({ rhMeanPct: 80, et0Mm: 3 });
      expect(five?.agroYears).toEqual({ rhMeanPct: [2021, 2022, 2023, 2024, 2025] });
    });

    it("climatology of rows that predate the deeper keys has no agro (unchanged behaviour)", async () => {
      const source = await sid();
      const src = createWeatherSource({ pool: h.pool, mode: "synthetic", now: () => NOW, climatologyYears: 10, climatologyEndYear: 2025 });
      await h.pool.query(
        `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, available_at)
         SELECT 'synthetic:c', 76.1, 13.0, d::date, '{"precipitation_sum": 2, "et0_fao_evapotranspiration": 3}'::jsonb, $1, true, 'synthetic', now() - interval '1 day'
           FROM generate_series('2021-01-01'::date, '2025-12-31'::date, interval '1 day') d ON CONFLICT DO NOTHING`,
        [source],
      );
      const c = await src.getClimatology(scope, range);
      expect(c?.days.length).toBe(7);
      expect(c!.days.every((d) => !("agro" in d))).toBe(true);
    });
  });

  describe("weather depth: one-off climatology refetch for cells stored before the deeper variables", () => {
    const livePoint = { farmId: "f", districtId: null, stateId: null, point: { lon: 76.1004, lat: 13.0033 } };
    const seedLive = async (vars: string, years: [number, number] = [2016, 2025]) => {
      const source = await ensureSource(h.pool, OPENMETEO_SOURCES.archive.manifestId, OPENMETEO_SOURCES.archive.fallback);
      await h.pool.query(
        `INSERT INTO weather_observations (location_key, lon, lat, observed_on, variables, source_id, is_synthetic, mode, available_at)
         SELECT 'open-meteo:12.970,76.091', 76.09, 12.97, d::date, ${vars}::jsonb, $1, false, 'live', now() - interval '1 day'
           FROM generate_series($2::date, $3::date, interval '1 day') d ON CONFLICT DO NOTHING`,
        [source, `${years[0]}-01-01`, `${years[1]}-12-31`],
      );
    };
    const clim = (mode: "live" | "synthetic" = "live", autoIngest = true) =>
      createWeatherSource({ pool: h.pool, mode, autoIngest, now: () => NOW, climatologyYears: 10, climatologyEndYear: 2025, fetchImpl: async () => { throw new Error("no network in this test"); } });
    const keys = async () => (await h.pool.query<{ idempotency_key: string }>("SELECT idempotency_key FROM jobs WHERE type='ingest.weather_archive' ORDER BY idempotency_key")).rows.map((r) => r.idempotency_key);
    beforeEach(async () => { await h.pool.query("DELETE FROM jobs WHERE type='ingest.weather_archive'"); });

    it("qualifying live years without relative_humidity_2m_mean enqueue the yearly archive jobs once under a key derived from the requested variable set, even though earlier jobs finished", async () => {
      await seedLive(`'{"precipitation_sum": 2, "et0_fao_evapotranspiration": 3}'`);
      // earlier, finished jobs (the bare first-generation key, and a key of another variable set) hold their keys forever; neither may block this one
      const bare = await enqueue(h.pool, "ingest.weather_archive", { lat: 13, lon: 76.1, start: "2025-01-01", end: "2025-12-31" }, null, "clim:13,76.1:2025");
      const other = await enqueue(h.pool, "ingest.weather_archive", { lat: 13, lon: 76.1, start: "2025-01-01", end: "2025-12-31" }, null, climatologyJobKey(13, 76.1, 2025, ["precipitation_sum"]));
      await h.pool.query("UPDATE jobs SET state='succeeded' WHERE id = ANY($1::uuid[])", [[bare.job.id, other.job.id]]);
      const src = clim();
      const c = await src.getClimatology(livePoint, range);
      expect(c).not.toBeNull(); // normals still come back from the stored rows; the refetch only improves later reads
      const id = variableSetId(ARCHIVE_DAILY_VARIABLES);
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      const mine = (await keys()).filter((k) => k.startsWith(`clim:${id}:`));
      expect(mine).toEqual(Array.from({ length: 10 }, (_, i) => `clim:${id}:13,76.1:${2016 + i}`));
      expect(mine[0]).toBe(climatologyJobKey(13, 76.1, 2016));
      await src.getClimatology(livePoint, range); // same process within 15 minutes: no second attempt
      await clim().getClimatology(livePoint, range); // a new process: the idempotency key dedupes
      expect((await keys()).filter((k) => k.startsWith(`clim:${id}:`))).toHaveLength(10);
    });

    it("the key follows the variable set: adding or removing a variable changes it, order does not", () => {
      const base = climatologyJobKey(13, 76.1, 2025);
      expect(base).toBe(`clim:${variableSetId(ARCHIVE_DAILY_VARIABLES)}:13,76.1:2025`);
      expect(climatologyJobKey(13, 76.1, 2025, [...ARCHIVE_DAILY_VARIABLES, "snowfall_sum"])).not.toBe(base);
      expect(climatologyJobKey(13, 76.1, 2025, ARCHIVE_DAILY_VARIABLES.slice(1))).not.toBe(base);
      expect(climatologyJobKey(13, 76.1, 2025, [...ARCHIVE_DAILY_VARIABLES].reverse())).toBe(base);
      expect(climatologyJobKey(13.004, 76.1004, 2025)).toBe(base); // rounded to 0.01 degree like the request
    });

    it("nothing is queued when the stored years already carry humidity, in synthetic mode, or with autoIngest off", async () => {
      await seedLive(`'{"precipitation_sum": 2, "et0_fao_evapotranspiration": 3, "relative_humidity_2m_mean": 80}'`);
      await clim().getClimatology(livePoint, range);
      expect(await keys()).toEqual([]);
      await h.pool.query("TRUNCATE weather_observations");
      await seedLive(`'{"precipitation_sum": 2}'`);
      await clim("live", false).getClimatology(livePoint, range);
      expect(await keys()).toEqual([]);
      await clim("synthetic").getClimatology(livePoint, range); // synthetic never reads live rows and never queues
      expect(await keys()).toEqual([]);
    });

    it("depth backfill is per year: with humidity stored for every qualifying year but one, only that year is enqueued", async () => {
      await seedLive(`'{"precipitation_sum": 2, "et0_fao_evapotranspiration": 3, "relative_humidity_2m_mean": 80}'`);
      await h.pool.query(`UPDATE weather_observations SET variables = variables - 'relative_humidity_2m_mean' WHERE observed_on BETWEEN '2020-01-01' AND '2020-12-31'`); // a failed or stale year
      await clim().getClimatology(livePoint, range);
      expect(await keys()).toEqual([climatologyJobKey(13, 76.1, 2020)]);
    });
  });
});
