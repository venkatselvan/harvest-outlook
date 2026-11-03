import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { memoryCache } from "../src/ingest/cache";
import type { FetchLike } from "../src/ingest/http";
import { loadProviderConfig } from "../src/providers/config";
import { fetchDailyArchive, fetchForecast, OPENMETEO_ATTRIBUTION, OPTIONAL_DAILY_VARIABLES, parseOpenMeteoDaily, REQUIRED_DAILY_VARIABLES } from "../src/providers/openmeteo/client";

const fx = (n: string) => JSON.parse(readFileSync(resolve(__dirname, "fixtures/openmeteo", n), "utf8")) as { url: string; fetchedAt: string; body: any };
const archive = fx("archive_hassan.json");
const forecast = fx("forecast_hassan.json");
const forecastAgro = fx("forecast_hassan_agro.json");
const config = loadProviderConfig({ PROVIDER_TIMEOUT_MS: "200", PROVIDER_MAX_RETRIES: "2" });
const noSleep = async () => undefined;

const ok = (body: unknown): Awaited<ReturnType<FetchLike>> => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() });
const status = (code: number, body: unknown = {}): Awaited<ReturnType<FetchLike>> => ({ ok: false, status: code, text: async () => JSON.stringify(body), headers: new Headers() });

describe("Open-Meteo parsing (recorded real responses)", () => {
  it("archive: units, grid cell and elevation come from the response; rows are reanalysis, not station data", () => {
    const r = parseOpenMeteoDaily({ endpoint: "archive", body: archive.body, requestedLat: 13.0033, requestedLon: 76.1004, fetchedAt: archive.fetchedAt, horizonDays: null, requested: REQUIRED_DAILY_VARIABLES });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.data).toHaveLength(7);
    const d0 = r.data[0]!;
    expect(d0.validDate).toBe("2026-10-15");
    expect(d0.values.precipitation_sum).toBe(1.4);
    expect(d0.units).toEqual({ precipitation_sum: "mm", temperature_2m_max: "°C", temperature_2m_min: "°C", et0_fao_evapotranspiration: "mm", shortwave_radiation_sum: "MJ/m²" });
    expect([d0.gridLat, d0.gridLon, d0.elevationM]).toEqual([12.970123, 76.090904, 944]);
    expect(d0.requestedLat).toBe(13.0033); // requested != used: both are retained in memory
    expect(d0.measurementKind).toBe("reanalysis");
    expect(d0.evidenceState).toBe("observed");
    expect(d0.issueTime).toBeNull();
    expect(d0.horizonDays).toBeNull();
    expect(d0.availableAt).toBe(archive.fetchedAt);
    expect(d0.attribution).toBe(OPENMETEO_ATTRIBUTION);
    expect(d0.modelBasis).toBe("request_parameter_not_reported_by_response");
  });

  it("forecast: issue time is the fetch time (upper bound), horizon is the requested days, lead days are local-date based", () => {
    const requested = [...REQUIRED_DAILY_VARIABLES, "precipitation_probability_max"];
    const r = parseOpenMeteoDaily({ endpoint: "forecast", body: forecast.body, requestedLat: 13, requestedLon: 76.1, fetchedAt: forecast.fetchedAt, horizonDays: 3, requested });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.data.map((x) => x.validDate)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(r.data.every((x) => x.issueTime === forecast.fetchedAt && x.issueTimeBasis === "fetch_time_upper_bound" && x.horizonDays === 3)).toBe(true);
    // fetched 19:55Z on 29 Oct = 01:25 IST on 30 Oct, so the first valid day is lead 0
    expect(r.data.map((x) => x.leadDays)).toEqual([0, 1, 2]);
    expect(r.data[0]!.evidenceState).toBe("forecast");
    expect(r.data[0]!.units.precipitation_probability_max).toBe("%");
    expect(r.data[2]!.values.precipitation_probability_max).toBe(47);
    // generationtime_ms is compute time, never used as an issue time
    expect(r.data[0]!.issueTime).not.toBe(String(forecast.body.generationtime_ms));
  });

  it("does not assume units: an unrecognised unit makes the result unavailable", () => {
    const body = structuredClone(archive.body);
    body.daily_units.precipitation_sum = "inch";
    const r = parseOpenMeteoDaily({ endpoint: "archive", body, requestedLat: 13, requestedLon: 76, fetchedAt: archive.fetchedAt, horizonDays: null, requested: REQUIRED_DAILY_VARIABLES });
    expect(r).toMatchObject({ status: "unavailable", reason: "unexpected_unit" });
  });

  it("missing required variable or length mismatch is schema_mismatch; optional probability may be absent", () => {
    const missing = structuredClone(archive.body);
    delete missing.daily.et0_fao_evapotranspiration;
    delete missing.daily_units.et0_fao_evapotranspiration;
    expect(parseOpenMeteoDaily({ endpoint: "archive", body: missing, requestedLat: 1, requestedLon: 1, fetchedAt: archive.fetchedAt, horizonDays: null, requested: REQUIRED_DAILY_VARIABLES })).toMatchObject({ reason: "schema_mismatch" });
    const short = structuredClone(archive.body);
    short.daily.precipitation_sum.pop();
    expect(parseOpenMeteoDaily({ endpoint: "archive", body: short, requestedLat: 1, requestedLon: 1, fetchedAt: archive.fetchedAt, horizonDays: null, requested: REQUIRED_DAILY_VARIABLES })).toMatchObject({ reason: "schema_mismatch" });
    const noProb = parseOpenMeteoDaily({ endpoint: "forecast", body: archive.body, requestedLat: 1, requestedLon: 1, fetchedAt: archive.fetchedAt, horizonDays: 7, requested: [...REQUIRED_DAILY_VARIABLES, "precipitation_probability_max"] });
    expect(noProb.status).toBe("ok");
  });

  it("drops all-null days instead of storing empty rows, and reports no_data when nothing remains", () => {
    const body = structuredClone(archive.body);
    for (const v of Object.keys(body.daily_units)) if (v !== "time") body.daily[v][6] = null;
    const r = parseOpenMeteoDaily({ endpoint: "archive", body, requestedLat: 1, requestedLon: 1, fetchedAt: archive.fetchedAt, horizonDays: null, requested: REQUIRED_DAILY_VARIABLES });
    expect(r.status === "ok" && r.data.length).toBe(6);
    for (const v of Object.keys(body.daily_units)) if (v !== "time") body.daily[v] = body.daily[v].map(() => null);
    expect(parseOpenMeteoDaily({ endpoint: "archive", body, requestedLat: 1, requestedLon: 1, fetchedAt: archive.fetchedAt, horizonDays: null, requested: REQUIRED_DAILY_VARIABLES })).toMatchObject({ reason: "no_data" });
  });
});

describe("Open-Meteo fetch behaviour", () => {
  it("rejects invalid requests without any network call", async () => {
    const f = vi.fn();
    const deps = { config, fetchImpl: f as unknown as FetchLike };
    expect(await fetchForecast({ lat: 13, lon: 76, days: 17 }, deps)).toMatchObject({ status: "unavailable", reason: "invalid_request" });
    expect(await fetchDailyArchive({ lat: 13, lon: 76, start: "2026-10-05", end: "2026-10-01" }, deps)).toMatchObject({ reason: "invalid_request" });
    expect(await fetchDailyArchive({ lat: 95, lon: 76, start: "2026-10-01", end: "2026-10-05" }, deps)).toMatchObject({ reason: "invalid_request" });
    expect(await fetchDailyArchive({ lat: 13, lon: 76, start: "2026-02-30", end: "2026-03-05" }, deps)).toMatchObject({ reason: "invalid_request" });
    expect(f).not.toHaveBeenCalled();
  });

  it("network failure retries at most twice then returns typed unavailable (no fabricated data)", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const r = await fetchForecast({ lat: 13, lon: 76.1, days: 3 }, { config, fetchImpl: f as unknown as FetchLike, sleep: noSleep });
    expect(r).toMatchObject({ status: "unavailable", reason: "network_error" });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("HTTP 400 is final (no retry) and surfaces the provider's reason", async () => {
    const f = vi.fn(async () => status(400, { error: true, reason: "Latitude must be in range of -90 to 90" }));
    const r = await fetchDailyArchive({ lat: 13, lon: 76, start: "2026-10-01", end: "2026-10-02" }, { config, fetchImpl: f as unknown as FetchLike, sleep: noSleep });
    expect(r).toMatchObject({ status: "unavailable", reason: "invalid_request" });
    expect((r as { detail: string }).detail).toContain("Latitude must be");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("5xx and 429 are retried; a later success is returned", async () => {
    const seq = [status(503), status(429), ok(archive.body)];
    const f = vi.fn(async () => seq.shift()!);
    const r = await fetchDailyArchive({ lat: 13, lon: 76.1, start: "2026-10-15", end: "2026-10-21" }, { config, fetchImpl: f as unknown as FetchLike, sleep: noSleep });
    expect(r.status).toBe("ok");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("times out a hung request", async () => {
    const f: FetchLike = (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const r = await fetchForecast({ lat: 13, lon: 76.1, days: 3 }, { config: loadProviderConfig({ PROVIDER_TIMEOUT_MS: "20", PROVIDER_MAX_RETRIES: "0" }), fetchImpl: f, sleep: noSleep });
    expect(r).toMatchObject({ status: "unavailable", reason: "timeout" });
  });

  it("rounds requested coordinates to 0.01 degree before they leave the server", async () => {
    let seen = "";
    const f: FetchLike = async (u) => {
      seen = u;
      return ok(archive.body);
    };
    await fetchDailyArchive({ lat: 13.00334, lon: 76.10041, start: "2026-10-15", end: "2026-10-21" }, { config, fetchImpl: f });
    expect(seen).toContain("latitude=13&longitude=76.1");
  });

  it("cache: fresh hit makes no request and keeps the original fetch time; expiry refetches; failure after expiry returns stale", async () => {
    const cache = memoryCache();
    let t = Date.parse("2026-10-29T20:00:00Z");
    const now = () => new Date(t);
    let calls = 0;
    let failing = false;
    const f: FetchLike = async () => {
      calls++;
      if (failing) throw new Error("down");
      return ok(forecast.body);
    };
    const deps = { config, fetchImpl: f, cache, now, sleep: noSleep };
    const first = await fetchForecast({ lat: 13, lon: 76.1, days: 3 }, deps);
    expect(first.status === "ok" && first.data.cached).toBe(false);
    const issue0 = first.status === "ok" ? first.data.rows[0]!.issueTime : null;
    expect(issue0).toBe("2026-10-29T20:00:00.000Z");

    t += 2 * 3600 * 1000; // inside the 3 h forecast window
    const second = await fetchForecast({ lat: 13, lon: 76.1, days: 3 }, deps);
    expect(calls).toBe(1);
    expect(second.status === "ok" && second.data.cached).toBe(true);
    expect(second.status === "ok" && second.data.rows[0]!.issueTime).toBe(issue0); // not re-stamped

    t += 2 * 3600 * 1000; // 4 h: expired
    const third = await fetchForecast({ lat: 13, lon: 76.1, days: 3 }, deps);
    expect(calls).toBe(2);
    expect(third.status === "ok" && third.data.rows[0]!.issueTime).toBe("2026-10-30T00:00:00.000Z");

    t += 4 * 3600 * 1000;
    failing = true;
    const fourth = await fetchForecast({ lat: 13, lon: 76.1, days: 3 }, { ...deps, sleep: noSleep });
    expect(fourth.status === "ok" && [fourth.data.stale, fourth.data.cached]).toEqual([true, true]);
  });

  it("archive cache window is 24 h (not 3 h)", async () => {
    const cache = memoryCache();
    let t = Date.parse("2026-10-29T20:00:00Z");
    let calls = 0;
    const f: FetchLike = async () => {
      calls++;
      return ok(archive.body);
    };
    const deps = { config, fetchImpl: f, cache, now: () => new Date(t) };
    const req = { lat: 13, lon: 76.1, start: "2026-10-15", end: "2026-10-21" };
    await fetchDailyArchive(req, deps);
    t += 20 * 3600 * 1000;
    await fetchDailyArchive(req, deps);
    expect(calls).toBe(1);
    t += 5 * 3600 * 1000;
    await fetchDailyArchive(req, deps);
    expect(calls).toBe(2);
  });
});

describe("Open-Meteo weather depth (constructed fixture forecast_hassan_agro.json, not a recorded response)", () => {
  const requested = [...REQUIRED_DAILY_VARIABLES, ...OPTIONAL_DAILY_VARIABLES, "precipitation_probability_max"];
  const parse = (body: unknown) => parseOpenMeteoDaily({ endpoint: "forecast", body, requestedLat: 13, requestedLon: 76.1, fetchedAt: forecastAgro.fetchedAt, horizonDays: 3, requested });

  it("parses the deeper keys; sunshine_duration seconds are stored as hours with unit h; other units are kept as reported", () => {
    const r = parse(forecastAgro.body);
    if (r.status !== "ok") throw new Error("expected ok");
    const d0 = r.data[0]!;
    expect(d0.values.wind_gusts_10m_max).toBe(31.3);
    expect(d0.values.soil_moisture_0_to_7cm_mean).toBe(0.318);
    expect(d0.values.sunshine_duration).toBe(7.1); // 25560 s / 3600
    expect(d0.units.sunshine_duration).toBe("h");
    expect(d0.units.soil_moisture_0_to_7cm_mean).toBe("m³/m³");
    expect(d0.units.vapour_pressure_deficit_max).toBe("kPa");
    expect(r.data[1]!.values.sunshine_duration).toBe(8);
  });

  it("an unrecognised unit on an OPTIONAL key omits that key and notes it; rain and temperature still parse; required keys keep their strict behaviour", () => {
    const body = structuredClone(forecastAgro.body);
    body.daily_units.wind_gusts_10m_max = "m/s"; // would otherwise be read as km/h and trip the 60 km/h alert
    const r = parse(body);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.notes).toEqual(["unexpected_unit:wind_gusts_10m_max:m/s"]);
    expect("wind_gusts_10m_max" in r.data[0]!.values).toBe(false);
    expect("wind_gusts_10m_max" in r.data[0]!.units).toBe(false);
    expect(r.data[0]!.values).toMatchObject({ precipitation_sum: 1.2, temperature_2m_max: 26.9, wind_speed_10m_max: 14.8 });
    // sunshine already in hours: dividing by 3600 again would be wrong, so it is omitted too
    const sun = structuredClone(forecastAgro.body);
    sun.daily_units.sunshine_duration = "h";
    const s2 = parse(sun);
    expect(s2.status === "ok" && s2.notes).toEqual(["unexpected_unit:sunshine_duration:h"]);
    expect(s2.status === "ok" && "sunshine_duration" in s2.data[0]!.values).toBe(false);
    // the optional rain probability follows the same rule; a clean response has no notes
    const prob = structuredClone(forecastAgro.body);
    prob.daily_units.precipitation_probability_max = "fraction";
    expect(parse(prob)).toMatchObject({ status: "ok", notes: ["unexpected_unit:precipitation_probability_max:fraction"] });
    expect(parse(forecastAgro.body)).toMatchObject({ status: "ok", notes: [] });
    // a REQUIRED key is unchanged: the whole response is unavailable
    const rain = structuredClone(forecastAgro.body);
    rain.daily_units.precipitation_sum = "inch";
    expect(parse(rain)).toMatchObject({ status: "unavailable", reason: "unexpected_unit" });
  });

  it("the fetch result carries the notes", async () => {
    const body = structuredClone(forecastAgro.body);
    body.daily_units.wind_speed_10m_max = "mp/h";
    const f: FetchLike = async () => ok(body);
    const r = await fetchForecast({ lat: 13, lon: 76.1, days: 3 }, { config, fetchImpl: f });
    expect(r.status === "ok" && r.data.notes).toEqual(["unexpected_unit:wind_speed_10m_max:mp/h"]);
    expect(r.status === "ok" && r.data.rows[0]!.values.wind_gusts_10m_max).toBe(31.3);
  });

  it("a day is dropped when every REQUIRED key is null, even if an optional key holds a value; an optional series of the wrong length is omitted with a note", () => {
    const body = structuredClone(forecastAgro.body);
    for (const v of REQUIRED_DAILY_VARIABLES) body.daily[v][1] = null; // rain, temperatures, ET0, radiation all null on day 2
    const r = parse(body);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(body.daily.relative_humidity_2m_mean[1]).toBe(74); // the deeper value is there...
    expect(r.data.map((x) => x.validDate)).toEqual(["2026-10-30", "2026-11-01"]); // ...and does not keep the day
    for (const v of Object.keys(body.daily_units)) if (v !== "time" && (REQUIRED_DAILY_VARIABLES as readonly string[]).includes(v)) body.daily[v] = body.daily[v].map(() => null);
    expect(parse(body)).toMatchObject({ status: "unavailable", reason: "no_data" });

    const short = structuredClone(forecastAgro.body);
    short.daily.wind_gusts_10m_max.pop();
    const s2 = parse(short);
    expect(s2.status === "ok" && s2.notes).toEqual(["length_mismatch:wind_gusts_10m_max"]);
    expect(s2.status === "ok" && "wind_gusts_10m_max" in s2.data[0]!.values).toBe(false);
    expect(s2.status === "ok" && s2.data[0]!.values.wind_speed_10m_max).toBe(14.8);
    const req = structuredClone(forecastAgro.body);
    req.daily.precipitation_sum.pop(); // a REQUIRED series of the wrong length still fails the response
    expect(parse(req)).toMatchObject({ status: "unavailable", reason: "schema_mismatch" });
  });

  it("a response without the deeper keys (the two recorded fixtures) still parses unchanged; null sunshine stays null", () => {
    const old = parse(forecast.body);
    expect(old.status === "ok" && Object.keys(old.data[0]!.values).sort()).toEqual([...REQUIRED_DAILY_VARIABLES, "precipitation_probability_max"].sort());
    const body = structuredClone(forecastAgro.body);
    body.daily.sunshine_duration[1] = null;
    const r = parse(body);
    expect(r.status === "ok" && r.data[1]!.values.sunshine_duration).toBeNull();
  });

  it("both endpoints request the deeper keys; the archive does not ask for the forecast-only rain probability", async () => {
    const seen: string[] = [];
    const f: FetchLike = async (u) => {
      seen.push(decodeURIComponent(u));
      return ok(u.includes("archive") || u.includes("start_date") ? archive.body : forecast.body);
    };
    await fetchForecast({ lat: 13, lon: 76.1, days: 3 }, { config, fetchImpl: f });
    await fetchDailyArchive({ lat: 13, lon: 76.1, start: "2026-10-15", end: "2026-10-21" }, { config, fetchImpl: f });
    for (const k of OPTIONAL_DAILY_VARIABLES) for (const u of seen) expect(u).toContain(k);
    expect(seen[0]).toContain("precipitation_probability_max");
    expect(seen[1]).not.toContain("precipitation_probability_max");
  });
});
