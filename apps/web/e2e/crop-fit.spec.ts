import { expect, test, type Page } from "@playwright/test";
import type { CropFitReview, PricedCommodity } from "@harvest/contracts";
import { planErrorReview, planPendingReview, planReview } from "../src/workspace/farm/cropFitFixtures";
import { FIXTURE_FARM_ID, fourOptionReview, workspaceBefore } from "../src/workspace/year/fixtures";

/**
 * Crop fit picker, crop fit view and the crop library default view (ROUND3_SPEC.md 3.1, 5, 5.1, 8.3). Every API route is
 * intercepted with SYNTHETIC fixtures; nothing reaches a provider. The picker and the view are mounted through
 * CropFitPickerHarness.tsx (served by the Vite dev server) because the swap sheet that hosts the picker belongs to the
 * year-plan packet; the library is the real /catalogue page.
 */
const env = (data: unknown) => ({ requestId: "crop-fit", mode: "synthetic", asOf: "2026-11-01T00:00:00Z", data, warnings: [], error: null });
const crop = (cropId: string, name: string, productId: string) => ({ cropId, name, products: [{ productId, name: "Grain", productBasis: "grain" }] });
const crops = [crop("paddy", "Paddy", "paddy-grain"), crop("pigeon-pea", "Pigeon pea", "pigeon-pea-whole"), crop("sorghum", "Sorghum", "sorghum-grain"), crop("maize", "Maize", "maize-grain")];
const inventoryEntry = (cropId: string, name: string): PricedCommodity => ({
  commodityId: cropId, sourceCommodity: name, grouping: "crop", identityStatus: "species_reference_available", identityNote: "Provider identity is preserved with its source scope.", botanicalName: null,
  profileId: cropId, profileStatus: "researched", profileUrl: `/api/v1/commodity-profiles/${cropId}`, cropId, productId: `${cropId}-grain`,
  priceCoverage: { validRows: 1, modalRows: 1, dateRange: { from: "2026-10-30", to: "2026-10-30" }, states: ["Karnataka"], marketCount: 1, unitStatus: "provider_unit_not_declared", examples: [] },
});

interface Calls { cropFit: { method: string; query: URLSearchParams }[] }
/** The crop library page also loads crop fit lazily (no query); the picker always sends mode. */
const pickerCalls = (calls: Calls) => calls.cropFit.filter((c) => c.query.has("mode"));
async function mock(page: Page, opts: { cropFit?: (call: number, method: string, query: URLSearchParams) => CropFitReview; saved?: boolean } = {}) {
  const calls: Calls = { cropFit: [] };
  const workspace = {
    ...workspaceBefore,
    rotationPlans: opts.saved
      ? [{ id: "plan-1", year: 2027, season: "Kharif", cropId: "sorghum", cropName: "Sorghum", productId: "sorghum-grain", productName: "Grain", plannedSowingDate: "2027-05-20", plannedHarvestDate: "2027-09-20" }]
      : [],
  };
  await page.clock.setFixedTime(new Date("2026-11-01T10:00:00+05:30"));
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path.endsWith("/command-center")) return; // left pending: these pages do not depend on it
    if (path.endsWith("/crop-fit")) {
      calls.cropFit.push({ method, query: url.searchParams });
      return route.fulfill({ json: env((opts.cropFit ?? (() => planReview))(calls.cropFit.length, method, url.searchParams)) });
    }
    if (path.endsWith("/year-plan")) return route.fulfill({ json: env(fourOptionReview) });
    const data =
      path === "/api/v1/session" ? { authenticated: true, csrfToken: "qa" }
      : path === "/api/v1/farms" ? { farms: [{ id: FIXTURE_FARM_ID, name: "Hassan field", location: { stateCode: "IN-KA", districtId: "IN-KA-hassan", districtName: "Hassan", precision: "district" }, areaHectares: 0.16, facts: {} }] }
      : path.endsWith("/workspace") ? workspace
      : path === "/api/v1/crops" ? { crops }
      : path === "/api/v1/commodities" ? { snapshot: { id: "saved", checkedAt: "2026-10-30T09:00:00Z", complete: true, commodityCount: 3, rowCount: 3, sourceUrl: "https://api.data.gov.in/resource/agmarknet", limitations: [] }, total: 3, offset: 0, limit: 300, items: [inventoryEntry("paddy", "Paddy"), inventoryEntry("sorghum", "Sorghum"), { ...inventoryEntry("mango", "Mango"), cropId: null, productId: null }] }
      : path === "/api/v1/ai/activity" ? { invocations: [] }
      : {};
    return route.fulfill({ json: env(data) });
  });
  return calls;
}

test.use({ viewport: { width: 390, height: 844 } });

/** Mounts the picker into a fresh container and returns what it reported. */
async function openPicker(page: Page, props: { sowing: string; after: string | null; current: { cropId: string; productId: string; systemId?: string | null } | null }) {
  await page.goto("/catalogue");
  await page.evaluate(
    async ({ farmId, props }) => {
      const w = window as unknown as { __sink: { picked: any[]; closed: number } };
      w.__sink = { picked: [], closed: 0 };
      const host = await import(/* @vite-ignore */ "/src/workspace/farm/CropFitPickerHarness.tsx");
      const box = document.createElement("div");
      box.id = "picker-host";
      box.style.cssText = "position:fixed;inset:0;overflow:auto;background:var(--surface, #fff);padding:12px;z-index:9999";
      document.body.appendChild(box);
      host.mountPicker(box, { farmId, ...props }, w.__sink);
    },
    { farmId: FIXTURE_FARM_ID, props },
  );
  return page.locator("#picker-host");
}
const sink = (page: Page) => page.evaluate(() => (window as unknown as { __sink: { picked: any[]; closed: number } }).__sink);

test("picker requests date mode with the after override, lists the current crop first with Keep, and Use this crop reports the scored candidate", async ({ page }) => {
  const calls = await mock(page);
  const host = await openPicker(page, { sowing: "2027-05-16", after: "paddy", current: { cropId: "sorghum", productId: "sorghum-grain" } });
  await expect(host.getByRole("heading", { name: "Crops for sowing on 16 May 2027" })).toBeVisible();
  const first = host.locator("article.cf-pick-row").first();
  await expect(first.getByRole("heading", { level: 4 })).toHaveText("Sorghum");
  await expect(first).toContainText("In this plan");
  await expect(first).toContainText("Rank 3 · Score 72");
  await expect(first).toHaveAttribute("aria-current", "true");
  await expect(first.getByRole("button", { name: "Keep Sorghum" })).toBeVisible();
  expect(pickerCalls(calls)[0]!.method).toBe("GET");
  expect(Object.fromEntries(pickerCalls(calls)[0]!.query)).toEqual({ mode: "date", sowing: "2027-05-16", after: "paddy" });

  // Meta's picks with the spark and the reasons, then the full ranked list with plan labels and history.
  const picks = host.getByRole("region", { name: /Top picks/ });
  await expect(picks.getByRole("button", { name: /AI used: Top crop picks for your field/ })).toBeVisible();
  await expect(picks).toContainText("A legume after paddy returns nitrogen.");
  const all = host.locator("section[aria-labelledby='cf-picker-all']");
  await expect(all.getByRole("heading", { name: "All ranked crops (4)" })).toBeVisible();
  const pigeon = all.locator("article.cf-pick-row", { hasText: "Pigeon pea" }).first();
  await expect(pigeon).toContainText("In your year plan: Best overall");
  await expect(pigeon).toContainText("Grown here before: 2025");
  await expect(pigeon).toContainText("Field idle 7 weeks before sowing, −2 points");
  await expect(all.locator("article.cf-pick-row", { hasText: "Finger millet + pigeon pea (8:1)" })).toContainText("Sourced shares");

  // Touch target and no horizontal overflow at phone width.
  const button = all.getByRole("button", { name: "Use this crop: Maize" });
  const box = (await button.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/crop-fit-picker-390.png` : undefined, fullPage: false });

  await all.getByRole("button", { name: "Use this crop: Finger millet + pigeon pea (8:1)" }).click();
  const after = await sink(page);
  expect(after.picked).toHaveLength(1);
  expect(after.picked[0]).toMatchObject({ cropId: "finger-millet", productId: "finger-millet-grain", sowing: "2027-05-23", kind: "intercrop", companion: { cropId: "pigeon-pea", rowRatio: "8:1", systemId: "finger-millet-pigeon-pea-8-1" } });
  expect(after.closed).toBe(0);

  await first.getByRole("button", { name: "Keep Sorghum" }).click();
  expect((await sink(page)).closed).toBe(1);
  expect((await sink(page)).picked).toHaveLength(1);
});

test("picker shows the skeleton while the review is pending, then the crops; a failed request shows the retry card and Try again recovers", async ({ page }) => {
  let n = 0;
  const calls = await mock(page, { cropFit: (_call, method, query) => (!query.has("mode") || method === "POST" ? planReview : (n++, n === 1 ? planPendingReview : n === 2 ? planErrorReview : planReview)) });
  const host = await openPicker(page, { sowing: "2027-05-16", after: null, current: null });
  await expect(host.locator(".cf-card-skeleton").first()).toBeVisible();
  await expect(host.getByText("Scoring crops for this date…")).toBeVisible();
  // Pending is polled (every 1.5 s) and the next answer is an error review: the retry card, not a stuck skeleton.
  const alert = host.getByRole("alert");
  await expect(alert).toContainText("The scoring job failed.", { timeout: 10_000 });
  expect(pickerCalls(calls).every((c) => !c.query.has("after"))).toBe(true);
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(host.getByRole("heading", { name: "All ranked crops (4)" })).toBeVisible();
  expect(pickerCalls(calls).at(-1)!.method).toBe("POST");
  await expect(host.getByRole("button", { name: /^Keep/ })).toHaveCount(0);
});

test("crop fit view: one line says it matches the year plan; cards carry the plan chip, the wait line and an intercrop with both prices; the sheet has the companion block", async ({ page }) => {
  await mock(page);
  await page.goto("/catalogue");
  await page.evaluate(async (farmId) => {
    const host = await import(/* @vite-ignore */ "/src/workspace/farm/CropFitPickerHarness.tsx");
    const box = document.createElement("div");
    box.id = "view-host";
    document.body.appendChild(box);
    host.mountView(box, farmId);
  }, FIXTURE_FARM_ID);
  const view = page.locator("#view-host");
  await expect(view.getByText("Same candidates, dates and scoring as the year plan.")).toHaveCount(1);
  const cards = view.locator("article.cf-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("In your year plan: Best overall");
  await expect(cards.nth(0)).toContainText("Field idle 7 weeks before sowing, −2 points");
  const intercrop = cards.nth(1);
  await expect(intercrop.getByRole("button", { name: "Finger millet + pigeon pea (8:1)" })).toBeVisible();
  await expect(intercrop).toContainText("Sourced shares");
  await expect(intercrop).toContainText("Finger millet: ₹20 to ₹29/kg at harvest");
  await expect(intercrop).toContainText("Pigeon pea: ₹60 to ₹78/kg at harvest");
  // The date input allows the three later horizons (1,461 days from 1 Nov 2026).
  await view.getByRole("button", { name: "Pick a date" }).click();
  await expect(view.getByLabel("Sowing date")).toHaveAttribute("max", "2030-11-01");
  await view.getByRole("button", { name: "Finger millet + pigeon pea (8:1)" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Finger millet + pigeon pea (8:1)" });
  await expect(dialog.getByRole("heading", { name: "Companion crop" })).toBeVisible();
  await expect(dialog).toContainText("Pigeon pea in rows 8:1 with finger millet, as alternate rows");
  await expect(dialog).toContainText("Nitrogen left for the next crop: 15 to 30 kg/ha");
  await expect(dialog.getByRole("link", { name: "Synthetic intercrop source (test)" })).toHaveAttribute("href", "https://example.org/intercrop");
});

test("crop library opens on Crops for your farm with chips from the farm, the plan and crop fit; the full catalogue sits behind a button", async ({ page }) => {
  await mock(page, { saved: true });
  await page.goto("/catalogue");
  await expect(page.getByRole("heading", { name: "Crops for your farm", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Commodity group")).toHaveCount(0);
  const rowFor = (name: string) => page.getByRole("listitem").filter({ has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) });
  await expect(rowFor("Paddy")).toContainText("Growing now");
  await expect(rowFor("Paddy").getByRole("button", { name: "Open Paddy profile" })).toBeVisible();
  await expect(rowFor("Sorghum")).toContainText("Saved season 2027");
  // Chips from the lazily loaded crop fit review (pigeon pea ranks first in the fixture) and year plan (never blocks the page).
  await expect(rowFor("Pigeon pea")).toContainText("Crop fit rank 1");
  await expect(page.getByRole("listitem").filter({ hasText: "In your year plan" }).first()).toBeVisible();
  await expect(rowFor("Dhaincha \\(green manure\\)")).toBeVisible();
  await expect(rowFor("Dhaincha \\(green manure\\)").getByRole("button", { name: /profile/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Browse the full catalogue (3 entries)" }).click();
  await expect(page.getByRole("heading", { name: "The market-wide catalogue", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Commodity group")).toHaveValue("crops");
  await page.getByLabel("Search crops").fill("mango");
  await expect(page.getByRole("button", { name: "Open Mango profile" })).toBeVisible();
  await page.getByRole("button", { name: "Back to crops for your farm" }).click();
  await expect(page.getByRole("heading", { name: "Crops for your farm", level: 2 })).toBeVisible();
});
