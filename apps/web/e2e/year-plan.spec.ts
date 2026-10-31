import { expect, test, type Page } from "@playwright/test";
import type { YearPlanReview } from "@harvest/contracts";
import {
  FIXTURE_FARM_ID,
  applyResult,
  emptyReview,
  occupiedReview,
  pendingReview,
  priceTrendFixture,
  rescoredBestOverall,
  unavailableReview,
  workspaceBefore,
} from "../src/workspace/year/fixtures";

// Every API route is intercepted with synthetic fixtures; nothing reaches a provider or alters stored farms.
const env = (data: unknown) => ({ requestId: "year-plan", mode: "synthetic", asOf: "2026-11-01T00:00:00Z", data, warnings: [], error: null });
const notFound = { ...env(null), error: { code: "not_found", message: "Not found" } };
const product = (productId: string, name: string) => ({ productId, name, productBasis: "grain" });
const crops = [
  { cropId: "paddy", name: "Paddy", products: [product("paddy-grain", "Grain")] },
  { cropId: "maize", name: "Maize", products: [product("maize-grain", "Grain")] },
  { cropId: "sunflower", name: "Sunflower", products: [product("sunflower-seed", "Seed")] },
  { cropId: "green-gram", name: "Green gram", products: [product("green-gram-whole", "Whole")] },
  { cropId: "black-gram", name: "Black gram", products: [product("black-gram-whole", "Whole")] },
  { cropId: "chickpea", name: "Chickpea", products: [product("chickpea-whole", "Whole")] },
  { cropId: "ginger", name: "Ginger", products: [product("ginger-fresh", "Fresh"), product("ginger-dry", "Dry")] },
];

async function mock(page: Page, opts: { script?: YearPlanReview[]; missing?: boolean } = {}) {
  let script = [...(opts.script ?? [occupiedReview])];
  let last = script[0]!;
  let workspace = structuredClone(workspaceBefore);
  const calls = { gets: 0, posts: 0, rescores: [] as any[], applies: [] as any[], trends: [] as string[] };
  const nextReview = () => {
    last = script.length ? script.shift()! : last;
    return last;
  };
  await page.clock.setFixedTime(new Date("2026-11-01T10:00:00+05:30"));
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path.endsWith("/command-center")) return; // left pending: the Year plan tab does not depend on it
    if (opts.missing && (path.includes("/year-plan") || path === "/api/v1/price-trend"))
      return route.fulfill({ status: 404, json: notFound });
    if (path.endsWith("/year-plan/rescore")) {
      calls.rescores.push(route.request().postDataJSON());
      return route.fulfill({ json: env(rescoredBestOverall) });
    }
    if (path.endsWith("/year-plan/apply")) {
      const body = route.request().postDataJSON();
      calls.applies.push(body);
      const result = applyResult(last, body.optionId, workspace);
      workspace = result.workspace;
      script = [];
      last = result.review;
      return route.fulfill({ json: env(result) });
    }
    if (path.endsWith("/year-plan")) {
      if (method === "POST") calls.posts++;
      else calls.gets++;
      return route.fulfill({ json: env(nextReview()) });
    }
    if (path === "/api/v1/price-trend") {
      calls.trends.push(url.search);
      return route.fulfill({ json: env(priceTrendFixture(url.searchParams.get("productId") ?? "unknown")) });
    }
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "qa" }
        : path === "/api/v1/farms"
          ? {
              farms: [
                {
                  id: FIXTURE_FARM_ID,
                  name: "Hassan field",
                  location: { stateCode: "IN-KA", districtId: "IN-KA-hassan", districtName: "Hassan", precision: "district" },
                  areaHectares: 1.2,
                  facts: {},
                },
              ],
            }
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
  return calls;
}

test.use({ viewport: { width: 390, height: 844 } });

test("three options render with score rings and profit ranges", async ({ page }) => {
  await mock(page);
  await page.goto("/planner");
  const rows = page.locator(".yp-cal-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByText("Sep 2026 to Sep 2027 · Paddy growing until mid-Nov")).toBeVisible();
  const expected = [
    ["Best overall", "78", "₹52 thousand to ₹1.4 lakh"],
    ["Soil enrichment", "74", "₹45 thousand to ₹1.3 lakh"],
    ["Lowest water", "63", "₹26 to 80 thousand"],
  ];
  for (const [i, [label, score, profit]] of expected.entries()) {
    const head = rows.nth(i).locator(".yp-row-head");
    await expect(head).toContainText(label!);
    await expect(head.locator(".ui-score-ring")).toHaveAttribute("aria-label", `Score ${score} out of 100`);
    await expect(head).toContainText(profit!);
  }
  await expect(page.getByRole("button", { name: /^Paddy, growing now/ })).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Saved seasons" })).toBeVisible();
});

test("a strip opens the sheet with three reasons, four rows and the mocked price trend", async ({ page }) => {
  const calls = await mock(page);
  await page.goto("/planner");
  await page.getByRole("button", { name: /^Maize, sow 1 Dec 2026/ }).click();
  const sheet = page.getByRole("dialog", { name: "Best overall" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".yp-reasons li")).toHaveCount(3);
  await expect(sheet.locator(".yp-estimates dt")).toHaveText(["Yield", "Price at harvest", "Cost", "Profit"]);
  await expect(sheet.getByText("₹21 to ₹25 per kg")).toBeVisible();
  await expect(sheet.getByRole("img", { name: /Maize \(grain\) mandi price by month, Nov 2023 to Oct 2026/ })).toBeVisible();
  await expect(sheet.locator(".ui-sparkline-line")).toHaveAttribute("d", /^M /);
  expect(calls.trends[0]).toContain("productId=maize-grain");
  await expect(sheet.locator(".yp-bars li")).toHaveCount(5);
  await expect(sheet.locator(".yp-bars")).toContainText("weight 40");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("edit then re-score updates the row as Your version with warning chips, without a model call", async ({ page }) => {
  const calls = await mock(page);
  await page.goto("/planner");
  await page.locator(".yp-cal-row").first().locator(".yp-row-head").click();
  const sheet = page.getByRole("dialog", { name: "Best overall" });
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet.getByRole("combobox", { name: "Crop" }).first().selectOption("sunflower");
  await sheet.getByLabel("Sowing date").first().fill("2027-01-20");
  const postsBefore = calls.posts;
  await sheet.getByRole("button", { name: "Re-score plan" }).click();
  await expect.poll(() => calls.rescores.length).toBe(1);
  expect(calls.rescores[0].optionId).toBe("opt-best-overall");
  expect(calls.rescores[0].slots.map((s: { cropId: string }) => s.cropId)).toEqual(["paddy", "sunflower", "green-gram"]);
  const row = page.locator(".yp-cal-row").first();
  await expect(row.locator(".yp-row-head")).toContainText("Your version");
  await expect(row.locator(".yp-row-chips")).toContainText("Sunflower: outside the district sowing window");
  await expect(page.getByRole("dialog", { name: "Your version" })).toBeVisible();
  expect(calls.posts).toBe(postsBefore);
});

test("apply adds the seasons once; a second apply is a no-op", async ({ page }) => {
  const calls = await mock(page);
  await page.goto("/planner");
  await page.locator(".yp-cal-row").first().locator(".yp-row-head").click();
  await page.getByRole("dialog", { name: "Best overall" }).getByRole("button", { name: "Use this plan" }).click();
  const confirm = page.getByRole("dialog", { name: "Add these seasons?" });
  await expect(confirm.locator(".yp-apply-list li")).toHaveCount(2);
  await confirm.getByRole("button", { name: "Add 2 seasons" }).click();
  await expect(page.getByRole("dialog", { name: "Added to your saved seasons" })).toBeVisible();
  expect(calls.applies).toEqual([
    { reviewId: occupiedReview.reviewId, optionId: "opt-best-overall", slotIds: ["a-maize", "a-green-gram"], expectedWorkspaceVersion: 1 },
  ]);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".season-list")).toContainText("Maize");
  const row = page.locator(".yp-cal-row").first();
  await expect(row.locator(".yp-row-chips")).toContainText("In saved seasons");
  await row.locator(".yp-row-head").click();
  await expect(page.getByRole("dialog", { name: "Best overall" }).getByRole("button", { name: "Already in saved seasons" })).toBeDisabled();
  expect(calls.applies).toHaveLength(1);
});

test("pending then ready: the planning indicator names the model, then three options appear", async ({ page }) => {
  const calls = await mock(page, { script: [emptyReview, pendingReview, pendingReview, occupiedReview] });
  await page.goto("/planner");
  await expect(page.getByText("Planning…")).toBeVisible();
  await expect(page.getByText("Planning with muse-spark-1.3")).toBeVisible();
  await expect(page.locator(".yp-cal-row")).toHaveCount(3, { timeout: 10_000 });
  await expect(page.getByText("Planning…")).toHaveCount(0);
  expect(calls.posts).toBe(1);
});

test("model unavailable shows the calculated plans with a chip", async ({ page }) => {
  await mock(page, { script: [unavailableReview] });
  await page.goto("/planner");
  await expect(page.getByText("Model unavailable, showing calculated plans")).toBeVisible();
  await expect(page.locator(".yp-cal-row")).toHaveCount(3);
});

test("without the backend the view explains itself and saved seasons still render", async ({ page }) => {
  await mock(page, { missing: true });
  await page.goto("/planner");
  await expect(page.getByText("Year plans are not available here yet")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Saved seasons" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} theme at 390 px: no page overflow, the calendar scrolls to the current month`, async ({ page }) => {
    await mock(page);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/planner");
    await expect(page.locator(".yp-cal-row")).toHaveCount(3);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const scroller = page.locator(".yp-cal-scroll");
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await page.locator(".yp-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `../../docs/reference/redesign/year-plan-mock-${theme}.png` });
  });
}
