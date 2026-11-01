import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import {
  ApplyYearPlanResult,
  PriceTrend,
  RescoreYearPlan,
  YearPlanOption,
  YearPlanReview,
  YearPlanSlot,
} from "@harvest/contracts";
import pool from "../../../../../data/research/rotation/crop-pool.json";
import {
  FIXTURE_FARM_ID,
  FIXTURE_FIELD_AREA_HA,
  applyResult,
  bestOverallV2,
  emptyReview,
  fourOptionReview,
  freshReview,
  greenManureFirst,
  lowestWaterV2,
  maizeTrend,
  occupiedReview,
  pendingReview,
  rescoredBestOverall,
  staleReview,
  unavailableReview,
} from "./fixtures";
import {
  columnOf,
  formatAreaHa,
  formatInr,
  formatInrBand,
  formatInrFull,
  formatInrRange,
  formatKgRange,
  monthColumns,
  stripPlacement,
} from "./format";
import {
  POOL_CROPS,
  CALENDAR_TEXT_MAX,
  FALLBACK_GREEN_MANURE,
  calendarWarnings,
  cropChoices,
  isLegume,
  noteLines,
  nitrogenCreditText,
  profitText,
  mergeServerReview,
  modelUnavailable,
  needsGeneration,
  replaceOption,
  rescoreBody,
  scenarioText,
  draftFromOption,
} from "./model";
import { ensureYearPlan, generateYearPlan, pollYearPlan } from "./yearPlanApi";
import { PlanCalendar, gapLabel, stripLabel, trackItems } from "./PlanCalendar";
import { SlotDetail } from "./OptionSheet";
import { BAND_EXPLANATION } from "./Estimates";
import { SlotEditor } from "./SlotEditor";
import { sparklineGeometry } from "../ui/Sparkline";
import { summarizeTrend } from "../ui/PriceTrendChart";

describe("year plan fixtures", () => {
  it("validate against the shared contracts", () => {
    for (const review of [occupiedReview, fourOptionReview, freshReview, pendingReview, unavailableReview, staleReview, emptyReview])
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

// ---------------------------------------------------------------------------------------------------------------------
// Round 2: full-rupee bands, the headline fallback order, gaps, green manure, a fourth row

/** Text nodes of rendered markup (tags, comments and attributes removed), for "what is drawn on the surface" checks. */
const textNodes = (html: string) =>
  html
    .replace(/<!--[^>]*-->/g, "")
    .split(/<[^>]+>/)
    .map((t) => t.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim())
    .filter(Boolean);

const calendarHtml = (review: YearPlanReview, appliedOptionIds: string[] = []) =>
  renderToString(() => (
    <PlanCalendar
      horizonFrom={review.scenario.horizon.from}
      todayIso="2026-11-01"
      options={review.options}
      appliedOptionIds={appliedOptionIds}
      onOpen={() => {}}
    />
  ));

describe("full-rupee formatting for profit bands", () => {
  it("uses Indian digit grouping and rounds to the nearest 100", () => {
    expect(formatInrFull(123400)).toBe("₹1,23,400");
    expect(formatInrFull(4149)).toBe("₹4,100");
    expect(formatInrFull(4150)).toBe("₹4,200");
    expect(formatInrFull(99950)).toBe("₹1,00,000");
    expect(formatInrFull(12345678)).toBe("₹1,23,45,700");
    expect(formatInrFull(950)).toBe("₹1,000");
    expect(formatInrFull(0)).toBe("₹0");
  });
  it("keeps the sign on losses, rounds them symmetrically and never prints a negative zero", () => {
    expect(formatInrFull(-3149)).toBe("−₹3,100");
    expect(formatInrFull(-3150)).toBe("−₹3,200");
    expect(formatInrFull(-1234567)).toBe("−₹12,34,600");
    expect(formatInrFull(-30)).toBe("₹0");
  });
  it("writes a band low to high in full figures, never as thousands, and says 'about' when both ends round alike", () => {
    expect(formatInrBand({ low: 4149, high: 9849 })).toBe("₹4,100 to ₹9,800");
    const crossing = formatInrBand({ low: -3149, high: 84040 });
    expect(crossing).toBe("−₹3,100 to ₹84,000");
    expect(crossing).not.toMatch(/thousand|lakh|crore/);
    expect(formatInrBand({ low: 9849, high: 4149 })).toBe("₹4,100 to ₹9,800");
    expect(formatInrBand({ low: 4120, high: 4140 })).toBe("about ₹4,100");
    expect(formatInrBand({ low: -5200, high: -5200 })).toBe("−₹5,200");
    expect(formatInrBand({ low: 123400, high: 184000 })).toBe("₹1,23,400 to ₹1,84,000");
  });
  it("trims the field area to two decimals without trailing zeros", () => {
    expect(formatAreaHa(0.16)).toBe("0.16");
    expect(formatAreaHa(1.2)).toBe("1.2");
    expect(formatAreaHa(2)).toBe("2");
    expect(formatAreaHa(10)).toBe("10");
    expect(formatAreaHa(0.1 + 0.2)).toBe("0.3");
    expect(formatAreaHa(1.234)).toBe("1.23");
    expect(formatAreaHa(0.001)).toBe("under 0.01");
  });
});

describe("profit headline: field total, then per hectare, then the old range", () => {
  const range = { low: 52_000, high: 142_000 };
  const est = (low: number, high: number) => ({ central: (low + high) / 2, likely: { low, high }, possible: { low: low - 5000, high: high + 5000 } });
  it("shows the field total's likely band with the area as the caption", () => {
    const h = profitText({ totalProfitForField: est(4149, 9849), fieldAreaHa: 0.16, totalProfitEstimate: est(25000, 61000), totalProfitPerHa: range });
    expect(h).toEqual({ value: "₹4,100 to ₹9,800", caption: "for your 0.16 ha", source: "field" });
  });
  it("falls back to the per-hectare estimate with the boundary hint when there is no field total", () => {
    const base = { totalProfitEstimate: est(25_000, 61_000), totalProfitPerHa: range, fieldAreaHa: null };
    for (const forField of [null, undefined]) {
      expect(profitText({ ...base, totalProfitForField: forField })).toEqual({
        value: "₹25,000 to ₹61,000",
        caption: "per hectare · draw the boundary for your field total",
        source: "per_ha",
      });
    }
  });
  it("falls back to the existing per-hectare range, then to 'not available'", () => {
    expect(profitText({ totalProfitPerHa: range })).toEqual({ value: "₹52 thousand to ₹1.4 lakh", caption: "profit per ha", source: "range" });
    expect(profitText({ totalProfitPerHa: null }).source).toBe("none");
    expect(profitText({}).value).toBe("Profit not available");
  });
  it("matches the old three-option fixture exactly (no round-2 fields) and the new field headline", () => {
    expect(occupiedReview.options.map((o) => profitText(o).value)).toEqual([
      "₹52 thousand to ₹1.4 lakh",
      "₹45 thousand to ₹1.3 lakh",
      "₹26 to 80 thousand",
    ]);
    expect(occupiedReview.options.every((o) => profitText(o).source === "range")).toBe(true);
    const h = profitText(bestOverallV2);
    expect(h.source).toBe("field");
    expect(h.caption).toBe(`for your ${formatAreaHa(FIXTURE_FIELD_AREA_HA)} ha`);
    expect(h.value).toBe(formatInrBand(bestOverallV2.totalProfitForField!.likely));
    expect(h.value).toMatch(/^₹[\d,]+ to ₹[\d,]+$/);
  });
});

describe("round 2 fixtures keep the estimate contract", () => {
  it("orders possible.low <= likely.low <= central <= likely.high <= possible.high everywhere and ties the field total to the area", () => {
    for (const option of fourOptionReview.options) {
      const estimates = [option.totalProfitEstimate, option.totalRevenueEstimate, ...option.slots.flatMap((s) => [s.profitEstimate, s.revenueEstimate])];
      for (const e of estimates) {
        if (!e) continue;
        expect(e.possible.low).toBeLessThanOrEqual(e.likely.low);
        expect(e.likely.low).toBeLessThanOrEqual(e.central);
        expect(e.central).toBeLessThanOrEqual(e.likely.high);
        expect(e.likely.high).toBeLessThanOrEqual(e.possible.high);
      }
      expect(option.fieldAreaHa).toBe(0.16);
      expect(Math.abs(option.totalProfitForField!.central - option.totalProfitEstimate!.central * 0.16)).toBeLessThanOrEqual(100);
    }
  });
  it("has four options, exactly one green manure slot, gaps with dated reasons, and a deterministic fourth", () => {
    expect(fourOptionReview.options.map((o) => o.label)).toEqual(["Best overall", "Soil enrichment", "Lowest water", "Green manure first"]);
    const manures = fourOptionReview.options.flatMap((o) => o.slots).filter((s) => s.kind === "green_manure");
    expect(manures).toHaveLength(1);
    expect(manures[0]).toMatchObject({ revenuePerHa: { low: 0, high: 0 }, nitrogenCreditKgPerHa: { low: 60, high: 80 }, price: null });
    expect(greenManureFirst.origin).toBe("deterministic");
    expect(bestOverallV2.gaps![0]!.reason).toMatch(/19 Apr and 19 May/);
    expect(lowestWaterV2.gaps).toEqual([]);
  });
});

describe("calendar surface", () => {
  const html = calendarHtml(fourOptionReview);
  it("draws a fourth row", () => {
    expect(html.match(/class="yp-cal-row"/g)).toHaveLength(4);
    expect(html).toContain("Green manure first");
  });
  it("shows the field profit headline and its caption on each row, not the per-hectare range", () => {
    const nodes = textNodes(html);
    for (const option of fourOptionReview.options) {
      expect(nodes).toContain(formatInrBand(option.totalProfitForField!.likely));
    }
    expect(nodes.filter((t) => t === "for your 0.16 ha")).toHaveLength(4);
    expect(nodes.join(" ")).not.toContain("profit per ha");
  });
  it("marks model options with the AI spark and deterministic options with a Calculated chip", () => {
    expect(html.match(/aria-label="AI used: Choosing your three year plans"/g)).toHaveLength(3);
    const nodes = textNodes(html);
    expect(nodes.filter((t) => t === "Calculated")).toHaveLength(1);
    const lastRow = html.slice(html.lastIndexOf('class="yp-cal-row"'));
    expect(lastRow).toContain("Calculated");
    expect(lastRow).not.toContain("AI used");
  });
  it("does not nest buttons: the head is a div with one stretched button and the spark is its sibling", () => {
    const row = html.slice(html.indexOf('class="yp-cal-row"'), html.indexOf('class="yp-track"'));
    expect(row).toContain('class="yp-row-head"');
    expect(row.match(/<button/g)).toHaveLength(2); // the open button and the spark
    expect(row).toContain("Best overall, score 78 out of 100, ");
  });
  it("draws a Field rests strip for each gap, with the reason in its accessible name but not on the surface", () => {
    const gaps = fourOptionReview.options.flatMap((o) => o.gaps ?? []);
    expect(gaps).toHaveLength(3);
    expect(html.match(/class="yp-gap[ "]/g)).toHaveLength(3);
    for (const gap of gaps) {
      expect(html).toContain(`aria-label="${gapLabel(gap).replace(/'/g, "&#39;")}"`);
      expect(textNodes(html).join(" ")).not.toContain(gap.reason);
    }
    expect(gapLabel(gaps[0]!)).toBe(
      "Field rests 19 Apr to 19 May, 31 days. No sourced sowing window for a pool crop between 19 Apr and 19 May on this field; the next windows open 20 May (kharif).",
    );
    expect(textNodes(html).filter((t) => t === "Field rests").length).toBeGreaterThanOrEqual(3);
  });
  it("starts every strip's accessible name with the text drawn on it (WCAG 2.5.3), then adds the full dates", () => {
    const slots = fourOptionReview.options.flatMap((o) => o.slots);
    expect(stripLabel(slots.find((s) => s.slotId === "a-maize")!)).toBe(
      "Maize, 1 Dec to 8 Apr. Sow 1 Dec 2026, harvest by 8 Apr 2027. Open details",
    );
    expect(stripLabel(slots.find((s) => s.fixed)!)).toBe("Paddy, growing now. Harvest 10 to 18 Nov 2026. Open details");
    expect(stripLabel({ ...slots.find((s) => s.slotId === "a-maize")!, price: null })).toContain("harvest by 8 Apr 2027, no price series yet. Open details");
    const manure = slots.find((s) => s.kind === "green_manure")!;
    expect(stripLabel({ ...manure, nitrogenCreditKgPerHa: null })).toBe(
      "Green manure, Cowpea, 8 Jan to 8 Mar. Sow 8 Jan 2027, ploughed in by 8 Mar 2027. Open details",
    );
    // Every drawn strip text is a prefix of its label once punctuation is dropped.
    const html = calendarHtml(fourOptionReview);
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const strips = [...html.matchAll(/<button[^>]*class="yp-strip[^"]*"[^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/button>/g)];
    expect(strips).toHaveLength(fourOptionReview.options.reduce((n, o) => n + o.slots.length, 0));
    for (const m of strips) {
      const drawn = norm(textNodes(m[2]!).join(" "));
      expect(drawn.length).toBeGreaterThan(0);
      expect(norm(m[1]!.replace(/&#39;/g, "'")).startsWith(drawn)).toBe(true);
    }
  });
  it("puts crops and gaps in calendar order so Tab follows the timeline", () => {
    expect(trackItems(bestOverallV2).map((i) => (i.kind === "slot" ? i.slot.cropId : "gap"))).toEqual(["paddy", "maize", "gap", "green-gram"]);
    expect(trackItems(lowestWaterV2).map((i) => i.kind)).toEqual(["slot", "slot"]);
  });
  it("draws the green manure strip with its label, the crop name and the nitrogen credit", () => {
    const row = html.slice(html.lastIndexOf('class="yp-cal-row"'));
    expect(row).toContain("is-green-manure");
    const nodes = textNodes(row);
    expect(nodes).toContain("Green manure · Cowpea");
    expect(nodes).toContain("+N 60 to 80 kg/ha");
    expect(row).toContain("Green manure, Cowpea, +N 60 to 80 kg/ha. Sow 8 Jan 2027, ploughed in by 8 Mar 2027. Open details");
    // no harvest band on a crop that is ploughed in
    expect(row.slice(row.indexOf("is-green-manure"), row.indexOf("is-green-manure") + 400)).not.toContain("yp-strip-harvest");
    expect(html.match(/is-green-manure/g)).toHaveLength(2); // the strip and the legend swatch
  });
  it("lists Green manure and Field rests in the legend", () => {
    const legend = textNodes(html.slice(html.indexOf('class="yp-legend"')));
    expect(legend).toEqual(expect.arrayContaining(["Growing now", "Planned crop", "Legume", "Green manure", "Field rests", "Harvest window"]));
  });
  it("shows the growing crop's two short lines and never draws a sentence longer than 90 characters", () => {
    const nodes = textNodes(html);
    expect(nodes).toContain("Harvest expected 10 Nov to 18 Nov (estimated from the sowing date)");
    expect(nodes).toContain("Next crop from 1 Dec");
    expect(nodes).toContain("Next crop from 8 Jan");
    // Soil enrichment still carries the old long warning; it is counted, not drawn.
    expect(nodes).toContain("1 note in the details");
    for (const node of nodes) expect(node.length).toBeLessThanOrEqual(CALENDAR_TEXT_MAX);
  });
  it("keeps the old three-option review rendering with the per-hectare range and no round-2 marks", () => {
    const old = calendarHtml(occupiedReview);
    expect(old.match(/class="yp-cal-row"/g)).toHaveLength(3);
    expect(old).not.toMatch(/class="yp-gap[ "]/);
    expect(textNodes(old).filter((t) => t === "profit per ha")).toHaveLength(3);
    expect(textNodes(old)).toContain("₹52 thousand to ₹1.4 lakh");
  });
});

describe("short lines and warnings for the calendar", () => {
  it("splits the growing crop's note on a line break and drops anything over 90 characters", () => {
    expect(noteLines("Harvest expected 13 Feb to 15 Mar (estimated from the sowing date)\nNext crop from 25 Mar")).toEqual([
      "Harvest expected 13 Feb to 15 Mar (estimated from the sowing date)",
      "Next crop from 25 Mar",
    ]);
    expect(noteLines(null)).toEqual([]);
    expect(noteLines("x".repeat(91))).toEqual([]);
    expect(noteLines("Harvest expected soon. Next crop from 25 Mar.")).toEqual(["Harvest expected soon", "Next crop from 25 Mar"]);
    expect(noteLines("a\nb\nc")).toEqual(["a", "b"]);
  });
  it("counts warnings that do not fit instead of drawing them", () => {
    const long = "w".repeat(CALENDAR_TEXT_MAX + 1);
    expect(calendarWarnings(["Sunflower: outside the district sowing window", long, long])).toEqual({
      short: ["Sunflower: outside the district sowing window"],
      hidden: 2,
    });
  });
  it("writes the nitrogen credit as a range, a single value, or nothing", () => {
    expect(nitrogenCreditText({ low: 60, high: 80 })).toBe("+N 60 to 80 kg/ha");
    expect(nitrogenCreditText({ low: 70, high: 70 })).toBe("+N 70 kg/ha");
    expect(nitrogenCreditText(null)).toBeNull();
  });
});

describe("editing with a green manure", () => {
  const editorHtml = (review: YearPlanReview, optionIndex: number) =>
    renderToString(() => (
      <SlotEditor
        option={review.options[optionIndex]!}
        horizon={review.scenario.horizon}
        choices={cropChoices(review, undefined)}
        busy={false}
        error=""
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    ));
  it("offers a Green manure group with the ids the review uses, and keeps them out of 'Other crops'", () => {
    const choices = cropChoices(fourOptionReview, undefined);
    expect(choices.filter((c) => c.role === "green_manure").map((c) => c.cropId)).toEqual(["gm-cowpea"]);
    expect(choices.filter((c) => c.role === "other")).toEqual([]);
    expect(choices.find((c) => c.cropId === "gm-cowpea")!.products).toEqual([{ productId: "gm-cowpea", name: "Cowpea (green manure)" }]);
    const html = editorHtml(fourOptionReview, 0);
    expect(html).toMatch(/<optgroup[^>]*label="Green manure"/);
    expect(html).toContain("+ Add green manure");
  });
  it("falls back to dhaincha, sunn hemp and cowpea when the review has no green manure slot", () => {
    const choices = cropChoices(occupiedReview, undefined).filter((c) => c.role === "green_manure");
    expect(choices.map((c) => [c.cropId, c.name])).toEqual([
      ["gm-cowpea", "Cowpea (green manure)"],
      ["gm-dhaincha", "Dhaincha"],
      ["gm-sunn-hemp", "Sunn hemp"],
    ]);
    expect(FALLBACK_GREEN_MANURE.map((g) => g.cropId).sort()).toEqual(choices.map((c) => c.cropId));
    const html = editorHtml(occupiedReview, 0);
    for (const name of ["Dhaincha", "Sunn hemp", "Cowpea (green manure)"]) expect(html).toContain(name);
  });
  it("sorts the green manure group after the feeders and before 'other'", () => {
    const order = cropChoices(fourOptionReview, [{ cropId: "wheat", name: "Wheat", products: [] }]).map((c) => c.role);
    const rank = ["nitrogen_fixer", "light_feeder", "moderate_feeder", "heavy_feeder", "green_manure", "other"];
    expect(order.map((r) => rank.indexOf(r))).toEqual([...order.map((r) => rank.indexOf(r))].sort((a, b) => a - b));
  });
  it("submits a green manure with kind and productId equal to the crop id; ordinary rows send neither", () => {
    const drafts = draftFromOption(greenManureFirst);
    const gm = drafts.find((d) => d.cropId === "gm-cowpea")!;
    expect(gm.kind).toBe("green_manure");
    const swapped = drafts.map((d) => (d.cropId === "gm-cowpea" ? { ...d, cropId: "gm-dhaincha", productId: "gm-dhaincha", sowing: "2027-01-20" } : d));
    const body = rescoreBody(fourOptionReview.reviewId!, greenManureFirst.optionId, swapped);
    expect(() => RescoreYearPlan.parse(body)).not.toThrow();
    const sent = body.slots.find((s) => s.cropId === "gm-dhaincha")!;
    expect(sent).toMatchObject({ kind: "green_manure", productId: "gm-dhaincha", sowing: "2027-01-20" });
    expect(sent.slotId).toBeUndefined(); // a changed crop is a new slot
    const inserted = rescoreBody(fourOptionReview.reviewId!, "opt-best-overall", [
      ...draftFromOption(bestOverallV2),
      { key: "added-1", fixed: false, cropId: "gm-sunn-hemp", productId: "gm-sunn-hemp", kind: "green_manure", sowing: "2027-05-01" },
    ]);
    expect(() => RescoreYearPlan.parse(inserted)).not.toThrow();
    expect(inserted.slots.filter((s) => s.kind === "green_manure").map((s) => [s.cropId, s.productId])).toEqual([["gm-sunn-hemp", "gm-sunn-hemp"]]);
    expect(inserted.slots.filter((s) => s.kind !== "green_manure").every((s) => !("kind" in s))).toBe(true);
  });
});

describe("detail sheet: profit as central, likely and possible", () => {
  const detail = (slot: YearPlanSlot, areaHa: number | null | undefined = 0.16) =>
    renderToString(() => <SlotDetail slot={slot} areaHa={areaHa} trend={undefined} />);
  const maize = bestOverallV2.slots.find((s) => s.slotId === "a-maize")!;
  it("keeps the yield, price, cost and profit rows with their basis lines", () => {
    const html = detail(maize);
    const dts = [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1]);
    expect(dts).toContain("Yield");
    expect(dts).toContain("Price at harvest");
    expect(dts).toContain("Cost");
    expect(dts).toContain("Profit");
    const nodes = textNodes(html);
    expect(nodes).toContain("₹21 to ₹25 per kg");
    expect(nodes.some((t) => t.startsWith("Recent district yields"))).toBe(true);
    expect(nodes.some((t) => t.startsWith("Paid-out cost plus family labour"))).toBe(true);
  });
  it("shows central, likely and possible per hectare and for the field, with the one-line key", () => {
    const html = detail(maize);
    const nodes = textNodes(html);
    const e = maize.profitEstimate!;
    const f = maize.profitForField!;
    expect(nodes).toEqual(expect.arrayContaining(["Per hectare", "For your 0.16 ha", "Central", "Likely", "Possible"]));
    expect(nodes.filter((t) => t === "Likely")).toHaveLength(2);
    for (const value of [formatInrFull(e.central), formatInrBand(e.likely), formatInrBand(e.possible), formatInrFull(f.central), formatInrBand(f.likely), formatInrBand(f.possible)])
      expect(nodes).toContain(value);
    expect(BAND_EXPLANATION).toBe("Likely = middle half of the simulated outcomes; possible = 10th to 90th percentile");
    expect(nodes).toContain(BAND_EXPLANATION);
  });
  it("shows only the per-hectare block when the field total is missing", () => {
    const nodes = textNodes(detail({ ...maize, profitForField: null }, null));
    expect(nodes).toContain("Per hectare");
    expect(nodes.some((t) => t.startsWith("For your"))).toBe(false);
  });
  it("falls back to the per-hectare range for a slot without estimates", () => {
    const old = occupiedReview.options[0]!.slots.find((s) => s.slotId === "a-maize")!;
    const nodes = textNodes(detail(old, undefined));
    expect(nodes).toContain(`${formatInrRange(old.profitPerHa!)} per ha`);
    expect(nodes).not.toContain("Central");
    expect(nodes).not.toContain(BAND_EXPLANATION);
  });
  it("describes a green manure without a yield or price row, and shows its loss as a negative value", () => {
    const gm = greenManureFirst.slots.find((s) => s.kind === "green_manure")!;
    const html = detail(gm);
    const dts = [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1]);
    expect(dts).toEqual(["Green manure", "Cost", "Profit"]);
    const nodes = textNodes(html);
    expect(nodes).toContain("+N 60 to 80 kg/ha for the next crop");
    expect(nodes).toContain("−₹5,200");
    expect(nodes.some((t) => t.includes("Not harvested or sold"))).toBe(true);
  });
  it("lists the long fixed-crop sentence among the uncertainties, not as the slot note", () => {
    const paddy = bestOverallV2.slots[0]!;
    const html = detail(paddy);
    expect(html).toContain("harvest date not recorded");
    expect(paddy.transitionNote).toContain("\n");
    expect(paddy.transitionNote!.split("\n").every((l) => l.length <= CALENDAR_TEXT_MAX)).toBe(true);
  });
});
