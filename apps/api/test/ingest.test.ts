import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { assertSyntheticMode, FIXTURE_DIR, loadSyntheticFixtures, SyntheticFixtureError } from "../src/ingest/fixtures";
import { loadManifest, manifestFileSchema, readManifest } from "../src/ingest/manifest";
import { scopedQuery } from "../src/ingest/scope";
import { SYNTHETIC_SOURCE_ID } from "../src/ingest/sources";
import { storeArchive, storeForecast } from "../src/ingest/weather-store";
import { runSeed } from "../src/ingest/seed";
import { loadProviderConfig } from "../src/providers/config";
import { parseOpenMeteoDaily, REQUIRED_DAILY_VARIABLES, type WeatherSeries } from "../src/providers/openmeteo/client";
import type { FetchLike } from "../src/ingest/http";
import { createIngestHandlers, type IngestContext } from "../src/worker/handlers/ingest";
import { handlers, runJob, claimJob } from "../src/worker/main";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/harvest_outlook_test";
let pool: Pool;
let available = false;

const fx = (n: string) => JSON.parse(readFileSync(resolve(__dirname, "fixtures/openmeteo", n), "utf8")) as { fetchedAt: string; body: any };
const archiveFx = fx("archive_hassan.json");
const forecastFx = fx("forecast_hassan.json");

beforeAll(async () => {
  pool = createPool(url);
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    if (process.env.CI) throw new Error("test database required in CI");
    console.warn("test database unavailable; ingest DB tests skipped");
    return;
  }
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
});
afterAll(async () => pool.end());

const ifDb = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => { if (!available) return ctx.skip(); await fn(); });
const count = async (t: string, where = "true") => Number((await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${where}`)).rows[0].n);

function series(endpoint: "archive" | "forecast", mutate?: (b: any) => void): WeatherSeries {
  const f = endpoint === "archive" ? archiveFx : forecastFx;
  const body = structuredClone(f.body);
  mutate?.(body);
  const r = parseOpenMeteoDaily({ endpoint, body, requestedLat: 13, requestedLon: 76.1, fetchedAt: f.fetchedAt, horizonDays: endpoint === "forecast" ? 3 : null, requested: endpoint === "archive" ? REQUIRED_DAILY_VARIABLES : [...REQUIRED_DAILY_VARIABLES, "precipitation_probability_max"] });
  if (r.status !== "ok") throw new Error("fixture parse failed");
  return { endpoint, rows: r.data, fetchedAt: f.fetchedAt, cached: false, stale: false, sourceUrl: "fixture" };
}

describe("source manifest loader", () => {
  ifDb("loads the real manifest and is idempotent (second run changes nothing)", async () => {
    const m = await readManifest();
    const first = await loadManifest(pool, m);
    expect(first).toMatchObject({ total: m.records.length, inserted: m.records.length, updated: 0 });
    const n1 = await count("source_documents", "manifest_id IS NOT NULL");
    const second = await loadManifest(pool, m);
    expect(second).toMatchObject({ inserted: 0, updated: 0 });
    expect(await count("source_documents", "manifest_id IS NOT NULL")).toBe(n1);
    const row = (await pool.query("SELECT * FROM source_documents WHERE manifest_id='MKT02-dgi-mandi-current'")).rows[0];
    expect(row.access_class).toBe("public");
    expect(row.metadata.accessRoute).toBe("api_key_required_free");
    expect(row.metadata.validation).toBe("retrieval_failed");
  });

  ifDb("a changed record is updated in place, not duplicated", async () => {
    const m = await readManifest();
    const changed = structuredClone(m);
    changed.records[0]!.title = changed.records[0]!.title + " (edited)";
    const r = await loadManifest(pool, changed);
    expect(r).toMatchObject({ inserted: 0, updated: 1 });
    await loadManifest(pool, m);
  });

  it("rejects duplicate ids and malformed records", () => {
    const base = { id: "a", url: "u", publisher: "p", title: "t", accessRoute: "r", licence: "l", retrievedAt: null, sha256: null, validation: "v" };
    expect(manifestFileSchema.safeParse({ schemaVersion: 1, records: [base, base] }).success).toBe(false);
    expect(manifestFileSchema.safeParse({ schemaVersion: 1, records: [{ ...base, sha256: "xyz" }] }).success).toBe(false);
    expect(manifestFileSchema.safeParse({ schemaVersion: 1, records: [{ ...base, retrievedAt: "yesterday" }] }).success).toBe(false);
    expect(manifestFileSchema.safeParse({ schemaVersion: 1, records: [base] }).success).toBe(true);
  });
});

describe("synthetic fixtures", () => {
  it("refuse to load outside synthetic mode, before touching the database", async () => {
    expect(() => assertSyntheticMode("live")).toThrow(SyntheticFixtureError);
    expect(() => assertSyntheticMode("replay")).toThrow(SyntheticFixtureError);
    expect(() => assertSyntheticMode("synthetic")).not.toThrow();
    // a pool that must never be used
    const trap = new Proxy({}, { get() { throw new Error("database touched"); } }) as unknown as Pool;
    await expect(loadSyntheticFixtures(trap, "live")).rejects.toThrow(/refusing to load synthetic fixtures/);
    await expect(loadSyntheticFixtures(trap, "replay")).rejects.toThrow(SyntheticFixtureError);
  });

  it("every shipped fixture record is marked synthetic with the synthetic source id", () => {
    for (const f of ["market_synthetic_ginger_like.json", "weather_synthetic_hassan_like.json"]) {
      const j = JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8"));
      expect(j.synthetic).toBe(true);
      expect(j.sourceId).toBe(SYNTHETIC_SOURCE_ID);
      expect(j.records.length).toBeGreaterThan(10);
      expect(j.records.every((r: any) => r.synthetic === true && r.sourceId === SYNTHETIC_SOURCE_ID)).toBe(true);
    }
  });

  ifDb("a fixture with an unmarked record is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synth-"));
    try {
      await cp(FIXTURE_DIR, dir, { recursive: true });
      const p = join(dir, "market_synthetic_ginger_like.json");
      const j = JSON.parse(await readFile(p, "utf8"));
      j.records[3].synthetic = false;
      await writeFile(p, JSON.stringify(j));
      await expect(loadSyntheticFixtures(pool, "synthetic", dir)).rejects.toThrow(SyntheticFixtureError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  ifDb("seed loads fixtures in synthetic mode only; rows carry mode synthetic", async () => {
    const live = await runSeed(pool, "live");
    expect(typeof live.fixtures).toBe("string");
    expect(await count("market_observations")).toBe(0);
    const syn = await runSeed(pool, "synthetic");
    expect(syn.fixtures).toMatchObject({ market: { inserted: 240, rejected: 0 }, weatherObservations: 110, weatherForecasts: 3 });
    expect(await count("market_observations", "mode='synthetic' AND is_synthetic")).toBe(240);
    expect(await count("market_observations", "mode <> 'synthetic'")).toBe(0);
    const row = (await pool.query("SELECT * FROM market_observations LIMIT 1")).rows[0];
    expect(row.unit).toBe("INR/quintal");
    expect(Number(row.price_modal_inr_per_kg)).toBeCloseTo(Number(row.price_modal) / 100, 6);
    expect(row.evidence_state).toBe("illustrative");
  });

  ifDb("the database refuses a row whose mode and is_synthetic disagree", async () => {
    await expect(pool.query("UPDATE weather_observations SET mode='live' WHERE is_synthetic")).rejects.toThrow(/weather_obs_mode_synth_ck/);
    await expect(pool.query("UPDATE weather_observations SET is_synthetic=true WHERE mode='live'")).resolves.toBeDefined();
  });
});

describe("mode-scoped reads", () => {
  ifDb("synthetic rows never appear in live (or replay) reads", async () => {
    await runSeed(pool, "synthetic");
    await storeArchive(pool, series("archive"));
    await storeForecast(pool, series("forecast"));
    const prod = (await pool.query("SELECT id FROM crop_products LIMIT 1")).rows[0].id;
    const src = (await pool.query("SELECT id FROM source_documents WHERE manifest_id='MKT02-dgi-mandi-current'")).rows[0].id;
    await pool.query(
      "INSERT INTO market_observations (market_id,product_id,observed_on,source_id,price_modal,unit,mode,is_synthetic,available_at) VALUES ('m1',$1,'2026-10-15',$2,6500,'INR/quintal','live',false,now())",
      [prod, src],
    );
    for (const mode of ["live", "replay"] as const) {
      const q = scopedQuery(mode);
      const availableBy = mode === "replay" ? new Date() : undefined; // replay reads require a cutoff
      const w = await q.weatherObservations(pool, { availableBy });
      const f = await q.weatherForecasts(pool, { availableBy });
      const m = await q.marketObservations(pool, { availableBy });
      expect(w.length).toBe(7);
      expect(f.length).toBe(3);
      expect(m.length).toBe(1);
      for (const r of [...w, ...f, ...m]) {
        expect(r.is_synthetic).toBe(false);
        expect(r.mode).not.toBe("synthetic");
      }
    }
    const s = scopedQuery("synthetic");
    expect((await s.weatherObservations(pool)).length).toBe(110);
    expect((await s.marketObservations(pool)).every((r) => r.is_synthetic === true)).toBe(true);
    // no filter combination widens a live read
    expect((await scopedQuery("live").weatherObservations(pool, { locationKey: "synthetic:hassan-like" })).length).toBe(0);
  });

  ifDb("availableBy excludes rows first available later (replay cutoff)", async () => {
    const early = new Date("2000-01-01T00:00:00Z");
    expect((await scopedQuery("replay").weatherObservations(pool, { availableBy: early })).length).toBe(0);
    expect((await scopedQuery("replay").weatherObservations(pool, { availableBy: new Date() })).length).toBe(7);
  });
});

describe("weather storage", () => {
  beforeEach(async (ctx) => {
    if (!available) return ctx.skip();
  });

  ifDb("observations keep units, grid cell, dataset kind and first availability; re-ingest is idempotent and records revisions", async () => {
    await pool.query("DELETE FROM weather_observations WHERE NOT is_synthetic");
    const first = await storeArchive(pool, series("archive"));
    expect(first).toMatchObject({ rows: 7, inserted: 7, revisions: 0, unchanged: 0, locationKey: "open-meteo:12.970,76.091" });
    const r1 = (await pool.query("SELECT * FROM weather_observations WHERE observed_on='2026-10-15' AND NOT is_synthetic")).rows[0];
    expect(r1.measurement_kind).toBe("reanalysis");
    expect(r1.evidence_state).toBe("observed");
    expect(r1.meta.units.precipitation_sum).toBe("mm");
    expect(r1.meta.elevationM).toBe(944);
    expect(r1.meta).not.toHaveProperty("requestedLat"); // private farm coordinates are not persisted
    expect(r1.variables.precipitation_sum).toBe(1.4);
    expect(r1.revised_at).toBeNull();
    const firstAvail = r1.available_at;

    const again = await storeArchive(pool, series("archive"));
    expect(again).toMatchObject({ inserted: 0, revisions: 0, unchanged: 7 });
    expect(await count("weather_observations", "NOT is_synthetic")).toBe(7);

    const revised = series("archive", (b) => (b.daily.precipitation_sum[0] = 2.5));
    revised.rows.forEach((r) => (r.availableAt = "2026-11-02T00:00:00.000Z"));
    expect(await storeArchive(pool, revised)).toMatchObject({ inserted: 0, revisions: 1, unchanged: 6 });
    // vintages: the original row is untouched, the revision is a new row pointing at it
    const vs = (await pool.query("SELECT * FROM weather_observations WHERE observed_on='2026-10-15' AND NOT is_synthetic ORDER BY vintage_seq")).rows;
    expect(vs).toHaveLength(2);
    expect(vs[0].variables.precipitation_sum).toBe(1.4);
    expect(vs[0].available_at.getTime()).toBe(firstAvail.getTime());
    expect(vs[0].revised_at).toBeNull();
    expect(vs[1].variables.precipitation_sum).toBe(2.5);
    expect(vs[1].revision_of).toBe(vs[0].id);
    expect(vs[1].vintage_seq).toBe(2);
    expect(vs[1].available_at.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(vs[1].revised_at.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    const untouched = (await pool.query("SELECT revised_at FROM weather_observations WHERE observed_on='2026-10-16' AND NOT is_synthetic")).rows;
    expect(untouched).toHaveLength(1);
    expect(untouched[0].revised_at).toBeNull();
  });

  ifDb("forecasts keep issue time, horizon and vintages", async () => {
    await pool.query("DELETE FROM weather_forecasts WHERE NOT is_synthetic");
    await storeForecast(pool, series("forecast"));
    const later = series("forecast");
    later.rows.forEach((r) => (r.issueTime = "2026-10-30T03:00:00.000Z"));
    await storeForecast(pool, later);
    const rows = (await pool.query("SELECT * FROM weather_forecasts WHERE NOT is_synthetic AND valid_on='2026-10-31' ORDER BY issued_at")).rows;
    expect(rows).toHaveLength(2); // two vintages retained, none overwritten
    expect(rows[0].horizon_days).toBe(3);
    expect(rows[0].evidence_state).toBe("forecast");
    expect(rows[0].issued_at.toISOString()).toBe("2026-10-29T19:55:44.000Z");
    expect(rows[0].meta.issueTimeBasis).toBe("fetch_time_upper_bound");
    expect(rows[0].meta.units.precipitation_probability_max).toBe("%");
  });
});

describe("ingest job handlers", () => {
  const jsonRes = (b: unknown): Awaited<ReturnType<FetchLike>> => ({ ok: true, status: 200, text: async () => JSON.stringify(b), headers: new Headers() });
  const mkCtx = async (type: string, payload: unknown, cancelled: () => boolean = () => false) => {
    const j = (await pool.query("INSERT INTO jobs (type, payload, state) VALUES ($1,$2::jsonb,'running') RETURNING id", [type, JSON.stringify(payload)])).rows[0];
    const progress: number[] = [];
    const ctx: IngestContext = { pool, heartbeat: async (p) => void (p !== undefined && progress.push(p)), isCancelled: async () => cancelled() };
    return { job: { id: j.id as string, owner_id: null, type, attempt: 1, max_attempts: 3, payload }, ctx, progress };
  };

  ifDb("registered in the worker by job type", async () => {
    for (const t of ["ingest.weather_archive", "ingest.weather_forecast", "ingest.market_prices"]) expect(typeof handlers[t]).toBe("function");
  });

  ifDb("weather_archive stores rows, reports progress, and is idempotent by payload hash", async () => {
    await pool.query("DELETE FROM weather_observations WHERE NOT is_synthetic");
    let calls = 0;
    const h = createIngestHandlers({ config: loadProviderConfig({}), fetchImpl: async () => (calls++, jsonRes(archiveFx.body)), now: () => new Date("2026-10-29T20:00:00Z") })["ingest.weather_archive"]!;
    const payload = { lat: 13.0033, lon: 76.1004, start: "2026-10-15", end: "2026-10-21", farmId: "11111111-1111-4111-8111-111111111111" };
    const a = await mkCtx("ingest.weather_archive", payload);
    const r1: any = await h(a.job, a.ctx);
    expect(r1).toMatchObject({ reused: false, status: "succeeded", counts: { rows: 7, inserted: 7 } });
    expect(a.progress.length).toBeGreaterThan(0);
    expect(JSON.stringify(r1)).not.toContain("11111111-1111"); // farm id not persisted/returned
    const b = await mkCtx("ingest.weather_archive", payload);
    const r2: any = await h(b.job, b.ctx);
    expect(r2.reused).toBe(true);
    expect(calls).toBe(1);
    const run = (await pool.query("SELECT detail, counts FROM ingest_runs WHERE id=$1", [r1.ingestRunId])).rows[0];
    expect(JSON.stringify(run)).not.toContain("13.0033");
    expect(run.detail.units.precipitation_sum).toBe("mm");
  });

  ifDb("provider failure fails the job with a typed, retryable-classified error and writes no rows", async () => {
    await pool.query("DELETE FROM weather_forecasts WHERE NOT is_synthetic");
    const h = createIngestHandlers({ config: loadProviderConfig({ PROVIDER_MAX_RETRIES: "0" }), fetchImpl: async () => { throw new Error("offline"); }, sleep: async () => undefined })["ingest.weather_forecast"]!;
    const a = await mkCtx("ingest.weather_forecast", { lat: 13, lon: 76.1 });
    await expect(h(a.job, a.ctx)).rejects.toMatchObject({ retryable: true, code: "network_error" });
    expect(await count("weather_forecasts", "NOT is_synthetic")).toBe(0);
    expect((await pool.query("SELECT status FROM ingest_runs WHERE job_id=$1", [a.job.id])).rows[0].status).toBe("unavailable");
    const bad = await mkCtx("ingest.weather_forecast", { lat: 913, lon: 76.1 });
    await expect(h(bad.job, bad.ctx)).rejects.toMatchObject({ retryable: false, code: "invalid_payload" });
  });

  ifDb("replay mode refuses ingestion", async () => {
    const h = createIngestHandlers({ config: loadProviderConfig({ RUNTIME_MODE: "replay" }), fetchImpl: async () => { throw new Error("must not be called"); } })["ingest.weather_forecast"]!;
    const a = await mkCtx("ingest.weather_forecast", { lat: 13, lon: 76.1 });
    await expect(h(a.job, a.ctx)).rejects.toMatchObject({ code: "replay_mode", retryable: false });
  });

  ifDb("market_prices without a key is unavailable (non-retryable) and makes no request", async () => {
    let calls = 0;
    const h = createIngestHandlers({ config: loadProviderConfig({}), fetchImpl: async () => (calls++, jsonRes({})) })["ingest.market_prices"]!;
    const a = await mkCtx("ingest.market_prices", { resourceId: "9ef84268-d588-465a-a308-a864a43d0070", commodity: "Ginger(Green)" });
    await expect(h(a.job, a.ctx)).rejects.toMatchObject({ code: "api_key_missing", retryable: false });
    expect(calls).toBe(0);
  });

  ifDb("market_prices with a key normalises, flags unverified mapping, skips unknown products, and never stores on cancel", async () => {
    const crop = (await pool.query("INSERT INTO crop_identities (slug) VALUES ('ginger') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO crop_products (crop_id, slug, name) VALUES ($1,'ginger-fresh','Ginger (fresh)')", [crop]);
    const rec = (i: number, c = "Ginger(Green)") => ({ state: "Karnataka", district: "Hassan", market: "Hassan", commodity: c, variety: "Other", grade: "FAQ", arrival_date: `${String(10 + i).padStart(2, "0")}/10/2026`, min_price: "6000", max_price: "7000", modal_price: "6500" });
    const rows = [rec(0), rec(1), rec(1), rec(2, "Ginger(Dry)"), rec(5)];
    const fetchImpl: FetchLike = async () => jsonRes({ total: rows.length, count: rows.length, records: rows });
    const cfg = loadProviderConfig({ DATA_GOV_IN_API_KEY: "k-test-key-123" });
    const h = createIngestHandlers({ config: cfg, fetchImpl })["ingest.market_prices"]!;
    const payload = { resourceId: "9ef84268-d588-465a-a308-a864a43d0070", commodity: "Ginger(Green)", from: "2026-10-10", to: "2026-10-12" };
    const a = await mkCtx("ingest.market_prices", payload);
    const r: any = await h(a.job, a.ctx);
    expect(r.counts).toMatchObject({ recordsRead: 5, normalized: 4, duplicatesIgnored: 1, outsideWindow: 1, inserted: 2, revisions: 0, unchanged: 0, skippedNoProduct: 1 });
    expect(r.counts.unresolvedProductSlugs).toEqual(["ginger-dry"]);
    expect(JSON.stringify(r)).not.toContain("k-test-key-123");
    const stored = (await pool.query("SELECT * FROM market_observations WHERE mode='live' AND market_id LIKE 'agmarknet:%' ORDER BY observed_on")).rows;
    expect(stored).toHaveLength(2);
    expect(stored[0].flags).toContain("commodity_mapping_unverified");
    expect(stored[0].validation_status).toBe("unverified_mapping");
    expect(r.counts.storedUnverifiedMapping).toBe(2);
    expect(stored[0].unit).toBe("INR/quintal");
    expect(Number(stored[0].price_modal_inr_per_kg)).toBe(65);

    // cancellation: nothing stored from a cancelled run
    await pool.query("DELETE FROM market_observations WHERE mode='live' AND market_id LIKE 'agmarknet:%'");
    const c = await mkCtx("ingest.market_prices", { ...payload, commodity: "Ginger(Green) " }, () => true);
    const cr: any = await h(c.job, c.ctx);
    expect(cr.status).toBe("cancelled");
    expect(await count("market_observations", "mode='live' AND market_id LIKE 'agmarknet:%'")).toBe(0);
  });

  ifDb("the worker loop runs an ingest job end to end (claim, run, succeed)", async () => {
    await pool.query("DELETE FROM jobs");
    const before = handlers["ingest.weather_forecast"];
    handlers["ingest.weather_forecast"] = createIngestHandlers({ config: loadProviderConfig({}), fetchImpl: async () => jsonRes(forecastFx.body) })["ingest.weather_forecast"] as never;
    try {
      const id = (await pool.query("INSERT INTO jobs (type, payload) VALUES ('ingest.weather_forecast', '{\"lat\":13,\"lon\":76.1,\"days\":3}') RETURNING id")).rows[0].id;
      const job = await claimJob(pool, "w1");
      expect(job?.id).toBe(id);
      expect(await runJob(pool, job!, "w1")).toBe("succeeded");
      const row = (await pool.query("SELECT state, result FROM jobs WHERE id=$1", [id])).rows[0];
      expect(row.state).toBe("succeeded");
      expect(row.result.counts.rows).toBe(3);
    } finally {
      handlers["ingest.weather_forecast"] = before!;
    }
  });
});
