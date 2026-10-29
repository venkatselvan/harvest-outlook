import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/*
 * Journal journey at 360 px against the real API in SYNTHETIC mode (support/start-journal-api.ts).
 * The "AI" answer is the journal_waterlogging fixture, so nothing here shows a real model reading a real photo.
 * JOURNAL_PATH defaults to the e2e harness page; set it to /journal once routes/pages.tsx mounts JournalPage.
 */
test.use({ viewport: { width: 360, height: 740 }, hasTouch: false });
const JOURNAL_PATH = process.env.JOURNAL_PATH ?? "/e2e/support/journal.html";
const ginger = JSON.parse(readFileSync(resolve(process.cwd(), "../../data/fixtures/synthetic/plan-ginger-basic.json"), "utf8"));

async function makeJpeg(page: Page, w: number, h: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w!;
      c.height = h!;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, w!, h!);
      grad.addColorStop(0, "#3a7d44");
      grad.addColorStop(1, "#c9a227");
      g.fillStyle = grad;
      g.fillRect(0, 0, w!, h!);
      g.fillStyle = "#fff";
      g.fillRect(w! * 0.1, h! * 0.1, w! * 0.15, h! * 0.15);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    },
    [w, h],
  );
  return Buffer.from(b64, "base64");
}

async function createFarmAndPlan(page: Page) {
  await page.goto("/farm");
  await expect(page.getByRole("heading", { name: "My farm" })).toBeVisible();
  await page.getByLabel("District name").fill("Wayanad");
  await page.getByLabel("State or union territory").selectOption("KL");
  await page.getByLabel("From", { exact: true }).selectOption("6");
  await page.getByLabel("To", { exact: true }).selectOption("8");
  await page.getByLabel("How is the land watered?").selectOption("rainfed");
  await page.getByLabel("Area", { exact: true }).fill("2.5");
  await page.getByRole("button", { name: "Save farm" }).click();
  await expect(page.getByTestId("farm-summary")).toContainText("Wayanad");
  const status = await page.evaluate(async (fx) => {
    const sess = (await (await fetch("/api/v1/session")).json()).data;
    const farms = (await (await fetch("/api/v1/farms")).json()).data.farms;
    const res = await fetch("/api/v1/plans", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": sess.csrfToken },
      body: JSON.stringify({ farmId: farms[0].id, cropId: fx.cropId, productId: fx.productId, confirmedInputs: fx.confirmedInputs, assumptions: fx.assumptions, ruleVersions: fx.ruleVersions, stageDefinitions: fx.stageDefinitions, parameters: fx.parameters }),
    });
    return res.status;
  }, ginger);
  expect(status).toBeLessThan(300);
}

test("entry with a photo, analysis, accepted stage proposal, confirmed revision and Why this changed (360 px)", async ({ page }) => {
  await createFarmAndPlan(page);
  await page.goto(JOURNAL_PATH);
  await expect(page.getByRole("heading", { name: "Journal", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Draft: typed note and an uploaded photo survive a reload (IndexedDB).
  await page.getByLabel("Note", { exact: true }).fill("Heavy rain last night. Water standing near the lower rows.");
  const buffer = await makeJpeg(page, 800, 600);
  await page.getByTestId("photo-file").setInputFiles({ name: "field.jpg", mimeType: "image/jpeg", buffer });
  await expect(page.getByAltText("Photo 1 for this entry")).toBeVisible();
  await expect(page.getByText("Draft saved on this device.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Restored your unsent draft from this device.")).toBeVisible();
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue(/Water standing near the lower rows/);
  await expect(page.getByAltText("Photo 1 for this entry")).toBeVisible();

  // Save with the keyboard only.
  const save = page.getByRole("button", { name: "Save entry" });
  await save.focus();
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("journal-notice")).toContainText("recorded exactly as you entered it");
  const card = page.getByTestId("journal-entry").first();
  await expect(card.getByText(/^Your photo · \d{4}-\d{2}-\d{2}$/).first()).toBeVisible();
  await expect(card.getByText(/Farmer-reported/)).toBeVisible();
  // The draft is gone after a successful save.
  await page.reload();
  await expect(page.getByText("Restored your unsent draft from this device.")).toHaveCount(0);

  // Analyze: fixture proposals appear with the AI label; nothing is confirmed yet.
  await page.getByRole("button", { name: "Analyze photo" }).click();
  await expect(page.getByText("AI proposal — confirm before it changes your plan").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Synthetic demonstration answer from a fixture/)).toBeVisible();
  await expect(page.getByTestId("proposal")).toHaveCount(2);
  await expect(page.getByTestId("confirmed-facts")).toHaveCount(0);
  await expect(page.getByTestId("revision")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Accept the stage proposal: a diff preview appears first; only Confirm creates the revision.
  await page.getByRole("button", { name: "Accept growth stage" }).click();
  const review = page.getByRole("group", { name: "Plan change preview" });
  await expect(review).toContainText("What would change");
  await expect(review).toContainText("Vegetative");
  await expect(review).toContainText("Nothing changes until you confirm");
  await expect(page.getByTestId("revision")).toHaveCount(0);
  await page.getByRole("button", { name: "Confirm plan change" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("journal-notice")).toContainText("updated to a new version");
  const rev = page.getByTestId("revision");
  await expect(rev).toHaveCount(1);
  await expect(rev).toContainText("Why this changed");
  await expect(rev).toContainText("Tasks that move");
  await expect(rev).toContainText("Vegetative");
  await expect(page.getByTestId("confirmed-facts")).toContainText("Growth stage");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The routine proposal can be rejected without touching the plan.
  await page.getByRole("button", { name: "Reject standing water visible" }).click();
  await expect(page.getByText("You rejected this. It was not used.")).toBeVisible();
  await expect(page.getByTestId("revision")).toHaveCount(1);
});

test("a routine expense entry saves with no AI step", async ({ page }) => {
  await createFarmAndPlan(page);
  await page.goto(JOURNAL_PATH);
  await page.getByLabel("What did you do or see?").selectOption("expense");
  await page.getByLabel("Amount in rupees").fill("600");
  await page.getByLabel("What for").fill("labour");
  await page.getByRole("button", { name: "Save entry" }).click();
  const card = page.getByTestId("journal-entry").first();
  await expect(card).toContainText("₹600.00 (labour)");
  await expect(card.getByRole("button", { name: /Analyze photo/ })).toHaveCount(0);
  await expect(page.getByTestId("proposal")).toHaveCount(0);
});
