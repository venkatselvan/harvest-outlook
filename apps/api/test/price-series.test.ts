import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HarvestPriceOutlook, PriceSeries, PriceTrend } from "../../../packages/contracts/src/price-outlook";
import { SYNTHETIC_SOURCE_ID, ensureSource } from "../src/ingest/sources";
import { isoWeek } from "../src/plans/adapters/market-outlook";
import { priceSeriesRoutes } from "../src/routes/price-series";
import { districtKey, harvestPriceOutlook, isoWeekMonday, priceSeries, priceTrend, productsWithHistory } from "../src/services/price-series";
import { GINGER_PRODUCT_ID, seedGinger } from "./fixtures/meta/helpers";
import { login, setupHarness, testConfig, type Harness } from "./helpers";

/**
 * Every row below is SYNTHETIC test data (mode 'synthetic', is_synthetic true, market ids prefixed synth-) or a
 * mode 'replay' test row; none is an observation of a real market. Prices are given in INR/kg and stored as
 * INR/quintal x 100 plus the converted INR/kg columns, as ingest does. Expected numbers are hand-computed in comments.
 */
const DRY_ID = "00000000-0000-4000-8000-0000000000d2";
let h: Harness;
let src: string;

interface RowOpts { market: string; date: string; kg: number; marketName?: string; state?: string; district?: string; product?: string; variety?: string; mode?: "synthetic" | "replay"; availableAt?: string; vintage?: number; minKg?: number; maxKg?: number }
async function row(o: RowOpts) {
  const mode = o.mode ?? "synthetic";
  const min = o.minKg ?? o.kg;
  const max = o.maxKg ?? o.kg;
  await h.pool.query(
    `INSERT INTO market_observations (market_id, product_id, observed_on, source_id, price_min, price_modal, price_max, unit, is_synthetic, mode, evidence_state,
       market_name, state_name, district_name, variety, grade, variety_key, grade_key, price_min_inr_per_kg, price_modal_inr_per_kg, price_max_inr_per_kg, available_at, vintage_seq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'INR/quintal',$8,$9,$10,$11,$12,$13,$14,'Local',$15,'local',$16,$17,$18,$19,$20)`,
    [o.market, o.product ?? GINGER_PRODUCT_ID, o.date, src, min * 100, o.kg * 100, max * 100, mode === "synthetic", mode, mode === "synthetic" ? "illustrative" : "observed",
      o.marketName ?? o.market, o.state ?? "Karnataka", o.district ?? "Synth District", o.variety ?? "Synth", (o.variety ?? "Synth").toLowerCase(), min, o.kg, max,
      o.availableAt ?? "2026-01-01T00:00:00Z", o.vintage ?? 1],
  );
}

beforeAll(async () => {
  h = await setupHarness();
  await seedGinger(h.pool);
  src = await ensureSource(h.pool, SYNTHETIC_SOURCE_ID, { title: "Synthetic development fixtures", publisher: "Harvest Outlook (generated)", url: "local:data/fixtures/synthetic", licence: "synthetic, not real data" });

  // ---- Series fixtures (ginger-fresh, Jan-Mar 2026).
  // synth-mys, district label "Mysore" (alias of registry "Mysuru"). Jan market-day values: 01-05 two varieties 40 and 50 -> 45; 60; 70; 80.
  // => Jan p50 = median(45,60,70,80) = 65, min 45, max 80, n 4. No February rows. Mar: 100, 110, 120, 130 -> p50 115.
  await row({ market: "synth-mys", marketName: "Synth Mysore Market", district: "Mysore", date: "2026-01-05", kg: 40, variety: "A" });
  await row({ market: "synth-mys", marketName: "Synth Mysore Market", district: "Mysore", date: "2026-01-05", kg: 50, variety: "B" });
  for (const [d, kg] of [["2026-01-06", 60], ["2026-01-07", 70], ["2026-01-08", 80], ["2026-03-02", 100], ["2026-03-03", 110], ["2026-03-04", 120], ["2026-03-05", 130]] as const) {
    await row({ market: "synth-mys", marketName: "Synth Mysore Market", district: "Mysore", date: d, kg });
  }
  // Renamed entry of the same market ("... APMC", district "Mysuru"): joins the same market-day (03-05 median(130,130) = 130).
  await row({ market: "synth-mys-apmc", marketName: "Synth Mysore Market APMC", district: "Mysuru", date: "2026-03-05", kg: 130 });
  // Invalid ordering (min 1000 > modal 999): excluded and counted, never repaired.
  await row({ market: "synth-mys", marketName: "Synth Mysore Market", district: "Mysore", date: "2026-03-06", kg: 999, minKg: 1000, maxKg: 1000 });
  // synth-has, district Hassan: only 3 trading days (fewer than MIN_VALID_DAYS = 8) -> district falls back to state.
  for (const d of ["2026-01-12", "2026-01-13", "2026-01-14"]) await row({ market: "synth-has", district: "Hassan", date: d, kg: 30 });
  // synth-tn in Tamil Nadu: 10 days at 20 (another state; only reached through the national fallback).
  for (let i = 1; i <= 10; i++) await row({ market: "synth-tn", state: "Tamil Nadu", district: "Coimbatore", date: `2026-01-${String(i + 15).padStart(2, "0")}`, kg: 20 });

  // ---- Seasonal reference fixtures (ginger-fresh, Karnataka, district label "Madikeri(Kodagu)" -> registry "Kodagu").
  // One quote on the Wednesday of ISO weeks 23-26 of 2023, 2024, 2025 (dates from Python date.fromisocalendar):
  //            W23  W24  W25  W26
  //   2023:     40   40   40   40
  //   2024:     50   60   50   60
  //   2025:     80   80  100  100
  const kodagu: Record<number, [string, number][]> = {
    2023: [["2023-06-07", 40], ["2023-06-14", 40], ["2023-06-21", 40], ["2023-06-28", 40]],
    2024: [["2024-06-05", 50], ["2024-06-12", 60], ["2024-06-19", 50], ["2024-06-26", 60]],
    2025: [["2025-06-04", 80], ["2025-06-11", 80], ["2025-06-18", 100], ["2025-06-25", 100]],
  };
  for (const rows of Object.values(kodagu)) for (const [d, kg] of rows) await row({ market: "synth-kod", district: "Madikeri(Kodagu)", date: d, kg });
  // Udupi: a single quote in 2025-W10, far from the harvest weeks -> Udupi district has no qualifying year.
  await row({ market: "synth-udu", district: "Udupi", date: "2025-03-05", kg: 70 });
  // Goa: quotes in 2025 only (weeks 24, 25) -> one year -> insufficient.
  await row({ market: "synth-goa", state: "Goa", district: "North Goa", date: "2025-06-11", kg: 90 });
  await row({ market: "synth-goa", state: "Goa", district: "North Goa", date: "2025-06-18", kg: 95 });

  // ---- Trend fixtures (ginger-dry, Karnataka, Hassan): one quote on the 10th of each month 2024-11 .. 2026-10.
  // Prior window 2024-11..2025-10 at 100, missing 2025-01 and 2025-02 (10 months). Last window 2025-11..2026-10 at 120,
  // missing 2026-03 (11 months), except 2026-01 = 240 whose prior partner (2025-01) is missing.
  for (let i = 0; i < 24; i++) {
    const t = new Date(Date.UTC(2024, 10 + i, 10));
    const ym = t.toISOString().slice(0, 7);
    if (["2025-01", "2025-02", "2026-03"].includes(ym)) continue;
    await row({ market: "synth-dry-h", district: "Hassan", product: DRY_ID, date: `${ym}-10`, kg: ym === "2026-01" ? 240 : i < 12 ? 100 : 120 });
  }
  // One ginger-dry quote in Kolar (1 month of data) for the trend's months-coverage fallback.
  await row({ market: "synth-dry-k", district: "Kolar", product: DRY_ID, date: "2026-05-20", kg: 110 });

  // ---- Replay fixtures (mode 'replay', ginger-fresh, Karnataka/Hassan): 10 days at 50 published 2026-02-11; a late
  // quote of 500 on 2026-02-12 and a revised 2026-02-05 vintage (70) both published 2026-03-15.
  for (let i = 1; i <= 10; i++) await row({ market: "synth-rep", district: "Hassan", mode: "replay", date: `2026-02-${String(i).padStart(2, "0")}`, kg: 50, availableAt: "2026-02-11T00:00:00Z" });
  await row({ market: "synth-rep", district: "Hassan", mode: "replay", date: "2026-02-12", kg: 500, availableAt: "2026-03-15T00:00:00Z" });
  await row({ market: "synth-rep", district: "Hassan", mode: "replay", date: "2026-02-05", kg: 70, availableAt: "2026-03-15T00:00:00Z", vintage: 2 });
}, 60_000);
afterAll(async () => h.close());

const Q1 = { productId: "ginger-fresh", from: "2026-01-01", to: "2026-03-31", bucket: "month" as const };

describe("helpers", () => {
  it("isoWeekMonday and district aliases", () => {
    expect(isoWeekMonday(2026, 1)).toBe("2025-12-29");
    expect(isoWeekMonday(2026, 25)).toBe("2026-06-15");
    expect(isoWeek("2026-06-17")).toEqual({ year: 2026, week: 25 });
    expect(districtKey("Mysore")).toBe("mysuru");
    expect(districtKey("Madikeri(Kodagu)")).toBe(districtKey("Kodagu"));
    expect(districtKey("Bangalore")).toBe("bangalore"); // deliberately unmapped (spans three current districts)
  });
});

describe("priceSeries: month buckets, gaps and coverage", () => {
  it("buckets market-day values by month, keeps the empty month as a gap, counts excluded rows", async () => {
    const s = await priceSeries(h.pool, "synthetic", { ...Q1, stateName: "Karnataka", districtName: "Mysuru" });
    expect(PriceSeries.parse(s)).toBeTruthy();
    expect(s.status).toBe("available");
    expect(s.scope).toMatchObject({ level: "district", requestedLevel: "district", stateName: "Karnataka", districtName: "Mysuru", marketCount: 1, fallbackNote: null });
    expect(s.unit).toBe("INR/kg");
    expect(s.buckets).toEqual([
      { start: "2026-01-01", end: "2026-01-31", p50: 65, min: 45, max: 80, n: 4, markets: 1 },
      { start: "2026-02-01", end: "2026-02-28", p50: null, min: null, max: null, n: 0, markets: 0 },
      { start: "2026-03-01", end: "2026-03-31", p50: 115, min: 100, max: 130, n: 4, markets: 1 },
    ]);
    expect(s.gaps).toEqual([{ from: "2026-02-01", to: "2026-02-28" }]);
    // 10 valid rows (5 Jan incl. two varieties, 4 Mar, 1 renamed APMC entry), 8 trading days, 1 invalid row excluded.
    expect(s.coverage).toEqual({ observations: 10, markets: 1, firstDate: "2026-01-05", lastDate: "2026-03-05", validDays: 8, excludedRows: 1 });
  });

  it("week buckets are clamped ISO weeks", async () => {
    const s = await priceSeries(h.pool, "synthetic", { productId: "ginger-fresh", stateName: "IN-KA", districtName: "Mysuru", from: "2026-01-01", to: "2026-01-14", bucket: "week" });
    // Only 4 Mysuru days (and 7 state/national days) fall in this range: no level reaches 8 trading days, so the most
    // specific level with rows is returned as insufficient.
    expect(s).toMatchObject({ status: "insufficient", missingReason: "price_history_insufficient", scope: { level: "district" } });
    expect(s.buckets.map((b) => [b.start, b.end, b.p50, b.n])).toEqual([
      ["2026-01-01", "2026-01-04", null, 0], // ISO 2026-W01 (Mon 2025-12-29) clamped to the range
      ["2026-01-05", "2026-01-11", 65, 4],
      ["2026-01-12", "2026-01-14", null, 0],
    ]);
    expect(s.gaps).toEqual([{ from: "2026-01-01", to: "2026-01-04" }, { from: "2026-01-12", to: "2026-01-14" }]);
  });
});

describe("priceSeries: scope fallback", () => {
  it("requested markets win when they have rows", async () => {
    const s = await priceSeries(h.pool, "synthetic", { ...Q1, stateName: "Karnataka", districtName: "Hassan", marketIds: ["synth-mys"] });
    expect(s.scope).toMatchObject({ level: "market", requestedLevel: "market", marketIds: ["synth-mys"], fallbackNote: null });
    expect(s.coverage.observations).toBe(9);
  });

  it("district with fewer than 8 trading days falls back to the state pool and says so", async () => {
    const s = await priceSeries(h.pool, "synthetic", { ...Q1, stateName: "Karnataka", districtName: "Hassan" });
    expect(s.scope).toMatchObject({ level: "state", requestedLevel: "district", stateName: "Karnataka", districtName: null, marketCount: 2 });
    expect(s.scope.fallbackNote).toBe("Hassan district: too few quotes in this period (3 trading days); showing Karnataka markets.");
    // Jan pooled market-days: mys [45,60,70,80] + has [30,30,30] -> median 45; never the Tamil Nadu rows.
    expect(s.buckets[0]).toMatchObject({ p50: 45, min: 30, max: 80, n: 7, markets: 2 });
  });

  it("absent requested market falls back to the district", async () => {
    const s = await priceSeries(h.pool, "synthetic", { ...Q1, stateName: "Karnataka", districtName: "Mysuru", marketIds: ["synth-nowhere"] });
    expect(s.scope).toMatchObject({ level: "district", requestedLevel: "market" });
    expect(s.scope.fallbackNote).toBe("The requested market: no quotes in this period; showing Mysuru district.");
  });

  it("a state without rows falls back to national and reports it", async () => {
    const s = await priceSeries(h.pool, "synthetic", { ...Q1, stateName: "Kerala" });
    expect(s.scope).toMatchObject({ level: "national", requestedLevel: "state", stateName: null, marketCount: 3 });
    expect(s.scope.fallbackNote).toBe("Kerala markets: no quotes in this period; showing all-India markets.");
  });

  it("unknown product: insufficient, not ingested", async () => {
    const s = await priceSeries(h.pool, "synthetic", { ...Q1, productId: "no-such-product", stateName: "Karnataka" });
    expect(s).toMatchObject({ status: "insufficient", missingReason: "price_history_not_ingested" });
    expect(s.buckets.every((b) => b.p50 === null)).toBe(true);
  });
});

describe("harvestPriceOutlook (pooled B_seasonal_reference)", () => {
  const base = { productId: "ginger-fresh", stateName: "Karnataka", harvestDate: "2026-06-17", asOf: "2026-11-01" };

  it("leave-one-year-out interval matches the hand-computed example (weekWindow 0)", async () => {
    const o = await harvestPriceOutlook(h.pool, "synthetic", { ...base, districtName: "Kodagu", weekWindow: 0 });
    expect(HarvestPriceOutlook.parse(o)).toBeTruthy();
    expect(o).toMatchObject({ status: "available", missingReason: null, harvestWeek: { year: 2026, week: 25 }, yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025] });
    expect(o.scope).toMatchObject({ level: "district", requestedLevel: "district", districtName: "Kodagu", fallbackNote: null });
    // p50 = median of W25 weekly medians {40, 50, 100} = 50.
    // LOO residuals, one per (year, week): value / median of the same week in the other two years:
    //   W23 40/65 50/60 80/45 | W24 40/70 60/60 80/50 | W25 40/75 50/70 100/45 | W26 40/80 60/70 100/50
    // 12 log residuals; type-7 quantiles (numpy) give p10 = 50*exp(-0.621709) = 26.85, p25 = 50*exp(-0.504035) = 30.20,
    // p75 = 50*exp(0.496344) = 82.14, p90 = 50*exp(0.681369) = 98.83 (cross-checked with numpy.quantile).
    expect([o.p10, o.p25, o.p50, o.p75, o.p90]).toEqual([26.85, 30.2, 50, 82.14, 98.83]);
    expect(o.residualCount).toBe(12);
    expect(o.perYear).toEqual([{ year: 2023, weeks: 1, median: 40 }, { year: 2024, weeks: 1, median: 50 }, { year: 2025, weeks: 1, median: 100 }]);
    // annualMean = mean of the 12 weekly medians = 740 / 12 = 61.67.
    expect(o.annualMean).toBe(61.67);
    expect(o).toMatchObject({ annualWeeks: 12, weeksUsed: 3, observations: 3, marketsUsed: 1 });
  });

  it("default +/-2 week window pools W23-W26: p50 = median of 12 weekly medians = (50 + 60) / 2 = 55", async () => {
    const o = await harvestPriceOutlook(h.pool, "synthetic", { ...base, districtName: "Kodagu" });
    expect(o).toMatchObject({ status: "available", weekWindow: 2, p50: 55, weeksUsed: 12, residualCount: 12 });
    expect(o.p25! <= o.p50! && o.p50! <= o.p75!).toBe(true);
  });

  it("district without qualifying years falls back to the state pool", async () => {
    const o = await harvestPriceOutlook(h.pool, "synthetic", { ...base, districtName: "Udupi", weekWindow: 0 });
    expect(o.scope).toMatchObject({ level: "state", requestedLevel: "district", districtName: null });
    expect(o.scope.fallbackNote).toBe("Udupi district: fewer than 2 years with quotes in these weeks; showing Karnataka markets.");
    expect(o.p50).toBe(50);
  });

  it("fewer than two years: insufficient with the D45 reason and no prices", async () => {
    const goa = await harvestPriceOutlook(h.pool, "synthetic", { ...base, stateName: "Goa" });
    expect(HarvestPriceOutlook.parse(goa)).toBeTruthy();
    expect(goa).toMatchObject({ status: "insufficient", missingReason: "price_history_insufficient", yearsUsed: [2025], p10: null, p25: null, p50: null, p75: null, p90: null, annualMean: null });
    expect(goa.scope).toMatchObject({ level: "state", stateName: "Goa" });
    expect(await harvestPriceOutlook(h.pool, "synthetic", { ...base, stateName: "Kerala" })).toMatchObject({ status: "insufficient", missingReason: "market_not_in_history" });
    expect(await harvestPriceOutlook(h.pool, "synthetic", { ...base, productId: "no-such-product" })).toMatchObject({ status: "insufficient", missingReason: "price_history_not_ingested" });
  });

  it("years before asOf only: asOf in 2025 considers 2022-2024 and finds two years", async () => {
    const o = await harvestPriceOutlook(h.pool, "synthetic", { ...base, districtName: "Kodagu", asOf: "2025-11-01", weekWindow: 0 });
    expect(o).toMatchObject({ yearsConsidered: [2022, 2023, 2024], yearsUsed: [2023, 2024], status: "insufficient", missingReason: "price_residuals_insufficient", residualCount: 8 });
  });
});

describe("priceTrend", () => {
  it("monthly series with null months and a paired year-on-year change", async () => {
    const t = await priceTrend(h.pool, "synthetic", { productId: "ginger-dry", stateName: "Karnataka", districtName: "Hassan", months: 24, asOf: "2026-11-01" });
    expect(PriceTrend.parse(t)).toBeTruthy();
    expect(t).toMatchObject({ from: "2024-11-01", to: "2026-10-31", status: "available" });
    expect(t.scope).toMatchObject({ level: "district", districtName: "Hassan" });
    expect(t.series).toHaveLength(24);
    expect(t.series.filter((m) => m.p50 === null).map((m) => m.month)).toEqual(["2025-01", "2025-02", "2026-03"]);
    // Paired months exclude 2026-01 (240; its prior partner 2025-01 is missing): 120 vs 100 -> +20.0 %. Unpaired would give +30.9 %.
    expect(t.yoy).toEqual({ lastMonthsWithData: 11, priorMonthsWithData: 10, pairedMonths: 9, lastMean: 120, priorMean: 100, changePct: 20 });
    expect(t.yoyMissingReason).toBeNull();
  });

  it("a district with quotes in fewer than half of the months falls back to the state series", async () => {
    // Kolar ginger-dry: one quote (2026-05-20) = 1 of 24 months; the Karnataka pool has 22 months.
    const t = await priceTrend(h.pool, "synthetic", { productId: "ginger-dry", stateName: "Karnataka", districtName: "Kolar", months: 24, asOf: "2026-11-01" });
    expect(t).toMatchObject({ status: "available", scope: { level: "state", requestedLevel: "district", marketCount: 2 } });
    expect(t.scope.fallbackNote).toBe("Kolar district: quotes in only 1 of 24 months; showing Karnataka markets.");
  });

  it("when no level covers half of the months, the most specific level with rows is returned as insufficient", async () => {
    // ginger-fresh synthetic rows cover 5 of 36 months in Karnataka (and nationally): nothing qualifies.
    const t = await priceTrend(h.pool, "synthetic", { productId: "ginger-fresh", stateName: "Karnataka", districtName: "Hassan", asOf: "2026-11-01" });
    expect(t).toMatchObject({ status: "insufficient", missingReason: "price_history_insufficient", scope: { level: "district", districtName: "Hassan" }, yoy: null });
    expect(t.series).toHaveLength(36);
  });

  it("no year-on-year change when a window has fewer than 9 months", async () => {
    const t = await priceTrend(h.pool, "synthetic", { productId: "ginger-dry", stateName: "Karnataka", districtName: "Hassan", months: 24, asOf: "2026-06-01" });
    expect(t.yoy).toBeNull();
    expect(t.yoyMissingReason).toBe("Year-on-year needs at least 9 months with quotes in each 12-month window (last 11, prior 5).");
  });
});

describe("mode separation and replay cutoff", () => {
  it("replay reads only vintages available by the cutoff", async () => {
    const q = { productId: "ginger-fresh", stateName: "Karnataka", districtName: "Hassan", from: "2026-02-01", to: "2026-02-28", bucket: "month" as const };
    const early = await priceSeries(h.pool, "replay", { ...q, asOf: "2026-02-20" });
    expect(early.buckets[0]).toMatchObject({ p50: 50, max: 50, n: 10 }); // the 500 quote and the 70 revision are not yet published
    const late = await priceSeries(h.pool, "replay", { ...q, asOf: "2026-03-20" });
    expect(late.buckets[0]).toMatchObject({ p50: 50, min: 50, max: 500, n: 11 }); // 02-05 now 70 (latest vintage), plus 500
    expect(late.coverage.observations).toBe(11);
    expect(early.limitations.some((l) => l.startsWith("Replay: only rows with a recorded available_at at or before 2026-02-20T23:59:59.999Z"))).toBe(true);
    // Synthetic rows never appear in replay: no Mysuru rows, and the state pool holds only the replay market.
    const mys = await priceSeries(h.pool, "replay", { ...Q1, stateName: "Karnataka", districtName: "Mysuru", asOf: "2026-04-01" });
    expect(mys.scope).toMatchObject({ level: "state", marketCount: 1 });
    expect(mys.coverage.observations).toBe(11);
  });

  it("replay needs a valid cutoff: the route requires asOf and the service rejects an impossible date", async () => {
    const app = await h.make({ RUNTIME_MODE: "replay" });
    await app.register(priceSeriesRoutes, { config: testConfig({ RUNTIME_MODE: "replay" }), pool: h.pool });
    const c = await login(app);
    const missing = await c.call("GET", "/api/v1/price-outlook?productId=ginger-fresh&stateName=Karnataka&harvestDate=2026-06-17");
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: "validation_failed", message: "asOf is required in replay mode" });
    const ok = await c.call("GET", "/api/v1/price-series?productId=ginger-fresh&stateName=Karnataka&districtName=Hassan&from=2026-02-01&to=2026-02-28&asOf=2026-02-20");
    expect(ok.json().data.buckets[0]).toMatchObject({ p50: 50, max: 50, n: 10 });
    await expect(harvestPriceOutlook(h.pool, "replay", { productId: "ginger-fresh", stateName: "Karnataka", harvestDate: "2026-06-17", asOf: "2026-02-30" })).rejects.toThrow(/asOf must be a calendar date/);
  });

  it("live mode never reads synthetic (or replay) rows", async () => {
    expect(await priceSeries(h.pool, "live", { ...Q1, stateName: "Karnataka" })).toMatchObject({ status: "insufficient", missingReason: "price_history_not_ingested" });
    expect(await harvestPriceOutlook(h.pool, "live", { productId: "ginger-fresh", stateName: "Karnataka", districtName: "Kodagu", harvestDate: "2026-06-17", asOf: "2026-11-01" })).toMatchObject({ status: "insufficient", missingReason: "price_history_not_ingested" });
    expect(await productsWithHistory(h.pool, "live", "Karnataka", { asOf: "2026-11-01" })).toEqual([]);
    // Same queries in synthetic mode do see the fixtures.
    expect((await priceSeries(h.pool, "synthetic", { ...Q1, stateName: "Karnataka" })).status).toBe("available");
  });
});

describe("productsWithHistory", () => {
  it("lists products with valid quotes in the state over the last 3 years", async () => {
    const list = await productsWithHistory(h.pool, "synthetic", "IN-KA", { asOf: "2026-11-01" });
    // ginger-dry: 21 monthly Hassan quotes + 1 Kolar quote. ginger-fresh since 2023-11-02: 11 days in Jan-Mar 2026 + 8 Kodagu days (2024, 2025) + 1 Udupi day = 20.
    expect(list).toEqual([
      { productId: "ginger-dry", validDays: 22, observations: 22, markets: 2, firstDate: "2024-11-10", lastDate: "2026-10-10", meetsMinValidDays: true },
      { productId: "ginger-fresh", validDays: 20, observations: 22, markets: 4, firstDate: "2024-06-05", lastDate: "2026-03-05", meetsMinValidDays: true },
    ]);
    expect(await productsWithHistory(h.pool, "synthetic", "Kerala", { asOf: "2026-11-01" })).toEqual([]);
  });
});

describe("routes", () => {
  it("serves the three reads with auth, validation and a private cache header", async () => {
    const app = await h.make();
    await app.register(priceSeriesRoutes, { config: h.config, pool: h.pool });
    const anon = await app.inject({ method: "GET", url: "/api/v1/price-outlook?productId=ginger-fresh&stateName=Karnataka&harvestDate=2026-06-17" });
    expect(anon.statusCode).toBe(401);
    const c = await login(app);
    const o = await c.call("GET", "/api/v1/price-outlook?productId=ginger-fresh&stateName=Karnataka&districtName=Kodagu&harvestDate=2026-06-17&asOf=2026-11-01&weekWindow=0");
    expect(o.statusCode).toBe(200);
    expect(o.headers["cache-control"]).toBe("private, max-age=300");
    const od = o.json();
    expect(od.mode).toBe("synthetic");
    expect(HarvestPriceOutlook.parse(od.data)).toMatchObject({ p50: 50, p25: 30.2, p75: 82.14 });
    const s = await c.call("GET", "/api/v1/price-series?productId=ginger-fresh&stateName=Karnataka&districtName=Mysuru&from=2026-01-01&to=2026-03-31&bucket=month");
    expect(s.statusCode).toBe(200);
    expect(PriceSeries.parse(s.json().data).buckets[0]!.p50).toBe(65);
    const t = await c.call("GET", "/api/v1/price-trend?productId=ginger-dry&stateName=Karnataka&districtName=Hassan&months=24&asOf=2026-11-01");
    expect(t.statusCode).toBe(200);
    expect(PriceTrend.parse(t.json().data).yoy!.changePct).toBe(20);
    expect((await c.call("GET", "/api/v1/price-series?productId=ginger-fresh&from=2026-03-01&to=2026-01-01")).statusCode).toBe(400);
    expect((await c.call("GET", "/api/v1/price-outlook?productId=ginger-fresh&stateName=Karnataka&harvestDate=2026-02-30")).statusCode).toBe(400);
    expect((await c.call("GET", "/api/v1/price-trend?productId=ginger-fresh&stateName=Karnataka&months=6")).statusCode).toBe(400);
  });
});
