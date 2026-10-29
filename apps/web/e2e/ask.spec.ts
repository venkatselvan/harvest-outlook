import { expect, test } from "@playwright/test";

// SYNTHETIC mode against the real API: the assistant replays a recorded synthetic fixture (provenance synthetic_fixture).
// Nothing here shows a live model answer, and no provider is contacted.
test.use({ viewport: { width: 360, height: 740 } });

test("a synthetic fixture turn renders approved blocks, provenance, limitations, clarification, trace and cost label", async ({ page }) => {
  await page.goto("/ask");
  await expect(page.getByRole("heading", { name: "Ask", level: 1 })).toBeVisible();
  await page.getByLabel("Your question").fill("When should I plant ginger on my 2 acre field?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();

  const answer = page.getByTestId("ask-answer");
  await expect(answer).toBeVisible();
  await expect(page.getByTestId("ask-provenance")).toContainText("Synthetic fixture");
  await expect(page.getByTestId("ask-block").first()).toContainText("Please confirm these details");
  await expect(page.locator(".ask-block.limitation")).toContainText("No crop ranking is shown yet");
  await expect(page.getByTestId("ask-limitations")).toBeVisible();
  await expect(page.getByTestId("ask-clarification")).toContainText("borewell, a canal, or only rain");
  await expect(page.getByTestId("ask-trace")).toContainText("Trace id:");
  await expect(page.getByTestId("ask-cost")).toContainText("estimated, not billed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // A clarification option sends a follow-up turn and keeps the answer on screen.
  await page.getByRole("button", { name: "rain only" }).click();
  await expect(page.getByTestId("ask-answer")).toBeVisible();
  await expect(page.getByTestId("ask-error")).toHaveCount(0);
});

test("speech synthesis that is unavailable shows a notice and the answer text remains", async ({ page }) => {
  await page.goto("/ask");
  await page.getByLabel("Your question").fill("When should I plant ginger?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByTestId("ask-answer")).toBeVisible();
  const text = await page.getByTestId("ask-block").first().innerText();

  // Force the speech endpoint to fail the way a missing provider does (424), whatever the server mode.
  await page.route("**/api/v1/speech/**", (route) =>
    route.fulfill({ status: 424, contentType: "application/json", body: JSON.stringify({ requestId: "r", mode: "synthetic", asOf: new Date().toISOString(), data: null, warnings: [], error: { code: "provider_unavailable", message: "Speech provider is not available", retryable: false } }) }),
  );
  await page.getByRole("button", { name: "Listen to this answer" }).click();
  await expect(page.locator(".speech-error")).toBeVisible();
  await expect(page.getByTestId("ask-block").first()).toHaveText(text);
});

test("provider unavailable and budget limits show plain messages with no retry loop", async ({ page }) => {
  await page.goto("/ask");
  const fail = (status: number, code: string, message: string) => ({ status, contentType: "application/json", body: JSON.stringify({ requestId: "r", mode: "synthetic", asOf: new Date().toISOString(), data: null, warnings: [], error: { code, message } }) });
  await page.route("**/api/v1/assistant/turns", (route) => route.fulfill(fail(424, "provider_unavailable", "down")));
  await page.getByLabel("Your question").fill("hello");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByTestId("ask-error")).toContainText("Assistant unavailable in this mode; browse Explore.");
  await page.unroute("**/api/v1/assistant/turns");
  await page.route("**/api/v1/assistant/turns", (route) => route.fulfill(fail(429, "budget_exceeded", "The spending limit would be exceeded")));
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByTestId("ask-error")).toContainText("spending limit");
});

test("keyboard: the form can be completed and submitted without a pointer", async ({ page }) => {
  await page.goto("/ask");
  await page.getByLabel("Language").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.type("When should I plant ginger?");
  await page.getByRole("button", { name: "Ask", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("ask-answer")).toBeVisible();
});
