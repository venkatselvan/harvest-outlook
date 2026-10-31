import { expect, test, type Page, type Route } from "@playwright/test";

// Pure browser regressions: every API route is intercepted; no session, farm or paid provider is touched.
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const envelope = (data: unknown) => ({
  schemaVersion: "1.0",
  requestId: "test",
  mode: "synthetic",
  asOf: "2026-10-30T00:00:00Z",
  data,
  warnings: [],
  error: null,
});
const farm = (id: string, name: string) => ({
  id,
  name,
  location: {
    districtId: "IN-KA-hassan",
    districtName: "Hassan",
    stateCode: "IN-KA",
    precision: "district",
  },
  areaHectares: 1,
  facts: {},
});
const workspace = (id: string) => ({
  farmId: id,
  version: 1,
  updatedAt: "2026-10-30T00:00:00Z",
  boundary: null,
  previousHarvest: { status: "unknown" },
  cycles: [],
  rotationPlans:
    id === B
      ? [
          {
            id: "rice-season",
            year: 2026,
            season: "Rabi",
            cropId: "rice",
            cropName: "Rice",
            plannedSowingDate: "2026-11-01",
          },
        ]
      : [],
});
const turn = {
  status: "approved",
  provenance: "synthetic_fixture",
  traceId: "qa",
  intent: "plan_question",
  language: "en",
  gateStatus: "approved",
  answerBlocks: [
    {
      id: "b",
      kind: "text",
      text: "Late answer for Farm Alpha",
      numericRefIds: [],
      claimIds: [],
    },
  ],
  numericRefs: [],
  claimEvidenceRefs: [],
  clarifications: [],
  approvedText: null,
  approvedTextHash: null,
  limitations: [],
  incomplete: null,
  costEstimate: {
    estimatedUsd: 0,
    settledUsd: 0,
    providerCalls: 0,
    billable: false,
    basis: "estimated_not_billed",
  },
};
async function fixture(page: Page) {
  let ended = false;
  let turnRoute: Route | undefined;
  let turnBody: Record<string, unknown> | undefined;
  let putRoute: Route | undefined;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/assistant/turns") {
      turnRoute = route;
      turnBody = route.request().postDataJSON();
      return;
    }
    if (path.endsWith("/workspace") && route.request().method() === "PUT") {
      putRoute = route;
      return;
    }
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "test" }
        : path === "/api/v1/farms"
          ? {
              farms: ended ? [] : [farm(A, "Farm Alpha"), farm(B, "Farm Beta")],
            }
          : path.endsWith("/workspace")
            ? workspace(path.includes(A) ? A : B)
            : path.endsWith("/monitoring")
              ? {
                  checkedAt: "2026-10-30T00:00:00Z",
                  weather: {
                    status: "unavailable",
                    reason: "missing",
                    issuedAt: null,
                    attribution: "",
                    point: null,
                    days: [],
                  },
                  market: {
                    status: "unavailable",
                    reason: "missing",
                    products: [],
                  },
                  meta: {
                    status: "unavailable",
                    reason: "test",
                    automatic: false,
                  },
                }
              : path === "/api/v1/crops"
                ? {
                    crops: [
                      { cropId: "ginger", name: "Ginger", products: [] },
                      { cropId: "rice", name: "Rice", products: [] },
                    ],
                  }
                : path === "/api/v1/districts"
                  ? {
                      areas: [],
                      districts: [],
                      districtListAvailable: false,
                      note: null,
                    }
                  : {};
    await route.fulfill({ json: envelope(data) });
  });
  return {
    get turnBody() {
      return turnBody;
    },
    get putRoute() {
      return putRoute;
    },
    async answer() {
      await turnRoute!.fulfill({ json: envelope(turn) });
    },
    async finishSave() {
      const id = putRoute!.request().url().includes(A) ? A : B;
      await putRoute!.fulfill({
        json: envelope({
          ...workspace(id),
          ...putRoute!.request().postDataJSON(),
          version: 2,
        }),
      });
    },
    end() {
      ended = true;
    },
  };
}

test("assistant captures farm/language and ignores an answer completed after farm switching", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/ask");
  await expect(page.getByLabel("Selected farm")).toHaveValue(A);
  await page.getByLabel("Assistant language").selectOption("hi");
  await page.getByLabel("Message Evara").fill("Question for alpha");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => api.turnBody?.farmId).toBe(A);
  expect(api.turnBody?.language).toBe("hi");
  await page.getByLabel("Selected farm").selectOption(B);
  await api.answer();
  await expect(
    page.getByText("Late answer for Farm Alpha", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Selected farm").selectOption(A);
  await expect(
    page.getByText("Late answer for Farm Alpha", { exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.entries(sessionStorage).some(
        ([k, v]) =>
          k.startsWith("ho.chat.") && v.includes("Late answer for Farm Alpha"),
      ),
    ),
  ).toBe(false);
});

test("session end purges transcript state and prevents a pending answer from being restored", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/ask");
  await expect(page.getByLabel("Selected farm")).toHaveValue(A);
  await page.getByLabel("Message Evara").fill("Question before ending session");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => api.turnBody?.farmId).toBe(A);
  api.end();
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("ho:session-ended")),
  );
  await api.answer();
  await expect(
    page.getByText("Late answer for Farm Alpha", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Message Evara")).toHaveValue("");
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter(
        (k) => k.startsWith("ho.chat.") && k !== "ho.chat.sessionScope",
      ),
    ),
  ).toEqual([]);
});

test("ho:ask composes a review and an old farm save cannot replace the selected farm workspace", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/planner");
  await expect(page.getByLabel("Selected farm")).toHaveValue(A);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("ho:ask", {
        detail: { text: "Review weather and market evidence" },
      }),
    ),
  );
  await expect(page.getByLabel("Message Evara")).toHaveValue(
    "Review weather and market evidence",
  );
  await page
    .getByRole("button", { name: "Close assistant", exact: true })
    .click();
  await page.getByRole("button", { name: "Add a season", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Crop", exact: true })
    .selectOption("ginger");
  await page.getByRole("button", { name: "Save season", exact: true }).click();
  await expect.poll(() => !!api.putRoute).toBe(true);
  expect(api.putRoute!.request().url()).toContain(A);
  await page.getByLabel("Selected farm").selectOption(B);
  await api.finishSave();
  await expect(page.locator(".rotation-board")).toContainText("Rice");
  await expect(page.locator(".rotation-board")).not.toContainText("Ginger");
});

test("harvest history waits for the selected farm instead of copying the prior farm during loading", async ({
  page,
}) => {
  const api = await fixture(page);
  let delayed: Route | undefined;
  await page.route(`**/api/v1/farms/${A}/workspace`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: envelope({
        ...workspace(A),
        previousHarvest: {
          status: "known",
          cropId: "ginger",
          cropName: "Ginger",
          harvestDate: "2026-10-01",
        },
      }),
    });
  });
  await page.route(`**/api/v1/farms/${B}/workspace`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    delayed = route;
  });
  await page.goto("/farm/manage");
  await expect(page.getByLabel("Selected farm")).toHaveValue(A);
  await expect(page.locator(".harvest-history-card")).toContainText("Ginger");
  await page.getByLabel("Selected farm").selectOption(B);
  await expect.poll(() => !!delayed).toBe(true);
  await page
    .locator(".harvest-history-card")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Save harvest history", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("combobox", { name: "Previous crop", exact: true }),
  ).toHaveCount(0);
  await delayed!.fulfill({ json: envelope(workspace(B)) });
  await expect(
    dialog.getByRole("button", { name: "Save harvest history", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("combobox", { name: "Previous crop", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Save harvest history", exact: true })
    .click();
  await expect.poll(() => !!api.putRoute).toBe(true);
  expect(api.putRoute!.request().url()).toContain(B);
  expect(api.putRoute!.request().postDataJSON().previousHarvest).toEqual({
    status: "unknown",
  });
  await api.finishSave();
  await expect(dialog).toHaveCount(0);
});
