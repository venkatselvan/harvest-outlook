/**
 * T07b: Open-Meteo archive (ERA5-family reanalysis, gridded model estimate, NOT station data) daily rows for the Hassan
 * ginger supply region, 2010-01-01 to today, stored through the existing archive adapter and vintage store.
 *
 *   pnpm --filter @harvest/api exec tsx ../../scripts/seed/ingest-weather-hassan-archive.ts [-- --from 2010 --max-requests 20 --dry-run]
 *
 * - Public district reference point (Hassan town, 13.0033, 76.1004); the adapter rounds to 0.01 degree before sending.
 *   This is a regional supply proxy, not a farm location.
 * - One request per calendar year (adapter limit 367 days); hard cap --max-requests (default 20).
 * - available_at = fetch time (stored by the adapter). Availability basis for replay is NOT the fetch time: the archive is
 *   documented with a ~5-day delay, so the replay export assigns availableAt = date + 6 days
 *   (basis assumed_reanalysis_lag_6d); see evals/cases/forecast/ginger-karnataka-2026-10-30/holdout-policy.md.
 * - Days whose variables are all null (not yet produced) are dropped by the adapter, never stored as zero.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../../apps/api/src/env";
import { createPool } from "../../apps/api/src/db/pool";
import { storeArchive } from "../../apps/api/src/ingest/weather-store";
import { finishRun, payloadHash, startRun } from "../../apps/api/src/ingest/runs";
import { loadProviderConfig } from "../../apps/api/src/providers/config";
import { fetchDailyArchive } from "../../apps/api/src/providers/openmeteo/client";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const LAT = 13.0033;
const LON = 76.1004;
const fromYear = Number(arg("from", "2010"));
const maxRequests = Number(arg("max-requests", "20"));
const dryRun = process.argv.includes("--dry-run");
const today = new Date().toISOString().slice(0, 10);
const toYear = Number(today.slice(0, 4));

const config = loadProviderConfig();
if (config.RUNTIME_MODE === "replay") {
  console.error("Refusing: ingestion is disabled in replay mode.");
  process.exit(2);
}
const years = Array.from({ length: toYear - fromYear + 1 }, (_, i) => fromYear + i);
if (years.length > maxRequests) {
  console.error(`Refusing: ${years.length} yearly requests exceed --max-requests ${maxRequests}.`);
  process.exit(2);
}
if (!process.env.DATABASE_URL && !dryRun) {
  console.error("DATABASE_URL is required (or pass --dry-run).");
  process.exit(2);
}
const pool = dryRun ? null : createPool(process.env.DATABASE_URL!);
const startedAt = new Date();
const hash = payloadHash({ job: "ingest.weather_archive", lat: Math.round(LAT * 100) / 100, lon: Math.round(LON * 100) / 100, fromYear, toYear });
const runId = pool ? await startRun(pool, { jobId: null, jobType: "ingest.weather_archive", hash, provider: "open-meteo", mode: "live" }) : null;

const perYear: Record<string, unknown>[] = [];
let requests = 0;
let fatal: string | null = null;
let locationKey: string | null = null;
for (const y of years) {
  const start = `${y}-01-01`;
  const end = y === toYear ? today : `${y}-12-31`;
  const res = await fetchDailyArchive({ lat: LAT, lon: LON, start, end, timezone: "Asia/Kolkata" }, { config });
  requests++;
  if (res.status !== "ok") {
    perYear.push({ year: y, status: res.reason, detail: res.detail });
    if (res.reason !== "no_data") { fatal = `${y}: ${res.reason}`; break; }
    continue;
  }
  const rows = res.data.rows;
  const first = rows[0]!;
  const entry: Record<string, unknown> = { year: y, rows: rows.length, firstDate: first.validDate, lastDate: rows[rows.length - 1]!.validDate, gridLat: first.gridLat, gridLon: first.gridLon, units: first.units, cached: res.data.cached };
  if (pool) {
    const c = await storeArchive(pool, res.data);
    locationKey = c.locationKey;
    Object.assign(entry, { inserted: c.inserted, revisions: c.revisions, unchanged: c.unchanged });
  }
  perYear.push(entry);
  console.log(`archive ${y}: ${rows.length} rows ${first.validDate}..${rows[rows.length - 1]!.validDate}`);
}
const summary = {
  job: "ingest.weather_archive", provider: "open-meteo", endpoint: "archive", measurementKind: "reanalysis", mode: dryRun ? "dry-run" : "live",
  requestPoint: "Hassan town public reference (13.0033, 76.1004) rounded to 0.01 degree", locationKey, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  requests, maxRequests, fatal, perYear,
  totals: { rows: perYear.reduce((a, r) => a + (Number(r.rows) || 0), 0), inserted: perYear.reduce((a, r) => a + (Number(r.inserted) || 0), 0) },
  availabilityBasis: "stored available_at = fetch time; replay uses date + 6 days (assumed_reanalysis_lag_6d)",
  attribution: "Weather data by Open-Meteo.com (https://open-meteo.com/), CC BY 4.0",
};
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/raw/openmeteo");
mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `archive-hassan-${today}.json`);
writeFileSync(file, JSON.stringify(summary, null, 1) + "\n");
if (pool && runId) {
  await finishRun(pool, runId, fatal ? "failed" : "succeeded", { requests, totals: summary.totals }, { fromYear, toYear });
  await pool.end();
}
console.log(JSON.stringify({ requests, totals: summary.totals, locationKey, fatal }));
console.log(`wrote ${file}`);
if (fatal) process.exit(1);
