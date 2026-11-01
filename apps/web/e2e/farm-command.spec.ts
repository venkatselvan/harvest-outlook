import { expect, test, type Page, type Route } from "@playwright/test";
import {
  CropFitReview as cropFitSchema,
  FarmCommandCenter as schema,
  MarketTimeline as marketSchema,
  SoilReview as soilReviewSchema,
  TodayView as todaySchema,
} from "@harvest/contracts";
import {
  dateFreshReview as cropFitDateReview,
  readyModelReview as cropFitReadyReview,
  seasonReview as cropFitSeasonReview,
} from "../src/workspace/farm/cropFitFixtures";
import { readyModelReview as soilReadyReview } from "../src/workspace/farm/soilReviewFixtures";
import {
  marketFixture,
  marketNoPriceFixture,
  FIXTURE_TODAY_INDEX,
} from "../src/workspace/market/fixtures";
import {
  todayEmptyFixture,
  todayFixture,
} from "../src/workspace/today/fixtures";
import {
  insufficientTrendFixture,
  priceTrendFixture,
} from "../src/workspace/year/fixtures";
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
  options: {
    holdPlant?: boolean;
    extendedCare?: boolean;
    /** Answer GET /today from the synthetic Today fixture. Without it the endpoint returns an empty envelope and the Today view shows its unavailable state. */
    today?: boolean;
    /** Answer GET /today for the first farm with this (synthetic) view instead of the default fixture; implies `today`. */
    todayView?: (farmId: string) => unknown;
    /** Adds a saved ginger season to the first farm and answers GET /price-trend (full series for maize, none for ginger). */
    trends?: boolean;
  } = {},
) {
  const workspaces: any = { [A]: workspace(A), [B]: workspace(B) };
  const trendRequests: URLSearchParams[] = [];
  const timelineRequests: URLSearchParams[] = [];
  const cropFitRequests: URLSearchParams[] = [];
  if (options.trends)
    workspaces[A].rotationPlans = [
      {
        id: "season-ginger",
        year: 2027,
        season: "Kharif",
        cropId: "ginger",
        cropName: "Ginger",
        productId: "ginger-fresh",
        productName: "Fresh ginger",
        plannedSowingDate: "2027-04-20",
      },
    ];
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
    if (path === "/api/v1/price-trend") {
      const query = new URL(route.request().url()).searchParams;
      trendRequests.push(query);
      const productId = query.get("productId") ?? "unknown";
      return route.fulfill({
        json: env(
          productId === "maize-product"
            ? priceTrendFixture(productId)
            : insufficientTrendFixture(productId),
        ),
      });
    }
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
    // Round-2 routes, answered from the SYNTHETIC fixtures of their views so no test depends on the live database.
    if (path.endsWith("/market-timeline") && method === "GET") {
      const query = new URL(route.request().url()).searchParams;
      timelineRequests.push(query);
      const productId = query.get("productId") ?? "unknown";
      const base =
        productId === "ginger-fresh"
          ? marketNoPriceFixture(id)
          : marketFixture(id);
      return route.fulfill({
        json: env(
          marketSchema.parse({
            ...base,
            productId,
            productName: productId === "ginger-fresh" ? "Fresh ginger" : "Maize",
            cropName: productId === "ginger-fresh" ? "Ginger" : "Maize",
          }),
        ),
      });
    }
    if (path.endsWith("/crop-fit")) {
      const query = new URL(route.request().url()).searchParams;
      if (method === "GET") cropFitRequests.push(query);
      const mode = query.get("mode");
      return route.fulfill({
        json: env(
          cropFitSchema.parse(
            mode === "season"
              ? cropFitSeasonReview
              : mode === "date"
                ? cropFitDateReview
                : cropFitReadyReview,
          ),
        ),
      });
    }
    if (path.endsWith("/soil-review"))
      return route.fulfill({
        json: env(
          soilReviewSchema.parse(
            { ...soilReadyReview, farmId: id },
          ),
        ),
      });
    if (
      (options.today || options.todayView) &&
      path.endsWith("/today") &&
      method === "GET"
    )
      return route.fulfill({
        json: env(
          todaySchema.parse(
            id === A
              ? (options.todayView?.(A) ?? todayFixture(A))
              : todayEmptyFixture(B),
          ),
        ),
      });
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
                  : path.endsWith("/journal")
                    ? { entries: [] }
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
    trendRequests,
    timelineRequests,
    cropFitRequests,
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

const tabNames = ["Today", "Plan", "Market", "Farm"];
const farmViews = (page: Page) =>
  page.getByRole("navigation", { name: "Farm views" });
const noHorizontalScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

test("one selected-farm workspace holds the Today view and four tabs, and the Farm tab keeps crop fit, soil records and activity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const api = await fixture(page, { today: true });
  await page.goto("/farm");
  await expect(
    page.getByRole("heading", { name: "South field", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Your field", exact: true }),
  ).toBeVisible();
  const tabs = farmViews(page);
  await expect(tabs.getByRole("link")).toHaveCount(4);
  for (const name of tabNames)
    await expect(tabs.getByRole("link", { name, exact: true })).toBeVisible();
  // The due-task count is announced as the Today tab's description, not folded into its name.
  await expect(
    tabs.getByRole("link", { name: "Today", exact: true }),
  ).toHaveAccessibleDescription("1 care task due");
  await expect(
    page
      .getByRole("region", { name: "Upcoming steps" })
      .getByRole("heading", { name: "Check field moisture", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../docs/reference/redesign/command-center-planted-fixture.png",
    fullPage: true,
  });
  // Farm tab: crop fit first, then soil records and activity behind the secondary toggle.
  await tabs.getByRole("link", { name: "Farm", exact: true }).click();
  const sections = page.getByRole("navigation", { name: "Farm sections" });
  await expect(
    sections.getByRole("link", { name: "Crop fit", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const fit = page.getByRole("region", { name: "Which crop fits next?" });
  await expect(
    fit.getByRole("heading", { name: "Which crop fits next?", level: 2 }),
  ).toBeVisible();
  // The old focused-crop grid is gone; the review's three picks replace it.
  await expect(page.locator(".focused-crop-card")).toHaveCount(0);
  await expect(fit.getByRole("heading", { name: "Top picks", exact: true })).toBeVisible();
  await expect(fit.locator(".cf-card")).toHaveCount(3);
  await expect(fit.getByRole("button", { name: "Groundnut", exact: true })).toBeVisible();
  // Mode controls: the server's default (next crop) is shown as pressed and its resolved sowing date is stated.
  const when = fit.getByRole("group", { name: "When to sow" });
  for (const name of ["Next crop", "By season", "Pick a date"])
    await expect(when.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(when.getByRole("button", { name: "Next crop", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(when.getByRole("button", { name: "By season", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(fit.getByText("Sowing from 4 Feb 2027, after paddy")).toBeVisible();
  expect(api.cropFitRequests[0]!.has("mode")).toBe(false); // the first GET leaves the mode to the server
  // Switching mode asks the server again for that mode and shows the season chips.
  await when.getByRole("button", { name: "By season", exact: true }).click();
  await expect(when.getByRole("button", { name: "By season", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(fit.getByRole("group", { name: "Season" })).toBeVisible();
  await expect(fit.getByText(/windows from 1 Apr 2027/)).toBeVisible();
  const seasonRequest = api.cropFitRequests.find((q) => q.get("mode") === "season")!;
  expect(seasonRequest.get("season")).toMatch(/^(kharif|rabi|summer)$/);
  await expect(page.getByRole("button", { name: "Compare crops", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Soil reports", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Farm soil reports" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close farm tool" }).click();
  await sections.getByRole("link", { name: "Soil records", exact: true }).click();
  // The soil review sits above the report list (soil markers).
  const review = page.getByRole("heading", { name: "Soil review", exact: true });
  const markers = page.getByRole("heading", { name: "Soil markers", exact: true });
  await expect(review).toBeVisible();
  await expect(
    page.getByText("Soil pH 7.2 rates neutral and salinity is normal."),
  ).toBeVisible();
  await expect(markers).toBeVisible();
  expect((await review.boundingBox())!.y).toBeLessThan(
    (await markers.boundingBox())!.y,
  );
  await expect(fit).toHaveCount(0);
  await sections.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Crop progress", exact: true }),
  ).toBeVisible();
  await expect(
    tabs.getByRole("link", { name: "Farm", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  // Market tab: the timeline first, the FAO bulletin collapsed below it until opened.
  await tabs.getByRole("link", { name: "Market", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Market timeline", exact: true }),
  ).toBeVisible();
  const context = page.locator("details.market-context-details");
  await expect(context).not.toHaveAttribute("open", "");
  await context
    .getByText("Wider market context (FAO monthly bulletin)", { exact: true })
    .click();
  const global = page.getByRole("region", { name: "Global market context" });
  await expect(global.getByText("105.2", { exact: false })).toBeVisible();
  await expect(global).toContainText("index points");
  await expect(global).not.toContainText("₹105");
  await expect(global).toContainText("not an Indian mandi price");
  await page.getByLabel("Selected farm", { exact: true }).selectOption(B);
  await expect(global).toContainText("no crop-specific indicator");
});

test("Market tab shows the market timeline for each tracked product, moves its three cards with the week slider, and says so when no product is tracked", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const api = await fixture(page, { trends: true });
  await page.goto("/farm?tab=harvest");
  const view = page.getByRole("region", { name: "Market timeline", exact: true });
  await expect(
    view.getByRole("heading", { name: "Market timeline", exact: true }),
  ).toBeVisible();
  // One chip per tracked product, the growing maize cycle first, then the saved ginger season.
  const products = view.getByRole("group", { name: "Product" });
  await expect(products.getByRole("button")).toHaveText(["Maize", "Fresh ginger"]);
  await expect(products.getByRole("button", { name: "Maize", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(products.getByRole("button", { name: "Fresh ginger", exact: true })).toHaveAttribute("aria-pressed", "false");
  // The request carries the product and the 36-months-back, 12-months-ahead window.
  await expect(view.getByTestId("market-chart")).toBeVisible();
  expect(Object.fromEntries(api.timelineRequests[0]!)).toEqual({
    productId: "maize-product",
    monthsBack: "36",
    monthsAhead: "12",
  });
  // The slider spans the whole range with its thumb at today's week.
  const slider = view.getByRole("slider", { name: "Move through the weeks" });
  await expect(slider).toHaveValue(String(FIXTURE_TODAY_INDEX));
  await expect(slider).toHaveAttribute("aria-valuetext", "Week of 26 Oct 2026");
  await expect(view.getByRole("button", { name: "Back to today" })).toHaveCount(0);
  // Three cards for the selected week: Price, Weather and Events.
  const card = (kind: string) => view.locator(`[data-card="${kind}"]`);
  for (const [kind, title] of [
    ["price", "Price"],
    ["weather", "Weather"],
    ["events", "Events"],
  ] as const) {
    await expect(card(kind)).toBeVisible();
    await expect(card(kind).getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  await expect(card("price")).toContainText("Observed");
  await expect(card("events")).toContainText("Fall armyworm scouting window");
  // One week later the cards follow the slider: a seasonal reference price and no events.
  await slider.focus();
  await slider.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "Week of 2 Nov 2026");
  await expect(card("price")).toContainText("Reference");
  await expect(card("events")).toContainText("No alerts or price moves this week");
  await view.getByRole("button", { name: "Back to today" }).click();
  await expect(slider).toHaveAttribute("aria-valuetext", "Week of 26 Oct 2026");
  // A product with no stored price series says so and keeps weather and events.
  await products.getByRole("button", { name: "Fresh ginger", exact: true }).click();
  await expect(
    view.getByTestId("market-no-price"),
  ).toContainText("No mandi price series is stored for Fresh ginger yet");
  expect(api.timelineRequests.map((q) => q.get("productId"))).toContain("ginger-fresh");
  await expect(card("weather")).toBeVisible();
  // The FAO bulletin is still on the tab, collapsed under the timeline.
  await expect(
    page.locator("details.market-context-details > summary"),
  ).toHaveText("Wider market context (FAO monthly bulletin)");
  // A farm that tracks no product gets the empty state instead of a chart.
  await page.getByLabel("Selected farm", { exact: true }).selectOption(B);
  await expect(page.getByTestId("market-empty")).toHaveText(
    "Add a crop to your farm or plan to see its market timeline.",
  );
  await expect(view.getByRole("slider")).toHaveCount(0);
  await expect(view.getByRole("group", { name: "Product" })).toHaveCount(0);
});

test("planting a focused crop requires its exact product/date and exposes the saved crop care", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/farm");
  await page.getByRole("button", { name: "Plant crop", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("What did you plant?");
  // The 19 rotation-pool crops plus the 7 mock care-schedule crops that are outside the pool (wheat, sugarcane, shallot, ...).
  await expect(dialog.getByRole("radio")).toHaveCount(26);
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
  await expect(page.getByTestId("today-recorded-crop")).toContainText(
    "Ginger",
  );
  const steps = page.getByRole("region", { name: "Upcoming steps" });
  await expect(
    steps.getByRole("heading", { name: "Check field moisture", exact: true }),
  ).toBeVisible();
  await steps
    .getByRole("button", { name: "Mark done: Check field moisture" })
    .click();
  await expect.poll(() => api.careBodies.length).toBe(1);
  expect(api.careBodies[0].completedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await expect(steps.locator(".today-chip")).toHaveText("Done");
  await expect(
    steps.getByRole("button", { name: /Mark done/ }),
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
  // Tomato now lists the pool's real product form beside the mock's own, so the product is chosen explicitly.
  await dialog.getByRole("combobox", { name: "Harvest product" }).selectOption("tomato-fresh");
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
  await expect(page.getByTestId("today-recorded-crop")).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "What's growing on this field?",
      exact: true,
    }),
  ).toBeVisible();
});

for (const theme of ["light", "dark"] as const)
  test(`${theme} full-screen layout remains usable at 360px`, async ({
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
    await expect(
      page.getByRole("region", { name: "Upcoming steps" }),
    ).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    // The rail is gone; the four tabs are the bottom bar.
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(farmViews(page).getByRole("link")).toHaveCount(4);
    await expect(
      farmViews(page).getByRole("link", { name: "Today", exact: true }),
    ).toBeInViewport();
  });

for (const theme of ["light", "dark"] as const)
  test(`${theme} 390 px: four bottom tabs replace the rail and the Evara button clears the bar and the content`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await fixture(page, { today: true });
    await page.goto("/farm");
    await expect(
      page.getByRole("region", { name: "Upcoming steps" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Your field" })).toBeVisible();
    // The rail is hidden; one tab navigation is visible and it is the bottom bar.
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(farmViews(page)).toHaveCount(1);
    const bar = page.locator("nav.farm-bottom-tabs");
    await expect(bar).toBeVisible();
    await expect(page.locator("nav.farm-context-tabs")).toBeHidden();
    const links = bar.getByRole("link");
    await expect(links).toHaveCount(4);
    for (const name of tabNames) {
      const link = bar.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      const box = (await link.boundingBox())!;
      expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
    }
    await expect(
      bar.getByRole("link", { name: "Today", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(bar.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(
      bar.getByRole("link", { name: "Today", exact: true }),
    ).toHaveAccessibleDescription("1 care task due");
    // The bar is pinned to the bottom edge and spans the screen.
    const barBox = (await bar.boundingBox())!;
    expect(barBox.x).toBe(0);
    expect(barBox.width).toBe(390);
    expect(Math.round(barBox.y + barBox.height)).toBe(844);
    // Content uses the full width with 16 px gutters.
    const field = (await page
      .getByRole("region", { name: "Your field" })
      .boundingBox())!;
    expect(Math.round(field.x)).toBe(16);
    expect(Math.round(field.x + field.width)).toBe(374);
    expect(await noHorizontalScroll(page)).toBe(true);
    // Evara sits above the bar on the right with a 12 px gap.
    // The header also carries an Evara button (the model activity indicator); this is the floating launcher.
  const evara = page.locator(".assistant-launcher");
    await expect(evara).toBeVisible();
    const evaraBox = (await evara.boundingBox())!;
    expect(barBox.y - (evaraBox.y + evaraBox.height)).toBeGreaterThanOrEqual(
      11.5,
    );
    expect(barBox.y - (evaraBox.y + evaraBox.height)).toBeLessThanOrEqual(12.5);
    expect(Math.round(390 - (evaraBox.x + evaraBox.width))).toBe(16);
    // The last content ends above the Evara button when scrolled to the end.
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    const lastContent = await page
      .locator(".today-layout")
      .evaluate((el) => el.getBoundingClientRect().bottom);
    expect(lastContent).toBeLessThanOrEqual(evaraBox.y);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `../../docs/reference/redesign/shell-mobile-${theme}.png`,
    });
  });

test("390 px: focus runs through the page, the bottom tabs, then Evara; Evara opens above the bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { today: true });
  await page.goto("/farm");
  await expect(
    page.getByRole("region", { name: "Upcoming steps" }),
  ).toBeVisible();
  const bar = page.locator("nav.farm-bottom-tabs");
  // The header also carries an Evara button (the model activity indicator); this is the floating launcher.
  const evara = page.locator(".assistant-launcher");
  await bar.getByRole("link", { name: "Farm", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(evara).toBeFocused();
  await page.keyboard.press("Enter");
  const panel = page.getByLabel("Evara farm assistant", { exact: true });
  await expect(panel).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(barBox.y);
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(390);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("390 px: the More menu holds add a farm, crop library and manage farms", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { today: true });
  await page.goto("/farm");
  const more = page.getByRole("button", { name: "More", exact: true });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("link", { name: "Manage farms", exact: true }),
  ).toHaveCount(0);
  const box = (await more.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  for (const name of ["Add a farm", "Crops for your farm", "Manage farms"])
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole("link", { name: "Crops for your farm", exact: true }).click();
  await expect(page).toHaveURL(/\/catalogue$/);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // Off the farm tabs no tab is current, and the bar is still there to go back.
  await expect(
    page.locator("nav.farm-bottom-tabs").locator('[aria-current="page"]'),
  ).toHaveCount(0);
  await page
    .locator("nav.farm-bottom-tabs")
    .getByRole("link", { name: "Plan", exact: true })
    .click();
  await expect(page).toHaveURL(/\/farm\?tab=year$/);
});

test("1280 px keeps the icon rail and the top tab row, with no bottom bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await fixture(page, { today: true });
  await page.goto("/farm");
  await expect(
    page.getByRole("region", { name: "Upcoming steps" }),
  ).toBeVisible();
  const rail = page.locator(".sidebar");
  await expect(rail).toBeVisible();
  expect((await rail.boundingBox())!.width).toBe(72);
  for (const name of [
    "Farm workspace",
    "Add a farm",
    "Crops for your farm",
    "Manage farms",
  ])
    await expect(
      rail.getByRole("link", { name, exact: true }),
    ).toBeVisible();
  await expect(farmViews(page)).toHaveCount(1);
  await expect(page.locator("nav.farm-context-tabs")).toBeVisible();
  await expect(page.locator("nav.farm-bottom-tabs")).toBeHidden();
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeHidden();
  const main = (await page.locator(".app-body").boundingBox())!;
  expect(main.x).toBe(72);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({
    path: "../../docs/reference/redesign/shell-desktop-light.png",
  });
});

test("tabs switch by click and by keyboard, and only the selected tab is current", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page, { today: true });
  await page.goto("/farm");
  const tabs = farmViews(page);
  const link = (name: string) => tabs.getByRole("link", { name, exact: true });
  await expect(link("Today")).toHaveAttribute("aria-current", "page");
  expect(await tabs.locator('[aria-current="page"]').count()).toBe(1);
  await link("Plan").click();
  await expect(page).toHaveURL(/\/farm\?tab=year$/);
  await expect(link("Plan")).toHaveAttribute("aria-current", "page");
  expect(await tabs.locator('[aria-current="page"]').count()).toBe(1);
  await link("Market").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/farm\?tab=harvest$/);
  await expect(link("Market")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Market timeline", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Wider market context (FAO monthly bulletin)", { exact: true }),
  ).toBeVisible();
  await link("Farm").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/farm\?tab=soil$/);
  await expect(
    page.getByRole("heading", { name: "Which crop fits next?", level: 2 }),
  ).toBeVisible();
  await link("Today").click();
  await expect(page).toHaveURL(/\/farm\?tab=today$/);
  await expect(link("Today")).toHaveAttribute("aria-current", "page");
  expect(await tabs.locator('[aria-current="page"]').count()).toBe(1);
  // Tab order inside the row is the visual order.
  await link("Today").focus();
  for (const name of ["Plan", "Market", "Farm"]) {
    await page.keyboard.press("Tab");
    await expect(link(name)).toBeFocused();
  }
});

test("legacy routes open the matching tab and Farm section", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page, { today: true });
  const expectTab = async (path: string, tab: string, section?: string) => {
    await page.goto(path);
    await expect(
      farmViews(page).getByRole("link", { name: tab, exact: true }),
      `${path} selects ${tab}`,
    ).toHaveAttribute("aria-current", "page");
    if (section)
      await expect(
        page
          .getByRole("navigation", { name: "Farm sections" })
          .getByRole("link", { name: section, exact: true }),
        `${path} selects ${section}`,
      ).toHaveAttribute("aria-current", "page");
  };
  await expectTab("/planner", "Plan");
  await expectTab("/outlook", "Market");
  await expectTab("/farm/settings", "Farm", "Soil records");
  await expect(
    page.getByRole("heading", { name: "Soil markers", exact: true }),
  ).toBeVisible();
  await expectTab("/journal", "Farm", "Activity");
  await expect(
    page.getByRole("heading", { name: "Crop progress", exact: true }),
  ).toBeVisible();
  await expectTab("/farm?tab=activity", "Farm", "Activity");
  await expectTab("/farm?tab=soil&view=records", "Farm", "Soil records");
  await expectTab("/farm?tab=year", "Plan");
  await expectTab("/explore", "Farm", "Crop fit");
  await expect(
    page.getByRole("dialog", { name: "Compare crops for this farm" }),
  ).toBeVisible();
});

test("farm query views react to navigation and survive a fresh reload", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/farm?tab=soil");
  const tabs = farmViews(page);
  const cropFit = page.getByRole("heading", {
    name: "Which crop fits next?",
    level: 2,
  });
  await expect(
    tabs.getByRole("link", { name: "Farm", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(cropFit).toBeVisible();
  await tabs.getByRole("link", { name: "Today", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Your field", exact: true }),
  ).toBeVisible();
  await expect(cropFit).toHaveCount(0);
  await tabs.getByRole("link", { name: "Farm", exact: true }).click();
  await expect(cropFit).toBeVisible();
  await expect(page.locator(".cf-card")).toHaveCount(3);
  await page.reload();
  await expect(cropFit).toBeVisible();
  await expect(page.locator(".cf-card")).toHaveCount(3);
});

test("regional care references appear as dated steps whose detail starts with Guidance from, and the next action leads the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  // SYNTHETIC Today view for a farm whose region has no matched care schedule: one local care task plus Tamil Nadu
  // references dated on the sowing date (care_task steps with a "Guidance from" detail), a dated stage check and a
  // transition. The server dates all of them; the view must show each window and never an undated panel.
  const prefix =
    "Guidance from Tamil Nadu sources (no local schedule for Hassan).";
  const base = todayFixture(A);
  const reference = (id: string, title: string, dueFrom: string, dueTo: string, action: string) => ({
    id,
    kind: "care_task" as const,
    title,
    detail: `${prefix} ${action}`,
    dueFrom,
    dueTo,
    status: "upcoming" as const,
    careTask: null,
    alertId: null,
  });
  const steps = [
    base.upcoming[0]!, // "Check field moisture", due 31 Oct to 2 Nov, completable
    reference("ref:maize-cycle:irrigation:49", "Regional irrigation reference", "2026-11-03", "2026-11-09", "Irrigate at tasselling if the top soil is dry."),
    reference("ref:maize-cycle:weeding:60", "Second weeding reference", "2026-11-14", "2026-11-14", "Hoe between rows once weeds reach the knee."),
    {
      id: "check:maize-cycle:stage-check",
      kind: "stage_check" as const,
      title: "Check: Inspect the observed crop stage",
      detail: `${prefix} Dated from the calendar estimate of the Tasselling and silking stage; check the actual crop stage first. Check the actual crop before using this regional reference.`,
      dueFrom: "2026-11-09",
      dueTo: "2026-11-28",
      status: "upcoming" as const,
      careTask: null,
      alertId: null,
    },
  ];
  await fixture(page, {
    todayView: () => ({ ...base, upcoming: steps, nextAction: steps[0] }),
  });
  await page.goto("/farm");
  const panel = page.getByRole("region", { name: "Upcoming steps" });
  await expect(panel).toBeVisible();
  // The undated panels no longer exist anywhere on Today.
  await expect(page.locator(".stage-guidance-panel")).toHaveCount(0);
  await expect(page.getByText("Other-region care references")).toHaveCount(0);
  await expect(page.getByText("Stage checks without a date")).toHaveCount(0);
  // The next-action card leads, with its window and a Done button for the completable care task.
  const next = panel.getByTestId("today-next-action");
  await expect(next).toBeVisible();
  await expect(next.getByRole("heading", { name: "Check field moisture", exact: true })).toBeVisible();
  await expect(next).toContainText("Next action");
  await expect(next).toContainText("Do between 31 Oct and 2 Nov");
  await expect(next.getByRole("button", { name: "Mark done: Check field moisture" })).toBeVisible();
  // The list below starts with the second step; the card's step is not repeated.
  const later = panel.getByRole("list", { name: "Later steps" });
  const items = later.getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.first().getByRole("heading")).toHaveText("Regional irrigation reference");
  await expect(later.getByRole("heading", { name: "Check field moisture" })).toHaveCount(0);
  // Every step shows a date window; none says "Expected" without a date.
  await expect(items.nth(0).locator(".today-step-when")).toHaveText("3 to 9 Nov");
  await expect(items.nth(1).locator(".today-step-when")).toHaveText("14 Nov");
  await expect(items.nth(2).locator(".today-step-when")).toHaveText("9 to 28 Nov");
  const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const windows = panel.locator(".today-step-when, .today-next-when");
  await expect(windows).toHaveCount(4);
  for (const when of await windows.all())
    await expect(when).toContainText(new RegExp(`\\d{1,2}.*${month}`));
  await expect(panel).not.toContainText("Expected");
  // The regional references are dated steps whose detail starts with "Guidance from", and they cannot be marked done.
  for (const index of [0, 1, 2]) {
    await expect(items.nth(index).locator(".today-step-detail")).toHaveText(
      /^Guidance from Tamil Nadu sources \(no local schedule for Hassan\)\./,
    );
    await expect(items.nth(index).getByRole("button")).toHaveCount(0);
  }
  await expect(items.nth(0).locator(".today-step-detail")).toContainText(
    "Irrigate at tasselling if the top soil is dry.",
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
