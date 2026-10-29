import { expect, test } from "@playwright/test";

// Real API in SYNTHETIC mode with the T06b crop routes (e2e/support/start-crops-api.ts) behind the Explore harness
// (e2e/support/vite.explore.config.ts). No provider is contacted. Findings depend on the seeded synthetic catalogue.
test.use({ viewport: { width: 360, height: 740 }, hasTouch: false });

test("Hassan, kharif May, rainfed: results, three cards, choose ginger", async ({ page }) => {
  await page.goto("/explore");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".mode-banner")).toContainText("SYNTHETIC MODE");

  // validation is inline and the form stays
  await page.getByRole("button", { name: "Compare crops" }).click();
  await expect(page.getByText("Choose your state.")).toBeVisible();
  await expect(page.getByLabel("State")).toBeFocused();

  await page.getByLabel("State").selectOption("IN-KA");
  await page.getByLabel("District (optional)").selectOption("IN-KA-hassan");
  await page.getByLabel("Planting month").selectOption("5");
  await page.getByLabel("How is the land watered?").selectOption("rainfed");

  // area unit toggle shows the conversion
  await page.getByLabel("I know the area").check();
  await page.getByLabel("Area amount").fill("2");
  await expect(page.getByTestId("area-conversion")).toHaveText("2 acre = 0.81 hectare");
  await page.getByLabel("hectare", { exact: true }).check();
  await expect(page.getByTestId("area-conversion")).toHaveText("2 hectare = 4.94 acre");

  // no horizontal overflow at 360 px
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "Compare crops" }).click();
  const rows = page.getByTestId("result-row");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(25);
  await expect(rows.first()).toContainText("Eligibility: Eligible");
  await expect(rows.first()).toContainText(/Evidence coverage \d\/6 dimensions/);

  const row = (product: string) => page.locator(`[data-testid="result-row"][data-product="${product}"]`);
  await row("ginger-fresh").getByRole("checkbox").check();
  await row("turmeric-dry").getByRole("checkbox").check();
  await row("sorghum-grain").getByRole("checkbox").check();
  await expect(page.getByTestId("crop-card")).toHaveCount(3);

  // a fourth is refused
  await row("black-gram-whole").getByRole("checkbox").click();
  await expect(row("black-gram-whole").getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByText("at most 3 crops")).toBeVisible();
  await expect(page.getByTestId("crop-card")).toHaveCount(3);

  const ginger = page.locator('[data-testid="crop-card"][data-product="ginger-fresh"]');
  await expect(ginger).toContainText("Eligibility:");
  await expect(ginger.getByTestId("price-reference")).toContainText("Unavailable — price access pending");
  await expect(ginger.getByTestId("missing-input")).toBeVisible();

  // citations load on demand
  const turmeric = page.locator('[data-testid="crop-card"][data-product="turmeric-dry"]');
  await turmeric.locator("summary", { hasText: "Rule IDs and evidence" }).click();
  await expect(turmeric.getByText("Spices Board India").first()).toBeVisible();

  await ginger.getByRole("button", { name: "Choose this crop" }).click();
  await expect(page).toHaveURL(/\/farm\?cropId=ginger&productId=ginger-fresh$/);
  const stored = JSON.parse(await page.getByTestId("selected-crop").innerText());
  expect(stored).toMatchObject({ cropId: "ginger", productId: "ginger-fresh" });
});

test("the profile persists across reload (without notes) and a 429 keeps the form", async ({ page }) => {
  await page.goto("/explore");
  await page.getByLabel("State").selectOption("IN-KA");
  await page.getByLabel("Planting month").selectOption("6");
  await page.getByLabel("How is the land watered?").selectOption("unknown");
  await page.getByLabel("Notes about your farm (optional)").fill("private note");
  await page.reload();
  await expect(page.getByLabel("State")).toHaveValue("IN-KA");
  await expect(page.getByLabel("Planting month")).toHaveValue("6");
  await expect(page.getByLabel("Notes about your farm (optional)")).toHaveValue("");

  await page.route("**/api/v1/crop-comparisons", (route) =>
    route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ requestId: "r", mode: "synthetic", asOf: new Date().toISOString(), data: null, warnings: [], error: { code: "rate_limited", message: "Too many requests", retryable: true } }) }),
  );
  await page.getByRole("button", { name: "Compare crops" }).click();
  await expect(page.getByTestId("compare-error")).toContainText("Too many comparisons");
  await expect(page.getByLabel("State")).toHaveValue("IN-KA");
});
