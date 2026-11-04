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
        demo_track_record: { value: true },
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
    withField?: boolean;
    secondFarm?: boolean;
    holdPut?: boolean;
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
  let putRoute: Route | undefined;
  let realCreated = false;
  let demoCreated = false;
  let demoCalls = 0;
  const demoWorkspace = () => ({
    ...workspace(B),
    previousHarvest: {
      status: "known",
      cropId: "finger-millet",
      cropName: "Finger millet",
      harvestDate: "2023-12-10",
    },
    cycles: [
      {
        id: "demo2y:ginger-2024",
        cropId: "ginger",
        cropName: "Ginger",
        productId: "ginger-fresh",
        sowingDate: "2024-05-20",
        establishmentDate: "2024-05-20",
        establishmentMethod: "rhizome_planting",
        stage: "harvested",
        harvestDate: "2025-01-18",
      },
      {
        id: "demo2y:maize-2025",
        cropId: "maize",
        cropName: "Maize",
        productId: "maize-grain",
        sowingDate: "2025-06-08",
        establishmentDate: "2025-06-08",
        establishmentMethod: "direct_sowing",
        stage: "harvested",
        harvestDate: "2025-10-04",
      },
      {
        id: "demo2y:ginger-2026",
        cropId: "ginger",
        cropName: "Ginger",
        productId: "ginger-fresh",
        sowingDate: "2026-05-16",
        establishmentDate: "2026-05-16",
        establishmentMethod: "rhizome_planting",
        stage: "growing",
      },
    ],
    rotationPlans: [],
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
  let yearPlanPosts = 0;
  let metaActive = false;
  let chatRoute: Route | undefined;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith("/year-plan") && method === "POST") yearPlanPosts++;
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
      if (options.holdPut) { putRoute = route; return; }
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
            label:
              "Demo farm with two years of sample records near the public ARS Arsikere research-site reference",
            source: "Public campus location; prefilled field boundary",
            records: {
              cycles: 3,
              seasons: 0,
              journalEntries: 41,
              careActions: 5,
            },
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
                  ...(options.secondFarm ? [farm(B)] : []),
                  ...(demoCreated ? [farm(B, true)] : []),
                ],
              }
            : path.endsWith("/workspace")
              ? path.includes(B)
                ? demoWorkspace()
                : { ...workspace(A), ...(options.withField ? { fields: [{ id: "east-field", name: "East field", boundary: { type: "Polygon", coordinates: [[[76.942, 11.0105], [76.944, 11.0105], [76.944, 11.012], [76.942, 11.0105]]] }, notes: "Preserve this note", checkIntervalDays: 9 }] } : {}) }
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
                      ? new URL(route.request().url()).searchParams.has("state")
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
    get yearPlanPosts() {
      return yearPlanPosts;
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
    async finishPut() {
      await putRoute!.fulfill({ json: envelope({ ...workspace(A), ...putBody, version: 2 }) });
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
  await page.getByRole("link", { name: "Modify farm", exact: true }).click();
  await expect(page.getByLabel("Selected farm")).toHaveValue(A);
  await page
    .getByRole("button", { name: "Try demo farm", exact: true })
    .click();
  await expect(page.getByLabel("Selected farm")).toHaveValue(B);
  await expect(
    page.getByText("Demo farm ready: two years of records loaded."),
  ).toBeVisible();
  await expect(page.locator(".demo-banner")).toContainText(
    "Demo farm · two years of sample records",
  );
  await expect(page.locator(".demo-banner")).toContainText(
    "Harvests, journal entries, sales and the crop in the field now were loaded as sample records",
  );
  await expect(page.locator(".demo-banner")).not.toContainText(
    "prefilled boundary",
  );
  await expect(page.locator(".harvest-history-card")).toContainText(
    "Finger millet",
  );
  await expect(page.locator(".harvest-history-card")).toContainText(
    "Harvested",
  );
  await expect(page.locator(".harvest-history-card")).not.toContainText(
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
    "Finger millet",
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
  await page.getByRole("link", { name: "Modify farm", exact: true }).click();
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
  // No banner and no plan request while the history is still unknown: the server enqueues the year plan only from
  // the workspace save that records known history.
  await expect(page.getByText(/One step to go/)).toHaveCount(0);
  expect(api.yearPlanPosts).toBe(0);
  await page.reload();
  await expect(page.getByText(/One step to go/)).toHaveCount(0);
  expect(api.yearPlanPosts).toBe(0);
  await page.goto("/farm?history=1");
  await page.getByRole("button", { name: "I don't know yet" }).click();
  await page.getByRole("button", { name: "Save harvest history" }).click();
  await expect(
    page.getByRole("dialog", { name: "What grew here last?" }),
  ).toHaveCount(0);
  expect(api.yearPlanPosts).toBe(0);
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


/** These requests are intercepted by fixture(); editing cannot mutate a stored farm. */
async function dragVertex(page: Page, index: number, dx: number, dy: number, touch = false) {
  const handle = page.locator(`.farm-map [data-vertex-index="${index}"]`);
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (touch) {
    const input = await page.context().newCDPSession(page);
    await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 8; step++) {
      await input.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8, id: 1 }] });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    }
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await input.detach();
  } else {
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 }); await page.mouse.up();
  }
  await expect.poll(async () => { const moved = (await handle.boundingBox())!; return Math.abs(moved.x - box.x - dx); }).toBeLessThanOrEqual(2);
}

test("farm vertices drag locally, undo restores a moved point, and only Finish saves", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const api = await fixture(page, { existing: true });
  await page.goto("/farm/manage");
  await page.getByRole("button", { name: "Edit farm boundary", exact: true }).click();
  await expect(page.locator(".boundary-vertex")).toHaveCount(3);
  const first = page.locator('[data-vertex-index="0"]');
  const original = (await first.boundingBox())!;
  await first.click();
  expect(api.putBody).toBeUndefined();
  await expect(page.getByRole("button", { name: "Finish boundary", exact: true })).toBeVisible();
  await dragVertex(page, 0, 22, -12);
  expect(api.putBody).toBeUndefined();
  await expect(page.getByText("3 boundary points", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(Math.round((await first.boundingBox())!.x)).toBe(Math.round(original.x));
  await dragVertex(page, 0, 15, -8);
  await page.getByRole("button", { name: "Finish boundary", exact: true }).click();
  await expect.poll(() => !!api.putBody).toBe(true);
  const saved = api.putBody!.boundary as typeof boundary;
  expect(saved.coordinates[0]![0]).not.toEqual(boundary.coordinates[0]![0]);
  expect(saved.coordinates[0]![0]).toEqual(saved.coordinates[0]!.at(-1));
  expect(saved.coordinates[0]).toHaveLength(4);
});

test("a new polygon misclick can be dragged and map panning works again after release", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const api = await fixture(page);
  await page.goto("/farm"); await page.getByRole("button", { name: "Set up my farm" }).click();
  const map = page.locator(".farm-map .map-canvas");
  for (const position of [{ x: 110, y: 160 }, { x: 280, y: 160 }, { x: 220, y: 300 }]) await map.click({ position });
  await dragVertex(page, 1, -35, 20);
  await expect(page.getByText("3 boundary points", { exact: true })).toBeVisible();
  const first = page.locator('[data-vertex-index="0"]');
  const before = (await first.boundingBox())!;
  const area = (await map.boundingBox())!;
  await page.mouse.move(area.x + area.width - 200, area.y + 210); await page.mouse.down();
  await page.mouse.move(area.x + area.width - 145, area.y + 225, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => Math.abs((await first.boundingBox())!.x - before.x)).toBeGreaterThan(35);
  expect(api.putBody).toBeUndefined();
  await page.getByRole("button", { name: "Finish boundary", exact: true }).click();
  await expect(page.locator(".boundary-label")).toBeVisible();
});

test.describe("touch-enabled field editor", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("saved field corners support keyboard adjustment and cancel, then touch drag and explicit field save", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await fixture(page, { existing: true, withField: true });
  await page.goto("/farm/manage");
  await page.getByRole("button", { name: "Edit outline for East field", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save field boundary", exact: true })).toHaveCount(0);
  const first = page.locator('[data-vertex-index="0"]');
  await first.focus();
  const original = (await first.boundingBox())!;
  await page.keyboard.press("Shift+ArrowRight");
  expect(Math.abs((await first.boundingBox())!.x - original.x - 10)).toBeLessThanOrEqual(2);
  expect(api.putBody).toBeUndefined();
  await page.locator(".fields-draw").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".boundary-vertex")).toHaveCount(0);
  expect(api.putBody).toBeUndefined();
  await page.getByRole("button", { name: "Edit outline for East field", exact: true }).click();
  const canvas = (await page.locator(".farm-map .map-canvas").boundingBox())!;
  const corner = (await first.boundingBox())!;
  await dragVertex(page, 0, Math.round(canvas.x + 25 - corner.x - corner.width / 2), 0, true);
  await page.getByRole("button", { name: "Finish field", exact: true }).click();
  await expect(page.locator(".map-validation-error")).toContainText("outside the farm boundary");
  expect(api.putBody).toBeUndefined();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await dragVertex(page, 0, 12, -8, true);
  await page.getByRole("button", { name: "Finish field", exact: true }).click();
  expect(api.putBody).toBeUndefined();
  await page.getByRole("button", { name: "Save field boundary", exact: true }).click();
  await expect.poll(() => !!api.putBody).toBe(true);
  const fields = api.putBody!.fields as { id: string; notes: string; checkIntervalDays: number; boundary: typeof boundary }[];
  expect(fields).toHaveLength(1);
  expect(fields[0]).toMatchObject({ id: "east-field", notes: "Preserve this note", checkIntervalDays: 9 });
  expect(fields[0]!.boundary.coordinates[0]![0]).not.toEqual([76.942, 11.0105]);
});

});


test("a late outline save cannot clear a new farm's drawing and saving disables discard", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const api = await fixture(page, { existing: true, withField: true, secondFarm: true, holdPut: true });
  await page.goto("/farm/manage");
  await page.getByRole("button", { name: "Edit outline for East field", exact: true }).click();
  await page.getByRole("button", { name: "Finish field", exact: true }).click();
  await page.getByRole("button", { name: "Save field boundary", exact: true }).click();
  await expect.poll(() => !!api.putBody).toBe(true);
  await expect(page.locator(".fields-draw").getByRole("button", { name: "Discard", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Selected farm" }).selectOption(B);
  await expect(page.locator('[data-field-id="east-field"]')).toHaveCount(0);
  await page.getByTestId("fields-add").click();
  const map = page.locator(".farm-map .map-canvas");
  await map.click({ position: { x: 180, y: 180 } });
  await map.click({ position: { x: 230, y: 240 } });
  await expect(page.getByText("2 field points", { exact: true })).toBeVisible();
  await api.finishPut();
  await expect(page.getByRole("combobox", { name: "Selected farm" })).toHaveValue(B);
  await expect(page.getByText("2 field points", { exact: true })).toBeVisible();
  await expect(page.locator(".fields-draw")).toContainText("Drawing a new field.");
});
