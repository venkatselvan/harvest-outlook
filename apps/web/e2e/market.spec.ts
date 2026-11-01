import { expect, test, type Page } from "@playwright/test";
import { MarketTimeline as marketSchema } from "@harvest/contracts";
import { marketFixture, FIXTURE_TODAY_INDEX } from "../src/workspace/market/fixtures";
import { formatInr, priceSummary } from "../src/workspace/market/model";

// UI-only route mocks: every /api/v1 request is answered here from the SYNTHETIC market fixture; no provider is called.
// Needs MarketView mounted in the Market tab (`?tab=harvest`), which the orchestrator wires in FarmCommandCenter.tsx.
const A = "11111111-1111-4111-8111-111111111111";
const asOf = "2026-11-01T04:30:00Z";
const env = (data: unknown, error: { code: string; message: string } | null = null) => ({ requestId: "market-test", mode: "synthetic", asOf, data, warnings: [], error });
const maizeCycle = { id: "maize-cycle", cropId: "maize", cropName: "Maize", productId: "maize-grain", productName: "Maize grain", sowingDate: "2026-09-15", establishmentDate: "2026-09-15", establishmentMethod: "direct_sowing", stage: "growing" };
const workspace = { farmId: A, version: 1, updatedAt: asOf, boundary: null, previousHarvest: { status: "none" }, cycles: [maizeCycle], rotationPlans: [] };
const quotes = { checkedAt: asOf, selectionBasis: "none", providerStatus: "unavailable", missingReason: "no_quote", status: "unavailable", requestLimit: 6, requestsMade: 0, products: [], limitations: [] };
const command = {
  farmId: A, asOf, workspace,
  focusedCrops: [{ cropId: "maize", displayName: "Maize", botanicalName: "Zea mays", productionType: "annual", establishmentMethods: ["direct_sowing"], products: [{ productId: "maize-grain", productName: "Maize grain", sourceCommodities: ["Maize"], mappingStatus: "verified" }], limitations: [] }],
  sources: [], currentCycles: [{ cycle: maizeCycle, careTasks: [], limitations: [] }], soil: { markers: { farmId: A, samples: [], limitations: [] }, fit: [] },
  weather: { kind: "forecast", status: "unavailable", reason: "fixture", issuedAt: null, source: "Fixture", days: [] }, currentQuotes: quotes, priorYearMarkets: [], limitations: [],
};

async function mock(page: Page) {
  const timelineUrls: string[] = [];
  const timeline = marketSchema.parse(marketFixture(A)); // the mock never serves a response the contract would reject
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/market-timeline")) {
      timelineUrls.push(url.search);
      return route.fulfill({ json: env(timeline) });
    }
    if (path.endsWith("/today") || path.startsWith("/api/v1/price-trend")) return route.fulfill({ status: 404, json: env(null, { code: "not_found", message: "not mocked" }) });
    const data =
      path === "/api/v1/session" ? { authenticated: true, csrfToken: "test" }
      : path === "/api/v1/farms" ? { farms: [{ id: A, name: "South field", areaHectares: 1.2, location: { stateCode: "IN-KA", districtId: "IN-KA-hassan", districtName: "Hassan", precision: "district" }, facts: {} }] }
      : path.endsWith("/workspace") ? workspace
      : path.endsWith("/command-center") ? command
      : path === "/api/v1/crops" ? { crops: [{ cropId: "maize", name: "Maize", products: [{ productId: "maize-grain", name: "Maize grain" }] }] }
      : path.endsWith("/monitoring") ? { farmId: A, checkedAt: asOf, weather: { status: "unavailable", reason: "fixture", issuedAt: null, attribution: "Fixture", point: null, days: [] }, market: { status: "unavailable", reason: "fixture", products: [] }, meta: { status: "unavailable", reason: "fixture", automatic: false } }
      : path.endsWith("/market-quotes") ? quotes
      : path.endsWith("/soil-markers") ? { farmId: A, samples: [], limitations: [] }
      : path.endsWith("/soil-reports") ? { reports: [] }
      : path === "/api/v1/ai/activity" ? { invocations: [] }
      : {};
    await route.fulfill({ json: env(data) });
  });
  return { timeline, timelineUrls };
}

const slider = (page: Page) => page.getByRole("slider", { name: "Move through the weeks" });
const card = (page: Page, kind: string) => page.locator(`[data-card="${kind}"]`);

test.use({ viewport: { width: 390, height: 844 } });

test("market timeline: chart present, slider opens at today and moves the three cards together", async ({ page }) => {
  const { timeline, timelineUrls } = await mock(page);
  await page.goto("/farm?tab=harvest");
  await expect(slider(page)).toBeVisible();
  expect(timelineUrls[0]).toBe("?productId=maize-grain&monthsBack=36&monthsAhead=12");
  await expect(page.getByRole("button", { name: "Maize grain" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("market-chart").locator('svg[role="img"]')).toBeVisible();
  await expect(page.getByTestId("market-chart").locator("svg")).toHaveAttribute("aria-label", /Maize grain mandi price by week/);

  // Today.
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "Week of 26 Oct 2026");
  await expect(slider(page)).toHaveValue(String(FIXTURE_TODAY_INDEX));
  const now = timeline.points[FIXTURE_TODAY_INDEX]!;
  await expect(page.getByTestId("market-price-value")).toHaveText(`${formatInr((now.price as { p50: number }).p50)}/kg`);
  await expect(card(page, "price")).toContainText("Observed");
  await expect(card(page, "weather")).toContainText("Observed");
  await expect(card(page, "events")).toContainText("Fall armyworm scouting window");
  await expect(page.getByRole("button", { name: "Back to today" })).toHaveCount(0);

  // One ArrowRight = one week: reference price and band, forecast weather, no events.
  await slider(page).focus();
  await slider(page).press("ArrowRight");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "Week of 2 Nov 2026");
  await expect(page.getByTestId("market-week")).toHaveText("Week of 2 Nov 2026");
  await expect(card(page, "price")).toContainText("Reference");
  await expect(page.getByTestId("market-price-band")).toHaveText(priceSummary(timeline.points[FIXTURE_TODAY_INDEX + 1]!).band);
  await expect(card(page, "weather")).toContainText("Forecast");
  await expect(card(page, "events")).toContainText("No alerts or price moves this week");
  await expect(page.locator(".market-cursor")).toHaveAttribute("data-index", String(FIXTURE_TODAY_INDEX + 1));

  // Back to today returns the thumb and keeps focus on the slider.
  await page.getByRole("button", { name: "Back to today" }).click();
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "Week of 26 Oct 2026");
  await expect(slider(page)).toBeFocused();

  // Overlay toggle draws that year's path as a dashed line.
  const toggle = page.getByRole("button", { name: "Show the 2025-26 price path on the chart" });
  await toggle.click();
  await expect(page.getByRole("button", { name: "Hide the 2025-26 price path on the chart" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('path.market-overlay[data-crop-year="2025-26"]')).toHaveCount(1);
  await expect(page.getByText("Past years whose monsoon rain was closest to this one; how prices moved then, not a forecast.")).toBeVisible();

  // Mobile: no horizontal page scroll at 390 px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
