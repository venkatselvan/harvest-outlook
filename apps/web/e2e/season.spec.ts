import { expect, test, type Page } from "@playwright/test";

// SYNTHETIC mode against e2e/support/start-plan-api.ts (PORT 8795) and the Vite entry on 5195. No provider is contacted.
test.use({ viewport: { width: 360, height: 740 } });

const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function seed(page: Page) {
  await page.goto("/farm");
  await expect(page.getByRole("heading", { name: "My farm" })).toBeVisible();
  await page.evaluate(async () => {
    let s = (await (await fetch("/api/v1/session", { credentials: "same-origin" })).json()).data;
    if (!s?.authenticated) s = (await (await fetch("/api/v1/session", { method: "POST", credentials: "same-origin" })).json()).data;
    const h = { "x-csrf-token": s.csrfToken, accept: "application/json" };
    const farm = (
      await (
        await fetch("/api/v1/farms", {
          method: "POST",
          headers: { ...h, "content-type": "application/json", "idempotency-key": "e2e-farm-" + Math.random().toString(36).slice(2) },
          body: JSON.stringify({
            name: "Hassan farm",
            // Approximate coordinates inside the synthetic Hassan-like weather grid cell, so the plan finds the seeded synthetic weather.
            location: { districtId: "typed:KA:hassan", districtName: "Hassan", stateCode: "KA", lat: 13.0033, lon: 76.1004, precision: "approximate" },
            areaHectares: 1.2,
            facts: { irrigation_category: { value: "supplemental", basis: "farmer_reported", confirmed: true, source: "e2e" } },
          }),
        })
      ).json()
    ).data;
    const c = document.createElement("canvas");
    c.width = 800;
    c.height = 600;
    const g = c.getContext("2d")!;
    g.fillStyle = "#3a7d44";
    g.fillRect(0, 0, 800, 600);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
    const fd = new FormData();
    fd.append("file", new File([blob], "farm.jpg", { type: "image/jpeg" }));
    const media = (await (await fetch(`/api/v1/media?farmId=${farm.id}`, { method: "POST", headers: { ...h, "idempotency-key": "e2e-media-" + Math.random().toString(36).slice(2) }, body: fd })).json()).data;
    await fetch(`/api/v1/media/${media.id}/region`, {
      method: "PUT",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ polygon: [[0.2, 0.25], [0.8, 0.2], [0.85, 0.8], [0.15, 0.75]], source: "manual", transform: { orientationApplied: true, normalizedWidth: 800, normalizedHeight: 600 } }),
    });
  });
}

test("create a ginger plan, slide through past/forecast/scenario dates without network, generate schematic illustrations", async ({ page }) => {
  await seed(page);
  const today = istToday();
  await page.goto("/farm?cropId=ginger&productId=ginger-fresh");
  await expect(page.getByTestId("create-plan")).toBeVisible();
  await page.getByLabel("Planting date").fill(addDays(today, -70)) // plan range must include the weather gap at today-60..today-51;
  await page.getByTestId("create-plan-submit").click();
  await page.waitForURL(/\/farm\/plan\//);
  await expect(page.getByTestId("plan-summary")).toBeVisible();
  await expect(page.locator(".mode-banner")).toContainText("SYNTHETIC");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId("panel-stage")).toContainText("inferred", { ignoreCase: true });

  const api: string[] = [];
  page.on("request", (r) => r.url().includes("/api/") && api.push(`${r.method()} ${r.url()}`));
  const date = page.locator("#se-date");

  await date.fill(addDays(today, -55)); // inside the labelled gap of the synthetic weather seed (today-60 .. today-51)
  await expect(page.getByTestId("weather-title")).toHaveText("No record");
  await date.fill(addDays(today, -3));
  await expect(page.getByTestId("weather-title")).toHaveText("Observed");
  await date.fill(addDays(today, 1));
  await expect(page.getByTestId("weather-title")).toHaveText("Forecast");
  await expect(page.getByTestId("weather-lines")).toContainText("Issued");
  await expect(page.getByTestId("weather-lines")).toContainText(/Horizon: [1-3] days from issue/);
  await date.fill(addDays(today, 60));
  await expect(page.getByTestId("weather-title")).toHaveText("Unavailable"); // honest: the synthetic seed has no multi-year climatology, so no scenario is invented (D31/never substituted)
  await expect(page.getByTestId("weather-lines")).not.toContainText("Rain ");

  // Keyboard on the slider and a burst of input events.
  const range = page.locator("#se-range");
  await range.focus();
  const before = await page.getByTestId("selected-date-text").textContent();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("PageDown");
  expect(await page.getByTestId("selected-date-text").textContent()).not.toBe(before);
  await range.evaluate((el: HTMLInputElement) => {
    for (let i = 0; i < 60; i++) {
      el.value = String(i * 3);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await expect(page.getByTestId("panel-outlook")).toContainText("Unavailable");
  expect(api).toEqual([]); // no request while sliding or typing a date

  await page.getByTestId("generate-illustrations").click();
  await expect(page.getByTestId("generate-status")).toContainText("Schematic drawings are shown", { timeout: 30000 });
  await expect(page.getByTestId("generate-reasons")).toContainText("Synthetic mode");
  await date.fill(addDays(today, 5));
  await expect(page.getByTestId("scene-label")).toContainText("Schematic");
  const afterGenerate = api.length;
  await range.evaluate((el: HTMLInputElement) => {
    for (let i = 0; i < 30; i++) {
      el.value = String(100 + i);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  expect(api.length).toBe(afterGenerate);
});
