import { deflateSync } from "node:zlib";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  FarmCommandCenter as commandSchema,
  TodayView as todaySchema,
  type TodayView,
} from "@harvest/contracts";
import {
  FIXTURE_ALERT_IDS,
  FIXTURE_BOUNDARY,
  todayEmptyFixture,
  todayFixture,
} from "../src/workspace/today/fixtures";
import { formatInr, formatTemp, priceAt, weatherAt } from "../src/workspace/today/model";

// UI-only route mocks: every /api/v1 request is answered here from the synthetic Today fixture; no provider is called.
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  J = "33333333-3333-4333-8333-333333333333";
const asOf = "2026-11-01T04:30:00Z";
const env = (data: unknown, error: { code: string; message: string } | null = null) => ({
  requestId: "today-test",
  mode: "synthetic",
  asOf,
  data,
  warnings: [],
  error,
});

// ---------------------------------------------------------------- tiny PNG encoder for mock scene images
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** Synthetic patchwork, deliberately schematic so a screenshot is never mistaken for a real scene. */
function png(size: number, tint: [number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const block = (Math.floor(x / 12) * 7 + Math.floor(y / 10) * 13) % 5;
      const field = x > size * 0.4 && x < size * 0.6 && y > size * 0.4 && y < size * 0.6;
      const base: [number, number, number] = field ? [86, 128, 70] : [[118, 112, 84], [96, 116, 78], [132, 124, 96], [84, 104, 72], [108, 120, 88]][block] as [number, number, number];
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = Math.min(255, base[0] + tint[0]);
      raw[o + 1] = Math.min(255, base[1] + tint[1]);
      raw[o + 2] = Math.min(255, base[2] + tint[2]);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const observedPng = png(96, [0, 0, 0]);
const illustrationPng = png(96, [40, 30, 10]);

// ---------------------------------------------------------------- shell context mocks
const maizeCycle = {
  id: "maize-cycle",
  cropId: "maize",
  cropName: "Maize",
  productId: "maize-grain",
  productName: "Maize grain",
  sowingDate: "2026-09-15",
  establishmentDate: "2026-09-15",
  establishmentMethod: "direct_sowing",
  stage: "growing",
};
const workspace = (farmId: string) => ({
  farmId,
  version: 1,
  updatedAt: asOf,
  boundary: farmId === A ? FIXTURE_BOUNDARY : null,
  previousHarvest: { status: "none" },
  cycles: farmId === A ? [maizeCycle] : [],
  rotationPlans: [],
});
const quotes = {
  checkedAt: asOf,
  selectionBasis: "none",
  providerStatus: "unavailable",
  missingReason: "no_quote",
  status: "unavailable",
  requestLimit: 6,
  requestsMade: 0,
  products: [],
  limitations: [],
};
const careTask = (status: "due" | "completed") => ({
  id: "task-moisture",
  actionId: "moisture-check",
  cycleId: "maize-cycle",
  cropId: "maize",
  title: "Check field moisture",
  action: "Inspect the field before deciding on irrigation.",
  anchor: "direct_sowing",
  dueFrom: "2026-10-31",
  dueTo: "2026-11-02",
  conditions: [],
  sourceRefs: [{ sourceId: "care-source", locator: "Crop guide fixture" }],
  status,
  completedOn: status === "completed" ? "2026-11-01" : null,
  journalEntryId: status === "completed" ? J : null,
  evidenceState: "source_schedule",
});
const command = (farmId: string, completed: boolean) => ({
  farmId,
  asOf,
  workspace: workspace(farmId),
  focusedCrops: [
    {
      cropId: "maize",
      displayName: "Maize",
      botanicalName: "Zea mays",
      productionType: "annual",
      establishmentMethods: ["direct_sowing"],
      products: [{ productId: "maize-grain", productName: "Maize grain", sourceCommodities: ["Maize"], mappingStatus: "verified" }],
      limitations: [],
    },
  ],
  sources: [{ id: "care-source", url: "https://example.org/care", publisher: "Crop guide fixture", title: "Care", retrievedAt: asOf, geography: { scope: "state" } }],
  currentCycles: workspace(farmId).cycles.map((cycle) => ({ cycle, careTasks: [careTask(completed ? "completed" : "due")], limitations: [] })),
  soil: { markers: { farmId, samples: [], limitations: [] }, fit: [] },
  weather: { kind: "forecast", status: "unavailable", reason: "fixture", issuedAt: null, source: "Fixture", days: [] },
  currentQuotes: quotes,
  priorYearMarkets: [],
  limitations: [],
});

interface MockOptions {
  /** How /today answers: the fixture, a 404 envelope, or a network failure. */
  today?: "ok" | "missing" | "network";
  /** Hold farm B's /today response until `releaseB()`. */
  holdB?: boolean;
  /** Fail the first care completion with a 500 after holding it until `releaseCare()`. */
  failFirstCare?: boolean;
}

async function mock(page: Page, options: MockOptions = {}) {
  const state = {
    today: options.today ?? "ok",
    completed: new Set<string>(),
    dismissed: new Set<string>(),
    careBodies: [] as { clientEntryId: string; completedOn: string }[],
    careKeys: [] as string[],
    dismissPaths: [] as string[],
    todayFarms: [] as string[],
    heldB: undefined as Route | undefined,
    heldCare: undefined as Route | undefined,
  };
  const todayFor = (farmId: string): TodayView => {
    const view = farmId === A ? todayFixture(A) : todayEmptyFixture(B);
    view.alerts = view.alerts.filter((alert) => !state.dismissed.has(alert.id));
    view.upcoming = view.upcoming.map((step) =>
      state.completed.has(step.careTask?.id ?? "")
        ? { ...step, status: "completed", careTask: step.careTask && { ...step.careTask, status: "completed", completedOn: "2026-11-01", journalEntryId: J } }
        : step,
    );
    return todaySchema.parse(view); // the mock never serves a response the contract would reject
  };
  commandSchema.parse(command(A, false));
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method(),
      id = path.includes(B) ? B : A;
    if (path.includes("/ndvi/") && method === "GET")
      return route.fulfill({ status: 200, contentType: "image/png", body: path.endsWith("/future") ? illustrationPng : observedPng });
    if (path.endsWith("/today")) {
      state.todayFarms.push(id);
      if (state.today === "network") return route.abort("failed");
      if (state.today === "missing")
        return route.fulfill({ status: 404, json: env(null, { code: "not_found", message: `Route GET:${path} not found` }) });
      if (id === B && options.holdB && !state.heldB) {
        state.heldB = route;
        return;
      }
      return route.fulfill({ json: env(todayFor(id)) });
    }
    if (path.endsWith("/complete") && method === "POST") {
      const body = route.request().postDataJSON();
      state.careBodies.push(body);
      state.careKeys.push(route.request().headers()["idempotency-key"] ?? "");
      if (options.failFirstCare && state.careBodies.length === 1) {
        state.heldCare = route;
        return;
      }
      state.completed.add(decodeURIComponent(path.split("/care/")[1]!.split("/")[0]!));
      return route.fulfill({ json: env({ journalEntryId: J, completedOn: body.completedOn, alreadyCompleted: false }) });
    }
    if (path.includes("/alerts/") && path.endsWith("/dismiss") && method === "POST") {
      state.dismissPaths.push(path);
      const alertId = path.split("/alerts/")[1]!.split("/")[0]!;
      state.dismissed.add(alertId);
      const alert = todayFixture(id).alerts.find((item) => item.id === alertId)!;
      return route.fulfill({ json: env(alert) });
    }
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "test" }
        : path === "/api/v1/farms"
          ? {
              farms: [A, B].map((farmId, i) => ({
                id: farmId,
                name: i ? "North field" : "South field",
                areaHectares: 1.2,
                location: { stateCode: "IN-KA", districtId: "IN-KA-hassan", districtName: "Hassan", precision: "district" },
                facts: {},
              })),
            }
          : path.endsWith("/workspace")
            ? workspace(id)
            : path.endsWith("/command-center")
              ? command(id, state.completed.has("task-moisture"))
              : path === "/api/v1/crops"
                  ? { crops: [{ cropId: "maize", name: "Maize", products: [{ productId: "maize-grain", name: "Maize grain" }] }] }
                  : path.endsWith("/monitoring")
                    ? {
                        farmId: id,
                        checkedAt: asOf,
                        weather: { status: "unavailable", reason: "fixture", issuedAt: null, attribution: "Fixture", point: null, days: [] },
                        market: { status: "unavailable", reason: "fixture", products: [] },
                        meta: { status: "unavailable", reason: "fixture", automatic: false },
                      }
                    : path.endsWith("/market-quotes")
                      ? quotes
                      : path.endsWith("/soil-markers")
                        ? { farmId: id, samples: [], limitations: [] }
                        : path.endsWith("/soil-reports")
                          ? { reports: [] }
                          : path === "/api/v1/ai/activity"
                            ? { invocations: [] }
                            : {};
    await route.fulfill({ json: env(data) });
  });
  return {
    state,
    async releaseB() {
      await state.heldB!.fulfill({ json: env(todayFor(B)) });
    },
    async failHeldCare() {
      await state.heldCare!.fulfill({ status: 500, json: env(null, { code: "internal_error", message: "Simulated failure" }) });
    },
  };
}

const fixture = todayFixture(A);
const slider = (page: Page) => page.getByRole("slider", { name: "Move through the season" });
const chip = (page: Page) => page.getByTestId("today-date-chip");
const stage = (page: Page) => page.getByTestId("today-stage");
const card = (page: Page, kind: string) => page.locator(`[data-card="${kind}"]`);
async function press(page: Page, key: string, times: number) {
  const target = slider(page);
  await target.focus();
  for (let i = 0; i < times; i++) await target.press(key);
}
async function openToday(page: Page) {
  await page.goto("/farm");
  await expect(page.getByRole("heading", { name: "South field", exact: true })).toBeVisible();
  await expect(slider(page)).toBeVisible();
}

test.use({ viewport: { width: 390, height: 844 } });

test("slider opens at today and moves the stage, date, price and weather together", async ({ page }) => {
  await mock(page);
  await openToday(page);
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "1 Nov 2026");
  await expect(slider(page)).toHaveValue("47");
  await expect(chip(page)).toHaveText(/Today\s*1 Nov 2026/);
  await expect(stage(page)).toContainText("Vegetative");
  await expect(stage(page)).toContainText("8 Nov");
  await expect(stage(page)).toContainText("Growing");
  const now = priceAt(fixture.priceTrack, "2026-11-01")!;
  await expect(page.getByTestId("today-price-at-date")).toHaveText(`1 Nov: ${formatInr(now.p50!)}/kg recorded`);
  const nowWeather = weatherAt(fixture.weatherTrack, "2026-11-01")!;
  await expect(card(page, "weather")).toContainText("Weather on 1 Nov");
  await expect(card(page, "weather")).toContainText("Forecast");
  await expect(card(page, "weather")).toContainText(`${formatTemp(nowWeather.tMaxC)}/${formatTemp(nowWeather.tMinC)}`);
  await expect(card(page, "harvest")).toContainText("63–73 days");
  await expect(card(page, "price")).toContainText("₹19–24");
  await expect(card(page, "price")).toContainText("Based on 3 years of Karnataka mandi prices");
  await expect(page.getByRole("button", { name: "Back to today" })).toHaveCount(0);

  // 39 days later by keyboard: 10 Dec 2026, inside the grain-filling stage, beyond the forecast horizon.
  await press(page, "ArrowRight", 39);
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "10 Dec 2026");
  await expect(chip(page)).toHaveText("10 Dec 2026");
  await expect(stage(page)).toContainText("Grain filling · 29 Nov to 28 Dec");
  await expect(stage(page)).not.toContainText("Growing");
  const later = priceAt(fixture.priceTrack, "2026-12-10")!;
  await expect(page.getByTestId("today-price-at-date")).toHaveText(`10 Dec: ${formatInr(later.p50!)}/kg typical`);
  const laterWeather = weatherAt(fixture.weatherTrack, "2026-12-10")!;
  await expect(card(page, "weather")).toContainText("Weather on 10 Dec");
  await expect(card(page, "weather")).toContainText("Typical");
  await expect(card(page, "weather")).not.toContainText("Forecast");
  await expect(card(page, "weather")).toContainText(`${formatTemp(laterWeather.tMaxC)}/${formatTemp(laterWeather.tMinC)}`);
  await expect(card(page, "weather")).toContainText("Typical for this date, 2023 to 2025");

  await page.getByRole("button", { name: "Back to today" }).click();
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "1 Nov 2026");
  await expect(slider(page)).toBeFocused();
  await expect(chip(page)).toContainText("Today");
  await slider(page).press("End");
  await expect(stage(page)).toContainText("Harvest window");
  await expect(chip(page)).toHaveText(/13 Jan 2027/);

  // Details live one tap away in a bottom sheet; Escape closes it.
  await card(page, "price").getByRole("button", { name: /details and sources/ }).click();
  const sheet = page.getByRole("dialog", { name: "Expected price at harvest" });
  await expect(sheet).toContainText("not a forecast and not a farm-gate price");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("satellite view shows observed scene dates for past dates and a labelled illustration for future dates", async ({ page }) => {
  await mock(page);
  await openToday(page);
  await expect(page.getByRole("region", { name: "Interactive crop growth model" })).toBeVisible();
  await expect(stage(page)).toContainText("Illustration");
  await page.getByRole("button", { name: "Satellite", exact: true }).click();
  await expect(page.getByRole("button", { name: "Satellite", exact: true })).toHaveAttribute("aria-pressed", "true");
  const image = page.locator(".today-sat img");
  await expect(image).toHaveAttribute("data-scene-kind", "observed");
  await expect(image).toHaveAttribute("alt", "Satellite image of your field, observed 27 Oct 2026, 4% cloud in the scene");
  await expect(image).toHaveAttribute("src", new RegExp(`/api/v1/farms/${A}/ndvi/.+20261027.+/image\\?kind=visual$`));
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(96);
  await expect(stage(page)).toContainText("Observed");
  await expect(stage(page)).toContainText("27 Oct 2026");
  await expect(stage(page)).toContainText("Cloud 4%");
  await expect(page.locator(".today-sat-outline polygon")).toHaveCount(1);

  // Ten days back: the nearest scene on or before 22 Oct is the 22 Oct scene.
  await press(page, "ArrowLeft", 10);
  await expect(chip(page)).toHaveText("22 Oct 2026");
  await expect(stage(page)).toContainText("22 Oct 2026");
  await expect(stage(page)).toContainText("Cloud 12%");
  await expect(image).toHaveAttribute("data-scene-kind", "observed");

  // A future date in grain filling has a stage illustration derived from the latest real scene.
  await press(page, "ArrowRight", 49);
  await expect(chip(page)).toHaveText("10 Dec 2026");
  await expect(image).toHaveAttribute("data-scene-kind", "illustration");
  await expect(image).toHaveAttribute("src", /\/future\?stageId=grain_fill$/);
  await expect(stage(page)).toContainText("Illustration of a typical Grain filling");
  await expect(stage(page)).toContainText("from image of 27 Oct");
  await expect(page.locator(".today-sat-outline")).toHaveCount(0);

  // A future date without an illustration shows the latest real scene, labelled as such.
  await press(page, "ArrowLeft", 25);
  await expect(chip(page)).toHaveText("15 Nov 2026");
  await expect(image).toHaveAttribute("data-scene-kind", "latest");
  await expect(stage(page)).toContainText("Latest image 27 Oct 2026");
  await expect(stage(page)).toContainText("Tasselling and silking");
});

test("Done is optimistic, rolls back on error, reuses its idempotency key and persists after reload", async ({ page }) => {
  const api = await mock(page, { failFirstCare: true });
  await openToday(page);
  const steps = page.getByRole("region", { name: "Upcoming steps" });
  // The next action is a bold card above the list; the list starts with the second step.
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  const moisture = steps.getByTestId("today-next-action");
  await expect(moisture).toHaveAttribute("data-step-id", "care:task-moisture");
  await expect(moisture).toContainText("Do between 31 Oct and 2 Nov");
  await expect(moisture.locator(".today-chip")).toHaveCount(0);
  await moisture.getByRole("button", { name: "Mark done: Check field moisture" }).click();
  await expect.poll(() => api.state.careBodies.length).toBe(1);
  await expect(moisture.locator(".today-chip")).toHaveText("Done");
  await expect(moisture.getByRole("button", { name: /Mark done/ })).toHaveCount(0);
  await api.failHeldCare();
  await expect(steps.getByRole("alert")).toContainText('Could not record "Check field moisture". Simulated failure');
  await expect(moisture.locator(".today-chip")).toHaveCount(0);
  await expect(moisture).toContainText("Do between 31 Oct and 2 Nov");
  await moisture.getByRole("button", { name: "Mark done: Check field moisture" }).click();
  await expect.poll(() => api.state.careBodies.length).toBe(2);
  expect(api.state.careBodies[1]).toEqual(api.state.careBodies[0]);
  expect(api.state.careKeys[1]).toBe(api.state.careBodies[0]!.clientEntryId);
  expect(api.state.careBodies[0]!.completedOn).toBe("2026-11-01");
  await expect(moisture.locator(".today-chip")).toHaveText("Done");
  await expect(steps.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(slider(page)).toBeVisible();
  const reloaded = page.getByRole("region", { name: "Upcoming steps" }).locator('[data-step-id="care:task-moisture"]');
  await expect(reloaded.locator(".today-chip")).toHaveText("Done");
  await expect(reloaded.getByRole("button", { name: /Mark done/ })).toHaveCount(0);
  // Stage transitions show their date (never "Expected" without one) and have no Done button.
  const stageStep = page.locator('[data-step-id="stage:tasselling"]');
  await expect(stageStep).toContainText("9 Nov");
  await expect(stageStep).not.toContainText("Expected");
  await expect(stageStep.getByRole("button", { name: /Mark done/ })).toHaveCount(0);
});

test("alerts link to dated sources, and dismissing one removes it for good", async ({ page }) => {
  const api = await mock(page);
  await openToday(page);
  const alerts = page.getByRole("region", { name: "Alerts" });
  await expect(alerts).toContainText("News and official warnings checked today via Meta search");
  await expect(alerts.getByRole("button", { name: "AI used: Daily news check" })).toBeVisible();
  await expect(alerts).not.toContainText("IMD");
  await expect(alerts.getByRole("listitem")).toHaveCount(3);
  await expect(alerts.getByRole("listitem").first()).toContainText("Warning");
  const rain = alerts.locator(`[data-alert-id="${FIXTURE_ALERT_IDS.weather}"]`);
  await expect(rain.getByRole("link")).toHaveAttribute("href", "https://example.org/forecast");
  await expect(rain.getByRole("link")).toContainText("Forecast fixture · 1 Nov 2026");
  await rain.getByRole("button", { name: "Clear field drains before 4 Nov" }).click();
  await expect(page.locator(`[data-step-id="alert:${FIXTURE_ALERT_IDS.weather}"]`)).toBeFocused();
  await alerts.getByRole("button", { name: "Dismiss alert: Maize prices fell 9% in 30 days" }).click();
  await expect(alerts.getByRole("listitem")).toHaveCount(2);
  await expect(alerts).not.toContainText("Maize prices fell");
  await expect.poll(() => api.state.dismissPaths).toEqual([`/api/v1/farms/${A}/alerts/${FIXTURE_ALERT_IDS.price}/dismiss`]);
  await page.reload();
  await expect(page.getByRole("region", { name: "Alerts" }).getByRole("listitem")).toHaveCount(2);
});

test("the next action card shows the window and action; every later step shows its window", async ({ page }) => {
  await mock(page);
  await openToday(page);
  const steps = page.getByRole("region", { name: "Upcoming steps" });
  const card = steps.getByTestId("today-next-action");
  await expect(card.getByRole("heading", { name: "Check field moisture" })).toBeVisible();
  await expect(card).toContainText("Next action");
  await expect(card).toContainText("Do between 31 Oct and 2 Nov");
  await expect(card).toContainText("Inspect the field before deciding on irrigation.");
  await expect(card.getByRole("button", { name: "Mark done: Check field moisture" })).toBeVisible();
  const lines = steps.getByRole("listitem");
  await expect(lines.first()).toContainText("Clear field drains before 4 Nov");
  await expect(lines.first()).toContainText("1 to 3 Nov");
  await expect(lines.nth(1)).toContainText("5 to 10 Nov");
  await expect(steps).not.toContainText("Expected");
});

test("the outlook line sits under the price value: writing while pending, the sentence with the AI mark when ready", async ({ page }) => {
  await mock(page);
  let note: TodayView["outlookNote"] = { status: "pending", text: null, facts: [], origin: null, generatedAt: null, modelInvocation: null };
  await page.route("**/api/v1/farms/*/today", (route) => route.fulfill({ json: env(todaySchema.parse({ ...todayFixture(A), outlookNote: note })) }));
  await openToday(page);
  const card = page.locator('[data-card="price"]');
  await expect(card.getByTestId("today-outlook-note")).toHaveText(/Writing the outlook…/);
  note = todayFixture(A).outlookNote!;
  await page.reload();
  const line = page.locator('[data-card="price"]').getByTestId("today-outlook-note");
  await expect(line).toContainText("Maize grain in Karnataka has usually fetched ₹19 to ₹24 per kg around harvest");
  await line.getByRole("button", { name: "AI used: Harvest price outlook in words" }).click();
  await expect(page.getByRole("dialog")).toContainText("Harvest price outlook in words");
  await page.keyboard.press("Escape");
  note = { status: "unavailable", text: null, facts: [], origin: null, generatedAt: null, modelInvocation: null };
  await page.reload();
  await expect(page.locator('[data-card="price"]')).toContainText("₹19–24");
  await expect(page.locator('[data-card="price"]').getByTestId("today-outlook-note")).toHaveCount(0);
});

test("switching farms clears the view before the next farm loads", async ({ page }) => {
  const api = await mock(page, { holdB: true });
  await openToday(page);
  await expect(page.getByRole("region", { name: "Alerts" }).getByRole("listitem")).toHaveCount(3);
  await page.getByLabel("Selected farm", { exact: true }).selectOption(B);
  await expect(page.getByRole("heading", { name: "North field", exact: true })).toBeVisible();
  await expect.poll(() => api.state.todayFarms.includes(B)).toBe(true);
  await expect(page.getByRole("status", { name: "Loading today's field view" })).toBeVisible();
  await expect(slider(page)).toHaveCount(0);
  await expect(page.getByText("Heavy rain expected on 4 Nov")).toHaveCount(0);
  await expect(page.getByText("Check field moisture")).toHaveCount(0);
  await expect(page.locator(".today-sat img, .field-growth-canvas")).toHaveCount(0);
  await api.releaseB();
  await expect(page.getByRole("heading", { name: "What's growing on this field?" })).toBeVisible();
  await expect(page.getByRole("link", { name: "See your year plan" })).toHaveAttribute("href", "/planner");
  await expect(card(page, "weather")).toContainText("Weather on 1 Nov");
  await expect(card(page, "harvest")).toHaveCount(0);
  const alerts = page.getByRole("region", { name: "Alerts" });
  await expect(alerts.getByRole("listitem")).toHaveCount(1);
  await expect(alerts).toContainText("News and warnings search paused");
  await expect(page.getByText("Leaf-feeding pest window")).toHaveCount(0);
  await expect(slider(page)).toHaveCount(0);
});

test("a missing or unreachable Today endpoint shows the error state and keeps the care schedule", async ({ page }) => {
  const api = await mock(page, { today: "missing" });
  await page.goto("/farm");
  await expect(page.getByRole("heading", { name: "South field", exact: true })).toBeVisible();
  const error = page.getByRole("alert").filter({ hasText: "Today's field view is unavailable" });
  await expect(error).toContainText("not available on this server yet");
  const steps = page.getByRole("region", { name: "Upcoming steps" });
  await expect(steps).toContainText("From your crop care schedule");
  await expect(steps).toContainText("Check field moisture");
  await page.getByLabel("Selected farm", { exact: true }).selectOption(B);
  await expect(page.getByRole("heading", { name: "What's growing on this field?" })).toBeVisible();
  await page.getByLabel("Selected farm", { exact: true }).selectOption(A);
  await expect(page.getByRole("alert").filter({ hasText: "not available on this server yet" })).toBeVisible();
  api.state.today = "network";
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not reach the server" })).toBeVisible();
  api.state.today = "ok";
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "1 Nov 2026");
});

for (const theme of ["light", "dark"] as const)
  test(`${theme} theme at 390 px renders without horizontal overflow`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await mock(page);
    await openToday(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(card(page, "health")).toContainText("Near typical");
    const surface = await card(page, "price").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(surface).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(27, 31, 36)");
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noOverflow()).toBe(true);
    await page.getByRole("button", { name: "Satellite", exact: true }).click();
    await expect.poll(() => page.locator(".today-sat img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(96);
    expect(await noOverflow()).toBe(true);
    await page.getByRole("button", { name: "Illustration", exact: true }).click();
    await expect(page.locator(".field-growth-canvas")).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `../../docs/reference/redesign/today-mock-${theme}.png`, fullPage: true });
  });

test("recording the first planting replaces the empty state with the new cycle within one refetch, without a reload", async ({ page }) => {
  await mock(page);
  const fresh = { planted: false, plantBodies: [] as { cropId: string; productId?: string; expectedWorkspaceVersion: number }[], todayCalls: 0 };
  const newCycle = { ...maizeCycle, id: "new-cycle", stage: "sowed", sowingDate: "2026-11-01", establishmentDate: "2026-11-01" };
  const ws = () => ({ ...workspace(A), version: fresh.planted ? 2 : 1, cycles: fresh.planted ? [newCycle] : [] });
  // Registered after mock(), so these answers take precedence for farm A; everything else falls through to mock().
  await page.route(
    (url) => url.pathname.startsWith(`/api/v1/farms/${A}/`),
    async (route) => {
      const tail = new URL(route.request().url()).pathname.slice(`/api/v1/farms/${A}/`.length);
      if (tail === "today" && route.request().method() === "GET") {
        fresh.todayCalls++;
        return route.fulfill({ json: env(todaySchema.parse(fresh.planted ? todayFixture(A) : todayEmptyFixture(A))) });
      }
      if (tail === "workspace") return route.fulfill({ json: env(ws()) });
      if (tail === "command-center")
        return route.fulfill({
          json: env(
            commandSchema.parse({
              ...command(A, false),
              workspace: ws(),
              currentCycles: fresh.planted ? [{ cycle: newCycle, careTasks: [], limitations: ["This crop has no reviewed care schedule in the focused catalogue."] }] : [],
            }),
          ),
        });
      if (tail === "cycles" && route.request().method() === "POST") {
        fresh.plantBodies.push(route.request().postDataJSON());
        fresh.planted = true;
        return route.fulfill({ status: 201, json: env({ cycle: newCycle, workspace: ws(), journalEntryId: J, alreadyRecorded: false }) });
      }
      return route.fallback();
    },
  );
  await page.goto("/farm");
  await expect(page.getByRole("heading", { name: "What's growing on this field?" })).toBeVisible();
  // Leave Today and return, so the view mounts with the workspace already loaded: the live path where the first
  // workspace version change after mount used to be ignored (a fresh page load hid it).
  await page.getByRole("link", { name: "Market", exact: true }).first().click();
  await page.getByRole("link", { name: "Today", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "What's growing on this field?" })).toBeVisible();
  const callsBeforePlanting = fresh.todayCalls;
  await page.getByRole("button", { name: "Plant a crop" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Maize", exact: true }).check();
  await dialog.getByRole("button", { name: "Record planting", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fresh.plantBodies).toHaveLength(1);
  expect(fresh.plantBodies[0]).toMatchObject({ cropId: "maize", productId: "maize-grain", expectedWorkspaceVersion: 1 });
  // The view switches to the new cycle on its own: the slider appears and the empty prompt is gone.
  await expect(slider(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "What's growing on this field?" })).toHaveCount(0);
  expect(fresh.todayCalls - callsBeforePlanting).toBe(1); // exactly one refetch after the workspace version moved
});
