import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANIFEST_PATH,
  buildPlan,
  enumerateDates,
  labelsDigest,
  loadManifest,
  parseArgs,
  parseRetryAfter,
  planUnits,
  runPull,
  toSourceDate,
  unmatchedLabels,
  validateManifest,
  type Manifest,
  type Progress,
  type PullDeps,
  type PullOptions,
} from "../../../scripts/seed/ingest-mandi-history";
import type { FetchLike } from "../src/ingest/http";
import type { MarketStoreCounts } from "../src/ingest/market-store";
import { loadProviderConfig } from "../src/providers/config";
import { loadCommodityMap, type MandiRow } from "../src/providers/datagovin/normalize";

const VARIETY = "35985678-0d79-46b4-9ed6-6f13308a1d24";
const KEY = "SECRET-KEY-0123456789";
const map = loadCommodityMap();

const rec = (date: string, commodity: string, market: string, modal: number, state = "Karnataka") => ({
  State: state, District: "Dharwad", Market: market, Commodity: commodity, Variety: "Other", Grade: "FAQ",
  Arrival_Date: toSourceDate(date), Min_Price: String(modal - 100), Max_Price: String(modal + 100), Modal_Price: String(modal), Commodity_Code: "1",
});

/** A fake variety-wise API: honours filters[State], filters[Arrival_Date], limit and offset like the real resource. */
function fakeApi(data: Array<Record<string, unknown>>, opts: { ignoreDate?: boolean; on?: (n: number, url: URL) => { status: number; headers?: Record<string, string> } | null } = {}) {
  const calls: Array<{ state: string | null; date: string | null; offset: number; limit: number }> = [];
  const times: number[] = [];
  const impl = (now: () => Date): FetchLike => async (urlText) => {
    const u = new URL(urlText);
    const call = { state: u.searchParams.get("filters[State]"), date: u.searchParams.get("filters[Arrival_Date]"), offset: Number(u.searchParams.get("offset")), limit: Number(u.searchParams.get("limit")) };
    calls.push(call);
    times.push(now().getTime());
    const forced = opts.on?.(calls.length, u);
    if (forced) return { ok: forced.status < 400, status: forced.status, text: async () => JSON.stringify({ error: "limited" }), headers: new Headers(forced.headers ?? {}) };
    const hits = data.filter((r) => r.State === call.state && (opts.ignoreDate || r.Arrival_Date === call.date));
    const page = hits.slice(call.offset, call.offset + call.limit);
    return { ok: true, status: 200, text: async () => JSON.stringify({ total: hits.length, count: page.length, records: page }), headers: new Headers() };
  };
  return { calls, times, impl };
}

function setup(manifestOver: Partial<Manifest> = {}, only?: string[]) {
  const manifest: Manifest = {
    schemaVersion: 1, id: "test-history", resourceId: VARIETY, granularity: "state-day", states: ["Karnataka"], range: { from: "2026-10-28", to: "2026-10-30" }, pageSize: 2,
    products: [
      { cropId: "maize", productId: "maize-grain", enabled: true, commodities: [{ label: "Maize" }] },
      { cropId: "finger-millet", productId: "finger-millet-grain", enabled: true, commodities: [{ label: "Ragi(Finger Millet)" }] },
      { cropId: "brinjal", productId: "brinjal-fresh", enabled: true, commodities: [{ label: "Brinjal" }] },
      { cropId: "paddy", productId: "paddy-grain", enabled: false, commodities: [{ label: "Paddy(Common)" }], labelHints: ["paddy", "dhan"] },
    ],
    ...manifestOver,
  };
  const check = validateManifest(manifest, map, only ? new Set(only) : undefined);
  const dir = mkdtempSync(join(tmpdir(), "mandi-history-"));
  const progressPath = join(dir, "progress.json");
  const clock = { t: Date.parse("2026-11-01T06:00:00Z") };
  const now = () => new Date(clock.t);
  const stored: MandiRow[] = [];
  const storeRows = async (rows: MandiRow[]): Promise<MarketStoreCounts> => {
    stored.push(...rows);
    return { inserted: rows.length, revisions: 0, unchanged: 0, storedUnverifiedMapping: rows.filter((r) => !r.mappingVerified).length, skippedNoProduct: 0, skippedUnmapped: 0, unresolvedProductSlugs: [] };
  };
  const options = (over: Partial<PullOptions> = {}): PullOptions => ({
    manifest, labels: check.labels, states: manifest.states, dates: enumerateDates(manifest.range.from, manifest.range.to), order: "oldest", pauseMs: 8000, maxRequests: 100, pageSize: 2,
    progressPath, ignoreCooldown: false, defaultCooldownSeconds: 120, transientRetries: 2, resetProgress: false, ...over,
  });
  const deps = (fetchImpl: FetchLike, over: Partial<PullDeps> = {}): PullDeps => ({
    config: loadProviderConfig({ DATA_GOV_IN_API_KEY: KEY, RUNTIME_MODE: "live" }), fetchImpl, sleep: async (ms) => void (clock.t += ms), now, commodityMap: map, storeRows, log: () => undefined, ...over,
  });
  return { manifest, check, options, deps, stored, clock, now, progressPath, readProgress: () => JSON.parse(readFileSync(progressPath, "utf8")) as Progress };
}

describe("manifest and plan", () => {
  it("the shipped manifest resolves every enabled label to a commodity-map entry for the same product", () => {
    const m = loadManifest(DEFAULT_MANIFEST_PATH);
    const check = validateManifest(m, map);
    expect(check.errors).toEqual([]);
    expect(check.labels.size).toBe(m.products.filter((p) => p.enabled).reduce((n, p) => n + p.commodities.length, 0));
    // whitespace variants returned by the resource must still match (Ragi (Finger Millet) vs Ragi(Finger Millet))
    expect(check.labels.get("ragi(fingermillet)")?.productId).toBe("finger-millet-grain");
    expect(check.warnings.some((w) => w.includes("Brinjal"))).toBe(true);
    expect(check.labels.get("jowar(sorghum)")?.verified).toBe(true);
  });

  it("rejects a label that maps to another product, a missing label, and a label under two products", () => {
    const wrongProduct = setup({ products: [{ cropId: "wheat", productId: "wheat-grain", enabled: true, commodities: [{ label: "Maize" }] }] });
    expect(wrongProduct.check.errors.join("\n")).toContain("maps to maize-grain");
    const missing = setup({ products: [{ cropId: "x", productId: "wheat-grain", enabled: true, commodities: [{ label: "Wheat Flour Imaginary" }] }] });
    expect(missing.check.errors.join("\n")).toContain("no entry in commodity-map.json");
    const twice = setup({ products: [
      { cropId: "maize", productId: "maize-grain", enabled: true, commodities: [{ label: "Maize" }] },
      { cropId: "maize", productId: "maize-grain", enabled: true, commodities: [{ label: "Maize" }] },
    ] });
    expect(twice.check.errors.join("\n")).toMatch(/listed twice|appears under both/);
  });

  it("covers every calendar day of the window, samples every 7th day, and orders newest first by default", () => {
    const all = enumerateDates("2023-11-01", "2026-10-31");
    expect(all).toHaveLength(1096);
    expect(all.at(-1)).toBe("2026-10-31");
    expect(enumerateDates("2023-11-01", "2026-10-31", 7, 0)).toHaveLength(157);
    expect(enumerateDates("2024-02-27", "2024-03-01")).toEqual(["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"]);
    const units = planUnits(["Karnataka", "Tamil Nadu"], ["2026-10-01", "2026-10-02"]);
    expect(units.map((u) => u.key)).toEqual(["Karnataka|2026-10-02", "Tamil Nadu|2026-10-02", "Karnataka|2026-10-01", "Tamil Nadu|2026-10-01"]);
    const m = loadManifest(DEFAULT_MANIFEST_PATH);
    const plan = buildPlan(m, m.states, all, 1000, 8000);
    expect(plan.units).toBe(2192);
    expect(plan.requestsExpected!).toBeGreaterThan(plan.requestsLowerBound);
  });

  it("parses Retry-After as seconds or HTTP date and falls back for absent or invalid values", () => {
    const now = new Date("2026-11-01T06:00:00Z");
    expect(parseRetryAfter("90", now, 120)).toBe(90);
    expect(parseRetryAfter("Sun, 01 Nov 2026 06:05:00 GMT", now, 120)).toBe(300);
    expect(parseRetryAfter(null, now, 120)).toBe(120);
    expect(parseRetryAfter("soon", now, 120)).toBe(120);
    expect(parseRetryAfter("999999999", now, 120)).toBe(86_400);
  });

  it("rejects unknown options and impossible dates", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--from", "2026-02-30"])).toThrow(/real YYYY-MM-DD/);
    expect(() => parseArgs(["--max-requests"])).toThrow(/needs a value/);
    expect(parseArgs(["--", "--dry-run", "--products", "maize-grain,wheat-grain"])).toMatchObject({ dryRun: true, products: ["maize-grain", "wheat-grain"], maxRequests: 500 });
  });
});

describe("pull loop", () => {
  const day = "2026-10-29";
  const data = () => [
    rec(day, "Maize", "Hubli", 2500), rec(day, "Maize", "Gadag", 2450), rec(day, "Ragi (Finger Millet)", "Mysuru", 3500),
    rec(day, "Mashrooms", "Hubli", 9000), rec(day, "Brinjal", "Hubli", 3200),
    rec("2026-10-28", "Maize", "Hubli", 2400),
  ];

  it("keeps only enabled labels (whitespace variants included), pages at the page size and stores through the injected writer", async () => {
    const t = setup();
    const api = fakeApi(data());
    const r = await runPull(t.options({ dates: [day] }), t.deps(api.impl(t.now)));
    expect(r.status).toBe("complete");
    expect(api.calls.map((c) => c.offset)).toEqual([0, 2, 4]);
    expect(api.calls.every((c) => c.state === "Karnataka" && c.date === "29/10/2026")).toBe(true);
    expect(t.stored.map((x) => `${x.productSlug}:${x.marketName}`).sort()).toEqual(["brinjal-fresh:Hubli", "finger-millet-grain:Mysuru", "maize-grain:Gadag", "maize-grain:Hubli"]);
    // unverified mapping (Brinjal) is passed through so the shared store can flag it hidden; verified ones are not
    expect(t.stored.find((x) => x.productSlug === "brinjal-fresh")?.mappingVerified).toBe(false);
    expect(t.stored.find((x) => x.productSlug === "maize-grain")?.mappingVerified).toBe(true);
    expect(t.stored.every((x) => x.flags.includes("availability_basis:conservative_upper_bound"))).toBe(true);
    const p = t.readProgress();
    expect(p.census["Karnataka|Mashrooms"]?.rows).toBe(1);
    expect(unmatchedLabels(p, t.manifest, t.check.labels).map((u) => u.label)).toEqual(["Mashrooms"]);
  });

  it("paces requests by the pause and honours the request cap, resuming mid-unit at the saved offset without refetching pages", async () => {
    const t = setup();
    const api = fakeApi(data());
    const first = await runPull(t.options({ dates: [day], maxRequests: 2 }), t.deps(api.impl(t.now)));
    expect(first.status).toBe("paused_max_requests");
    expect(first.requests).toBe(2);
    expect(t.readProgress().units["Karnataka|2026-10-29"]).toMatchObject({ status: "partial", nextOffset: 4, pages: 2 });
    expect(api.times[1]! - api.times[0]!).toBeGreaterThanOrEqual(8000);
    const second = await runPull(t.options({ dates: [day] }), t.deps(api.impl(t.now)));
    expect(second.status).toBe("complete");
    expect(api.calls.map((c) => c.offset)).toEqual([0, 2, 4]); // third request continued at offset 4: nothing refetched
    expect(t.stored).toHaveLength(4); // each identity stored once across the two sessions
    const third = await runPull(t.options({ dates: [day] }), t.deps(api.impl(t.now)));
    expect(third).toMatchObject({ status: "complete", requests: 0, unitsSkippedDone: 1 });
    expect(api.calls).toHaveLength(3);
  });

  it("stops on HTTP 429 without retrying, records Retry-After, refuses to send during the cooldown and resumes at the same offset after it", async () => {
    const t = setup();
    const api = fakeApi(data(), { on: (n) => (n === 2 ? { status: 429, headers: { "retry-after": "90" } } : null) });
    const r = await runPull(t.options({ dates: [day] }), t.deps(api.impl(t.now)));
    expect(r).toMatchObject({ status: "stopped_rate_limited", retryAfterSeconds: 90, requests: 2 });
    expect(api.calls).toHaveLength(2); // one 429, no immediate retry
    const p = t.readProgress();
    expect(p.cooldown).toMatchObject({ retryAfterRaw: "90" });
    expect(Date.parse(p.cooldown!.until) - t.clock.t).toBe(90_000);
    expect(p.units["Karnataka|2026-10-29"]).toMatchObject({ status: "partial", nextOffset: 2 });

    const early = await runPull(t.options({ dates: [day] }), t.deps(api.impl(t.now)));
    expect(early).toMatchObject({ status: "stopped_rate_limited", requests: 0 });
    expect(api.calls).toHaveLength(2); // nothing sent while cooling down

    t.clock.t += 91_000;
    const later = await runPull(t.options({ dates: [day] }), t.deps(api.impl(t.now)));
    expect(later.status).toBe("complete");
    expect(api.calls.map((c) => c.offset)).toEqual([0, 2, 2, 4]); // the 429-ed page was requested again, from the saved offset
    expect(t.stored).toHaveLength(4);
    expect(t.readProgress().cooldown).toBeNull();
  });

  it("applies the default cooldown when a 429 carries no Retry-After", async () => {
    const t = setup();
    const api = fakeApi(data(), { on: (n) => (n === 1 ? { status: 429 } : null) });
    const r = await runPull(t.options({ dates: [day], defaultCooldownSeconds: 300 }), t.deps(api.impl(t.now)));
    expect(r).toMatchObject({ status: "stopped_rate_limited", retryAfterSeconds: 300 });
    expect(t.readProgress().cooldown?.retryAfterRaw).toBeNull();
  });

  it("retries a transient 5xx twice with backoff but fails clearly on a client error", async () => {
    const t = setup();
    const flaky = fakeApi(data(), { on: (n) => (n <= 2 ? { status: 503 } : null) });
    const ok = await runPull(t.options({ dates: [day] }), t.deps(flaky.impl(t.now)));
    expect(ok.status).toBe("complete");
    expect(flaky.calls.slice(0, 3).map((c) => c.offset)).toEqual([0, 0, 0]);
    const u = setup();
    const denied = fakeApi(data(), { on: () => ({ status: 403 }) });
    const bad = await runPull(u.options({ dates: [day] }), u.deps(denied.impl(u.now)));
    expect(bad.status).toBe("failed");
    expect(denied.calls).toHaveLength(1);
    expect(bad.fatal).toContain("auth_rejected");
  });

  it("stops without storing anything when the Arrival_Date filter is ignored by the API", async () => {
    const t = setup();
    const api = fakeApi([rec("2020-01-01", "Maize", "Hubli", 2100), rec("2020-01-02", "Maize", "Gadag", 2100)], { ignoreDate: true });
    const r = await runPull(t.options({ dates: [day] }), t.deps(api.impl(t.now)));
    expect(r).toMatchObject({ status: "failed", fatal: "date_filter_not_honoured" });
    expect(t.stored).toHaveLength(0);
  });

  it("re-fetches a finished unit when the label set changes, so a maize-only validation does not hide later products", async () => {
    const maizeOnly = setup({}, ["maize-grain"]);
    const api = fakeApi(data());
    await runPull(maizeOnly.options({ dates: [day] }), maizeOnly.deps(api.impl(maizeOnly.now)));
    expect(maizeOnly.stored.map((x) => x.productSlug)).toEqual(["maize-grain", "maize-grain"]);
    const full = setup();
    expect(labelsDigest(full.check.labels)).not.toBe(labelsDigest(maizeOnly.check.labels));
    // same progress file, wider label set: the unit is pulled again and the other products are stored
    const wider = { ...full.options({ dates: [day] }), progressPath: maizeOnly.progressPath };
    const before = api.calls.length;
    await runPull(wider, full.deps(api.impl(full.now)));
    expect(api.calls.length).toBeGreaterThan(before);
    expect(full.stored.map((x) => x.productSlug).sort()).toEqual(["brinjal-fresh", "finger-millet-grain", "maize-grain", "maize-grain"]);
  });

  it("never writes the API key into the progress file, the result or the log", async () => {
    const logs: string[] = [];
    const t = setup();
    const api = fakeApi(data(), { on: (n) => (n === 3 ? { status: 429, headers: { "retry-after": "30" } } : null) });
    const r = await runPull(t.options({ dates: [day] }), t.deps(api.impl(t.now), { log: (s) => logs.push(s) }));
    const everything = JSON.stringify(r) + readFileSync(t.progressPath, "utf8") + logs.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toMatch(/api-key|https?:\/\//i);
  });

  it("skips dates later than today (India) instead of requesting them", async () => {
    const t = setup();
    const api = fakeApi(data());
    const r = await runPull(t.options({ dates: ["2026-11-02", "2026-12-25"] }), t.deps(api.impl(t.now)));
    expect(r).toMatchObject({ status: "complete", requests: 0 });
    expect(api.calls).toHaveLength(0);
  });
});
