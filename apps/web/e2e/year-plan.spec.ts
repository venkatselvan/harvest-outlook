import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { YearPlanReview } from "@harvest/contracts";
import {
  FIXTURE_FARM_ID,
  applyResult,
  emptyReview,
  fourOptionReview,
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
  let script = [...(opts.script ?? [fourOptionReview])];
  let last = script[0]!;
  let workspace = structuredClone(workspaceBefore);
  const calls = { gets: 0, posts: 0, postBodies: [] as unknown[], rescores: [] as any[], applies: [] as any[], trends: [] as string[] };
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
    if (method === "POST" && path.endsWith("/year-plan")) calls.postBodies.push(route.request().postDataJSON());
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
                  areaHectares: 0.16,
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

test("four options render with score rings and the profit for the field in full rupees", async ({ page }) => {
  await mock(page);
  await page.goto("/planner");
  const rows = page.locator(".yp-cal-row");
  await expect(rows).toHaveCount(4);
  await expect(page.getByText("Sep 2026 to Sep 2027 · Paddy growing until mid-Nov")).toBeVisible();
  // Likely band (p25 to p75) for the 0.16 ha field, rounded to the nearest 100, Indian grouping, no "thousand".
  const expected = [
    ["Best overall", "78", "₹8,300 to ₹22,800"],
    ["Soil enrichment", "74", "₹7,100 to ₹21,400"],
    ["Lowest water", "63", "₹4,100 to ₹12,800"],
    ["Green manure first", "66", "₹5,500 to ₹16,700"],
  ];
  for (const [i, [label, score, profit]] of expected.entries()) {
    const head = rows.nth(i).locator(".yp-row-head");
    await expect(head).toContainText(label!);
    await expect(head.locator(".ui-score-ring")).toHaveAttribute("aria-label", `Score ${score} out of 100`);
    await expect(head.locator(".yp-row-profit strong")).toHaveText(profit!);
    await expect(head.locator(".yp-row-profit small")).toHaveText("for your 0.16 ha");
    await expect(head).not.toContainText("thousand");
  }
  await expect(page.getByRole("button", { name: /^Paddy, growing now/ })).toHaveCount(4);
  await expect(page.getByRole("heading", { name: "Saved seasons" })).toBeVisible();
});

test("three rows carry the AI spark, the calculated fourth carries a chip, and the spark does not open the sheet", async ({ page }) => {
  await mock(page);
  await page.goto("/planner");
  const rows = page.locator(".yp-cal-row");
  await expect(rows).toHaveCount(4);
  for (const i of [0, 1, 2]) await expect(rows.nth(i).getByRole("button", { name: "AI used: Choosing your three year plans" })).toBeVisible();
  await expect(rows.nth(3).locator(".ai-spark")).toHaveCount(0);
  await expect(rows.nth(3).locator(".yp-row-line")).toContainText("Calculated");
  await expect(rows.nth(0).locator(".yp-row-line")).not.toContainText("Calculated");
  await rows.nth(0).getByRole("button", { name: "AI used: Choosing your three year plans" }).click();
  await expect(page.getByRole("dialog", { name: "Choosing your three year plans" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Best overall" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a Field rests strip shows its reason on tap, hides it, and shows it again on keyboard focus", async ({ page }) => {
  await mock(page);
  await page.goto("/planner");
  const row = page.locator('.yp-cal-row[data-option-id="opt-best-overall"]');
  const gap = row.getByRole("button", { name: /^Field rests 19 Apr to 19 May, 31 days/ });
  const note = row.locator(".yp-gap-note");
  const reason = "No sourced sowing window for a pool crop between 19 Apr and 19 May on this field; the next windows open 20 May (kharif).";
  await expect(gap).toBeVisible();
  await expect(note).toHaveCount(0);
  await gap.click();
  await expect(note).toContainText(reason);
  await row.getByRole("button", { name: "Hide the field rests note" }).click();
  await expect(note).toHaveCount(0);
  await gap.focus();
  await expect(note).toContainText(reason);
  await page.keyboard.press("Escape");
  await expect(note).toHaveCount(0);
  // The three gaps carry three different reasons (no window, needs irrigation, scored lower).
  const reasons = [fourOptionReview.options[0], fourOptionReview.options[1], fourOptionReview.options[3]].map((o) => o!.gaps![0]!.reason);
  expect(new Set(reasons).size).toBe(3);
  await expect(page.locator(".yp-gap")).toHaveCount(3);
});

test("the green manure strip is labelled with its crop and nitrogen credit and opens its own detail", async ({ page }) => {
  await mock(page);
  await page.goto("/planner");
  const strip = page.getByRole("button", { name: /^Green manure, Cowpea, \+N 60 to 80 kg\/ha\. Sow 8 Jan 2027, ploughed in by 8 Mar 2027/ });
  await expect(strip).toHaveClass(/is-green-manure/);
  await expect(strip).toContainText("Green manure · Cowpea");
  await expect(strip).toContainText("+N 60 to 80 kg/ha");
  await expect(page.locator(".yp-legend")).toContainText("Green manure");
  await expect(page.locator(".yp-legend")).toContainText("Field rests");
  await strip.click();
  const sheet = page.getByRole("dialog", { name: "Green manure first" });
  await expect(sheet.getByRole("heading", { name: "Cowpea (green manure) · Green manure" })).toBeVisible();
  await expect(sheet.locator(".yp-estimates dt")).toHaveText(["Green manure", "Cost", "Profit"]);
  await expect(sheet.locator(".yp-slot-detail")).toContainText("+N 60 to 80 kg/ha for the next crop");
  await expect(sheet.locator(".yp-slot-detail")).toContainText("−₹5,200");
  // Deterministic option: a Calculated chip, not the AI mark, above the reasons.
  await expect(sheet.locator("#yp-why").locator("..")).toContainText("Calculated");
  await expect(sheet.getByRole("button", { name: /Reasons by AI/ })).toHaveCount(0);
});

test("the growing crop shows two short lines, and no sentence longer than 90 characters is drawn on the calendar", async ({ page }) => {
  await mock(page);
  await page.goto("/planner");
  const row = page.locator('.yp-cal-row[data-option-id="opt-best-overall"]');
  await expect(row.locator(".yp-row-notes span")).toHaveText([
    "Harvest expected 10 Nov to 18 Nov (estimated from the sowing date)",
    "Next crop from 1 Dec",
  ]);
  const tooLong = await page.locator(".yp-cal-scroll").evaluate((root) => {
    const found: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      if (text.length > 90) found.push(text);
    }
    return found;
  });
  expect(tooLong).toEqual([]);
  // The soil enrichment row still has the old long warning: counted on the calendar, listed in full in the sheet.
  const soil = page.locator('.yp-cal-row[data-option-id="opt-soil-enrichment"]');
  await expect(soil.locator(".yp-row-chips")).toContainText("1 note in the details");
  await soil.locator(".yp-row-head").click();
  const sheet = page.getByRole("dialog", { name: "Soil enrichment" });
  await expect(sheet.locator(".yp-notes li")).toContainText("harvest date not recorded");
  await expect(sheet.locator(".yp-gap-list li")).toContainText("Summer sowing here needs irrigation; the field is recorded as rainfed.");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  // The fixed crop's long sentence is in its sheet uncertainties.
  await page.getByRole("button", { name: /^Paddy, growing now/ }).first().click();
  const best = page.getByRole("dialog", { name: "Best overall" });
  await best.getByText("What could change this").click();
  await expect(best.locator(".yp-details ul").first()).toContainText("harvest date not recorded");
});

test("a strip opens the sheet with three reasons, four rows and the mocked price trend", async ({ page }) => {
  const calls = await mock(page);
  await page.goto("/planner");
  await page.getByRole("button", { name: /^Maize, 1 Dec to 8 Apr\. Sow 1 Dec 2026/ }).click();
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

test("the sheet shows central, likely and possible per hectare and for the field, for the plan and for each crop", async ({ page }) => {
  await mock(page);
  await page.goto("/planner");
  await page.locator(".yp-cal-row").first().locator(".yp-row-head").click();
  const sheet = page.getByRole("dialog", { name: "Best overall" });
  const explanation = "Likely = middle half of the simulated outcomes; possible = 10th to 90th percentile";
  // Plan total (top of the sheet).
  const total = sheet.locator("section", { has: page.locator("#yp-total") });
  await expect(total.getByRole("group", { name: /^Per hectare: central ₹97,200, likely ₹51,600 to ₹1,42,800, possible −₹3,000 to ₹1,97,500$/ })).toBeVisible();
  await expect(total.getByRole("group", { name: /^For your 0.16 ha: central ₹15,600, likely ₹8,300 to ₹22,800, possible −₹500 to ₹31,600$/ })).toBeVisible();
  await expect(total).toContainText(explanation);
  // The reasons carry the AI mark.
  await expect(sheet.getByRole("button", { name: "Reasons by AI (AI used: Choosing your three year plans)" })).toBeVisible();
  // One crop (maize): per ha and for the field in the Profit row, with the yield and price rows still present.
  await sheet.getByRole("button", { name: "Maize", exact: true }).click();
  const profit = sheet.locator(".yp-estimates > div", { has: page.locator("dt", { hasText: "Profit" }) });
  await expect(profit.getByRole("group", { name: /^Per hectare: central ₹44,900, likely ₹27,700 to ₹62,100, possible ₹7,100 to ₹82,800$/ })).toBeVisible();
  await expect(profit.getByRole("group", { name: /^For your 0.16 ha: central ₹7,200, likely ₹4,400 to ₹9,900, possible ₹1,100 to ₹13,200$/ })).toBeVisible();
  await expect(profit).toContainText(explanation);
  await expect(sheet.locator(".yp-estimates dt")).toHaveText(["Yield", "Price at harvest", "Cost", "Profit"]);
  await expect(sheet.getByText("₹21 to ₹25 per kg")).toBeVisible();
});

test("without a field area the rows show the per-hectare likely band and the hint to draw the boundary", async ({ page }) => {
  const noArea: YearPlanReview = {
    ...fourOptionReview,
    scenario: { ...fourOptionReview.scenario, fieldAreaHa: null },
    options: fourOptionReview.options.map((o) => ({ ...o, fieldAreaHa: null, totalProfitForField: null, slots: o.slots.map((s) => ({ ...s, profitForField: null })) })),
  };
  await mock(page, { script: [noArea] });
  await page.goto("/planner");
  const head = page.locator(".yp-cal-row").first().locator(".yp-row-head");
  await expect(head.locator(".yp-row-profit strong")).toHaveText("₹51,600 to ₹1,42,800");
  await expect(head.locator(".yp-row-profit small")).toHaveText("per hectare · draw the boundary for your field total");
  await head.click();
  const sheet = page.getByRole("dialog", { name: "Best overall" });
  // Plan total and the open crop: one per-hectare block each, and no field block anywhere.
  await expect(sheet.getByRole("group", { name: /^Per hectare:/ })).toHaveCount(2);
  await expect(sheet.getByRole("group", { name: /^For your/ })).toHaveCount(0);
});

test("a review from before round 2 still renders three rows with the per-hectare range and no gaps", async ({ page }) => {
  await mock(page, { script: [occupiedReview] });
  await page.goto("/planner");
  const rows = page.locator(".yp-cal-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first().locator(".yp-row-profit strong")).toHaveText("₹52 thousand to ₹1.4 lakh");
  await expect(rows.first().locator(".yp-row-profit small")).toHaveText("profit per ha");
  await expect(page.locator(".yp-gap")).toHaveCount(0);
  await expect(page.locator(".yp-strip.is-green-manure")).toHaveCount(0);
  await rows.first().locator(".yp-row-head").click();
  const sheet = page.getByRole("dialog", { name: "Best overall" });
  await expect(sheet.locator("#yp-total")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Maize", exact: true }).click();
  await expect(sheet.locator(".yp-estimates")).toContainText("per ha");
  await expect(sheet.getByRole("group", { name: /^Per hectare:/ })).toHaveCount(0);
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

test("the editor inserts a green manure and sends kind green_manure with productId equal to the crop id", async ({ page }) => {
  const calls = await mock(page);
  await page.goto("/planner");
  await page.locator(".yp-cal-row").first().locator(".yp-row-head").click();
  const sheet = page.getByRole("dialog", { name: "Best overall" });
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  const selects = sheet.getByRole("combobox", { name: "Crop" });
  await expect(selects.first().locator('optgroup[label="Green manure"] option')).toHaveText(["Cowpea (green manure)"]);
  await sheet.getByRole("button", { name: "+ Add green manure" }).click();
  await expect(selects).toHaveCount(3);
  await expect(selects.nth(2)).toHaveValue("gm-cowpea");
  await expect(sheet.getByText("Green manure, ploughed in")).toBeVisible();
  await sheet.getByRole("button", { name: "Re-score plan" }).click();
  await expect.poll(() => calls.rescores.length).toBe(1);
  expect(calls.rescores[0].slots.at(-1)).toEqual({ cropId: "gm-cowpea", productId: "gm-cowpea", kind: "green_manure", sowing: "2027-06-19" });
  expect(calls.rescores[0].slots.filter((s: { kind?: string }) => s.kind).length).toBe(1);
});

test("axe finds no serious or critical violation on the four-row calendar with a note open, or in its detail sheets", async ({ page }) => {
  await mock(page);
  await page.goto("/planner");
  await expect(page.locator(".yp-cal-row")).toHaveCount(4);
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
  const blocking = async (scope: string) => {
    const result = await new AxeBuilder({ page }).include(scope).withTags(tags).analyze();
    return result.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  };
  await page.locator(".yp-gap").first().click();
  await expect(page.locator(".yp-gap-note")).toBeVisible();
  expect(await blocking(".yp-panel")).toEqual([]);
  await page.locator(".yp-cal-row").first().locator(".yp-row-head").click();
  const sheet = page.getByRole("dialog", { name: "Best overall" });
  await sheet.getByRole("button", { name: "Maize", exact: true }).click();
  expect(await blocking('[role="dialog"]')).toEqual([]);
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet.getByRole("button", { name: "+ Add green manure" }).click();
  expect(await blocking('[role="dialog"]')).toEqual([]);
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

test("pending then ready: the planning indicator names the model, then four options appear", async ({ page }) => {
  const calls = await mock(page, { script: [emptyReview, pendingReview, pendingReview, fourOptionReview] });
  await page.goto("/planner");
  await expect(page.getByText("Planning…")).toBeVisible();
  await expect(page.getByText("Planning with muse-spark-1.3")).toBeVisible();
  await expect(page.locator(".yp-cal-row")).toHaveCount(4, { timeout: 10_000 });
  await expect(page.getByText("Planning…")).toHaveCount(0);
  expect(calls.posts).toBe(1);
});

test("model unavailable shows the calculated plans with a chip", async ({ page }) => {
  await mock(page, { script: [unavailableReview] });
  await page.goto("/planner");
  await expect(page.getByText("Model unavailable, showing calculated plans")).toBeVisible();
  await expect(page.locator(".yp-cal-row")).toHaveCount(3);
  await expect(page.locator(".yp-row-line", { hasText: "Calculated" })).toHaveCount(3);
  await expect(page.locator(".yp-cal-row .ai-spark")).toHaveCount(0);
});

test("without the backend the view explains itself and saved seasons still render", async ({ page }) => {
  const calls = await mock(page, { missing: true });
  await page.goto("/planner");
  await expect(page.getByText("Year plans are not available here yet")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Saved seasons" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(calls.postBodies).toEqual([{}]); // the first ask is a plain ensure
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => calls.postBodies).toEqual([{}, { force: true }]); // Try again replaces a finished plan at once
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} theme at 390 px with four rows: no page overflow, the calendar scrolls to the current month`, async ({ page }) => {
    await mock(page);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/planner");
    await expect(page.locator(".yp-cal-row")).toHaveCount(4);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Every row head fits the 390 px column: the profit headline wraps instead of running off the edge.
    const overflowing = await page.locator(".yp-row-head").evaluateAll((heads) =>
      heads.filter((h) => h.scrollWidth > h.clientWidth + 1 || h.getBoundingClientRect().right > window.innerWidth + 1).length,
    );
    expect(overflowing).toBe(0);
    const scroller = page.locator(".yp-cal-scroll");
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await page.locator(".yp-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `../../docs/reference/redesign/year-plan-r2-mock-${theme}.png` });
  });
}
