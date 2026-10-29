import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWeatherSource } from "../src/plans/adapters/weather-source";
import { loadProviderConfig } from "../src/providers/config";
import { SYNTHETIC_SOURCE_ID, ensureSource } from "../src/ingest/sources";
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
    expect(c?.years).toEqual({ from: 2016, to: 2025 });
    expect(c?.days).toHaveLength(7);
    expect(c?.days[0]).toMatchObject({ rainMm: 2, et0Mm: 3, tMaxC: null });
  });
});
