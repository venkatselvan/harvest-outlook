import { deflateSync } from "node:zlib";
import { readyModelReview } from "../src/workspace/farm/soilReviewFixtures";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  FarmCommandCenter as commandSchema,
  TodayView as todaySchema,
  type TodayView,
} from "@harvest/contracts";
import {
  fieldCheckStepFixture,
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
  conditionCheck?: boolean;
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
    if (options.conditionCheck && farmId === A) {
      const step = fieldCheckStepFixture({status: state.completed.has('condition') ? 'completed' : 'due'});
      if (step.status === 'completed') { step.fieldCheck!.completedOn = '2026-11-01'; step.fieldCheck!.journalEntryId = J; }
      view.upcoming = [step];
      view.nextAction = step.status === 'completed' ? null : step;
    }

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
    if (path.endsWith("/checks/complete") && method === "POST") {
      const body = route.request().postDataJSON();
      state.completed.add('condition');
      const check = {...fieldCheckStepFixture().fieldCheck!, status: 'completed', completedOn: body.completedOn, journalEntryId: J};
      return route.fulfill({status: 201, json: env({check, journalEntryId: J, alreadyCompleted: false})});
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
/** The page h1 on Today is the headline (TODAY_MAP_LAYOUT_SPEC.md); the fixture farm has no fields. */
const headline = (page: Page) => page.getByRole("heading", { level: 1, name: "Your farm today." });
/** The deeper cards sit behind the collapsed "More from Today" disclosure; open it (idempotent). */
async function openMore(page: Page) {
  const details = page.getByTestId("today-more").locator("details.today-more-details");
  await expect(details).toHaveCount(1);
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator(":scope > summary").click();
}
async function openToday(page: Page) {
  await page.goto("/farm");
  await expect(headline(page)).toBeVisible();
  await expect(slider(page)).toBeVisible();
  await openMore(page);
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
  await expect(card(page, "price")).toContainText("Historical mandi range");
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
  await expect(card(page, "weather")).toContainText("Seasonal reference, not a forecast");

  await page.getByRole("button", { name: "Back to today" }).click();
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "1 Nov 2026");
  await expect(slider(page)).toBeFocused();
  await expect(chip(page)).toContainText("Today");
  await slider(page).press("End");
  await expect(stage(page)).toContainText("Harvest window");
  await expect(chip(page)).toHaveText(/13 Jan 2027/);

  // Details live one tap away in a bottom sheet; Escape closes it.
  await card(page, "price").getByRole("button", { name: /details and sources/ }).click();
  const sheet = page.getByRole("dialog", { name: "Harvest-week price" });
  await expect(sheet).toContainText("not a forecast and not a farm-gate price");
  await expect(sheet).toContainText("Based on 3 years of Karnataka mandi prices");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("satellite view shows observed scene dates for past dates and a labelled illustration for future dates", async ({ page }) => {
  await mock(page);
  await openToday(page);
  await page.getByRole("button", { name: "Illustration", exact: true }).click();
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

test("Price context discloses the pending or ready outlook and its AI evidence", async ({ page }) => {
  await mock(page);
  let note: TodayView["outlookNote"] = { status: "pending", text: null, facts: [], origin: null, generatedAt: null, modelInvocation: null };
  await page.route("**/api/v1/farms/*/today", (route) => route.fulfill({ json: env(todaySchema.parse({ ...todayFixture(A), outlookNote: note })) }));
  await openToday(page);
  const card = page.locator('[data-card="price"]');
  await card.getByText("Price context", { exact: true }).click();
  await expect(card.getByTestId("today-outlook-note")).toHaveText(/Writing the outlook…/);
  note = todayFixture(A).outlookNote!;
  await page.reload();
  await openMore(page);
  await page.locator('[data-card="price"]').getByText("Price context", { exact: true }).click();
  const line = page.locator('[data-card="price"]').getByTestId("today-outlook-note");
  await expect(line).toContainText("Maize grain in Karnataka has usually fetched ₹19 to ₹24 per kg around harvest");
  await line.getByRole("button", { name: "AI used: Harvest price outlook in words" }).click();
  await expect(page.getByRole("dialog")).toContainText("Harvest price outlook in words");
  await page.keyboard.press("Escape");
  note = { status: "unavailable", text: null, facts: [], origin: null, generatedAt: null, modelInvocation: null };
  await page.reload();
  await openMore(page);
  await expect(page.locator('[data-card="price"]')).toContainText("₹19–24");
  await expect(page.locator('[data-card="price"]').getByTestId("today-outlook-note")).toHaveCount(0);
});

test("switching farms clears the view before the next farm loads", async ({ page }) => {
  const api = await mock(page, { holdB: true });
  await openToday(page);
  await expect(page.getByRole("region", { name: "Alerts" }).getByRole("listitem")).toHaveCount(3);
  await page.getByLabel("Selected farm", { exact: true }).selectOption(B);
  await expect(page.getByLabel("Selected farm", { exact: true })).toHaveValue(B);
  await expect.poll(() => api.state.todayFarms.includes(B)).toBe(true);
  await expect(page.getByRole("status", { name: "Loading today's field view" })).toBeVisible();
  await expect(slider(page)).toHaveCount(0);
  await expect(page.getByText("Heavy rain expected on 4 Nov")).toHaveCount(0);
  await expect(page.getByText("Check field moisture")).toHaveCount(0);
  await expect(page.locator(".today-sat img, .field-growth-canvas")).toHaveCount(0);
  await api.releaseB();
  await expect(page.getByRole("heading", { name: "What's growing on this field?" })).toBeVisible();
  await expect(page.getByRole("link", { name: "See your year plan" })).toHaveAttribute("href", "/planner");
  await openMore(page);
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
  await expect(headline(page)).toBeVisible();
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
  test(`system ${theme} preference keeps dark glass at 390 px without horizontal overflow`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await mock(page);
    await openToday(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(card(page, "health")).toContainText("Within the stage greenness range");
    // Financial cards now share one glass surface; verify the actual painted parent.
    const surface = await page.getByRole("region", { name: "Harvest outlook", exact: true }).evaluate((el) => {
      const actual = getComputedStyle(el);
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--glass-panel)";
      probe.style.color = "var(--text)";
      el.append(probe);
      const expected = getComputedStyle(probe);
      const result = {
        background: actual.backgroundColor, foreground: actual.color,
        expectedBackground: expected.backgroundColor, expectedForeground: expected.color,
        backdrop: actual.backdropFilter,
        supportsBlur: CSS.supports("backdrop-filter", "blur(1px)"),
      };
      probe.remove();
      return result;
    });
    expect(surface.background).toBe(surface.expectedBackground);
    expect(surface.foreground).toBe(surface.expectedForeground);
    expect(surface.foreground).not.toBe(surface.background);
    const channels = surface.background.match(/[\d.]+/g)!.map(Number);
    const opacity = channels.length === 4 ? channels[3]! : 1;
    expect(opacity).toBeGreaterThan(.5);
    expect(opacity).toBeLessThan(1);
    if (surface.supportsBlur) expect(surface.backdrop).toContain("blur(");
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noOverflow()).toBe(true);
    await page.getByRole("button", { name: "Satellite", exact: true }).click();
    await expect.poll(() => page.locator(".today-sat img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(96);
    expect(await noOverflow()).toBe(true);
    await page.getByRole("button", { name: "Illustration", exact: true }).click();
    await expect(page.locator(".field-growth-canvas")).toBeVisible();
    await page.getByRole("button", { name: "Satellite", exact: true }).click();
    await expect.poll(() => page.locator(".today-sat img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(96);
    await page.waitForTimeout(150);
    await page.screenshot({ path: testInfo.outputPath(`today-system-${theme}-dark-ui.png`), fullPage: true });
  });

test.describe("at 360 px", () => {
  test.use({ viewport: { width: 360, height: 740 } });
  test("satellite evidence and the compact condition card fit, with all raw indices in Details", async ({ page }) => {
    await mock(page);
    await openToday(page);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    // The code-only curve reading sits under the hero image, beside (not inside) the calendar stage label.
    const line = page.getByTestId("today-curve-line");
    await expect(line).toBeVisible();
    await expect(line).toContainText("Satellite curve: greening, green-up seen 2 Oct, in line with the calendar estimate");
    await expect(line).not.toContainText("reading of");
    await expect(stage(page)).not.toContainText("Satellite curve");
    await expect(stage(page)).toContainText("Vegetative");
    const lineBox = (await line.boundingBox())!;
    expect(lineBox.x).toBeGreaterThanOrEqual(0);
    expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(360);
    const info = line.getByRole("button", { name: "About the satellite curve reading" });
    const infoBox = (await info.boundingBox())!;
    expect(infoBox.width).toBeGreaterThanOrEqual(44);
    expect(infoBox.height).toBeGreaterThanOrEqual(44);

    // The compact condition card keeps the interpretation and raw NDVI; all other indices live in Details.
    await expect(card(page, "health")).toContainText("Within the stage greenness range");
    await expect(card(page, "health")).toContainText("NDVI 0.62");
    await expect(card(page, "health").getByTestId("today-index-line")).toHaveCount(0);
    expect(await noOverflow()).toBe(true);

    // Health sheet: all seven indices and the 20 m note, without sideways scrolling inside the sheet.
    await card(page, "health").getByRole("button", { name: /details and sources/ }).click();
    const health = page.getByRole("dialog", { name: "Crop condition" });
    await expect(health.locator(".today-index-row")).toHaveCount(7);
    await expect(health).toContainText("B5, B8A and B11 are 20 m bands resampled to the 10 m grid, so these three indices rest on fewer independent pixels.");
    await expect(health).toContainText("(B8 − B11) / (B8 + B11)");
    expect(await health.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(health).toHaveCount(0);

    // Curve sheet: the evidence-only line is always there and the calendar stage it is compared with is named.
    await line.scrollIntoViewIfNeeded();
    await info.click();
    const curve = page.getByRole("dialog", { name: "Satellite curve and the calendar" });
    await expect(curve).toContainText("Evidence only: the stage dates above are calendar estimates and are not changed by this reading.");
    await expect(curve).toContainText("Calendar stage compared");
    await expect(curve).toContainText("Vegetative");
    await expect(curve).toContainText("Basis:");
    expect(await curve.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(curve).toHaveCount(0);
    expect(await noOverflow()).toBe(true);
  });
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
  await page.getByRole("button", { name: "More", exact: true }).filter({ visible: true }).click();
  await page.locator(".more-menu-panel").getByRole("link", { name: "Market", exact: true }).click();
  await farmTab(page, "Today").click();
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

// Presentation regressions: every route stays inside the UI fixture, with no provider traffic.
const farmTab = (page: Page, label: string) => page.getByRole("navigation", { name: "Farm views" }).getByRole("link", { name: label, exact: true }).filter({ visible: true }).first();

test("Actions and Today preserve the slider day, scene mode and loaded Today resource", async ({ page }) => {
  const api = await mock(page);
  await openToday(page);
  await page.getByRole("button", { name: "Satellite", exact: true }).click();
  await press(page, "ArrowRight", 4);
  const chosenDay = await slider(page).getAttribute("aria-valuetext");
  const loads = api.state.todayFarms.length;
  await farmTab(page, "Actions").click();
  await expect(page.getByTestId("today-actions")).toBeVisible();
  await expect(slider(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Upcoming steps" })).toBeVisible();
  await farmTab(page, "Today").click();
  await expect(slider(page)).toHaveAttribute("aria-valuetext", chosenDay!);
  await expect(page.getByRole("button", { name: "Satellite", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(api.state.todayFarms).toHaveLength(loads);
});

test("opening Actions pauses season playback and retains the paused day", async ({ page }) => {
  await mock(page);
  await openToday(page);
  await page.getByTestId("today-play").click();
  await expect.poll(() => slider(page).inputValue()).not.toBe("47");
  await farmTab(page, "Actions").click();
  await expect(page.getByTestId("today-actions")).toBeVisible();
  await farmTab(page, "Today").click();
  await expect(page.getByTestId("today-play")).toHaveAttribute("aria-pressed", "false");
  const pausedDay = await slider(page).inputValue();
  // Four player intervals: an accidentally running hidden player would advance the day.
  await page.waitForTimeout(500);
  await expect(slider(page)).toHaveValue(pausedDay);
});

test("Actions retains care rollback, retry idempotency and alert dismissal across presentations", async ({ page }) => {
  const api = await mock(page, { failFirstCare: true });
  await openToday(page);
  await farmTab(page, "Actions").click();
  const steps = page.getByRole("region", { name: "Upcoming steps" });
  const moisture = steps.getByTestId("today-next-action");
  await moisture.getByRole("button", { name: "Mark done: Check field moisture" }).click();
  await expect.poll(() => api.state.careBodies.length).toBe(1);
  await expect(moisture.locator(".today-chip")).toHaveText("Done");
  await api.failHeldCare();
  await expect(steps.getByRole("alert")).toContainText("Simulated failure");
  await expect(moisture.locator(".today-chip")).toHaveCount(0);
  await moisture.getByRole("button", { name: "Mark done: Check field moisture" }).click();
  await expect.poll(() => api.state.careBodies.length).toBe(2);
  expect(api.state.careKeys[1]).toBe(api.state.careKeys[0]);
  await expect(moisture.locator(".today-chip")).toHaveText("Done");
  const alerts = page.getByRole("region", { name: "Alerts" });
  await alerts.getByRole("button", { name: "Dismiss alert: Maize prices fell 9% in 30 days" }).click();
  await expect.poll(() => api.state.dismissPaths.length).toBe(1);
  await farmTab(page, "Today").click();
  await expect(page.locator(`[data-alert-id="${FIXTURE_ALERT_IDS.price}"]`)).toHaveCount(0);
  await expect(page.getByTestId("today-next-action").locator(".today-chip")).toHaveText("Done");
});

test("desktop groups all eight cards around the field and retains every disclosure and detail action", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mock(page);
  await openToday(page);
  const brief = page.getByTestId("today-overview");
  const primary = page.locator(".today-map-left > .today-primary");
  const conditions = page.getByRole("region", { name: "Weather and harvest", exact: true });
  const outlook = page.getByRole("region", { name: "Harvest outlook", exact: true });
  const planning = page.getByRole("region", { name: "Planning references", exact: true });
  for (const kind of ["health", "weather", "harvest", "profit", "price", "residue", "energy", "carbon"]) {
    await expect(card(page, kind)).toHaveCount(1);
  }
  await expect(page.getByTestId("today-more").locator('[data-card="health"]')).toBeVisible();
  await expect(conditions.locator(".today-card")).toHaveCount(2);
  await expect(outlook.locator(".today-card")).toHaveCount(3);
  await expect(planning.locator('[data-card="energy"]')).toBeHidden();
  await planning.locator("summary").click();
  await expect(card(page, "energy")).toBeVisible();
  await expect(card(page, "carbon")).toBeVisible();
  // Every grouped card still opens its original sheet, including both planning references.
  for (const kind of ["health", "weather", "harvest", "profit", "price", "residue", "energy", "carbon"]) {
    await card(page, kind).getByRole("button", { name: /details and sources/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await planning.locator("summary").click();
  await brief.getByRole("button", { name: "Review next step", exact: true }).click();
  await expect(page.locator('[data-step-id="care:task-moisture"]')).toBeFocused();
  await brief.locator("summary").click();
  for (const point of todayFixture(A).overview!.points) await expect(brief.getByText(point.text, { exact: true })).toBeVisible();
  await brief.locator('[data-ref-id="profit"]').click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await brief.locator("summary").click();
  // Map layout: left column (glance, hero, gauges), open centre, right column (attention, week, Evara), then More.
  const leftBox = (await page.locator(".today-map-left").boundingBox())!;
  const centreBox = (await page.getByTestId("today-map-centre").boundingBox())!;
  const rightBox = (await page.locator(".today-map-right").boundingBox())!;
  const moreBox = (await page.getByTestId("today-more").boundingBox())!;
  expect(leftBox.x + leftBox.width).toBeLessThanOrEqual(centreBox.x + 1);
  expect(centreBox.x + centreBox.width).toBeLessThanOrEqual(rightBox.x + 1);
  expect(leftBox.width).toBeLessThanOrEqual(361);
  expect(rightBox.width).toBeLessThanOrEqual(341);
  expect(moreBox.y).toBeGreaterThanOrEqual(Math.max(leftBox.y + leftBox.height, rightBox.y + rightBox.height) - 1);
  expect((await primary.boundingBox())!.y).toBeGreaterThan(leftBox.y);
  await expect(headline(page)).toBeVisible();
  for (const id of ["today-glance", "today-gauges", "today-attention", "today-week", "today-evara"]) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("today-gauges").locator("[data-basis]")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("today-grouped-desktop.png"), fullPage: true });
});

test("compact crop card links the existing satellite check and keeps profit arithmetic explicit", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mock(page);
  const view = todayFixture(A);
  const alert = view.alerts.find((item) => item.id === FIXTURE_ALERT_IDS.weather)!;
  alert.type = "satellite";
  alert.title = "Greenness changed in part of this field";
  alert.detail = "The synthetic satellite comparison flags a patch for a field check. Inspect it before deciding what to do.";
  alert.source.name = "Satellite fixture";
  const linkedStep = view.upcoming.find((step) => step.alertId === alert.id)!;
  linkedStep.title = "Inspect the patch in the satellite image";
  linkedStep.detail = "Check the marked patch on the ground before making a decision.";
  alert.suggestedStep = "Inspect the patch named in the satellite alert before deciding what to do";
  await page.route("**/api/v1/farms/*/today", (route) => route.fulfill({ json: env(todaySchema.parse(view)) }));
  await openToday(page);
  const condition = card(page, "health");
  await expect(condition).toContainText("Within the stage greenness range");
  await expect(condition.getByRole("link", { name: "Review suggested field check" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("today-compact-alert-profit.png"), fullPage: true });
  await page.getByRole("region", { name: "Harvest outlook", exact: true }).screenshot({ path: testInfo.outputPath("today-harvest-outlook.png") });
  await condition.getByRole("link", { name: "Review suggested field check" }).click();
  await expect(page.locator(`[data-step-id="alert:${FIXTURE_ALERT_IDS.weather}"]`)).toBeFocused();
  const arithmetic = card(page, "profit").getByRole("table", { name: "Revenue minus costs equals profit" });
  await expect(arithmetic.getByRole("row").nth(0)).toHaveText("Revenue₹1,52,400");
  await expect(arithmetic.getByRole("row").nth(1)).toHaveText("− Costs₹57,600");
  await expect(arithmetic.getByRole("row").nth(2)).toContainText("= Profit₹94.8k");
  await card(page, "residue").getByRole("button", { name: /details and sources/ }).click();
  await expect(page.getByRole("dialog")).toContainText("The incomes do not add up");
  await expect(page.getByRole("dialog")).toContainText("Dry fodder");
});

for (const width of [360, 390]) {
  test(`unavailable satellite explanation and stage metadata remain separate at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await mock(page);
    await page.route("**/api/v1/farms/*/ndvi/**", (route) => route.abort());
    await openToday(page);
    const message = page.locator(".today-sat > .today-hero-message");
    await expect(message).toContainText("The image could not load. Try again later.");
    const explanation = (await message.boundingBox())!;
    const metadata = (await page.locator(".today-hero-overlay").boundingBox())!;
    expect(metadata.y).toBeGreaterThanOrEqual(explanation.y + explanation.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`today-unavailable-${width}-viewport.png`) });
    await page.screenshot({ path: testInfo.outputPath(`today-unavailable-${width}.png`), fullPage: true });
  });
}

test('Field Image reviews EXIF dates, predicts from one photo at the slider date, compares and enforces six photos', async ({ page }) => {
  await mock(page);
  const photoId = '44444444-4444-4444-8444-444444444444';
  const mediaId = '55555555-5555-4555-8555-555555555555';
  const predictionId = '66666666-6666-4666-8666-666666666666';
  let photos: Array<{id: string; mediaId: string; capturedOn: string; createdAt: string; imagePath: string}> = [];
  let predictions: Array<{id: string; photoId: string; sourceDate: string; targetDate: string; status: string; imagePath: string | null; failureReason: null}> = [];
  const predictBodies: unknown[] = [];
  let uploads = 0, reads = 0;
  await page.route('**/api/v1/media**', async route => {
    if (route.request().method() === 'POST') {
      uploads++;
      return route.fulfill({status: 201, json: env({id: mediaId, contentPath: `/api/v1/media/${mediaId}/content`, exifCreatedAt: '2026-10-20'})});
    }
    return route.fulfill({contentType: 'image/png', body: observedPng});
  });
  await page.route('**/api/v1/farms/**/field-photos**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/image')) return route.fulfill({contentType: 'image/png', body: illustrationPng});
    if (path.endsWith('/predict')) {
      const body = route.request().postDataJSON(); predictBodies.push(body);
      predictions = [{id: predictionId, photoId, sourceDate: photos[0]!.capturedOn, targetDate: body.targetDate, status: 'queued', imagePath: null, failureReason: null}];
      return route.fulfill({status: 202, json: env(predictions[0])});
    }
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON().photos[0];
      photos = [{id: photoId, mediaId: input.mediaId, capturedOn: input.capturedOn, createdAt: asOf, imagePath: `/api/v1/media/${mediaId}/content`}];
    }
    if (predictions.length && route.request().method() === 'GET') {
      predictions[0]!.status = 'ready';
      predictions[0]!.imagePath = `${path}/predictions/${predictionId}/image`;
    }
    reads++;
    return route.fulfill({json: env({photos, predictions})});
  });
  await page.goto('/farm');
  await expect(slider(page)).toBeVisible();
  expect(reads).toBe(0); // no photo network request while another view is open
  await page.getByRole('button', {name: 'Field Image', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Add your field photos'})).toBeVisible();
  const file = {name: 'field.jpg', mimeType: 'image/jpeg', buffer: observedPng};
  await page.getByLabel('Upload field photos', {exact: true}).setInputFiles(file);
  await expect(page.getByLabel('Date taken for field.jpg')).toHaveValue('2026-10-20');
  await page.getByLabel('Date taken for field.jpg').fill('2026-10-21');
  await page.getByRole('button', {name: 'Save photo dates'}).click();
  await expect(page.getByRole('img', {name: 'Field photo taken 21 Oct 2026', exact: true})).toBeVisible();
  await press(page, 'ArrowRight', 12);
  await page.getByRole('button', {name: 'Predict with AI', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Predicting…'})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Compare original'})).toBeVisible({timeout: 10000});
  expect(predictBodies).toEqual([{targetDate: '2026-11-13'}]);
  await expect(page.getByTestId('field-images')).toContainText('not an observation');
  await page.getByRole('button', {name: 'Compare original'}).click();
  await expect(page.getByRole('img', {name: 'Field photo taken 21 Oct 2026', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Show AI prediction'}).click();
  await page.getByLabel('Upload field photos', {exact: true}).setInputFiles(Array.from({length: 6}, (_, i) => ({...file, name: `field-${i}.jpg`})));
  await expect(page.getByTestId('field-images').getByRole('alert')).toContainText('up to 6 photos');
  expect(uploads).toBe(1);
  await page.getByRole('button', {name: 'Satellite', exact: true}).click();
  await page.getByRole('button', {name: 'Field Image', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Compare original'})).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.locator('.today-hero').screenshot({path: '../../output/field-image-mobile.png'});
  await page.setViewportSize({width: 1440, height: 1000});
  await page.locator('.today-hero').screenshot({path: '../../output/field-image-desktop.png'});
});


test("grouped layout retains soil evidence and notes across phone, tablet and desktop widths", async ({ page }, testInfo) => {
  await mock(page);
  await page.route("**/api/v1/farms/*/soil-review**", route => route.fulfill({ json: env(readyModelReview) }));
  await page.route("**/api/v1/farms/*/issues**", route => route.fulfill({ json: env({
    farmId: A, asOf: "2026-11-01", issues: [], counts: { open: 0, treating: 0, resolved: 0, dismissed: 0 }, limitations: [],
  }) }));
  await openToday(page);
  const soil = page.getByTestId("today-soil");
  const brief = page.getByTestId("today-overview");
  await expect(soil.getByRole("list", { name: "Confirmed soil values" })).toBeVisible();
  await expect(soil).toContainText("7.2");
  await expect(soil).toContainText("0.86");
  for (const width of [360, 768, 1100, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await soil.locator("summary").click();
    await expect(soil.getByText("Soil pH 7.2 rates neutral and salinity is normal.", { exact: true })).toBeVisible();
    await brief.locator("summary").focus();
    await page.keyboard.press("Enter");
    for (const point of todayFixture(A).overview!.points) await expect(brief.getByText(point.text, { exact: true })).toBeVisible();
    // Check actual card bounds too: overflow-x: clip on the page must not hide a broken grid.
    const overflowing = await page.locator(".today-map-layout .today-card, .today-overview, .today-soil, .today-map-panel").evaluateAll(elements =>
      elements.filter(el => { const box = el.getBoundingClientRect(); return box.x < 0 || box.right > window.innerWidth || el.scrollWidth > el.clientWidth + 1; }).map(el => el.getAttribute("data-card") ?? el.className));
    expect(overflowing).toEqual([]);
    await soil.locator("summary").click();
    await brief.locator("summary").click();
    await headline(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`today-redesign-${width}.png`), fullPage: true });
    if (width === 1440) await page.screenshot({ path: testInfo.outputPath("today-redesign-desktop-viewport.png") });
  }
});

test('Field Image prediction and photo controls stay inside the card at every screen size', async ({page}, testInfo) => {
  await mock(page);
  const photoId = '44444444-4444-4444-8444-444444444444', mediaId = '55555555-5555-4555-8555-555555555555';
  await page.route('**/api/v1/media/**', route => route.fulfill({contentType: 'image/png', body: observedPng}));
  await page.route('**/api/v1/farms/**/field-photos**', route => route.fulfill({json: env({
    photos: [{id: photoId, mediaId, capturedOn: '2026-10-20', createdAt: asOf, imagePath: `/api/v1/media/${mediaId}/content`}], predictions: [],
  })}));
  await openToday(page);
  await page.getByRole('button', {name: 'Field Image', exact: true}).click();
  const predict = page.getByRole('button', {name: 'Predict with AI', exact: true});
  await expect(predict).toBeEnabled();
  for (const width of [1440, 2048, 1100, 768, 360]) {
    await page.setViewportSize({width, height: 1000});
    const frame = await page.locator('.today-hero-frame').boundingBox();
    const timeline = await page.locator('.today-hero-timeline').boundingBox();
    expect(timeline!.x + timeline!.width).toBeLessThanOrEqual(width);
    expect(timeline!.y).toBeGreaterThan(frame!.y);
    // Visibility alone misses clipping by an overflow:hidden ancestor.
    const clipped = await page.locator('.field-image-action, .field-images-toolbar, .field-image-thumbnails').evaluateAll(elements =>
      elements.filter(el => {
        const card = el.closest('.today-hero-frame')!.getBoundingClientRect(), box = el.getBoundingClientRect();
        return box.bottom > card.bottom || box.right > card.right || box.left < card.left;
      }).map(el => el.className));
    expect(clipped, `Controls clipped at ${width}px`).toEqual([]);
    await predict.click({trial: true});
    await page.locator('.today-hero').screenshot({path: testInfo.outputPath(`field-image-controls-${width}.png`)});
  }
});

test('Field Image replaces an outdated preview and explains maturity and seasonal weather', async ({page}) => {
  await mock(page);
  const photoId = '44444444-4444-4444-8444-444444444444', mediaId = '55555555-5555-4555-8555-555555555555';
  const oldId = '66666666-6666-4666-8666-666666666666', newId = '77777777-7777-4777-8777-777777777777';
  const photo = {id: photoId, mediaId, capturedOn: '2026-10-20', createdAt: asOf, imagePath: `/api/v1/media/${mediaId}/content`};
  const old = {id: oldId, photoId, sourceDate: '2026-10-20', targetDate: '2026-11-01', status: 'ready', imagePath: `/api/v1/farms/${A}/cycles/maize-cycle/field-photos/predictions/${oldId}/image`, failureReason: null, promptVersion: 'field-photo-v1', outdated: true};
  const updated = {...old, id: newId, imagePath: old.imagePath.replace(oldId,newId), promptVersion: 'field-photo-v2', outdated: false,
    guidance: {sourceStage: 'Initial', targetStage: 'Ripening / estimated harvest window', elapsedDays: 12, targetAgeDays: 119,
      growth: 'Dense mature crop with grain-filled panicles.', change: 'senescing', weather: {kind: 'typical', summary: 'Seasonal weather scenario', rainMm: 0.2, tMinC: 18, tMaxC: 29, sunshineHours: null, source: 'WEA-openmeteo-archive', issuedAt: null},
      interval: {from: '2026-10-20', to: '2026-11-01', observedDays: 0, forecastDays: 6, typicalDays: 6, missingDays: 0, rainMm: 10, meanTempC: 23},
      limitations: ['Seasonal averages cannot tell whether this exact day will be sunny or rainy.'], sources: []}};
  let regenerated = false;
  await page.route('**/api/v1/media/**', route => route.fulfill({contentType: 'image/png', body: observedPng}));
  await page.route('**/api/v1/farms/**/field-photos**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/image')) return route.fulfill({contentType: 'image/png', body: illustrationPng});
    if (path.endsWith('/predict')) {expect(route.request().postDataJSON()).toEqual({targetDate:'2026-11-01'}); regenerated = true; return route.fulfill({status: 202, json: env(updated)});}
    return route.fulfill({json: env({photos: [photo], predictions: regenerated ? [old, updated] : [old]})});
  });
  await openToday(page);
  await page.getByRole('button', {name: 'Field Image', exact: true}).click();
  await expect(page.getByText('This preview used older growth guidance without target-day weather.')).toBeVisible();
  await page.getByRole('button', {name: 'Regenerate with stage & weather'}).click();
  await expect(page.getByTestId('field-images')).toContainText('Exact weather on this date is not yet forecast');
  await expect(page.getByRole('button', {name: 'Regenerate with stage & weather'})).toHaveCount(0);
  await page.locator('.field-image-evidence summary').click();
  await expect(page.getByTestId('field-images')).toContainText('grain-filled panicles');
  await expect(page.getByTestId('field-images')).toContainText('cannot tell whether this exact day will be sunny or rainy');
  await page.getByRole('button', {name: 'Satellite', exact: true}).click();
  await page.getByRole('button', {name: 'Field Image', exact: true}).click();
  await expect(page.getByTestId('field-images').locator('.field-image-photo img')).toHaveAttribute('src', new RegExp(newId));
});

test('milestone buttons move the in-card timeline and dated photos show expected versus actual', async ({page}, testInfo) => {
  await mock(page);
  const photoId='44444444-4444-4444-8444-444444444444',mediaId='55555555-5555-4555-8555-555555555555';
  const predictionId='66666666-6666-4666-8666-666666666666';
  await page.route('**/api/v1/media/**',route=>route.fulfill({contentType:'image/png',body:observedPng}));
  await page.route('**/api/v1/farms/**/field-photos**',route=>route.fulfill(new URL(route.request().url()).pathname.endsWith('/image') ? {contentType:'image/png',body:illustrationPng} : {json:env({
    photos:[{id:photoId,mediaId,capturedOn:'2026-11-01',createdAt:'2026-11-01T10:00:00Z',imagePath:`/api/v1/media/${mediaId}/content`}],
    predictions:[{id:predictionId,photoId,sourceDate:'2026-10-20',targetDate:'2026-11-01',createdAt:'2026-10-25T10:00:00Z',status:'ready',failureReason:null,imagePath:`/api/v1/farms/${A}/cycles/maize-cycle/field-photos/predictions/${predictionId}/image`}],
  })}));
  await openToday(page);
  for (const width of [390,1440]) {
    await page.setViewportSize({width,height:1000});
  for (const mode of ['Illustration','Satellite','Field Image']) {
    await page.getByRole('button',{name:mode,exact:true}).click();
    await expect(page.locator('.today-hero-frame').getByRole('slider')).toBeVisible();
    const box = await page.locator('.today-hero-frame').boundingBox(); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    const timeline = (await page.locator('.today-hero-timeline').boundingBox())!;
    const visual = (await page.locator('.today-hero-visual').boundingBox())!;
    expect(visual.y).toBeGreaterThanOrEqual(timeline.y + timeline.height);
    // The hero sits in the 360 px left column of the map layout at a reduced height (TODAY_MAP_LAYOUT_SPEC.md).
    if (mode !== 'Field Image') expect(visual.height).toBeGreaterThanOrEqual(200);
    const before = page.getByRole('button',{name:/Day before estimated harvest/});
    await before.click();
    await expect(before).toHaveAttribute('aria-pressed','true');
    await page.getByRole('button',{name:'Back to today',exact:true}).click();
      await page.locator('.today-hero').screenshot({path:testInfo.outputPath(`milestones-${mode}-${width}.png`)});
  }
  }
  await page.getByText('Expected vs actual · 1 Nov 2026',{exact:true}).click();
  await expect(page.getByAltText('Expected crop appearance')).toBeVisible();
  await expect(page.getByAltText('Actual field observation')).toBeVisible();
  await expect(page.getByText('This prediction was saved before the actual photo was added.',{exact:false})).toBeVisible();
});

for (const mode of ['Illustration', 'Satellite', 'Field Image']) {
  test(`dragged season date survives a background prediction refresh in ${mode}`, async ({ page }) => {
    const { state } = await mock(page);
    let polls = 0;
    let pendingPoll: Route | undefined;
    await page.route('**/season-predictions', route => {
      if (++polls > 1) { pendingPoll = route; return; }
      return route.fulfill({ json: env({ state: 'running', pending: 1, result: null }) });
    });
    await openToday(page);
    await expect.poll(() => state.todayFarms.length).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: mode, exact: true }).click();
    await expect.poll(() => !!pendingPoll, { timeout: 10000 }).toBe(true);
    await slider(page).scrollIntoViewIfNeeded();
    const originalInput = (await slider(page).elementHandle())!;
    const rail = (await slider(page).boundingBox())!;
    const x = (fraction: number) => rail.x + 12 + (rail.width - 24) * fraction;
    await page.mouse.move(x(47 / 120), rail.y + rail.height / 2);
    await page.mouse.down();
    await page.mouse.move(x(.8), rail.y + rail.height / 2, { steps: 12 });
    await page.mouse.up();
    const selected = await slider(page).inputValue();
    const selectedDate = await slider(page).getAttribute('aria-valuetext');
    expect(Number(selected)).toBeGreaterThan(85);
    const requests = state.todayFarms.length;
    await pendingPoll!.fulfill({ json: env({ state: 'succeeded', pending: 0, result: null }) });
    await expect.poll(() => state.todayFarms.length).toBeGreaterThan(requests);
    await expect(page.locator('.today-milestone-status summary')).toHaveText('Automatic milestone previews');
    expect(await originalInput.evaluate(input => input.isConnected)).toBe(true);
    await expect(slider(page)).toHaveValue(selected);
    await expect(chip(page)).toHaveText(selectedDate!);
  });
}


test("condition field checks explain the reason and stay completed after refresh", async ({ page }) => {
  await mock(page, {conditionCheck: true});
  await openToday(page);
  const details = page.getByTestId("sc-check-details");
  await expect(details).toContainText("Maize leaf damage risk");
  await expect(page.getByText("Your check interval", {exact: false})).toHaveCount(0);
  await details.getByText("What to check", {exact: true}).click();
  await expect(details).toContainText("look for fresh feeding on young leaves");
  await expect(details).not.toContainText("Anything different from last week");
  await page.getByRole("button", {name: "Mark done: Check Maize on North strip", exact: true}).click();
  const sheet = page.getByRole("dialog", {name: "Check Maize on North strip"});
  await sheet.getByRole("radio", {name: "Nothing found", exact: true}).check();
  await sheet.getByRole("button", {name: "Save check", exact: true}).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Mark done: Check Maize on North strip", exact: true})).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("sc-check-details")).toContainText("Maize leaf damage risk");
  await expect(page.getByRole("button", {name: "Mark done: Check Maize on North strip", exact: true})).toHaveCount(0);
});
