import { expect, test, type Page, type Route } from "@playwright/test";
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const envelope = (data: unknown) => ({
  requestId: "test",
  mode: "synthetic",
  asOf: "2026-10-30T00:00:00Z",
  data,
  warnings: [],
  error: null,
});
const boundary = {
  type: "Polygon",
  coordinates: [
    [
      [76.94, 11.01],
      [76.945, 11.01],
      [76.945, 11.015],
      [76.94, 11.01],
    ],
  ],
};
const farm = (id: string, demo = false) => ({
  id,
  name: demo ? "Demo teaching farm" : "Existing real farm",
  location: {
    stateCode: "IN-TN",
    districtId: "IN-TN-coimbatore",
    districtName: "Coimbatore",
    lat: 11.012,
    lon: 76.943,
    precision: "precise",
  },
  areaHectares: 2,
  facts: demo
    ? {
        demo_prefilled: { value: true },
        demo_source: {
          value:
            "Real teaching-campus location; only the field outline is prefilled.",
        },
      }
    : {},
});
const workspace = (id: string, b = boundary) => ({
  farmId: id,
  version: 1,
  boundary: b,
  previousHarvest: { status: "unknown" },
  cycles: [],
  rotationPlans: [],
  updatedAt: "2026-10-30T00:00:00Z",
});
const boundaryContext = {
  suggestedName: "Coimbatore farm",
  location: {
    stateId: "IN-TN",
    stateName: "Tamil Nadu",
    districtId: "IN-TN-coimbatore",
    districtName: "Coimbatore",
    countryCode: "IN",
    source: "geoBoundaries administrative lookup",
    status: "resolved",
    uncertainties: [],
  },
  areaHectares: 2,
  centroid: { lat: 11.012, lon: 76.943 },
  sources: [],
};
async function fixture(
  page: Page,
  options: {
    existing?: boolean;
    holdContext?: boolean;
    unlistedDistrict?: boolean;
  } = {},
) {
  let contextRoute: Route | undefined;
  const contextData = () =>
    options.unlistedDistrict
      ? {
          ...boundaryContext,
          location: {
            ...boundaryContext.location,
            districtId: null,
            districtName: "Unlisted local division",
          },
        }
      : boundaryContext;
  let putBody: Record<string, unknown> | undefined;
  let realCreated = false;
  let demoCreated = false;
  let demoCalls = 0;
  const demoWorkspace = () => ({
    ...workspace(B),
    version: demoCalls >= 2 ? 2 : 1,
    boundary:
      demoCalls >= 2
        ? {
            type: "Polygon",
            coordinates: [
              [
                [76.94, 11.01],
                [76.945, 11.01],
                [76.945, 11.015],
                [76.94, 11.015],
                [76.94, 11.01],
              ],
            ],
          }
        : boundary,
  });
  let planningCalls = 0;
  let metaActive = false;
  let chatRoute: Route | undefined;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith("/planning-review")) {
      planningCalls++;
      await route.fulfill({
        json: envelope({
          reviewId: null,
          jobId: null,
          contextHash: null,
          status: "unavailable",
          stale: false,
          inputVersions: { farm: 1, workspace: 2 },
          generatedAt: null,
          retryAfter: null,
          modelInvocation: null,
          summary: "No source-backed options in this fixture.",
          localContext: {
            location: {
              stateId: "IN-TN",
              districtId: "IN-TN-coimbatore",
              districtName: "Coimbatore",
              village: null,
              villageBasis: "unavailable",
              granularity: "district",
              sources: [],
              limitations: [],
            },
            weather: {
              kind: "forecast",
              status: "unavailable",
              issuedAt: null,
              source: "Unavailable",
              days: [],
              limitations: [],
            },
            mandi: { status: "unavailable", references: [], limitations: [] },
            history: {
              basis: "farmer_reported",
              previousHarvest: { status: "unknown" },
              cycles: [],
              rotationAssessment: "not_assessed",
            },
            occupancy: [],
          },
          horizon: { from: "2026-10-30", to: "2027-10-29" },
          rotationDraft: [],
          comparisonShortlist: [],
          evidence: [],
          limitations: [],
          appliedProposalIds: [],
        }),
      });
      return;
    }
    if (path === "/api/v1/boundary-context" && options.holdContext) {
      contextRoute = route;
      return;
    }
    if (path === "/api/v1/assistant/turns") {
      metaActive = true;
      chatRoute = route;
      return;
    }
    if (path.endsWith("/workspace") && method === "PUT") {
      putBody = route.request().postDataJSON();
      await route.fulfill({
        json: envelope({ ...workspace(A), ...putBody, version: 2 }),
      });
      return;
    }
    if (path === "/api/v1/farms" && method === "POST") {
      realCreated = true;
      await route.fulfill({ json: envelope(farm(A)) });
      return;
    }
    if (path === "/api/v1/farms/demo") {
      demoCreated = true;
      demoCalls++;
      await route.fulfill({
        json: envelope({
          farm: farm(B, true),
          workspace: demoWorkspace(),
          demo: {
            prefilledBoundary: true,
            label: "Demo teaching farm",
            source: "Public campus location; prefilled field boundary",
          },
        }),
      });
      return;
    }
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "test" }
        : path === "/api/v1/capabilities"
          ? {
              mode: "synthetic",
              models: {
                text: "configured-but-not-invoked",
                escalation: "unused",
                image: "unused",
                segment: "unused",
                speechToText: null,
                textToSpeech: null,
              },
              providers: { meta: true },
              languages: ["en"],
              database: { reachable: true, postgis: true },
              limits: { maxUploadImageBytes: 1000, maxVoiceSeconds: 60 },
            }
          : path === "/api/v1/farms"
            ? {
                farms: [
                  ...(options.existing || realCreated ? [farm(A)] : []),
                  ...(demoCreated ? [farm(B, true)] : []),
                ],
              }
            : path.endsWith("/workspace")
              ? path.includes(B)
                ? demoWorkspace()
                : workspace(A)
              : path === "/api/v1/boundary-context"
                ? contextData()
                : path === "/api/v1/ai/activity"
                  ? {
                      invocations: metaActive
                        ? [
                            {
                              id: "actual-call",
                              provider: "meta",
                              requestedModel: "actually-running-meta-model",
                              model: null,
                              purpose: "chat",
                              status: "running",
                              startedAt: new Date().toISOString(),
                              processing: "standard",
                            },
                          ]
                        : [],
                    }
                  : path === "/api/v1/crops"
                    ? { crops: [] }
                    : path === "/api/v1/districts"
                      ? new URL(route.request().url()).searchParams.has(
                          "state",
                        )
                        ? {
                            districts: [
                              {
                                id: "IN-TN-coimbatore",
                                level: "district",
                                names: { en: "Coimbatore" },
                              },
                            ],
                            districtListAvailable: true,
                            note: null,
                          }
                        : {
                            areas: [
                              {
                                id: "IN-TN",
                                level: "state",
                                names: { en: "Tamil Nadu" },
                              },
                              {
                                id: "IN-KA",
                                level: "state",
                                names: { en: "Karnataka" },
                              },
                            ],
                          }
                      : {};
    await route.fulfill({ json: envelope(data) });
  });
  await page.route("**/*/MapServer/tile/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN6kAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  return {
    get planningCalls() {
      return planningCalls;
    },
    get contextRoute() {
      return contextRoute;
    },
    get putBody() {
      return putBody;
    },
    get demoCalls() {
      return demoCalls;
    },
    async finishContext() {
      await contextRoute!.fulfill({ json: envelope(contextData()) });
    },
    async finishChat() {
      metaActive = false;
      await chatRoute!.fulfill({
        json: envelope({
          status: "approved",
          provenance: "synthetic_fixture",
          traceId: "test",
          intent: null,
          language: "en",
          gateStatus: "approved",
          answerBlocks: [
            {
              id: "answer",
              kind: "text",
              text: "Test answer",
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
        }),
      });
    },
  };
}
async function triangle(page: Page) {
  const map = page.locator(".map-canvas");
  await map.click({ position: { x: 60, y: 160 } });
  await map.click({ position: { x: 190, y: 165 } });
  await map.click({ position: { x: 130, y: 245 } });
}

test("finish visibly finalizes a valid boundary and keeps it editable; crossed outlines retain their points", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/farm");
  await page.getByRole("button", { name: "Set up my farm" }).click();
  const map = page.locator(".map-canvas");
  for (const p of [
    { x: 60, y: 160 },
    { x: 190, y: 245 },
    { x: 60, y: 245 },
    { x: 190, y: 160 },
  ])
    await map.click({ position: p });
  await page
    .getByRole("button", { name: "Finish boundary", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("crosses itself");
  await expect(page.getByText("4 boundary points")).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await triangle(page);
  await page
    .getByRole("button", { name: "Finish boundary", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Finish boundary", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".boundary-label")).toContainText(
    "Mapped boundary",
  );
  await expect(page.locator(".boundary-summary")).toContainText(
    "boundary finished",
  );
  await page
    .locator(".boundary-label")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByText("3 boundary points")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish boundary", exact: true }),
  ).toBeEnabled();
});

test("boundary context prefills location but retains the manual name and water choice", async ({
  page,
}) => {
  const api = await fixture(page, { holdContext: true });
  await page.goto("/farm");
  await page.getByRole("button", { name: "Set up my farm" }).click();
  await page
    .getByRole("textbox", { name: "Farm name", exact: true })
    .fill("My own farm name");
  await page
    .getByRole("combobox", { name: "How is the land watered?", exact: true })
    .selectOption("irrigated");
  await triangle(page);
  await page
    .getByRole("button", { name: "Finish boundary", exact: true })
    .click();
  await expect.poll(() => !!api.contextRoute).toBe(true);
  await api.finishContext();
  await expect(
    page.getByRole("combobox", { name: "State", exact: true }),
  ).toHaveValue("IN-TN");
  await expect(
    page.getByRole("combobox", { name: "District", exact: true }),
  ).toHaveValue("IN-TN-coimbatore");
  await expect(
    page.getByRole("textbox", { name: "Farm name", exact: true }),
  ).toHaveValue("My own farm name");
  await expect(
    page.getByRole("combobox", {
      name: "How is the land watered?",
      exact: true,
    }),
  ).toHaveValue("irrigated");
});

test("a late location lookup never overwrites a state the farmer already chose", async ({
  page,
}) => {
  const api = await fixture(page, { holdContext: true });
  await page.goto("/farm");
  await page.getByRole("button", { name: "Set up my farm" }).click();
  await triangle(page);
  await page
    .getByRole("button", { name: "Finish boundary", exact: true })
    .click();
  await expect.poll(() => !!api.contextRoute).toBe(true);
  await page
    .getByRole("combobox", { name: "State", exact: true })
    .selectOption("IN-KA");
  await api.finishContext();
  await expect(
    page.getByRole("textbox", { name: "Farm name", exact: true }),
  ).toHaveValue("Coimbatore farm");
  await expect(
    page.getByRole("combobox", { name: "State", exact: true }),
  ).toHaveValue("IN-KA");
});

test("a late location lookup is ignored after the boundary is discarded", async ({
  page,
}) => {
  const api = await fixture(page, { holdContext: true });
  await page.goto("/farm");
  await page.getByRole("button", { name: "Set up my farm" }).click();
  await triangle(page);
  await page
    .getByRole("button", { name: "Finish boundary", exact: true })
    .click();
  await expect.poll(() => !!api.contextRoute).toBe(true);
  await page
    .getByRole("button", { name: "Choose another way to start", exact: true })
    .click();
  await api.finishContext();
  await page.getByRole("button", { name: "Set up my farm" }).click();
  await expect(
    page.getByRole("textbox", { name: "Farm name", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "State", exact: true }),
  ).toHaveValue("");
});

test("returning users can load the labelled demo repeatedly without replacing their real farm", async ({
  page,
}) => {
  const api = await fixture(page, { existing: true });
  await page.goto("/farm");
  // Below 768 px the rail is hidden; its links sit behind the header More button.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("link", { name: "Manage farms", exact: true }).click();
  await expect(page.getByLabel("Selected farm")).toHaveValue(A);
  await page
    .getByRole("button", { name: "Try demo farm", exact: true })
    .click();
  await expect(page.getByLabel("Selected farm")).toHaveValue(B);
  await expect(page.locator(".demo-banner")).toContainText(
    "prefilled boundary",
  );
  await expect(page.locator(".harvest-history-card")).toContainText(
    "Your land has a story.",
  );
  await expect(page.getByLabel("Selected farm").locator("option")).toHaveCount(
    2,
  );
  await page
    .getByRole("button", { name: "Try demo farm", exact: true })
    .click();
  await expect.poll(() => api.demoCalls).toBe(2);
  await expect(page.getByLabel("Selected farm")).toHaveValue(B);
  await expect(
    page.getByLabel("Selected farm").locator("option:checked"),
  ).toHaveText("Demo teaching farm");
  await expect(page.locator(".farm-title-row")).toContainText(
    "Demo teaching farm",
  );
  await expect(page.locator(".harvest-history-card")).toContainText(
    "Your land has a story.",
  );
  await expect(page.locator(".land-story")).toContainText(
    "Good farming looks beyond the next harvest.",
  );
  await page
    .getByRole("button", { name: "Edit farm boundary", exact: true })
    .click();
  await expect(page.getByText("4 boundary points")).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel boundary edit", exact: true })
    .click();
  await expect(page.getByLabel("Selected farm").locator("option")).toHaveCount(
    2,
  );
  await page.getByLabel("Selected farm").selectOption(A);
  await expect(page.locator(".farm-title-row")).toContainText(
    "Existing real farm",
  );
});

test("existing boundary edits finish with a saved confirmation", async ({
  page,
}) => {
  const api = await fixture(page, { existing: true });
  await page.goto("/farm");
  // Below 768 px the rail is hidden; its links sit behind the header More button.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("link", { name: "Manage farms", exact: true }).click();
  await expect(page.locator(".boundary-label")).toBeVisible();
  await page
    .getByRole("button", { name: "Edit farm boundary", exact: true })
    .click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await triangle(page);
  await page
    .getByRole("button", { name: "Finish boundary", exact: true })
    .click();
  await expect.poll(() => !!api.putBody).toBe(true);
  expect(api.putBody?.boundary).toBeTruthy();
  await expect(
    page.getByRole("button", { name: "Finish boundary", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Farm boundary finished and saved." }),
  ).toBeVisible();
});

test("saving the first farm does not wait for the location lookup and ignores its late response", async ({
  page,
}) => {
  const api = await fixture(page, { holdContext: true });
  await page.goto("/farm");
  await page.getByRole("button", { name: "Set up my farm" }).click();
  await triangle(page);
  await page
    .getByRole("button", { name: "Finish boundary", exact: true })
    .click();
  await expect.poll(() => !!api.contextRoute).toBe(true);
  await page
    .getByRole("textbox", { name: "Farm name", exact: true })
    .fill("Typed farm name");
  await page
    .getByRole("combobox", { name: "State", exact: true })
    .selectOption("IN-TN");
  await page
    .getByRole("combobox", { name: "District", exact: true })
    .selectOption("IN-TN-coimbatore");
  await page
    .getByRole("button", { name: "Save farm & continue", exact: true })
    .click();
  await expect(page.getByLabel("Selected farm")).toHaveValue(A);
  await expect(
    page.getByRole("dialog", { name: "What grew here last?" }),
  ).toBeVisible();
  await api.finishContext();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(api.planningCalls).toBe(0);
  await page.reload();
  await expect(page.getByText(/One step to go/)).toBeVisible();
  expect(api.planningCalls).toBe(0);
  await page.getByRole("button", { name: "Confirm harvest history" }).click();
  await page.getByRole("button", { name: "I don't know yet" }).click();
  await page.getByRole("button", { name: "Save harvest history" }).click();
  await expect.poll(() => api.planningCalls).toBeGreaterThan(0);
});

test("a resolved district outside the registry remains visible as editable text", async ({
  page,
}) => {
  await fixture(page, { unlistedDistrict: true });
  await page.goto("/farm");
  await page.getByRole("button", { name: "Set up my farm" }).click();
  await triangle(page);
  await page
    .getByRole("button", { name: "Finish boundary", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "District", exact: true }),
  ).toHaveValue("Unlisted local division");
  await page
    .getByRole("textbox", { name: "District", exact: true })
    .fill("My corrected division");
  await expect(
    page.getByRole("textbox", { name: "District", exact: true }),
  ).toHaveValue("My corrected division");
});

test("Evara displays only the model reported by an actual active invocation and clears it afterward", async ({
  page,
}) => {
  const api = await fixture(page, { existing: true });
  await page.goto("/ask");
  await expect(page.getByLabel("Message Evara")).toBeVisible();
  await expect(page.getByLabel("Actual model activity")).toHaveCount(0);
  await page.getByLabel("Message Evara").fill("Review the farm");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Actual model activity")).toContainText(
    "Thinking with actually-running-meta-model",
  );
  await expect(page.getByLabel("Actual model activity")).not.toContainText(
    "configured-but-not-invoked",
  );
  await api.finishChat();
  await expect(page.getByText("Test answer", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Actual model activity")).toHaveCount(0);
});
