import { describe, expect, it, vi } from "vitest";
import { renderToString } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { SeasonPreview as schema } from "@harvest/contracts";
import { FIXTURE_FARM_ID, seasonPreviewEmptyFixture, seasonPreviewFixture } from "./fixtures";
import { SeasonPreviewBody } from "./SeasonPreviewSheet";
import { loadSeasonPreview, seasonPreviewPath } from "./seasonPreviewApi";
import { addedSeasons, defaultYear, groupByYear, pricePathModel, rainBars, seasonTitle, stageStrip, yearHints } from "./seasonPreviewModel";

// Planner renders against a fake workspace (synthetic seasons); FarmPage pieces are stubbed (map and dialogs not needed).
const ws = vi.hoisted(() => ({ plans: [] as unknown[] }));
vi.mock("../state", () => ({
  today: () => "2026-11-01",
  dateLabel: (d: string) => d,
  useWorkspace: () => ({
    farm: () => ({ id: "11111111-1111-4111-8111-111111111111", name: "Hassan field", location: { districtName: "Hassan" }, areaHectares: 1.2, facts: {} }),
    workspace: Object.assign(() => ({ rotationPlans: ws.plans, previousHarvest: { status: "none" } }), { loading: false }),
    crops: () => [],
    cropName: (id: string) => ({ ragi: "Finger millet", "pigeon-pea": "Pigeon pea", "sunn-hemp": "Sunn hemp" })[id] ?? id,
    setNotice: () => undefined,
    saving: () => false,
    saveWorkspace: async () => undefined,
  }),
}));
vi.mock("../FarmPage", () => ({ HistoryDialog: () => null, PageHeading: (p: { title: string }) => <h1>{p.title}</h1> }));
const { Planner } = await import("../Planner");
/** SSR output without the hydration comment markers between text nodes. */
const strip = (html: string) => html.replace(/<!--[^>]*-->/g, "");
const renderPlanner = () => strip(renderToString(() => (<Router url="/planner"><Route path="/planner" component={Planner} /></Router>)));
const PIGEON = { id: "rot-pigeon", year: 2027, season: "Kharif", cropId: "pigeon-pea", cropName: "Pigeon pea", productId: "pigeon-pea-whole", plannedSowingDate: "2027-05-16", plannedHarvestDate: "2027-12-10" };

describe("Planner saved seasons (ROUND3_SPEC 2)", () => {
  it("opens on the year of the earliest upcoming saved season: a season only in 2027 renders on first paint and the count reads 1", () => {
    ws.plans = [PIGEON];
    const html = renderPlanner();
    expect(html).toMatch(/<strong[^>]*>2027<\/strong>/);
    expect(html).toContain("Pigeon pea");
    expect(html).toContain("1 PLANNED");
    expect(html).toContain("Preview season: Pigeon pea");
    expect(html).not.toContain("Your next chapter is unwritten");
  });
  it("lists every season across years grouped by year, shows cross-year hints, kind and companion names", () => {
    ws.plans = [
      PIGEON,
      { id: "gm", year: 2026, season: "Rabi", cropId: "sunn-hemp", cropName: "Sunn hemp", plannedSowingDate: "2026-11-20", kind: "green_manure" },
      { id: "ic", year: 2028, season: "Kharif", cropId: "ragi", cropName: "Finger millet", plannedSowingDate: "2028-06-20", kind: "intercrop", companion: { cropId: "pigeon-pea", cropName: "Pigeon pea", rowRatio: "4:1" } },
    ];
    const html = renderPlanner();
    expect(html).toMatch(/<strong[^>]*>2026<\/strong>/); // the green manure is the earliest upcoming season
    expect(html).toContain("3 PLANNED");
    expect(html).toContain("1 more in 2027 ›");
    expect(html).toContain("1 more in 2028 ›");
    expect(html).toContain("Finger millet + pigeon pea (4:1)");
    expect(html).toContain("Green manure");
    expect(html.indexOf(">2026</h3>")).toBeLessThan(html.indexOf(">2027</h3>"));
    expect(html.indexOf(">2027</h3>")).toBeLessThan(html.indexOf(">2028</h3>"));
  });
  it("model: default year, hints, grouping, added seasons, titles", () => {
    expect(defaultYear([], "2026-11-01")).toBe(2026);
    expect(defaultYear([{ ...PIGEON, plannedSowingDate: "2026-06-01", year: 2026 }], "2026-11-01")).toBe(2026);
    expect(defaultYear([PIGEON], "2026-11-01")).toBe(2027);
    expect(yearHints([PIGEON], 2026)).toEqual([{ year: 2027, count: 1, later: true }]);
    expect(groupByYear([PIGEON, { ...PIGEON, id: "b", year: 2026, plannedSowingDate: "2026-12-01" }]).map((g) => g.year)).toEqual([2026, 2027]);
    expect(addedSeasons(new Set(["x"]), [PIGEON, { ...PIGEON, id: "x" }]).map((p) => p.id)).toEqual(["rot-pigeon"]);
    expect(seasonTitle({ ...PIGEON, kind: "intercrop", cropName: "Finger millet", companion: { cropId: "pigeon-pea", rowRatio: "4:1" } }, () => "Pigeon pea")).toBe("Finger millet + pigeon pea (4:1)");
  });
});

describe("SeasonPreviewSheet sections (ROUND3_SPEC 7.7)", () => {
  it("fixtures follow the contract", () => {
    expect(schema.parse(seasonPreviewFixture())).toBeTruthy();
    expect(schema.parse(seasonPreviewEmptyFixture())).toBeTruthy();
  });
  it("renders every section from the full fixture, in order", () => {
    const html = strip(renderToString(() => <SeasonPreviewBody preview={seasonPreviewFixture()} />));
    const order = ["Sow 16 May 2027", "Planned season · calculated reference", "Stages", "Typical weather by month", "Price through the season", "Yield and profit for this field", "Soil checks", "Steps", "Limits of this preview"];
    let at = -1;
    for (const text of order) { const i = html.indexOf(text); expect(i, text).toBeGreaterThan(at); at = i; }
    expect(html).toContain("Establishment");
    expect(html).toContain("64 mm");
    expect(html).toContain("31° / 20°");
    expect(html).toContain("Water fit 62%");
    expect(html).toContain("Harvest week likely ₹66 to ₹75/kg");
    expect(html).toContain("Price now ₹72.5/kg");
    expect(html).toContain("600 kg to 1.1 t");
    expect(html).toContain("₹9,600 to ₹26,400");
    expect(html).toContain("State yields");
    expect(html).toContain("Score 64");
    expect(html).toContain("pH: OK");
    expect(html).toContain("Thin to one plant per hill");
    expect(html).toContain("Source: Synthetic publisher");
    expect(html).toContain("ui-sparkline-mark"); // the harvest week mark
  });
  it("shows the companion block for an intercrop", () => {
    const html = strip(renderToString(() => (
      <SeasonPreviewBody preview={seasonPreviewFixture({ kind: "intercrop", companion: { systemId: "s", cropId: "pigeon-pea", productId: "pigeon-pea-whole", cropName: "Pigeon pea", productName: "Whole", rowRatio: "4:1", arrangement: "row", yieldShare: { main: { low: 0.8, high: 0.9 }, companion: { low: 0.2, high: 0.3 } }, shareBasis: "assumed", yieldKgPerHa: null, yieldBasis: null, price: null, nitrogenCreditKgPerHa: null, source: null } })} />
    )));
    expect(html).toContain("With Pigeon pea (Whole), rows 4:1");
    expect(html).toContain("assumed yield shares");
  });
  it("renders each section's empty state", () => {
    const html = strip(renderToString(() => <SeasonPreviewBody preview={seasonPreviewEmptyFixture()} />));
    expect(html).toContain("No sourced stage calendar for this crop");
    expect(html).toContain("Unavailable: the farm has no map point");
    expect(html).toContain("Water fit appears once the year plan has been generated.");
    expect(html).toContain("A green manure is ploughed in: no product and no price.");
    expect(html).toContain("Generate the year plan to see yield, profit and score here.");
    expect(html).toContain("No confirmed soil report for this field.");
    expect(html).toContain("No dated steps for this season");
    expect(html).toContain("No limitations were reported.");
    expect(html).not.toContain("ui-sparkline");
  });
  it("model: stage strip with today's marker only inside the season; rain bars; harvest index on the price path", () => {
    const p = seasonPreviewFixture();
    expect(stageStrip(p.timeline, p.harvest, "2026-11-01").todayPct).toBeNull();
    const inside = stageStrip(p.timeline, p.harvest, "2027-08-01");
    expect(inside.todayPct).toBeGreaterThan(0);
    expect(inside.segments[0]).toMatchObject({ leftPct: 0, name: "Establishment" });
    expect(rainBars(p.weather.months).map((b) => b.heightPct)).toEqual([30, 71, 100]);
    const path = pricePathModel(p.price, p.harvest);
    expect(path.values[5]).toBeNull();
    expect(p.price!.path[path.harvestIndex!]!.weekStart <= "2027-11-30").toBe(true);
    expect(p.price!.path[path.harvestIndex! + 1]!.weekStart > "2027-11-30").toBe(true);
  });
  it("api: builds the query and rejects another farm's preview", async () => {
    expect(seasonPreviewPath(FIXTURE_FARM_ID, { planId: "rot-pigeon" })).toBe(`/api/v1/farms/${FIXTURE_FARM_ID}/season-preview?planId=rot-pigeon`);
    expect(seasonPreviewPath(FIXTURE_FARM_ID, { cropId: "maize", sowing: "2027-06-10" })).toContain("cropId=maize&sowing=2027-06-10");
    const env = (data: unknown) => new Response(JSON.stringify({ requestId: "t", mode: "synthetic", asOf: "2026-11-01T00:00:00Z", data, warnings: [], error: null }), { status: 200, headers: { "content-type": "application/json" } });
    const ok = await loadSeasonPreview(FIXTURE_FARM_ID, { planId: "rot-pigeon" }, (async () => env(seasonPreviewFixture())) as unknown as typeof fetch);
    expect(ok.planId).toBe("rot-pigeon");
    await expect(loadSeasonPreview("22222222-2222-4222-8222-222222222222", { planId: "rot-pigeon" }, (async () => env(seasonPreviewFixture())) as unknown as typeof fetch)).rejects.toThrow("another farm");
  });
});
