import { expect, test, type Page } from "@playwright/test";
import { PREVIEW_PORT, startPreviewStack } from "./support/preview-stack";
import { seedFarmAndPlan } from "./support/seed";

/*
 * Offline behaviour against the BUILT app (service worker active) and the real API in SYNTHETIC mode, started by
 * support/preview-stack.ts on ports 4177/8797 (the dev server has no service worker). Offline is real browser
 * offline (context.setOffline). The 409 case is a SIMULATED server answer (page.route), not a real server conflict.
 */
test.use({ baseURL: `http://localhost:${PREVIEW_PORT}`, viewport: { width: 360, height: 740 } });
test.describe.configure({ mode: "serial" });

let stop: () => void;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  stop = await startPreviewStack();
});
test.afterAll(() => stop?.());

async function controlled(page: Page) {
  await page.evaluate(async () => void (await navigator.serviceWorker.ready));
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

const journalPosts = (page: Page) => {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/journal") seen.push(r.headers()["idempotency-key"] ?? "");
  });
  return seen;
};

test("a plan loaded online renders from the saved copy offline with stale labels and disabled network actions", async ({ page, context }) => {
  const { planId } = await seedFarmAndPlan(page);
  await page.goto(`/farm/plan/${planId}`);
  await expect(page.getByTestId("plan-summary")).toBeVisible();
  await expect(page.getByTestId("stale-label")).toHaveCount(0); // live data carries no stale label
  // The seed has no field photo, so the button is natively disabled; what matters is that the offline guard is not applied.
  await expect(page.getByTestId("generate-illustrations")).not.toHaveAttribute("data-offline-disabled", /.*/);
  await controlled(page);
  await expect(page.getByTestId("plan-summary")).toBeVisible();
  await page.waitForTimeout(500); // let the snapshot writes settle

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("plan-summary")).toBeVisible();
  await expect(page.getByTestId("offline-banner")).toContainText("You are offline");
  const panels = await page.locator(".se-page .se-panel, .se-page .se-summary").count();
  expect(panels).toBeGreaterThanOrEqual(5);
  await expect(page.getByTestId("stale-label")).toHaveCount(panels);
  await expect(page.getByTestId("stale-label").first()).toHaveText(/^Saved .+ · offline$/);
  await expect(page.getByTestId("generate-illustrations")).toBeDisabled();
  await expect(page.getByTestId("generate-illustrations")).toHaveAttribute("data-offline-disabled", /.*/);
  await expect(page.getByTestId("offline-action-note-gen")).toContainText("needs the server");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId("plan-summary")).toBeVisible();
  await expect(page.getByTestId("stale-label")).toHaveCount(0);
  await expect(page.getByTestId("generate-illustrations")).not.toHaveAttribute("data-offline-disabled", /.*/);
  await expect(page.getByTestId("offline-action-note-gen")).toHaveCount(0);
});

test("a journal entry written offline is queued, then sent exactly once when back online, and appears in the timeline", async ({ page, context }) => {
  await seedFarmAndPlan(page);
  const posts = journalPosts(page);
  await page.goto("/journal");
  await expect(page.getByRole("heading", { name: "New journal entry" })).toBeVisible();
  await controlled(page);
  await expect(page.getByRole("heading", { name: "New journal entry" })).toBeVisible();
  await page.waitForTimeout(500);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "New journal entry" })).toBeVisible();
  await expect(page.locator(".jr-timeline").getByTestId("stale-label")).toHaveText(/^Saved .+ · offline$/);
  await expect(page.getByTestId("offline-action-note-jr")).toContainText("need the server");
  await page.getByLabel("Note", { exact: true }).fill("Offline note: first flush of ginger shoots.");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByTestId("journal-queued")).toContainText("Saved on this device");
  await expect(page.getByTestId("sync-panel")).toContainText("Offline note");
  await expect(page.getByTestId("sync-banner")).toContainText("1 journal entry is waiting");
  expect(posts).toHaveLength(0);

  // The queued entry survives a reload (still offline).
  await page.reload();
  await expect(page.getByTestId("sync-panel")).toContainText("Offline note");

  await context.setOffline(false);
  await expect(page.getByTestId("sync-panel")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".jr-timeline")).toContainText("Offline note: first flush of ginger shoots.");
  await page.waitForTimeout(1500);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatch(/^jrnl-entry-/);
  // A further reload must not resend anything.
  await page.reload();
  await expect(page.locator(".jr-timeline")).toContainText("Offline note");
  await page.waitForTimeout(800);
  expect(posts).toHaveLength(1);
});

// H1: the owner scope used to live in sessionStorage, so a new tab or a reopened app minted a new scope, could not see
// the saved plan and orphaned queued entries. Both tests below close the page and continue in a NEW page.
test("cold start: after closing the page, a new page offline renders the plan from the saved copy with stale labels", async ({ page, context }) => {
  const { planId } = await seedFarmAndPlan(page);
  await page.goto(`/farm/plan/${planId}`);
  await expect(page.getByTestId("plan-summary")).toBeVisible();
  await controlled(page);
  await expect(page.getByTestId("plan-summary")).toBeVisible();
  await page.waitForTimeout(500);
  await page.close();

  await context.setOffline(true);
  const fresh = await context.newPage();
  await fresh.goto(`/farm/plan/${planId}`);
  await expect(fresh.getByTestId("plan-summary")).toBeVisible();
  await expect(fresh.getByTestId("offline-banner")).toContainText("You are offline");
  await expect(fresh.getByTestId("stale-label").first()).toHaveText(/^Saved .+ · offline$/);
  await context.setOffline(false);
});

test("cold start: an entry queued offline survives closing the page and is sent exactly once from a new page", async ({ page, context }) => {
  await seedFarmAndPlan(page);
  const seen: string[] = [];
  context.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/journal") seen.push(r.headers()["idempotency-key"] ?? "");
  });
  await page.goto("/journal");
  await expect(page.getByRole("heading", { name: "New journal entry" })).toBeVisible();
  await controlled(page);
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.reload();
  await page.getByLabel("Note", { exact: true }).fill("Cold start note: queued before the page was closed.");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByTestId("sync-panel")).toContainText("Cold start note");
  expect(seen).toHaveLength(0);
  await page.close();

  const fresh = await context.newPage();
  await fresh.goto("/journal");
  await expect(fresh.getByTestId("sync-panel")).toContainText("Cold start note"); // visible again in the new page, still offline
  await context.setOffline(false);
  await expect(fresh.getByTestId("sync-panel")).toHaveCount(0, { timeout: 20_000 });
  await expect(fresh.locator(".jr-timeline")).toContainText("Cold start note: queued before the page was closed.");
  await fresh.waitForTimeout(1500);
  expect(seen).toHaveLength(1);
});

test("a 409 from the server puts the entry in conflict with a review UI; both choices work", async ({ page }) => {
  await seedFarmAndPlan(page);
  await page.goto("/journal");
  await expect(page.getByRole("heading", { name: "New journal entry" })).toBeVisible();
  let reject = true;
  let attempts = 0;
  await page.route("**/api/v1/journal", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts++;
    if (!reject) return route.continue();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ requestId: "sim", mode: "synthetic", asOf: new Date().toISOString(), data: null, warnings: [], error: { code: "idempotency_conflict", message: "An entry with this id already exists with different content (simulated)." } }),
    });
  });
  await page.getByLabel("Note", { exact: true }).fill("Local version of the note.");
  await page.getByRole("button", { name: "Save entry" }).click();
  const item = page.getByTestId("sync-item-conflict");
  await expect(item).toBeVisible();
  await expect(item).toContainText("idempotency_conflict");
  await expect(item).toContainText("On this device");
  await expect(item).toContainText("Local version of the note.");
  await expect(page.getByTestId("conflict-banner")).toBeVisible();
  expect(attempts).toBe(1); // conflicts are not retried automatically

  reject = false;
  await page.getByRole("button", { name: "Save mine as a new entry" }).click();
  await expect(page.getByTestId("sync-panel")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".jr-timeline")).toContainText("Local version of the note.");
  expect(attempts).toBe(2);

  // Keep-server path: nothing is sent and the local copy disappears.
  reject = true;
  await page.getByLabel("Note", { exact: true }).fill("Second local note.");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByTestId("sync-item-conflict")).toBeVisible();
  await page.getByRole("button", { name: "Keep server version" }).click();
  await expect(page.getByTestId("sync-panel")).toHaveCount(0);
  await expect(page.locator(".jr-timeline")).not.toContainText("Second local note.");
});
