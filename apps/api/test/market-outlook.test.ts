import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValueRecord } from "@harvest/contracts";
import { compareCrops, type ComparisonInput } from "../src/catalogue/compare";
import { snapshotFromFiles } from "../src/catalogue/snapshot";
import { SYNTHETIC_SOURCE_ID, ensureSource } from "../src/ingest/sources";
import { PgMarketOutlookSource, isoWeek, missingReasonText, priceReferencesFor, referenceRecords } from "../src/plans/adapters/market-outlook";
import { bindMarketOutlook } from "../src/agent/bindings/int2";
import { GINGER_PRODUCT_ID, seedGinger } from "./fixtures/meta/helpers";
import { loadCatalogueIntoDb } from "../src/catalogue/load";
import { ORIGIN, setupHarness, type Harness } from "./helpers";

/**
 * L3. Every row below is SYNTHETIC test data (mode synthetic, is_synthetic true; market ids prefixed synth-). The
 * expected numbers are hand-computed in the comments next to the rows. Replay rows are mode 'replay' test rows and are
 * not observations of any real market.
 */
const ISSUE = "2026-10-30";
const NOW = new Date("2026-10-30T09:00:00Z");
const DRY_ID = "00000000-0000-4000-8000-0000000000d2";
let h: Harness;
let src: string;

async function row(o: { market: string; date: string; quintal: number; product?: string; state?: string; variety?: string; mode?: "synthetic" | "replay"; availableAt?: string; validation?: "valid" | "unverified_mapping"; arrivals?: number | null }) {
  const mode = o.mode ?? "synthetic";
  await h.pool.query(
    `INSERT INTO market_observations (market_id, product_id, observed_on, source_id, price_min, price_modal, price_max, arrivals, unit, is_synthetic, mode, evidence_state, market_name, state_name, district_name,
       variety, grade, variety_key, grade_key, price_min_inr_per_kg, price_modal_inr_per_kg, price_max_inr_per_kg, available_at, validation_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'INR/quintal',$9,$10,$11,$1,$12,'Synth District',$13,'Local',$14,'local',$5/100.0,$6/100.0,$7/100.0,$15,$16)`,
    [o.market, o.product ?? GINGER_PRODUCT_ID, o.date, src, o.quintal * 0.5, o.quintal, o.quintal * 2, o.arrivals ?? null, mode === "synthetic", mode, mode === "synthetic" ? "illustrative" : "observed",
      o.state ?? "Karnataka", o.variety ?? "Synth Variety", (o.variety ?? "Synth Variety").toLowerCase(), o.availableAt ?? "2026-10-29T12:00:00Z", o.validation ?? "valid"],
  );
}

const source = (over: Partial<ConstructorParameters<typeof PgMarketOutlookSource>[0]> = {}) => new PgMarketOutlookSource({ pool: h.pool, mode: "synthetic", keyConfigured: true, now: () => NOW, ...over });
const WIN = { start: "2026-11-02", end: "2026-11-08" }; // ISO week 2026-W45
const WIN_NO_HISTORY = { start: "2026-12-07", end: "2026-12-13" }; // W50: no prior-year rows

beforeAll(async () => {
  h = await setupHarness();
  await seedGinger(h.pool);
  src = await ensureSource(h.pool, SYNTHETIC_SOURCE_ID, { title: "Synthetic development fixtures", publisher: "Harvest Outlook (generated)", url: "local:data/fixtures/synthetic", licence: "synthetic, not real data" });
  // Market synth-a, INR/quintal -> INR/kg is /100. Weekly medians (INR/kg) in the last 52 weeks (since 2025-10-31):
  //   2025-W45 (3-5 Nov 2025): quotes 60,80,70 -> 70 | W39 90 | W40 100 | W41 80 | W42 70 | W43 110 | W44 (28,29 Oct): 100,120 -> 110
  // => range of weekly medians 70..110; last quote 120 on 2026-10-29; valid days = 3 + 7 = 10 (>= 8).
  for (const [d, q] of [["2025-11-03", 6000], ["2025-11-04", 8000], ["2025-11-05", 7000], ["2026-09-25", 9000], ["2026-10-02", 10000], ["2026-10-09", 8000], ["2026-10-16", 7000], ["2026-10-23", 11000], ["2026-10-28", 10000], ["2026-10-29", 12000]] as const) {
    await row({ market: "synth-a", date: d, quintal: q });
  }
  // Two prior years of the same ISO week 45: 2024-W45 (4-6 Nov 2024): 40, 50 -> 45. 2025-W45 median 70.
  // Corresponding-season reference = median of weekly medians [70, 45] = 57.5; spread 45..70.
  await row({ market: "synth-a", date: "2024-11-04", quintal: 4000 });
  await row({ market: "synth-a", date: "2024-11-05", quintal: 5000 });
  // Unverified mapping row: would be the last quote at 999.99 INR/kg if it were not excluded.
  await row({ market: "synth-a", date: "2026-10-30", quintal: 99999, validation: "unverified_mapping" });
  // Market synth-b: only 3 trading days in the last 365 days (insufficient). Second state: not Karnataka.
  for (const d of ["2026-10-01", "2026-10-08", "2026-10-15"]) await row({ market: "synth-b", date: d, quintal: 5000 });
  // Market synth-t in another state with full coverage, to prove state fallback does not borrow other states.
  for (let i = 0; i < 10; i++) await row({ market: "synth-t", date: `2026-10-${String(10 + i).padStart(2, "0")}`, quintal: 3000, state: "Tamil Nadu" });
  // ginger-dry: one market with too few days.
  for (const d of ["2026-10-01", "2026-10-08"]) await row({ market: "synth-b", date: d, quintal: 20000, product: DRY_ID });
}, 60_000);
afterAll(async () => h.close());

describe("isoWeek", () => {
  it("handles year boundaries", () => {
    expect(isoWeek("2026-11-02")).toEqual({ year: 2026, week: 45 });
    expect(isoWeek("2025-11-03")).toEqual({ year: 2025, week: 45 });
    expect(isoWeek("2024-11-04")).toEqual({ year: 2024, week: 45 });
    expect(isoWeek("2021-01-03")).toEqual({ year: 2020, week: 53 });
    expect(isoWeek("2024-12-30")).toEqual({ year: 2025, week: 1 });
  });
});

describe("PgMarketOutlookSource: historical reference values", () => {
  it("returns last quote, range of weekly medians and corresponding-season reference, hand-checked", async () => {
    const r = await source().getOutlook("ginger-fresh", ["synth-a"], [WIN, WIN_NO_HISTORY], ISSUE);
    if (!("kind" in r)) throw new Error("expected a reference");
    expect(r.kind).toBe("historical_reference");
    expect(r.notForecast).toBe(true);
    expect(r.fallback).toBeNull();
    const m = r.markets[0]!;
    expect(m.marketId).toBe("synth-a");
    expect(m.lastQuote).toMatchObject({ kind: "quantity", unit: "INR/kg", value: "120.00", evidenceState: "observed", sourceUnit: "INR/quintal", scope: { level: "market", ids: ["synth-a"] }, validFrom: "2026-10-29", validTo: "2026-10-29" });
    expect(m.lastQuote.evidenceIds).toEqual([src]);
    expect(m.lastQuoteMeta).toMatchObject({ date: "2026-10-29", variety: "Synth Variety", grade: "Local" });
    expect(m.weeklyRange).toMatchObject({ kind: "range", unit: "INR/kg", evidenceState: "derived", value: { low: "70.00", high: "110.00" } });
    expect(m.weeklyRangeLabel).toMatch(/not a prediction interval/i);
    expect(m.weeksInRange).toBe(7);
    expect(m.validDaysLast365).toBe(10);
    expect(m.seasonal[0]).toMatchObject({ yearsUsed: [2024, 2025], weeklyMedianRange: { low: "45.00", high: "70.00" } });
    expect(m.seasonal[0]!.reference).toMatchObject({ value: "57.50", evidenceState: "derived", unit: "INR/kg", validFrom: "2026-11-02", validTo: "2026-11-08" });
    // no prior years for W50: unavailable, never filled
    expect(m.seasonal[1]!.reference).toMatchObject({ value: null, evidenceState: "unavailable", missingReason: "fewer_than_2_prior_years_for_these_iso_weeks" });
    for (const rec of referenceRecords(r)) expect(ValueRecord.safeParse(rec).success).toBe(true);
  });

  it("excludes the unverified-mapping row (it would be the last quote and the max)", async () => {
    const r = await source().getOutlook("ginger-fresh", ["synth-a"], [], ISSUE);
    if (!("kind" in r)) throw new Error("expected a reference");
    expect(r.markets[0]!.lastQuote.value).toBe("120.00");
    expect(r.markets[0]!.weeklyRange.value).toMatchObject({ high: "110.00" });
  });

  it("does not use mandi min/max for the range (min*0.5 and max*2 rows would widen it)", async () => {
    const r = await source().getOutlook("ginger-fresh", ["synth-a"], [], ISSUE);
    if (!("kind" in r)) throw new Error("expected a reference");
    expect(Number((r.markets[0]!.weeklyRange.value as { low: string }).low)).toBeGreaterThanOrEqual(70);
  });

  it("respects the availability cutoff: a vintage published after `now` is invisible", async () => {
    await row({ market: "synth-a", date: "2026-10-30", quintal: 15000, availableAt: "2026-10-30T20:00:00Z", variety: "Late Variety" });
    const before = await source({ now: () => new Date("2026-10-30T09:00:00Z") }).getOutlook("ginger-fresh", ["synth-a"], [], ISSUE);
    const after = await source({ now: () => new Date("2026-10-30T21:00:00Z") }).getOutlook("ginger-fresh", ["synth-a"], [], ISSUE);
    if (!("kind" in before) || !("kind" in after)) throw new Error("expected references");
    expect(before.markets[0]!.lastQuote.value).toBe("120.00");
    expect(after.markets[0]!.lastQuote.value).toBe("150.00");
    expect(after.markets[0]!.lastQuoteMeta.variety).toBe("Late Variety");
    expect(after.markets[0]!.lastQuoteMeta.date).toBe("2026-10-30");
  });

  it("replay mode reads only replay/live rows available by the issue instant and never synthetic rows", async () => {
    const rep = source({ mode: "replay" });
    expect(await rep.getOutlook("ginger-fresh", ["synth-a"], [], "2026-10-30T12:00:00Z")).toEqual({ state: "unavailable", missingReason: "price_history_not_ingested" });
    for (let i = 0; i < 9; i++) await row({ market: "synth-replay", date: `2026-10-${String(1 + i).padStart(2, "0")}`, quintal: 5000, mode: "replay", availableAt: "2026-10-09T12:00:00Z" });
    await row({ market: "synth-replay", date: "2026-10-12", quintal: 9000, mode: "replay", availableAt: "2026-10-21T00:00:00Z" });
    const early = await rep.getOutlook("ginger-fresh", ["synth-replay"], [], "2026-10-15T00:00:00Z");
    const late = await rep.getOutlook("ginger-fresh", ["synth-replay"], [], "2026-10-25T00:00:00Z");
    if (!("kind" in early) || !("kind" in late)) throw new Error("expected references");
    expect(early.markets[0]!.lastQuote.value).toBe("50.00");
    expect(late.markets[0]!.lastQuote.value).toBe("90.00");
  });
});

describe("missing-reason matrix", () => {
  it("no key and no rows: price_access_key_gated", async () => {
    expect(await source({ mode: "live", keyConfigured: false }).getOutlook("ginger-fresh", ["synth-a"], [], ISSUE)).toEqual({ state: "unavailable", missingReason: "price_access_key_gated" });
  });
  it("key configured, no rows (live never sees synthetic rows): price_history_not_ingested", async () => {
    expect(await source({ mode: "live", keyConfigured: true }).getOutlook("ginger-fresh", ["synth-a"], [], ISSUE)).toEqual({ state: "unavailable", missingReason: "price_history_not_ingested" });
  });
  it("an unknown product has no rows either", async () => {
    expect(await source().getOutlook("no-such-product", [], [], ISSUE)).toEqual({ state: "unavailable", missingReason: "price_history_not_ingested" });
  });
  it("rows exist but every candidate market has fewer than 8 valid days: price_history_insufficient", async () => {
    expect(await source().getOutlook("ginger-dry", ["synth-b"], [], ISSUE)).toEqual({ state: "unavailable", missingReason: "price_history_insufficient" });
  });
  it("an insufficient market is skipped and reported, not blended in", async () => {
    const r = await source().getOutlook("ginger-fresh", ["synth-a", "synth-b"], [], ISSUE);
    if (!("kind" in r)) throw new Error("expected a reference");
    expect(r.markets.map((m) => m.marketId)).toEqual(["synth-a"]);
    expect(r.skippedMarkets).toEqual([{ marketId: "synth-b", reason: "price_history_insufficient" }]);
  });
  it("requested market absent but others exist: falls back to state-level markets and says so", async () => {
    const r = await source().getOutlook("ginger-fresh", ["hassan-apmc"], [], ISSUE, { stateId: "IN-KA" });
    if (!("kind" in r)) throw new Error("expected a reference");
    expect(r.fallback).toMatchObject({ reason: "market_not_in_history", requestedMarketIds: ["hassan-apmc"], scope: "state", stateName: "Karnataka" });
    expect(r.fallback!.note).toBe("No quotes for this market; showing Karnataka markets");
    expect(r.markets.map((m) => m.marketId)).toEqual(["synth-a"]); // never synth-t (Tamil Nadu)
  });
  it("requested market absent and no state to fall back to: market_not_in_history", async () => {
    expect(await source().getOutlook("ginger-fresh", ["hassan-apmc"], [], ISSUE)).toEqual({ state: "unavailable", missingReason: "market_not_in_history" });
    expect(await source().getOutlook("ginger-fresh", ["hassan-apmc"], [], ISSUE, { stateId: "IN-KL" })).toEqual({ state: "unavailable", missingReason: "market_not_in_history" });
  });
  it("texts are honest", () => {
    expect(missingReasonText("price_history_not_ingested")).toBe("Price history not ingested yet");
    expect(missingReasonText("price_history_insufficient")).toMatch(/^Too few recent quotes/);
    expect(missingReasonText("market_not_in_history", "Karnataka")).toBe("No quotes for this market; showing Karnataka markets");
  });
});

describe("get_market_outlook tool binding", () => {
  const ctx = { ownerId: "o", mode: "synthetic" as const, requestId: "r", pool: undefined as never, agentRunId: "a", asOf: NOW.toISOString() };
  it("returns ValueRecords with INR/kg units plus a label record; forecasts stay empty; absent markets get real reasons", async () => {
    const src_ = source();
    const out = await bindMarketOutlook({ prices: { source: src_, keyConfigured: true } })({ productId: "ginger-fresh", marketIds: ["synth-a", "synth-b"], issueDate: ISSUE, harvestWindows: [WIN] }, ctx);
    expect(out.forecasts).toEqual([]);
    const q = out.references.filter((r) => r.kind === "quantity" || r.kind === "range");
    expect(q.length).toBe(3); // last quote, weekly range, one seasonal reference
    expect(q.every((r) => r.unit === "INR/kg")).toBe(true);
    expect(q.map((r) => r.evidenceState)).toEqual(["observed", "derived", "derived"]);
    const label = out.references.find((r) => r.kind === "text")!;
    expect(label.value).toMatch(/not a forecast/i);
    expect(label.value).toMatch(/not a farm-gate price/i);
    expect(out.missing).toEqual([{ marketId: "synth-b", reason: "price_history_insufficient: Too few recent quotes (fewer than 8 valid trading days in the last 365 days)" }]);
  });
  it("without wiring it reports the key-gated reason, and rows-less live reports not-ingested", async () => {
    const none = await bindMarketOutlook()({ productId: "ginger-fresh", marketIds: ["m1"], issueDate: ISSUE, harvestWindows: [WIN] }, ctx);
    expect(none.missing[0]!.reason).toMatch(/^price_access_key_gated:/);
    const live = await bindMarketOutlook({ prices: { source: source({ mode: "live" }), keyConfigured: true } })({ productId: "ginger-fresh", marketIds: ["m1"], issueDate: ISSUE, harvestWindows: [WIN] }, ctx);
    expect(live.missing[0]!.reason).toMatch(/^price_history_not_ingested:/);
  });
});

describe("comparison cards", () => {
  const snap = snapshotFromFiles();
  const input: ComparisonInput = { location: { stateId: "IN-KA", districtId: null }, planting: { month: 5 }, irrigation: "rainfed", excludedCropIds: [], assumedPrices: [] };
  const findGinger = (items: ReturnType<typeof compareCrops>["items"]) => items.find((i) => i.productId === "ginger-fresh")!;

  it("shows the labelled reference with date, market and weekly-median range, and leaves other products with the real reason", async () => {
    const productIds = snap.profiles.flatMap((p) => p.products.map((x) => x.productId));
    const priceReferences = await priceReferencesFor(source(), h.pool, "synthetic", { productIds, issueDate: ISSUE, stateId: "IN-KA", districtName: null, keyConfigured: true });
    const out = compareCrops(snap, input, { mode: "synthetic", now: NOW, priceReferences, priceMissingReason: "price_history_not_ingested" });
    const g = findGinger(out.items).priceReference;
    if (g.state !== "historical_reference") throw new Error("expected a reference");
    expect(g.label).toBe("Mandi reference (wholesale), not a farm-gate price");
    expect(g).toMatchObject({ evidenceState: "observed", notForecast: true, marketId: "synth-a" });
    expect(g.lastQuote).toMatchObject({ inrPerKg: "120.00", date: "2026-10-29" }); // the 2026-10-30 row published at 20:00Z is not yet available at NOW (09:00Z)
  });

  it("POST /crop-comparisons carries the reference for Karnataka (state fallback note absent: no district asked) and the real reason elsewhere", async () => {
    await loadCatalogueIntoDb(h.pool);
    const post = async (app: Awaited<ReturnType<Harness["make"]>>, state: string) =>
      (await app.inject({ method: "POST", url: "/api/v1/crop-comparisons", headers: { origin: ORIGIN }, payload: { location: { stateId: state }, planting: { month: 5 }, irrigation: "rainfed", cropIds: ["ginger"] } })).json();
    const keyed = await h.make({}, { priceKeyConfigured: true, priceNow: () => NOW });
    const ka = await post(keyed, "IN-KA");
    const g = ka.data.items.find((i: any) => i.productId === "ginger-fresh").priceReference;
    expect(g).toMatchObject({ state: "historical_reference", marketId: "synth-a", label: "Mandi reference (wholesale), not a farm-gate price", lastQuote: { inrPerKg: "120.00", date: "2026-10-29" } });
    expect(g.weeklyRange).toMatchObject({ lowInrPerKg: "70.00", highInrPerKg: "110.00" });
    expect(JSON.stringify(ka.warnings)).toMatch(/historical mandi reference/);
    const dry = ka.data.items.find((i: any) => i.productId === "ginger-dry").priceReference; // only an insufficient market
    expect(dry).toMatchObject({ state: "unavailable", missingReason: "price_history_insufficient", text: expect.stringMatching(/^Too few recent quotes/) });
    const kl = await post(keyed, "IN-KL"); // no Kerala rows: nothing to fall back to
    expect(kl.data.items.find((i: any) => i.productId === "ginger-fresh").priceReference).toMatchObject({ state: "unavailable", missingReason: "market_not_in_history" });
    const gated = await post(await h.make({}, { priceKeyConfigured: false, priceNow: () => NOW }), "IN-KA");
    expect(gated.data.items.find((i: any) => i.productId === "ginger-fresh").priceReference.state).toBe("historical_reference"); // rows exist: shown whatever the key flag
    const crops = ka.data.items.filter((i: any) => i.cropId !== "ginger");
    expect(crops.length).toBe(0);
  });
});
