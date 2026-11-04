import { expect, test, type Page } from "@playwright/test";
import type { FarmWorkspace } from "@harvest/contracts";
// Read-only imports of the year-plan fixtures (synthetic) for the apply flow, and the season preview fixture.
import { FIXTURE_FARM_ID, applyResult, occupiedReview, workspaceBefore } from "../src/workspace/year/fixtures";
import { seasonPreviewFixture } from "../src/workspace/season/fixtures";

// Every API route is intercepted with synthetic fixtures; nothing reaches a provider or alters stored farms.
const env = (data: unknown) => ({ requestId: "planner", mode: "synthetic", asOf: "2026-11-01T00:00:00Z", data, warnings: [], error: null });
const product = (productId: string, name: string) => ({ productId, name, productBasis: "grain" });
const crops = [
  { cropId: "paddy", name: "Paddy", products: [product("paddy-grain", "Grain")] },
  { cropId: "maize", name: "Maize", products: [product("maize-grain", "Grain")] },
  { cropId: "green-gram", name: "Green gram", products: [product("green-gram-whole", "Whole")] },
  { cropId: "pigeon-pea", name: "Pigeon pea", products: [product("pigeon-pea-whole", "Whole")] },
];
const PIGEON = { id: "rot-pigeon", year: 2027, season: "Kharif", cropId: "pigeon-pea", cropName: "Pigeon pea", productId: "pigeon-pea-whole", productName: "Whole", plannedSowingDate: "2027-05-16", plannedHarvestDate: "2027-12-10" };

async function mock(page: Page, opts: { rotationPlans?: unknown[]; cycles?: FarmWorkspace["cycles"] } = {}) {
  let workspace: FarmWorkspace = structuredClone(workspaceBefore);
  if (opts.rotationPlans) workspace = { ...workspace, rotationPlans: opts.rotationPlans as FarmWorkspace["rotationPlans"] };
  if (opts.cycles) workspace = {...workspace, cycles: opts.cycles};
  let review = occupiedReview;
  const previews: URLSearchParams[] = [];
  await page.clock.setFixedTime(new Date("2026-11-01T10:00:00+05:30"));
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/command-center")) return; // left pending: the Plan tab does not depend on it
    if (path.endsWith("/season-preview")) {
      previews.push(url.searchParams);
      return route.fulfill({ json: env(seasonPreviewFixture({ farmId: FIXTURE_FARM_ID, planId: url.searchParams.get("planId") })) });
    }
    if (path.endsWith("/year-plan/apply")) {
      const result = applyResult(review, route.request().postDataJSON().optionId, workspace);
      workspace = result.workspace;
      review = result.review;
      return route.fulfill({ json: env(result) });
    }
    if (path.endsWith("/year-plan")) return route.fulfill({ json: env(review) });
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "qa" }
        : path === "/api/v1/farms"
          ? { farms: [{ id: FIXTURE_FARM_ID, name: "Hassan field", location: { stateCode: "IN-KA", districtId: "IN-KA-hassan", districtName: "Hassan", precision: "district" }, areaHectares: 0.16, facts: {} }] }
          : path.endsWith("/workspace")
            ? workspace
            : path === "/api/v1/crops"
              ? { crops }
              : path === "/api/v1/ai/activity"
                ? { invocations: [] }
                : path === "/api/v1/districts"
                  ? { areas: [], districts: [], districtListAvailable: false, note: null }
                  : {};
    return route.fulfill({ json: env(data) });
  });
  return { previews };
}

test.use({ viewport: { width: 390, height: 844 } });

test("a season saved only in 2027 shows on first paint with the count 1, and Preview opens the season sheet", async ({ page }) => {
  const calls = await mock(page, { rotationPlans: [PIGEON], cycles: [] });
  await page.goto("/planner");
  const board = page.locator(".rotation-board");
  await expect(board.locator(".year-switch strong")).toHaveText("2027");
  await expect(board.getByRole("button", { name: "Preview season: Pigeon pea" })).toBeVisible();
  await expect(page.locator(".season-list .subtle-caption")).toHaveText("1 PLANNED");
  await page.locator(".season-list").getByRole("button", { name: "Preview season: Pigeon pea" }).click();
  const sheet = page.getByRole("dialog", { name: "Pigeon pea" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Planned season · calculated reference");
  for (const heading of ["Stages", "Typical weather by month", "Price through the season", "Yield and profit for this field", "Soil checks", "Steps", "Limits of this preview"])
    await expect(sheet.getByRole("heading", { name: heading })).toBeVisible();
  await expect(sheet).toContainText("Harvest week likely ₹66 to ₹75/kg");
  expect(calls.previews.map((q) => q.get("planId"))).toEqual(["rot-pigeon"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("after Use this plan the board moves to the first added season's year and both lists show the season", async ({ page }) => {
  await mock(page);
  await page.goto("/planner");
  await page.locator(".yp-cal-row").first().locator(".yp-row-head").click();
  await page.getByRole("dialog", { name: "Best overall" }).getByRole("button", { name: "Use this plan" }).click();
  await page.getByRole("dialog", { name: "Add these seasons?" }).getByRole("button", { name: /^Add \d+ seasons?$/ }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".season-list")).toContainText("Maize");
  await expect(page.locator(".rotation-board")).toContainText("Maize");
  const firstYear = await page.locator(".season-list .season-year").first().textContent();
  await expect(page.locator(".rotation-board .year-switch strong")).toHaveText(firstYear!.trim());
});


test('rotation starts with the growing crop and keeps future plans accessible', async ({page}) => {
  await mock(page, {rotationPlans: [PIGEON]});
  await page.goto('/planner');
  const board = page.locator('.rotation-board');
  await expect(board.locator('.year-switch strong')).toHaveText('2026');
  await expect(board.getByTestId('rotation-recorded-crop')).toContainText('Paddy');
  await expect(board.getByTestId('rotation-recorded-crop')).toContainText('Growing');
  await board.getByRole('button', {name: 'Next year'}).click();
  await expect(board.getByRole('button', {name: 'Preview season: Pigeon pea'})).toBeVisible();
  await expect(board.getByTestId('rotation-recorded-crop')).toContainText('Paddy');
});
