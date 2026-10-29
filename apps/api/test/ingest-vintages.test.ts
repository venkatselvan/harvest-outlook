// F1: vintage-safe ingestion and replay reads (review findings H1, M7, M8, L4).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { ReplayCutoffRequiredError } from "../src/ingest/errors";
import { storeMarketRows } from "../src/ingest/market-store";
import { scopedQuery } from "../src/ingest/scope";
import { ensureSource } from "../src/ingest/sources";
import { storeArchive, storeForecast } from "../src/ingest/weather-store";
import type { FetchLike } from "../src/ingest/http";
import { normalizeMandiRecords } from "../src/providers/datagovin/normalize";
import { loadProviderConfig } from "../src/providers/config";
import { parseOpenMeteoDaily, REQUIRED_DAILY_VARIABLES, type WeatherSeries } from "../src/providers/openmeteo/client";
import { createIngestHandlers, normalizeIngestPayload, type IngestContext } from "../src/worker/handlers/ingest";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/harvest_outlook_test";
let pool: Pool;
let available = false;

beforeAll(async () => {
  pool = createPool(url);
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    if (process.env.CI) throw new Error("test database required in CI");
    return;
  }
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
});
afterAll(async () => pool.end());

const ifDb = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => { if (!available) return ctx.skip(); await fn(); });
const fx = (n: string) => JSON.parse(readFileSync(resolve(__dirname, "fixtures/openmeteo", n), "utf8")) as { fetchedAt: string; body: any };
const archiveFx = fx("archive_hassan.json");
const forecastFx = fx("forecast_hassan.json");
const D = (s: string) => new Date(s);
// node-pg parses SQL `date` as local midnight; format in local time.
const dateOf = (v: unknown) => {
  const d = v as Date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Archive series whose first day (2026-10-15) has the given rain and every row the given availability. */
function archive(rain: number, availableAt: string): WeatherSeries {
  const body = structuredClone(archiveFx.body);
  body.daily.precipitation_sum[0] = rain;
  const r = parseOpenMeteoDaily({ endpoint: "archive", body, requestedLat: 13, requestedLon: 76.1, fetchedAt: archiveFx.fetchedAt, horizonDays: null, requested: REQUIRED_DAILY_VARIABLES });
  if (r.status !== "ok") throw new Error("fixture parse failed");
  r.data.forEach((x) => (x.availableAt = availableAt));
  return { endpoint: "archive", rows: r.data, fetchedAt: archiveFx.fetchedAt, cached: false, stale: false, sourceUrl: "fixture" };
}

function forecast(rain: number, availableAt: string): WeatherSeries {
  const body = structuredClone(forecastFx.body);
  body.daily.precipitation_sum[0] = rain;
  const r = parseOpenMeteoDaily({ endpoint: "forecast", body, requestedLat: 13, requestedLon: 76.1, fetchedAt: forecastFx.fetchedAt, horizonDays: 3, requested: [...REQUIRED_DAILY_VARIABLES, "precipitation_probability_max"] });
  if (r.status !== "ok") throw new Error("fixture parse failed");
  r.data.forEach((x) => (x.availableAt = availableAt));
  return { endpoint: "forecast", rows: r.data, fetchedAt: forecastFx.fetchedAt, cached: false, stale: false, sourceUrl: "fixture" };
}

const rainOn = (rows: Record<string, unknown>[], date: string) => {
  const hit = rows.filter((r) => dateOf(r.observed_on ?? r.valid_on) === date);
  expect(hit.length).toBeLessThanOrEqual(1); // one vintage per identity
  return hit[0] ? (hit[0].variables as Record<string, number>).precipitation_sum : undefined;
};

describe("H1: weather vintages", () => {
  ifDb("a replay read returns the value known at the cutoff, not a later revision", async () => {
    await storeArchive(pool, archive(5, "2026-06-03T00:00:00Z"));
    const rev = await storeArchive(pool, archive(42, "2026-06-20T00:00:00Z"));
    expect(rev).toMatchObject({ rows: 7, inserted: 0, revisions: 1, unchanged: 6 });

    const replay = scopedQuery("replay");
    expect(rainOn(await replay.weatherObservations(pool, { availableBy: D("2026-06-10T00:00:00Z") }), "2026-10-15")).toBe(5);
    expect(rainOn(await replay.weatherObservations(pool, { availableBy: D("2026-06-25T00:00:00Z") }), "2026-10-15")).toBe(42);
    // before the first vintage: nothing
    expect(await replay.weatherObservations(pool, { availableBy: D("2026-06-01T00:00:00Z") })).toHaveLength(0);
    // live: latest vintage, one row per day
    const live = await scopedQuery("live").weatherObservations(pool);
    expect(live).toHaveLength(7);
    expect(rainOn(live, "2026-10-15")).toBe(42);

    // dedup: identical values add no vintage
    expect(await storeArchive(pool, archive(42, "2026-07-01T00:00:00Z"))).toMatchObject({ inserted: 0, revisions: 0, unchanged: 7 });
    const n = (await pool.query("SELECT count(*)::int n FROM weather_observations WHERE observed_on='2026-10-15' AND NOT is_synthetic")).rows[0].n;
    expect(n).toBe(2);
    // a revert to an earlier value is still a new vintage (vintage 3 = 5 mm), visible only after its availability
    await storeArchive(pool, archive(5, "2026-08-01T00:00:00Z"));
    expect(rainOn(await replay.weatherObservations(pool, { availableBy: D("2026-07-15T00:00:00Z") }), "2026-10-15")).toBe(42);
    expect(rainOn(await replay.weatherObservations(pool, { availableBy: D("2026-08-02T00:00:00Z") }), "2026-10-15")).toBe(5);
    const chain = (await pool.query("SELECT id, vintage_seq, revision_of FROM weather_observations WHERE observed_on='2026-10-15' AND NOT is_synthetic ORDER BY vintage_seq")).rows;
    expect(chain.map((r) => r.vintage_seq)).toEqual([1, 2, 3]);
    expect(chain[1].revision_of).toBe(chain[0].id);
    expect(chain[2].revision_of).toBe(chain[1].id);
  });

  ifDb("rows with unknown availability are never returned under a cutoff", async () => {
    await pool.query("UPDATE weather_observations SET available_at = NULL WHERE observed_on='2026-10-16' AND NOT is_synthetic");
    const rows = await scopedQuery("replay").weatherObservations(pool, { availableBy: D("2027-01-01T00:00:00Z") });
    expect(rows.some((r) => dateOf(r.observed_on) === "2026-10-16")).toBe(false);
  });

  ifDb("a re-fetched forecast issue with changed values is a new vintage of that issue", async () => {
    await storeForecast(pool, forecast(3, "2026-10-29T20:00:00Z"));
    const r = await storeForecast(pool, forecast(9, "2026-10-29T23:00:00Z"));
    expect(r).toMatchObject({ inserted: 0, revisions: 1, unchanged: 2 });
    const first = forecastFx.body.daily.time[0] as string;
    const q = scopedQuery("replay");
    expect(rainOn(await q.weatherForecasts(pool, { availableBy: D("2026-10-29T21:00:00Z") }), first)).toBe(3);
    expect(rainOn(await q.weatherForecasts(pool, { availableBy: D("2026-10-30T00:00:00Z") }), first)).toBe(9);
  });
});

describe("M7: replay reads require a cutoff", () => {
  ifDb("every replay reader throws a typed error without availableBy; live and synthetic do not", async () => {
    const q = scopedQuery("replay");
    for (const read of [q.weatherObservations, q.weatherForecasts, q.marketObservations]) {
      await expect(read(pool)).rejects.toBeInstanceOf(ReplayCutoffRequiredError);
      await expect(read(pool, {})).rejects.toMatchObject({ code: "replay_cutoff_required", retryable: false });
      await expect(read(pool, { availableBy: new Date("not a date") })).rejects.toBeInstanceOf(ReplayCutoffRequiredError);
    }
    await expect(scopedQuery("live").weatherObservations(pool)).resolves.toBeDefined();
    await expect(scopedQuery("synthetic").marketObservations(pool)).resolves.toBeDefined();
  });
});

describe("market vintages and unverified mappings", () => {
  let sourceId: string;
  const rec = (modal: string) => ({ state: "Karnataka", district: "Hassan", market: "Hassan", commodity: "Ginger(Green)", variety: "Other", grade: "FAQ", arrival_date: "10/10/2026", min_price: "6000", max_price: "7000", modal_price: modal });
  const verified = [{ sourceCommodity: "Ginger(Green)", productSlug: "ginger-fresh", verified: true }];
  const unverified = [{ sourceCommodity: "Ginger(Green)", productSlug: "ginger-fresh", verified: false }];

  beforeAll(async () => {
    if (!available) return;
    const crop = (await pool.query("INSERT INTO crop_identities (slug) VALUES ('ginger') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO crop_products (crop_id, slug, name) VALUES ($1,'ginger-fresh','Ginger (fresh)')", [crop]);
    sourceId = await ensureSource(pool, "MKT02-dgi-mandi-current", { title: "t", publisher: "p", url: "u", licence: "l" });
  });

  ifDb("H1 (market): a revised modal price is a new vintage; replay sees the value known at the cutoff", async () => {
    const store = (modal: string, at: string) =>
      storeMarketRows(pool, normalizeMandiRecords([rec(modal)], { commodityMap: verified }).rows, { sourceId, mode: "live", availableAt: D(at) });
    expect(await store("6500", "2026-10-11T00:00:00Z")).toMatchObject({ inserted: 1, revisions: 0 });
    expect(await store("6500", "2026-10-12T00:00:00Z")).toMatchObject({ inserted: 0, revisions: 0, unchanged: 1 });
    expect(await store("6900", "2026-10-20T00:00:00Z")).toMatchObject({ inserted: 0, revisions: 1 });
    const modal = async (by?: string) => {
      const rows = await scopedQuery(by ? "replay" : "live").marketObservations(pool, by ? { availableBy: D(by) } : {});
      expect(rows).toHaveLength(1);
      return Number(rows[0]!.price_modal_inr_per_kg);
    };
    expect(await modal("2026-10-15T00:00:00Z")).toBe(65);
    expect(await modal("2026-10-21T00:00:00Z")).toBe(69);
    expect(await modal()).toBe(69);
    const rows = (await pool.query("SELECT vintage_seq, revision_of, revised_at FROM market_observations ORDER BY vintage_seq")).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].revision_of).not.toBeNull();
    expect(rows[0].revised_at).toBeNull();
    expect(rows[1].revised_at).toEqual(D("2026-10-20T00:00:00Z"));
    await pool.query("DELETE FROM market_observations");
  });

  ifDb("M8: unverified-mapping rows are stored flagged and hidden from default reads; opt-in returns them flagged", async () => {
    const c = await storeMarketRows(pool, normalizeMandiRecords([rec("6500")], { commodityMap: unverified }).rows, { sourceId, mode: "live", availableAt: D("2026-10-11T00:00:00Z") });
    expect(c).toMatchObject({ inserted: 1, storedUnverifiedMapping: 1 });
    const stored = (await pool.query("SELECT product_id, validation_status, flags FROM market_observations")).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].product_id).not.toBeNull();
    expect(stored[0].validation_status).toBe("unverified_mapping");

    for (const mode of ["live", "replay"] as const) {
      const q = scopedQuery(mode);
      const by = mode === "replay" ? D("2026-12-01T00:00:00Z") : undefined;
      expect(await q.marketObservations(pool, { availableBy: by })).toHaveLength(0);
      const opt = await q.marketObservations(pool, { availableBy: by, includeUnverified: true });
      expect(opt).toHaveLength(1);
      expect(opt[0]!.validation_status).toBe("unverified_mapping");
      expect(opt[0]!.flags).toContain("commodity_mapping_unverified");
    }

    // Once the mapping is verified, the identity (all vintages) becomes readable; values are not rewritten.
    const v = await storeMarketRows(pool, normalizeMandiRecords([rec("6500")], { commodityMap: verified }).rows, { sourceId, mode: "live", availableAt: D("2026-11-01T00:00:00Z") });
    expect(v).toMatchObject({ inserted: 0, revisions: 0, unchanged: 1, storedUnverifiedMapping: 0 });
    const after = await scopedQuery("replay").marketObservations(pool, { availableBy: D("2026-10-12T00:00:00Z") });
    expect(after).toHaveLength(1);
    expect(after[0]!.validation_status).toBe("valid");
    expect(after[0]!.available_at).toEqual(D("2026-10-11T00:00:00Z"));
    await pool.query("DELETE FROM market_observations");
  });

  ifDb("ingest run summaries expose a revisions count", async () => {
    const jsonRes = (b: unknown): Awaited<ReturnType<FetchLike>> => ({ ok: true, status: 200, text: async () => JSON.stringify(b), headers: new Headers() });
    let modal = "6500";
    const fetchImpl: FetchLike = async () => jsonRes({ total: 1, count: 1, records: [rec(modal)] });
    let t = D("2026-10-11T00:00:00Z");
    const h = createIngestHandlers({ config: loadProviderConfig({ DATA_GOV_IN_API_KEY: "k-test-key-123" }), fetchImpl, now: () => t })["ingest.market_prices"]!;
    const run = async (payload: Record<string, unknown>) => {
      const j = (await pool.query("INSERT INTO jobs (type, payload, state) VALUES ('ingest.market_prices',$1::jsonb,'running') RETURNING id", [JSON.stringify(payload)])).rows[0];
      const ctx: IngestContext = { pool, heartbeat: async () => undefined, isCancelled: async () => false };
      return (await h({ id: j.id, owner_id: null, type: "ingest.market_prices", attempt: 1, max_attempts: 3, payload }, ctx)) as any;
    };
    const base = { resourceId: "9ef84268-d588-465a-a308-a864a43d0070", commodity: "Ginger(Green)" };
    const r1 = await run({ ...base, from: "2026-10-01" });
    expect(r1.counts).toMatchObject({ inserted: 1, revisions: 0 });
    modal = "7000";
    t = D("2026-10-20T00:00:00Z");
    const r2 = await run({ ...base, from: "2026-10-02" });
    expect(r2.counts).toMatchObject({ inserted: 0, revisions: 1 });
    const stored = (await pool.query("SELECT counts FROM ingest_runs WHERE id=$1", [r2.ingestRunId])).rows[0];
    expect(stored.counts.revisions).toBe(1);
    await pool.query("DELETE FROM market_observations");
  });
});

describe("L4: ingest payload privacy", () => {
  it("normalisation rounds coordinates to 0.01 degree and drops farmId", () => {
    const p = normalizeIngestPayload("ingest.weather_archive", { lat: 13.00337, lon: 76.10049, start: "2026-10-15", end: "2026-10-21", farmId: "11111111-1111-4111-8111-111111111111" });
    expect(p).toEqual({ lat: 13, lon: 76.1, start: "2026-10-15", end: "2026-10-21" });
    expect(normalizeIngestPayload("ingest.weather_forecast", { lat: 12.98765, lon: 76.01234 })).toEqual({ lat: 12.99, lon: 76.01, days: 10 });
    expect(() => normalizeIngestPayload("ingest.weather_forecast", { lat: 99, lon: 0 })).toThrow(/invalid payload/);
  });

  ifDb("the handler rewrites the stored job payload before fetching; raw coordinates and farmId do not persist", async () => {
    const jsonRes = (b: unknown): Awaited<ReturnType<FetchLike>> => ({ ok: true, status: 200, text: async () => JSON.stringify(b), headers: new Headers() });
    const requested: string[] = [];
    const h = createIngestHandlers({ config: loadProviderConfig({}), fetchImpl: async (u) => (requested.push(String(u)), jsonRes(archiveFx.body)), now: () => D("2026-10-29T20:00:00Z") })["ingest.weather_archive"]!;
    const raw = { lat: 13.00337, lon: 76.10049, start: "2026-10-15", end: "2026-10-21", farmId: "22222222-2222-4222-8222-222222222222" };
    const j = (await pool.query("INSERT INTO jobs (type, payload, state) VALUES ('ingest.weather_archive',$1::jsonb,'running') RETURNING id", [JSON.stringify(raw)])).rows[0];
    const ctx: IngestContext = { pool, heartbeat: async () => undefined, isCancelled: async () => false };
    const res: any = await h({ id: j.id, owner_id: null, type: "ingest.weather_archive", attempt: 1, max_attempts: 3, payload: raw }, ctx);
    expect(res.status).toBe("succeeded");
    const job = (await pool.query("SELECT payload FROM jobs WHERE id=$1", [j.id])).rows[0];
    expect(job.payload).toEqual({ lat: 13, lon: 76.1, start: "2026-10-15", end: "2026-10-21" });
    const everything = JSON.stringify([job, (await pool.query("SELECT counts, detail FROM ingest_runs WHERE job_id=$1", [j.id])).rows, res]);
    expect(everything).not.toContain("13.00337");
    expect(everything).not.toContain("76.10049");
    expect(everything).not.toContain("22222222-2222");
    expect(requested.join(" ")).not.toContain("13.00337");
  });
});
