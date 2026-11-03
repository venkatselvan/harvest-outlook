/** Opt-in LIVE smoke (keyless): `pnpm --filter @harvest/api smoke:openmeteo`. Stores to DATABASE_URL and writes a trace. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../env";
import { createPool } from "../db/pool";
import { fetchDailyArchive, fetchForecast, OPTIONAL_DAILY_VARIABLES, OPTIONAL_FORECAST_VARIABLES, REQUIRED_DAILY_VARIABLES, type WeatherDayRow } from "../providers/openmeteo/client";
import type { FetchLike } from "./http";
import { loadProviderConfig } from "../providers/config";
import { pgCache } from "./cache";
import { storeArchive, storeForecast } from "./weather-store";

/**
 * Weather depth: one row per requested deeper key (units as stored, sample value, whether any day carried it) and the
 * documented call weighting (Open-Meteo counts more than 10 variables or more than 2 weeks of data fractionally).
 */
function deepVariables(rows: WeatherDayRow[], requested: readonly string[], days: number) {
  const keys = [...OPTIONAL_DAILY_VARIABLES, ...OPTIONAL_FORECAST_VARIABLES].filter((k) => requested.includes(k));
  return {
    requestedVariableCount: requested.length,
    documentedCallWeight: Math.round(Math.max(1, requested.length / 10) * Math.max(1, days / 14) * 100) / 100,
    keys: Object.fromEntries(keys.map((k) => [k, { present: rows.some((r) => r.values[k] != null), unit: rows[0]?.units[k] ?? null, firstDay: rows[0]?.values[k] ?? null }])),
  };
}

/** Records only the rate-limit response headers of each call; nothing else of the response is kept. */
const rateLimitHeaders: { url: string; headers: Record<string, string> }[] = [];
const recordingFetch: FetchLike = async (u, init) => {
  const res = await fetch(u, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/ratelimit|retry-after/i.test(k)) headers[k] = v;
  });
  rateLimitHeaders.push({ url: u.split("?")[0]!, headers });
  return res;
};

const HASSAN = { lat: 13.0033, lon: 76.1004 };
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = createPool(url);
const config = loadProviderConfig();
const today = new Date().toISOString().slice(0, 10);
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
// ERA5 lags real time by ~5 days; end 7 days back so the 7-day window is expected to be complete.
const archiveReq = { ...HASSAN, start: iso(-13), end: iso(-7) };
const trace: Record<string, unknown> = { task: "T05a", kind: "live-smoke", provider: "open-meteo", keyless: true, ranAt: new Date().toISOString(), location: "Hassan, Karnataka (requested, rounded to 0.01 degree before sending)" };
let failed = false;
try {
  const cache = pgCache(pool);
  const a = await fetchDailyArchive(archiveReq, { config, cache, fetchImpl: recordingFetch });
  if (a.status === "ok") {
    const stored = await storeArchive(pool, a.data);
    const r0 = a.data.rows[0]!;
    trace.archive = {
      status: "ok", window: archiveReq.start + ".." + archiveReq.end, rows: a.data.rows.length, cached: a.data.cached, fetchedAt: a.data.fetchedAt,
      units: r0.units, measurementKind: r0.measurementKind, model: r0.model, modelBasis: r0.modelBasis, grid: { lat: r0.gridLat, lon: r0.gridLon, elevationM: r0.elevationM },
      attribution: r0.attribution, stored, deepVariables: deepVariables(a.data.rows, [...REQUIRED_DAILY_VARIABLES, ...OPTIONAL_DAILY_VARIABLES], 7), firstRow: { date: r0.validDate, values: r0.values }, lastRow: { date: a.data.rows.at(-1)!.validDate, values: a.data.rows.at(-1)!.values }, sourceUrl: a.data.sourceUrl,
    };
  } else {
    failed = true;
    trace.archive = a;
  }
  const f = await fetchForecast({ ...HASSAN, days: 3 }, { config, cache, fetchImpl: recordingFetch });
  if (f.status === "ok") {
    const stored = await storeForecast(pool, f.data);
    const r0 = f.data.rows[0]!;
    trace.forecast = {
      status: "ok", rows: f.data.rows.length, cached: f.data.cached, fetchedAt: f.data.fetchedAt, issueTime: r0.issueTime, issueTimeBasis: r0.issueTimeBasis, horizonDays: r0.horizonDays,
      validDates: f.data.rows.map((r) => r.validDate), leadDays: f.data.rows.map((r) => r.leadDays), units: r0.units, model: r0.model, modelBasis: r0.modelBasis,
      grid: { lat: r0.gridLat, lon: r0.gridLon, elevationM: r0.elevationM }, attribution: r0.attribution, stored, deepVariables: deepVariables(f.data.rows, [...REQUIRED_DAILY_VARIABLES, ...OPTIONAL_DAILY_VARIABLES, ...OPTIONAL_FORECAST_VARIABLES], 3), firstRow: { date: r0.validDate, values: r0.values }, sourceUrl: f.data.sourceUrl,
    };
  } else {
    failed = true;
    trace.forecast = f;
  }
  // Empty when both reads were served from the cache (no network call was made).
  trace.rateLimitHeaders = rateLimitHeaders;
} finally {
  await pool.end();
}
const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../evals/results/live-smoke");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `openmeteo-${today}.json`);
writeFileSync(file, JSON.stringify(trace, null, 1) + "\n");
console.log(JSON.stringify(trace, null, 1));
console.log(`trace written: ${file}`);
if (failed) process.exitCode = 1;
