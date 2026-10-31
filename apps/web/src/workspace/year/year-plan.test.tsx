import { describe, expect, it } from "vitest";
import {
  ApplyYearPlanResult,
  PriceTrend,
  RescoreYearPlan,
  YearPlanOption,
  YearPlanReview,
} from "@harvest/contracts";
import pool from "../../../../../data/research/rotation/crop-pool.json";
import {
  FIXTURE_FARM_ID,
  applyResult,
  emptyReview,
  freshReview,
  maizeTrend,
  occupiedReview,
  pendingReview,
  rescoredBestOverall,
  staleReview,
  unavailableReview,
} from "./fixtures";
import { columnOf, formatInr, formatInrRange, formatKgRange, monthColumns, stripPlacement } from "./format";
import {
  POOL_CROPS,
  cropChoices,
  isLegume,
  mergeServerReview,
  modelUnavailable,
  needsGeneration,
  replaceOption,
  rescoreBody,
  scenarioText,
  draftFromOption,
} from "./model";
import { ensureYearPlan, generateYearPlan, pollYearPlan } from "./yearPlanApi";
import { sparklineGeometry } from "../ui/Sparkline";
import { summarizeTrend } from "../ui/PriceTrendChart";

describe("year plan fixtures", () => {
  it("validate against the shared contracts", () => {
    for (const review of [occupiedReview, freshReview, pendingReview, unavailableReview, staleReview, emptyReview])
      expect(() => YearPlanReview.parse(review)).not.toThrow();
    expect(() => YearPlanOption.parse(rescoredBestOverall)).not.toThrow();
    expect(() => PriceTrend.parse(maizeTrend)).not.toThrow();
    expect(maizeTrend.series).toHaveLength(36);
    expect(() => ApplyYearPlanResult.parse(applyResult(occupiedReview, "opt-best-overall"))).not.toThrow();
  });
  it("describe the occupied scenario: paddy fixed until mid-November, three options each with a legume and three reasons", () => {
    expect(occupiedReview.scenario.horizon).toEqual({ from: "2026-09-01", to: "2027-09-01" });
    expect(occupiedReview.options.map((o) => o.label)).toEqual(["Best overall", "Soil enrichment", "Lowest water"]);
    for (const option of occupiedReview.options) {
      expect(option.slots.length).toBeGreaterThanOrEqual(2);
      expect(option.slots.length).toBeLessThanOrEqual(3);
      expect(option.slots[0]!.fixed).toBe(true);
      expect(option.slots.some((s) => isLegume(s.cropId))).toBe(true);
      expect(option.reasons).toHaveLength(3);
      expect(option.totalProfitPerHa!.low).toBeLessThan(option.totalProfitPerHa!.high);
    }
  });
  it("keep the local rotation-role table in step with data/research/rotation/crop-pool.json", () => {
    const fromJson = Object.fromEntries(pool.pool.map((c) => [c.cropId, { role: c.rotationRole, productIds: c.productIds }]));
    expect(POOL_CROPS).toEqual(fromJson);
  });
});

describe("month grid placement", () => {
  it("places a strip across the year boundary", () => {
    expect(stripPlacement("2026-12-01", "2027-03-31", "2026-09-01")).toEqual({
      left: 25,
      width: 33.333,
      clippedStart: false,
      clippedEnd: false,
      visible: true,
    });
  });
  it("uses fractional days and clips at both ends", () => {
    const mid = stripPlacement("2026-11-16", "2026-11-30", "2026-09-01");
    expect(mid.left).toBeCloseTo((2 + 15 / 30) / 12 * 100, 2);
    expect(mid.width).toBeCloseTo((15 / 30 / 12) * 100, 2);
    const early = stripPlacement("2026-08-15", "2026-10-31", "2026-09-01");
    expect(early).toMatchObject({ left: 0, clippedStart: true, clippedEnd: false });
    expect(early.width).toBeCloseTo((2 / 12) * 100, 2);
    const late = stripPlacement("2027-07-01", "2027-10-15", "2026-09-01");
    expect(late).toMatchObject({ left: 83.333, width: 16.667, clippedEnd: true });
    expect(stripPlacement("2027-10-01", "2027-12-01", "2026-09-01").visible).toBe(false);
  });
  it("labels twelve columns from the horizon month and finds the current month", () => {
    const cols = monthColumns("2026-09-01");
    expect(cols.map((c) => c.label)).toEqual(["Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"]);
    expect(cols.filter((c) => c.showYear).map((c) => c.key)).toEqual(["2026-09", "2027-01"]);
    expect(columnOf("2026-11-01", "2026-09-01")).toBe(2);
    expect(columnOf("2027-09-01", "2026-09-01")).toBeNull();
  });
});

describe("money and quantity formatting", () => {
  it("formats rupees in thousand, lakh and crore", () => {
    expect(formatInr(541)).toBe("₹541");
    expect(formatInr(1659)).toBe("₹1.7 thousand");
    expect(formatInr(51702)).toBe("₹52 thousand");
    expect(formatInr(99999)).toBe("₹1 lakh");
    expect(formatInr(142822)).toBe("₹1.4 lakh");
    expect(formatInr(25_000_000)).toBe("₹2.5 crore");
    expect(formatInr(-1659)).toBe("−₹1.7 thousand");
  });
  it("formats profit ranges, sharing the unit only when both ends use it and neither is negative", () => {
    expect(formatInrRange({ low: 51702, high: 142822 })).toBe("₹52 thousand to ₹1.4 lakh");
    expect(formatInrRange({ low: 25738, high: 80138 })).toBe("₹26 to 80 thousand");
    expect(formatInrRange({ low: 120000, high: 180000 })).toBe("₹1.2 to 1.8 lakh");
    expect(formatInrRange({ low: -1659, high: 19261 })).toBe("−₹1.7 thousand to ₹19 thousand");
    expect(formatInrRange({ low: 80138, high: 25738 })).toBe("₹26 to 80 thousand");
    expect(formatKgRange({ low: 3600, high: 4400 })).toBe("3,600 to 4,400 kg");
  });
  it("matches the totals the calendar shows for the fixture options", () => {
    expect(occupiedReview.options.map((o) => formatInrRange(o.totalProfitPerHa!))).toEqual([
      "₹52 thousand to ₹1.4 lakh",
      "₹45 thousand to ₹1.3 lakh",
      "₹26 to 80 thousand",
    ]);
  });
});

describe("review state", () => {
  it("replaces only the edited option, in place, after a re-score", () => {
    const next = replaceOption(occupiedReview, "opt-best-overall", rescoredBestOverall);
    expect(next.options.map((o) => o.optionId)).toEqual(["opt-best-overall-edit-1", "opt-soil-enrichment", "opt-lowest-water"]);
    expect(next.options[1]).toBe(occupiedReview.options[1]);
    expect(occupiedReview.options[0]!.optionId).toBe("opt-best-overall");
    expect(replaceOption(occupiedReview, "missing", rescoredBestOverall)).toBe(occupiedReview);
  });
  it("keeps a farmer's version when the server returns the same review", () => {
    const local = replaceOption(occupiedReview, "opt-best-overall", rescoredBestOverall);
    const merged = mergeServerReview(local, { ...occupiedReview, appliedOptionIds: ["opt-soil-enrichment"] });
    expect(merged.options[0]!.origin).toBe("farmer_edit");
    expect(merged.appliedOptionIds).toEqual(["opt-soil-enrichment"]);
    expect(mergeServerReview(local, freshReview)).toBe(freshReview);
  });
  it("derives scenario text, generation need and the model-unavailable state", () => {
    const name = (id: string) => id;
    expect(scenarioText(occupiedReview.scenario, occupiedReview.options, "2026-11-01", name)).toBe(
      "Sep 2026 to Sep 2027 · Paddy growing until mid-Nov",
    );
    expect(scenarioText(freshReview.scenario, freshReview.options, "2026-11-01", (id) => (id === "maize" ? "Maize" : id))).toBe(
      "Starting fresh from today · last crop maize",
    );
    expect(needsGeneration(emptyReview)).toBe(true);
    expect(needsGeneration(pendingReview)).toBe(false);
    expect(modelUnavailable(unavailableReview)).toBe(true);
    expect(modelUnavailable(occupiedReview)).toBe(false);
  });
  it("groups editable crops by rotation role with legumes first and builds a valid re-score body", () => {
    const choices = cropChoices(occupiedReview, [
      { cropId: "sunflower", name: "Sunflower", products: [{ productId: "sunflower-seed", name: "Seed", productBasis: "seed" }] },
      { cropId: "wheat", name: "Wheat", products: [] },
    ]);
    expect(choices[0]!.role).toBe("nitrogen_fixer");
    expect(choices.some((c) => c.cropId === "sunflower")).toBe(true);
    expect(choices.some((c) => c.cropId === "wheat")).toBe(false);
    const drafts = draftFromOption(occupiedReview.options[0]!).map((d) =>
      d.slotId === "a-maize" ? { ...d, cropId: "sunflower", productId: "sunflower-seed", sowing: "2027-01-20" } : d,
    );
    const body = rescoreBody(occupiedReview.reviewId!, "opt-best-overall", drafts);
    expect(() => RescoreYearPlan.parse(body)).not.toThrow();
    expect(body.slots.map((s) => [s.cropId, s.slotId ?? null])).toEqual([
      ["paddy", "paddy-current"],
      ["sunflower", null],
      ["green-gram", "a-green-gram"],
    ]);
  });
});

describe("year plan client", () => {
  const envelope = (data: unknown) =>
    new Response(JSON.stringify({ requestId: "t", mode: "synthetic", asOf: "2026-11-01T00:00:00Z", data, warnings: [], error: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  function fake(queue: unknown[]) {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/v1/session") return envelope({ authenticated: true, csrfToken: "test" });
      return envelope(queue.length > 1 ? queue.shift() : queue[0]);
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  it("ensureYearPlan posts once, then polls until the review settles", async () => {
    const { calls, fetchImpl } = fake([pendingReview, pendingReview, occupiedReview]);
    const seen: string[] = [];
    const final = await ensureYearPlan(FIXTURE_FARM_ID, { fetchImpl, intervalMs: 1, onUpdate: (r) => seen.push(r.status) });
    expect(final.status).toBe("ready");
    expect(seen).toEqual(["pending", "pending", "ready"]);
    expect(calls.filter((c) => c.startsWith("POST /api/v1/farms"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("GET /api/v1/farms"))).toHaveLength(2);
  });
  it("posts {} by default and {\"force\":true} for Refresh and Try again", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/session") return envelope({ authenticated: true, csrfToken: "test" });
      if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
      return envelope(occupiedReview);
    }) as typeof fetch;
    await generateYearPlan(FIXTURE_FARM_ID, { fetchImpl });
    await generateYearPlan(FIXTURE_FARM_ID, { fetchImpl, force: true });
    await ensureYearPlan(FIXTURE_FARM_ID, { fetchImpl, force: true, intervalMs: 1 });
    expect(bodies).toEqual([{}, { force: true }, { force: true }]);
  });
  it("stops polling when the farm changes or the view unmounts", async () => {
    const { calls, fetchImpl } = fake([pendingReview]);
    const ctrl = new AbortController();
    const running = pollYearPlan(FIXTURE_FARM_ID, pendingReview, { fetchImpl, intervalMs: 50, signal: ctrl.signal });
    ctrl.abort();
    expect((await running).status).toBe("pending");
    expect(calls.filter((c) => c.includes("/year-plan"))).toHaveLength(0);
  });
});

describe("shared chart geometry", () => {
  it("breaks the sparkline at missing months and summarises the trend", () => {
    const g = sparklineGeometry([1, 2, null, 4], 300, 56);
    expect(g.path.match(/M/g)).toHaveLength(2);
    expect(g.points[2]).toBeNull();
    const s = summarizeTrend(maizeTrend);
    expect(s.monthsWithData).toBe(35);
    expect(s.latest?.month).toBe("2026-10");
  });
});
