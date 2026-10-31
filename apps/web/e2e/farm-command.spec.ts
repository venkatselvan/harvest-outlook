import { expect, test, type Page, type Route } from "@playwright/test";
import { FarmCommandCenter as schema } from "@harvest/contracts";
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  J = "33333333-3333-4333-8333-333333333333";
const asOf = "2026-10-31T00:00:00Z";
const env = (data: unknown) => ({
  requestId: "command-test",
  mode: "live",
  asOf,
  data,
  warnings: [],
  error: null,
});
const names = [
  ["paddy", "Paddy"],
  ["wheat", "Wheat"],
  ["maize", "Maize"],
  ["sugarcane", "Sugarcane"],
  ["tomato", "Tomato"],
  ["potato", "Potato"],
  ["ginger", "Ginger"],
  ["onion", "Onion"],
  ["shallot", "Shallot"],
  ["green-chillies", "Green Chillies"],
  ["turmeric", "Turmeric"],
  ["curry-tree", "Curry Tree"],
  ["coriander", "Coriander"],
  ["lemon", "Lemon"],
];
const focused = names.map(([cropId, displayName]) => ({
  cropId,
  displayName,
  botanicalName: `${displayName} source identity`,
  productionType: "annual",
  establishmentMethods:
    cropId === "paddy" ? ["direct_sowing", "transplanting"] : ["direct_sowing"],
  products:
    cropId === "ginger"
      ? [
          {
            productId: "ginger-fresh",
            productName: "Fresh ginger",
            sourceCommodities: ["Ginger"],
            mappingStatus: "verified",
          },
          {
            productId: "ginger-dry",
            productName: "Dry ginger",
            sourceCommodities: ["Ginger dry"],
            mappingStatus: "verified",
          },
        ]
      : [
          {
            productId: `${cropId}-product`,
            productName: displayName,
            sourceCommodities: [displayName],
            mappingStatus: "verified",
          },
        ],
  soilEffects:
    cropId === "maize"
      ? [
          {
            topic: "organic_matter",
            direction: "conditional",
            text: "Retained crop residues can contribute organic material.",
            conditions: ["Residues must remain in the field."],
            sourceRefs: [
              { sourceId: "care-source", locator: "Residue section" },
            ],
            quantifiedDelta: null,
          },
        ]
      : [],
  sequenceConstraints:
    cropId === "maize"
      ? [
          {
            text: "Check the previous crop and residue management before the next planting.",
            conditions: [],
            sourceRefs: [
              { sourceId: "care-source", locator: "Sequence section" },
            ],
          },
        ]
      : [],
  limitations: [],
}));
const cycle = {
  id: "maize-cycle",
  cropId: "maize",
  cropName: "Maize",
  productId: "maize-product",
  sowingDate: "2026-06-01",
  establishmentDate: "2026-06-01",
  establishmentMethod: "direct_sowing",
  stage: "growing",
};
const workspace = (farmId: string) => ({
  farmId,
  version: 1,
  updatedAt: asOf,
  boundary: {
    type: "Polygon",
    coordinates: [
      [
        [76.0, 13.0],
        [76.01, 13.0],
        [76.01, 13.01],
        [76.0, 13.01],
        [76.0, 13.0],
      ],
    ],
  },
  previousHarvest: { status: "none" },
  cycles: farmId === A ? [{ ...cycle }] : [],
  rotationPlans: [],
});
const review = () => ({
  reviewId: null,
  jobId: null,
  contextHash: null,
  status: "unavailable",
  stale: false,
  inputVersions: { farm: 1, workspace: 1 },
  generatedAt: null,
  retryAfter: null,
  modelInvocation: null,
  summary: "No sourced planning review available.",
  localContext: {
    location: {
      stateId: "IN-KA",
      districtId: "IN-KA-hassan",
      districtName: "Hassan",
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
      source: "Test source",
      days: [],
      limitations: [],
    },
    mandi: { status: "unavailable", references: [], limitations: [] },
    history: {
      basis: "farmer_reported",
      previousHarvest: { status: "none" },
      cycles: [],
      rotationAssessment: "not_assessed",
    },
    occupancy: [],
  },
  horizon: { from: "2026-10-31", to: "2027-10-30" },
  rotationDraft: [],
  comparisonShortlist: [],
  evidence: [],
  limitations: [],
  appliedProposalIds: [],
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
async function fixture(
  page: Page,
  options: { holdPlant?: boolean; extendedCare?: boolean } = {},
) {
  const workspaces: any = { [A]: workspace(A), [B]: workspace(B) };
  let completed = false,
    pending: Route | undefined,
    planted: any;
  const plantBodies: any[] = [],
    careBodies: any[] = [];
  const makeCenter = (id: string) => {
    const center = {
      farmId: id,
      asOf,
      workspace: workspaces[id],
      focusedCrops: focused,
      sources: [
        {
          id: "care-source",
          url: "https://example.org/care",
          publisher: "Published crop guide",
          title: "Crop care reference",
          retrievedAt: asOf,
          geography: { scope: "state" },
        },
      ],
      currentCycles: workspaces[id].cycles.map((c: any) => ({
        cycle: c,
        careTasks: [
          {
            id: `task-${c.id}`,
            actionId: "moisture-check",
            cycleId: c.id,
            cropId: c.cropId,
            title: "Check field moisture",
            action: "Inspect the field before deciding on irrigation.",
            anchor: "direct_sowing",
            dueFrom: "2026-10-31",
            dueTo: "2026-11-02",
            conditions: [
              "Use field observations; a calendar is not a soil-moisture reading.",
            ],
            sourceRefs: [
              {
                sourceId: "care-source",
                locator: "Crop guide, water management",
              },
            ],
            status: completed ? "completed" : "due",
            completedOn: completed ? "2026-10-31" : null,
            journalEntryId: completed ? J : null,
            evidenceState: "source_schedule",
          },
        ],
        stageGuidance: options.extendedCare
          ? [
              {
                actionId: "stage-check",
                title: "Inspect the observed crop stage",
                action:
                  "Check the actual crop before using this regional reference.",
                stage: "flowering",
                conditions: [],
                sourceRefs: [
                  { sourceId: "care-source", locator: "Stage guidance" },
                ],
                geographyIds: ["IN-TN"],
                applicability: "outside_source_region",
                requiresObservation: true,
              },
            ]
          : [],
        referenceGuidance: options.extendedCare
          ? [
              {
                actionId: "reference-check",
                title: "Regional irrigation reference",
                action: "A source reference from another state.",
                conditions: [],
                sourceRefs: [
                  { sourceId: "care-source", locator: "Regional guidance" },
                ],
                geographyIds: ["IN-TN"],
                reason: "The published source region does not match this farm.",
              },
            ]
          : [],
        limitations: [],
      })),
      soil: {
        markers: { farmId: id, samples: [], limitations: [] },
        fit: focused.map((c) => ({
          cropId: c.cropId,
          status: "needs_soil_report",
          summary: "No compatible confirmed field measurement is available.",
          checks: [],
          requirements: [],
          limitations: [],
        })),
      },
      planningReview: review(),
      weather: {
        kind: "forecast",
        status: "fresh",
        reason: null,
        issuedAt: asOf,
        source: "Forecast fixture",
        days: [
          { date: "2026-10-31", rainMm: 4, tMinC: 20, tMaxC: 29, et0Mm: 3 },
        ],
      },
      currentQuotes: quotes,
      priorYearMarkets: [],
      limitations: [],
    };
    if (options.extendedCare)
      for (const current of center.currentCycles)
        current.careTasks = Array.from({ length: 4 }, (_, index) => ({
          ...current.careTasks[0],
          id: `extended-${index}`,
          title: `Scheduled care ${index + 1}`,
        }));
    return center;
  };
  schema.parse(makeCenter(A)); // Keep the journey fixture aligned with the production response schema.
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method(),
      id = path.includes(B) ? B : A;
    if (path.endsWith("/cycles") && method === "POST") {
      const body = route.request().postDataJSON();
      plantBodies.push(body);
      planted = {
        id: "new-cycle",
        cropId: body.cropId,
        cropName: focused.find((c) => c.cropId === body.cropId)!.displayName,
        productId: body.productId,
        sowingDate: body.establishmentDate,
        establishmentDate: body.establishmentDate,
        establishmentMethod: body.establishmentMethod,
        stage: "sowed",
      };
      workspaces[id] = {
        ...workspaces[id],
        version: 2,
        cycles: [...workspaces[id].cycles, planted],
      };
      if (options.holdPlant) {
        pending = route;
        return;
      }
      return route.fulfill({
        json: env({
          cycle: planted,
          workspace: workspaces[id],
          journalEntryId: J,
          alreadyRecorded: false,
        }),
      });
    }
    if (path.endsWith("/complete") && method === "POST") {
      careBodies.push(route.request().postDataJSON());
      completed = true;
      return route.fulfill({
        json: env({
          journalEntryId: J,
          completedOn: "2026-10-31",
          alreadyCompleted: false,
        }),
      });
    }
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "test" }
        : path === "/api/v1/farms"
          ? {
              farms: [A, B].map((id, i) => ({
                id,
                name: i ? "North field" : "South field",
                areaHectares: 1.2,
                location: {
                  stateCode: "IN-KA",
                  districtId: "IN-KA-hassan",
                  districtName: "Hassan",
                  precision: "district",
                },
                facts: {},
              })),
            }
          : path.endsWith("/workspace")
            ? workspaces[id]
            : path.endsWith("/command-center")
              ? makeCenter(id)
              : path.endsWith("/planning-review")
                ? review()
                : path === "/api/v1/crops"
                  ? {
                      crops: focused.map((c) => ({
                        cropId: c.cropId,
                        name: c.displayName,
                        products: c.products.map((p) => ({
                          productId: p.productId,
                          name: p.productName,
                        })),
                      })),
                    }
                  : path.endsWith("/monitoring")
                    ? {
                        farmId: id,
                        checkedAt: asOf,
                        weather: {
                          status: "unavailable",
                          reason: "No forecast",
                          issuedAt: null,
                          attribution: "Source",
                          point: null,
                          days: [],
                        },
                        market: {
                          status: "unavailable",
                          reason: "No quote",
                          products: [],
                        },
                        meta: {
                          status: "unavailable",
                          reason: "No review",
                          automatic: false,
                        },
                      }
                    : path.endsWith("/market-quotes")
                      ? quotes
                      : path.endsWith("/soil-markers")
                        ? { farmId: id, samples: [], limitations: [] }
                        : path.endsWith("/soil-reports")
                          ? { reports: [] }
                          : path === "/api/v1/ai/activity"
                            ? { invocations: [] }
                            : path === "/api/v1/market-context"
                              ? {
                                  status: "available",
                                  fetchedAt: asOf,
                                  publishedAt: "2026-10-02",
                                  period: "2026-09",
                                  source: {
                                    name: "FAO monthly bulletin",
                                    url: "https://www.fao.org/worldfoodsituation/foodpricesindex/en/",
                                  },
                                  indices: [
                                    {
                                      category: "cereals",
                                      label: "Global cereals",
                                      cropIds: ["paddy", "wheat", "maize"],
                                      points: 105.2,
                                      unit: "index_2014_2016_100",
                                      monthOnMonthPct: -1.2,
                                    },
                                  ],
                                  topics: [
                                    {
                                      label: "Trade routes and freight",
                                      cropIds: ["maize", "wheat"],
                                    },
                                  ],
                                  limitations: [
                                    "Global observations are not local price forecasts.",
                                  ],
                                }
                              : {};
    await route.fulfill({ json: env(data) });
  });
  return {
    plantBodies,
    careBodies,
    get pending() {
      return pending;
    },
    async release() {
      await pending!.fulfill({
        json: env({
          cycle: planted,
          workspace: workspaces[A],
          journalEntryId: J,
          alreadyRecorded: false,
        }),
      });
    },
  };
}

test("one selected-farm workspace contains the field scene and all five contextual views", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page);
  await page.goto("/farm");
  await expect(
    page.getByRole("heading", { name: "South field", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Interactive crop growth model" }),
  ).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Farm views" });
  for (const name of [
    "Today",
    "Soil & crop fit",
    "Year plan",
    "Harvest outlook",
    "Activity",
  ])
    await expect(tabs.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Check field moisture", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../docs/reference/redesign/command-center-planted-fixture.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Satellite", exact: true }).click();
  await expect(page.locator(".map-canvas")).toBeVisible();
  await tabs
    .getByRole("link", { name: "Soil & crop fit", exact: true })
    .click();
  await expect(page.locator(".focused-crop-card")).toHaveCount(14);
  await page.getByRole("button", { name: "Soil reports", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Farm soil reports" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close farm tool" }).click();
  await tabs
    .getByRole("link", { name: "Harvest outlook", exact: true })
    .click();
  const global = page.getByRole("region", { name: "Global market context" });
  await expect(global.getByText("105.2", { exact: false })).toBeVisible();
  await expect(global).toContainText("index points");
  await expect(global).not.toContainText("₹105");
  await expect(global).toContainText("not an Indian mandi price");
  await page.getByLabel("Selected farm", { exact: true }).selectOption(B);
  await expect(global).toContainText("no crop-specific indicator");
});

test("planting a focused crop requires its exact product/date and exposes the saved crop care", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/farm");
  await page.getByRole("button", { name: "Plant crop", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("What did you plant?");
  await expect(dialog.getByRole("radio")).toHaveCount(14);
  await dialog.getByRole("radio", { name: "Ginger", exact: true }).check();
  await dialog
    .getByRole("combobox", { name: "Harvest product" })
    .selectOption("ginger-fresh");
  await dialog.getByLabel("Establishment date").fill("2026-10-30");
  await dialog
    .getByRole("button", { name: "Record planting", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => api.plantBodies.length).toBe(1);
  expect(api.plantBodies[0]).toMatchObject({
    cropId: "ginger",
    productId: "ginger-fresh",
    establishmentMethod: "direct_sowing",
    establishmentDate: "2026-10-30",
    expectedWorkspaceVersion: 1,
  });
  await expect(page.locator(".current-crop-name h3")).toHaveText("Ginger");
  await expect(
    page.getByRole("heading", { name: "Check field moisture", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done today", exact: true }).click();
  await expect.poll(() => api.careBodies.length).toBe(1);
  expect(api.careBodies[0].completedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await expect(
    page.getByRole("heading", { name: "Check field moisture", exact: true }),
  ).toHaveCount(0);
});

test("a planting save completed after farm switching cannot replace the selected farm", async ({
  page,
}) => {
  const api = await fixture(page, { holdPlant: true });
  await page.goto("/farm");
  await page.getByRole("button", { name: "Plant crop", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("What did you plant?");
  await dialog.getByRole("radio", { name: "Tomato", exact: true }).check();
  await dialog.getByLabel("Establishment date").fill("2026-10-30");
  await dialog
    .getByRole("button", { name: "Record planting", exact: true })
    .click();
  await expect.poll(() => !!api.pending).toBe(true);
  await page.getByRole("button", { name: "Close planting record" }).click();
  await page.getByLabel("Selected farm", { exact: true }).selectOption(B);
  await api.release();
  await expect(
    page.getByRole("heading", { name: "North field", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".current-crop-name h3")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No crop recorded yet", exact: true }),
  ).toBeVisible();
});

for (const theme of ["light", "dark"] as const)
  test(`${theme} full-screen layout remains usable at360px`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await fixture(page);
    await page.goto("/farm");
    await expect(
      page.getByRole("button", { name: "Plant crop", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Dark mode", exact: true }),
    ).toBeInViewport();
    await expect(page.locator(".field-growth-canvas")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("link", { name: "Farm workspace", exact: true }),
    ).toHaveAttribute("aria-label", "Farm workspace");
  });

test("farm query views react to navigation and survive a fresh reload", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/farm?tab=soil");
  const tabs = page.getByRole("navigation", { name: "Farm views" });
  await expect(
    tabs.getByRole("link", { name: "Soil & crop fit", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".focused-crop-card")).toHaveCount(14);
  await tabs.getByRole("link", { name: "Today", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Your field", exact: true }),
  ).toBeVisible();
  await tabs
    .getByRole("link", { name: "Soil & crop fit", exact: true })
    .click();
  await expect(page.locator(".focused-crop-card")).toHaveCount(14);
  await page.reload();
  await expect(page.locator(".focused-crop-card")).toHaveCount(14);
});

test("all scheduled care stays reachable and regional references remain undated", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await fixture(page, { extendedCare: true });
  await page.goto("/farm");
  await expect(
    page.getByRole("heading", { name: "Scheduled care 3", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Scheduled care 4", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "All 4 care actions" }).click();
  await expect(
    page.getByRole("heading", { name: "Scheduled care 4", exact: true }),
  ).toBeVisible();
  const guidance = page.locator(".stage-guidance-panel").first();
  await guidance.locator("summary").click();
  await expect(guidance).toContainText("This source covers another region");
  await expect(guidance).toContainText("No date has been assigned");
  await expect(
    guidance.getByRole("button", { name: "Done today" }),
  ).toHaveCount(0);
  const regional = page.locator(".stage-guidance-panel").last();
  await regional.locator("summary").click();
  await expect(regional).toContainText("no scheduled field dates");
  await expect(
    regional.getByRole("button", { name: "Done today" }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Farm views" })
    .getByRole("link", { name: "Soil & crop fit" })
    .click();
  const maize = page
    .locator(".focused-crop-card")
    .filter({ has: page.getByRole("heading", { name: "Maize", exact: true }) });
  await expect(maize).toContainText(
    "Retained crop residues can contribute organic material.",
  );
  await maize.getByText("Before the next crop", { exact: true }).click();
  await expect(maize).toContainText(
    "Check the previous crop and residue management",
  );
});

for (const mode of ["light", "dark"] as const)
  test(`supplied logo and Evara character load cleanly in ${mode} mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: mode });
    await fixture(page);
    await page.goto("/farm");
    const logo = page.locator(".brand-mark img.harvest-logo");
    await expect(logo).toHaveAttribute("src", "/brand/harvest-logo.png");
    await expect(logo).toHaveAttribute("alt", "");
    await expect
      .poll(() =>
        logo.evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth === 1254,
        ),
      )
      .toBe(true);
    const plate = await page
      .locator(".brand-mark")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(plate).toMatch(/rgb\((241, 246, 242|237, 243, 238)\)/);
    await page
      .getByRole("button", { name: "Open Evara", exact: true })
      .first()
      .click();
    await expect(
      page.getByLabel("Evara farm assistant", { exact: true }),
    ).toBeVisible();
    const avatars = page.locator("img.evara-mascot");
    await expect
      .poll(() =>
        avatars.evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth === 1254,
          ),
        ),
      )
      .toBe(true);
    for (const image of await avatars.all())
      await expect(image).toHaveAttribute("src", "/brand/evara-mascot.png");
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
      "href",
      "/brand/harvest-logo.png",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `../../docs/reference/redesign/brand-${mode}-fixture.png`,
      fullPage: true,
    });
  });
