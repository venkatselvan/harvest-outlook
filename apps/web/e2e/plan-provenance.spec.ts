import { expect, test } from "@playwright/test";
const realId = "11111111-1111-4111-8111-111111111111",
  demoId = "22222222-2222-4222-8222-222222222222",
  planId = "33333333-3333-4333-8333-333333333333";
const envelope = (data: unknown) => ({
  requestId: "test",
  mode: "synthetic",
  asOf: "2026-10-30T00:00:00Z",
  data,
  warnings: [],
  error: null,
});
const farm = (id: string, demo: boolean) => ({
  id,
  name: demo ? "Demo boundary farm" : "Real farm",
  location: {
    districtId: "IN-KA-hassan",
    districtName: "Hassan",
    stateCode: "IN-KA",
    precision: "district",
  },
  areaHectares: 1,
  facts: demo ? { demo_prefilled: { value: true } } : {},
});
for (const demoPlan of [true, false])
  test(`plan input provenance uses its actual ${demoPlan ? "demo" : "real"} farm despite an unrelated selected farm`, async ({
    page,
  }) => {
    const actualFarm = demoPlan ? demoId : realId;
    const selectedFarm = demoPlan ? realId : demoId;
    await page.addInitScript(
      (id) => localStorage.setItem("ho.selectedFarm", id),
      selectedFarm,
    );
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const data =
        path === "/api/v1/session"
          ? { authenticated: true, csrfToken: "test" }
          : path === "/api/v1/farms"
            ? { farms: [farm(realId, false), farm(demoId, true)] }
            : path === `/api/v1/plans/${planId}`
              ? {
                  snapshot: {
                    id: planId,
                    farmId: actualFarm,
                    cropId: "ginger",
                    productId: "ginger-fresh",
                    confirmedInputs: [
                      {
                        key: "planting_date",
                        value: {
                          value: "2026-06-01",
                          unit: null,
                          evidenceState: "farmer_reported",
                        },
                      },
                    ],
                    assumptions: [],
                    createdAt: "2026-06-01T00:00:00Z",
                    parentId: null,
                  },
                  outputs: [
                    {
                      id: "stages",
                      kind: "stage_windows",
                      output: {
                        plantingDate: "2026-06-01",
                        stages: [
                          {
                            stageId: "growing",
                            name: "Growing",
                            order: 1,
                            isHarvest: false,
                            evidenceIds: [],
                            reviewStatus: "approved",
                          },
                        ],
                        limitations: [],
                      },
                    },
                  ],
                  lineage: { parentId: null, childIds: [] },
                }
              : path === `/api/v1/plans/${planId}/timeline`
                ? {
                    planId,
                    scenarioId: "early",
                    planContentHash: "test",
                    asOfDate: "2026-06-01",
                    range: { from: "2026-06-01", to: "2026-06-01" },
                    days: [
                      {
                        calendarDate: "2026-06-01",
                        daysAfterPlanting: 0,
                        markers: { planting: true, asOf: true, past: false },
                        expectedStage: {
                          stageId: "growing",
                          occurrence: 1,
                          window: { start: "2026-06-01", end: "2026-06-01" },
                          inferred: true,
                          basis: "calendar_estimate",
                          possibleStageIds: ["growing"],
                        },
                        tasks: {
                          due: [],
                          overdue: [],
                          done: [],
                          conditionFlags: [],
                        },
                        weather: {
                          state: "unavailable",
                          values: null,
                          issuedAt: null,
                          horizonDays: null,
                          assumptionId: null,
                          sourceId: null,
                          missingReason: "not_available",
                        },
                        water: {
                          state: "unavailable",
                          outputId: null,
                          missingReason: "not_computed",
                        },
                        outlook: {
                          state: "unavailable",
                          harvestPeriodId: null,
                          artifactId: null,
                          issuedAt: null,
                          missingReason: "not_available",
                        },
                        visual: {
                          state: "illustrative",
                          assetId: "generated-stage-asset",
                        },
                        evidenceRefs: [],
                      },
                    ],
                  }
                : path.endsWith("/visuals")
                  ? { planId, generating: false, stages: [] }
                  : path.endsWith("/media")
                    ? { media: [] }
                    : path === "/api/v1/crops"
                      ? { crops: [] }
                      : path === "/api/v1/ai/activity"
                        ? { invocations: [] }
                        : path.endsWith("/workspace")
                          ? {
                              farmId: selectedFarm,
                              version: 0,
                              boundary: null,
                              previousHarvest: { status: "unknown" },
                              cycles: [],
                              rotationPlans: [],
                              updatedAt: null,
                            }
                          : {};
      await route.fulfill({ json: envelope(data) });
    });
    await page.goto(`/farm/plan/${planId}`);
    await expect(page.getByLabel("Selected farm")).toHaveValue(selectedFarm);
    const summary = page.getByTestId("plan-summary");
    await expect(summary).toBeVisible();
    await expect(summary.getByTestId("badge-farmer_reported")).toBeVisible();
    await expect(summary).not.toContainText("Illustrative");
    if (demoPlan) {
      await expect(summary.getByRole("note")).toContainText(
        "prefilled demo boundary",
      );
    } else {
      await expect(summary.getByRole("note")).toHaveCount(0);
    }
    await expect(page.getByTestId("panel-scene")).toContainText(
      "No photo recorded for this date",
    );
    await expect(page.locator("canvas,.growth-sketch")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Generate illustrations/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Soil measurements" }),
    ).toBeVisible();
    await expect(
      page.getByText("Soil moisture and soil condition remain unknown.", {
        exact: false,
      }),
    ).toBeVisible();
  });
