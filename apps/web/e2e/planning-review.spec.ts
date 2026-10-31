import { expect, test, type Page, type Route } from "@playwright/test";
import type { PlanningReview, PlanningProposal } from "@harvest/contracts";

// All endpoints are intercepted. These journeys never alter farms or invoke a provider.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const REVIEW = "33333333-3333-4333-8333-333333333333";
const env = (data: unknown) => ({
  schemaVersion: "1.0",
  requestId: "qa",
  mode: "synthetic",
  asOf: "2026-10-30T00:00:00Z",
  data,
  warnings: [],
  error: null,
});
const farm = (id: string) => ({
  id,
  name: id === A ? "Hassan field" : "Other field",
  location: {
    stateCode: "IN-KA",
    districtId: "IN-KA-hassan",
    districtName: "Hassan",
    precision: "district",
  },
  areaHectares: 1,
  facts: {},
});
const manual = {
  id: "manual",
  year: 2027,
  season: "Saved manual season",
  cropId: "ginger",
  cropName: "Ginger",
  plannedSowingDate: "2027-07-01",
  plannedHarvestDate: "2028-02-01",
};
const workspace = (id: string) => ({
  farmId: id,
  version: 1,
  updatedAt: "2026-10-30T00:00:00Z",
  boundary: null,
  previousHarvest: { status: "unknown" },
  cycles: [],
  rotationPlans: [manual],
});
const proposal: PlanningProposal = {
  id: "maize-proposal",
  cropId: "maize",
  productId: "maize-grain",
  cropName: "Maize",
  productName: "Grain",
  season: "rabi",
  plannedSowingDate: "2026-11-01",
  plannedHarvestDate: "2027-02-01",
  harvestWindow: { earliest: "2027-01-20", latest: "2027-02-10" },
  scope: "district",
  reason:
    "A district source supports this sowing window. Confirm the cultivar and water access before planting.",
  evidenceRefs: ["district-window"],
  uncertainties: ["No field soil test is available."],
  conditional: true,
};
function review(status: PlanningReview["status"] = "ready"): PlanningReview {
  return {
    reviewId: REVIEW,
    jobId: REVIEW,
    contextHash: "fixture",
    status,
    stale: false,
    inputVersions: { farm: 1, workspace: 1 },
    generatedAt: "2026-10-30T00:00:00Z",
    retryAfter: null,
    modelInvocation: null,
    summary:
      "Locally sourced options for Hassan, with open requirements to confirm.",
    localContext: {
      location: {
        stateId: "IN-KA",
        districtId: "IN-KA-hassan",
        districtName: "Hassan",
        village: null,
        villageBasis: "unavailable",
        granularity: "district",
        sources: ["district-window"],
        limitations: ["Village evidence is unavailable."],
      },
      weather: {
        kind: "forecast",
        status: "stale",
        issuedAt: "2026-10-28T00:00:00Z",
        source: "Weather fixture",
        days: [],
        limitations: ["Near-term only."],
      },
      mandi: {
        status: "unavailable",
        references: [],
        limitations: ["No dated quote."],
      },
      history: {
        basis: "farmer_reported",
        previousHarvest: { status: "unknown" },
        cycles: [],
        rotationAssessment: "not_assessed",
      },
      occupancy: [],
    },
    horizon: { from: "2026-10-30", to: "2027-10-29" },
    rotationDraft: status === "ready" ? [proposal] : [],
    comparisonShortlist:
      status === "ready"
        ? [
            {
              ...proposal,
              candidateId: "maize",
              rank: 1,
              nextSowingDate: "2026-11-01",
              sowingWindow: { from: "2026-11-01", to: "2026-11-30" },
              availability: "free_window",
            },
            {
              ...proposal,
              candidateId: "sunflower",
              cropId: "sunflower",
              productId: "sunflower-seed",
              cropName: "Sunflower",
              productName: "Seed",
              rank: 2,
              nextSowingDate: "2027-01-01",
              sowingWindow: { from: "2027-01-01", to: "2027-01-31" },
              availability: "free_window",
            },
            {
              ...proposal,
              candidateId: "potato",
              cropId: "potato",
              productId: "potato-tuber",
              cropName: "Potato",
              productName: "Tuber",
              rank: 3,
              nextSowingDate: "2026-11-01",
              sowingWindow: { from: "2026-11-01", to: "2026-11-30" },
              availability: "free_window",
            },
          ].map(
            ({
              id,
              season,
              plannedSowingDate,
              plannedHarvestDate,
              conditional,
              ...pick
            }: any) => pick,
          )
        : [],
    evidence: [
      {
        id: "district-window",
        title: "District crop window source",
        url: "https://example.org/crop-window",
        scope: "district",
        geographyIds: ["IN-KA-hassan"],
        reviewStatus: "pending",
        limitations: ["Confirm the named cultivar."],
      },
    ],
    limitations: ["Rotation suitability remains unassessed."],
    appliedProposalIds: [],
  };
}
function item(cropId: string, productId: string, cropName: string) {
  const unknown = {
    status: "unknown",
    value: null,
    basis: null,
    missingReason: "no_evidence",
    evidenceIds: [],
  };
  return {
    rank: 1,
    cropId,
    productId,
    cropName,
    productName:
      cropId === "sunflower" ? "Seed" : cropId === "potato" ? "Tuber" : "Grain",
    productBasis: "grain",
    group: "field",
    localNames: [],
    outcome: "unknown",
    screening: {
      reasons: [],
      unknownFields: [],
      appliedRuleIds: [],
      evidenceIds: [],
      candidateRuleIds: [],
      noApplicableRule: true,
    },
    context: null,
    referenceContexts: [],
    season: null,
    plantingWindow: null,
    repeatedPicking: null,
    harvestPattern: null,
    dimensions: {
      waterFit: unknown,
      timeToFirstIncome: unknown,
      harvestWindows: unknown,
      evidenceQuality: unknown,
      marketAccess: unknown,
      economics: unknown,
    },
    completeness: { known: 0, total: 6 },
    yieldReference: null,
    costBasis: { state: "unavailable", label: "Unavailable" },
    priceReference: {
      state: "unavailable",
      label: "No quotes",
      missingReason: "price_history_not_ingested",
    },
    downside: { computable: false, text: "Unknown" },
    mostConsequentialMissingInput: null,
    evidenceCoverage: {
      sourcedRequirements: 0,
      evidenceRecords: 0,
      validationPending: true,
    },
  };
}
async function fixture(
  page: Page,
  options: { pending?: boolean; holdA?: boolean } = {},
) {
  let current = review(options.pending ? "pending" : "ready");
  let hold: Route | undefined;
  let saved = workspace(A);
  const posts: string[] = [];
  const comparisons: any[] = [];
  const applies: any[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (path.endsWith("/planning-review/apply")) {
      const body = route.request().postDataJSON();
      applies.push(body);
      saved = {
        ...saved,
        version: 2,
        rotationPlans: [
          ...saved.rotationPlans,
          {
            ...proposal,
            id: proposal.id,
            year: 2026,
            notes: "Applied proposal",
          },
        ],
      };
      current = { ...current, appliedProposalIds: [proposal.id] };
      return route.fulfill({
        json: env({ workspace: saved, review: current }),
      });
    }
    if (path.endsWith("/planning-review")) {
      if (options.holdA && path.includes(A) && method === "GET" && !hold) {
        hold = route;
        return;
      }
      if (method === "POST") posts.push(path);
      return route.fulfill({ json: env(current) });
    }
    if (path === "/api/v1/crop-comparisons") {
      comparisons.push(route.request().postDataJSON());
      return route.fulfill({
        json: env({
          asOf: "2026-10-30",
          mode: "synthetic",
          input: {},
          rulePolicy: { executed: [], candidateRulesExecuted: false },
          rankingBasis: "Evidence only",
          items: [
            item("maize", "maize-grain", "Maize"),
            item("potato", "potato-tuber", "Potato"),
            item("sunflower", "sunflower-seed", "Sunflower"),
          ],
          counts: { unknown: 3 },
          unsupportedDimensions: [],
        }),
      });
    }
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "qa" }
        : path === "/api/v1/farms"
          ? { farms: [farm(A), farm(B)] }
          : path.endsWith("/workspace")
            ? path.includes(A)
              ? saved
              : workspace(B)
            : path === "/api/v1/ai/activity"
              ? { invocations: [] }
              : path === "/api/v1/crops"
                ? {
                    crops: [
                      {
                        cropId: "maize",
                        name: "Maize",
                        products: [
                          {
                            productId: "maize-grain",
                            name: "Grain",
                            productBasis: "grain",
                          },
                        ],
                      },
                      { cropId: "ginger", name: "Ginger", products: [] },
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
    return route.fulfill({ json: env(data) });
  });
  return {
    posts,
    comparisons,
    applies,
    get hold() {
      return hold;
    },
    setReady() {
      current = review();
    },
    async releaseOldUnavailable() {
      await hold!.fulfill({
        json: env({
          ...review("unavailable"),
          reviewId: null,
          jobId: null,
          rotationDraft: [],
          comparisonShortlist: [],
        }),
      });
    },
    get saved() {
      return saved;
    },
  };
}

test("an existing farm receives a review automatically; edit and explicit apply preserve saved seasons", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/planner");
  const panel = page.getByRole("region", {
    name: "Evara localized planning review",
  });
  await expect(
    panel.getByText("Ready to review", { exact: true }),
  ).toBeVisible();
  expect(api.applies).toHaveLength(0);
  await expect(
    panel.getByText("Stale forecast issued 28 Oct 2026"),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Edit proposal" }).click();
  await expect(
    page.getByRole("heading", { name: "What's growing next?" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Season", exact: true }),
  ).toHaveValue("Rabi");
  await page
    .getByRole("button", { name: "Close season editor", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Add 1 selected to rotation" })
    .click();
  await expect.poll(() => api.applies.length).toBe(1);
  expect(api.applies[0]).toEqual({
    reviewId: REVIEW,
    proposalIds: ["maize-proposal"],
    expectedWorkspaceVersion: 1,
  });
  expect(api.saved.rotationPlans.map((p) => p.id)).toEqual([
    "manual",
    "maize-proposal",
  ]);
  await expect(
    panel.getByText("Added to your rotation", { exact: true }),
  ).toBeVisible();
});

test("comparison waits for review, follows ranked local windows, and retains manual date and picks across navigation", async ({
  page,
}) => {
  const api = await fixture(page, { pending: true });
  await page.goto("/explore");
  await expect(
    page.getByRole("button", { name: "Refresh comparison", exact: true }),
  ).toBeDisabled();
  expect(api.comparisons).toHaveLength(0);
  api.setReady();
  await expect.poll(() => api.comparisons.length).toBe(1);
  expect(api.comparisons[0].planting.date).toBe("2026-11-01");
  await expect(page.locator(".growth-sketch")).toHaveCount(0);
  await expect(page.getByLabel("Soil-water appearance")).toHaveCount(0);
  const headers = page.locator(".comparison-table-card thead th");
  await expect(headers).toHaveText([
    "FOR YOUR FARM",
    "×MaizeGrain",
    "×SunflowerSeed",
    "×PotatoTuber",
  ]);
  await expect(
    page.getByText("Source-based harvest estimate · confirm cultivar").first(),
  ).toBeVisible();
  const panel = page.getByRole("region", {
    name: "Evara localized planning review",
  });
  await expect(panel.getByLabel("Priority 2")).toHaveText("#2");
  const reason = panel.locator(".planning-option-reason").first();
  await expect(reason.locator("p").first()).not.toBeVisible();
  await reason.getByText("Why this option", { exact: true }).click();
  await expect(reason.locator("p").first()).toContainText(
    "Confirm the cultivar",
  );
  await page.locator(".crop-option").filter({ hasText: "Potato" }).click();
  await page.getByLabel("Planned sowing").fill("2027-01-15");
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Rotation planner" })
    .click();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Compare crops" })
    .click();
  await expect(page.getByLabel("Planned sowing")).toHaveValue("2027-01-15");
  await expect(page.locator(".comparison-table-card thead th")).toHaveText([
    "FOR YOUR FARM",
    "×MaizeGrain",
    "×SunflowerSeed",
  ]);
});

test("switching farms during the initial context read cannot dispatch paid planning work for the old farm", async ({
  page,
}) => {
  const api = await fixture(page, { holdA: true });
  await page.goto("/planner");
  await expect.poll(() => !!api.hold).toBe(true);
  await page.getByLabel("Selected farm").selectOption(B);
  await expect(
    page
      .getByRole("region", { name: "Evara localized planning review" })
      .getByText("Ready to review", { exact: true }),
  ).toBeVisible();
  await api.releaseOldUnavailable();
  await expect(page.getByLabel("Selected farm")).toHaveValue(B);
  expect(api.posts.some((path) => path.includes(A))).toBe(false);
});
