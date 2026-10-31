import { expect, test, type Page, type Route } from "@playwright/test";
import type { CurrentMandiQuotes } from "@harvest/contracts";
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const envelope = (data: unknown) => ({
  requestId: "test",
  mode: "live",
  asOf: "2026-10-30T00:00:00Z",
  data,
  warnings: [],
  error: null,
});
function quotes(id: string, reason: string | null = null): CurrentMandiQuotes {
  return {
    checkedAt: "2026-10-30T09:00:00Z",
    selectionBasis: "recommendation_watchlist",
    status: reason ? "unavailable" : "available",
    providerStatus: reason ?? "ok",
    missingReason: reason,
    requestLimit: 6,
    requestsMade: 1,
    limitations: [
      "Single dated quotes do not establish a historical price range.",
    ],
    products: [
      {
        productId: "maize-grain",
        status: reason ? "unavailable" : "available",
        missingReason: reason,
        providerStatus: reason ?? "ok",
        scope: reason ? "unavailable" : "state",
        fallbackReason: reason
          ? null
          : "No matching district quote; showing a market in the same state.",
        quotes: reason
          ? []
          : [
              {
                productId: "maize-grain",
                commodity: "Maize",
                date: "2026-10-30",
                marketId: id === "a" ? "m-a" : "m-b",
                marketName:
                  id === "a" ? "District Alpha Market" : "Broader Beta Market",
                state: "Karnataka",
                district: "Other district",
                variety: "Hybrid",
                grade: null,
                min: "1800",
                modal: "2000",
                max: "2100",
                unit: "INR/quintal",
                unitBasis: "agmarknet_convention",
                modalInrPerKg: "20",
                evidenceState: "observed",
                source: "https://www.data.gov.in/resource/agmarknet",
                fetchedAt: "2026-10-30T09:00:00Z",
                stale: false,
                flags: [],
              },
            ],
      },
    ],
  };
}
async function fixture(
  page: Page,
  options: { rateLimited?: boolean; holdA?: boolean } = {},
) {
  let pending: Route | undefined;
  let posts = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/market-quotes")) {
      if (route.request().method() === "POST") {
        posts++;
        if (path.includes(A) && options.holdA) {
          pending = route;
          return;
        }
        return route.fulfill({
          json: envelope(
            quotes(
              path.includes(A) ? "a" : "b",
              options.rateLimited ? "rate_limited" : null,
            ),
          ),
        });
      }
      return route.fulfill({ json: envelope(quotes("a", "not_refreshed")) });
    }
    const data =
      path === "/api/v1/session"
        ? { authenticated: true, csrfToken: "test" }
        : path === "/api/v1/farms"
          ? {
              farms: [A, B].map((id) => ({
                id,
                name: id === A ? "Field Alpha" : "Field Beta",
                location: {
                  stateCode: "IN-KA",
                  districtId: "IN-KA-hassan",
                  districtName: "Hassan",
                  precision: "district",
                },
                facts: {},
                areaHectares: 1,
              })),
            }
          : path.endsWith("/workspace")
            ? {
                farmId: path.includes(A) ? A : B,
                version: 1,
                updatedAt: null,
                boundary: null,
                previousHarvest: { status: "unknown" },
                cycles: [],
                rotationPlans: [],
              }
            : path.endsWith("/monitoring")
              ? {
                  farmId: path.includes(A) ? A : B,
                  checkedAt: "2026-10-30T09:00:00Z",
                  weather: {
                    status: "unavailable",
                    reason: "forecast_unavailable",
                    issuedAt: null,
                    attribution: "",
                    point: null,
                    days: [],
                  },
                  market: {
                    status: "unavailable",
                    reason: "price_history_insufficient",
                    products: [
                      {
                        productId: "maize-grain",
                        reference: {
                          state: "unavailable",
                          label: "No history",
                          missingReason: "price_history_insufficient",
                        },
                      },
                    ],
                  },
                  meta: {
                    status: "unavailable",
                    reason: "not_requested",
                    automatic: false,
                  },
                }
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
                    ],
                  }
                : path === "/api/v1/ai/activity"
                  ? { invocations: [] }
                  : {};
    await route.fulfill({ json: envelope(data) });
  });
  return {
    get posts() {
      return posts;
    },
    get pending() {
      return pending;
    },
    async release() {
      await pending!.fulfill({ json: envelope(quotes("a")) });
    },
  };
}

test("an actual latest dated quote remains visible when historical trading history is insufficient", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/outlook");
  const current = page.getByRole("region", {
    name: "Latest dated mandi quotes",
  });
  await expect(
    current.getByText("Reported today", { exact: true }),
  ).toBeVisible();
  await expect(
    current.getByText("District Alpha Market · 30 Oct 2026"),
  ).toBeVisible();
  await expect(
    current.getByText("Broader state reference · Other district, Karnataka"),
  ).toBeVisible();
  await expect(
    current.getByText("₹2,000 / quintal in source · AGMARKNET unit convention"),
  ).toBeVisible();
  await expect(
    current.getByRole("link", { name: "AGMARKNET / data.gov.in ↗" }),
  ).toHaveAttribute("href", "https://www.data.gov.in/resource/agmarknet");
  await expect(
    page.getByText("Historical summaries are not available yet."),
  ).toBeVisible();
  expect(api.posts).toBe(1);
});

test("provider rate limits are distinct from missing commodity mapping and insufficient history", async ({
  page,
}) => {
  await fixture(page, { rateLimited: true });
  await page.goto("/outlook");
  const current = page.getByRole("region", {
    name: "Latest dated mandi quotes",
  });
  await expect(
    current.getByText("Mandi provider could not return a quote"),
  ).toBeVisible();
  await expect(
    current.getByText(/The mandi provider is rate limiting requests/).first(),
  ).toBeVisible();
  await expect(
    current.getByText(/Crop-to-market mapping needs verification/),
  ).toHaveCount(0);
  await expect(current.getByText("Reported today")).toHaveCount(0);
});

test("a late current-quote response cannot replace the selected farm quotes", async ({
  page,
}) => {
  const api = await fixture(page, { holdA: true });
  await page.goto("/outlook");
  await expect.poll(() => !!api.pending).toBe(true);
  await page.getByLabel("Selected farm").selectOption(B);
  await expect(
    page.getByText("Broader Beta Market · 30 Oct 2026"),
  ).toBeVisible();
  await api.release();
  await expect(
    page.getByText("District Alpha Market · 30 Oct 2026"),
  ).toHaveCount(0);
  await expect(
    page.getByText("Broader Beta Market · 30 Oct 2026"),
  ).toBeVisible();
});
