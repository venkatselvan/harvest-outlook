import { expect, test, type Page } from "@playwright/test";
import type {
  PricedCommodity,
  ResearchedCropProfile,
} from "@harvest/contracts";
const env = (data: unknown) => ({
  requestId: "test",
  mode: "live",
  asOf: "2026-10-30T00:00:00Z",
  data,
  warnings: [],
  error: null,
});
const source = "https://api.data.gov.in/resource/agmarknet";
const entry = (
  id: string,
  name: string,
  grouping = "crop",
): PricedCommodity => ({
  commodityId: id,
  sourceCommodity: name,
  grouping,
  identityStatus:
    grouping === "crop" ? "species_reference_available" : "identity_pending",
  identityNote: "Provider identity is preserved with its source scope.",
  botanicalName: grouping === "crop" ? "Mangifera indica" : null,
  profileId: id,
  profileStatus: grouping === "livestock" ? "not_applicable" : "researched",
  profileUrl: `/api/v1/commodity-profiles/${id}`,
  cropId: null,
  productId: null,
  priceCoverage: {
    validRows: 2,
    modalRows: 2,
    dateRange: { from: "2026-10-30", to: "2026-10-30" },
    states: ["Maharashtra"],
    marketCount: 1,
    unitStatus: "provider_unit_not_declared",
    examples: [
      {
        market: "Pune APMC",
        district: "Pune",
        state: "Maharashtra",
        date: "2026-10-30",
        modal: "4000",
        sourcePriceUnit: "unit not declared",
      },
    ],
  },
});
const ecological = (name = "Mangifera indica") => ({
  ecoportCode: "1416",
  sourceUrl: "https://ecocrop.apps.fao.org/ecocrop/srv/en/dataSheet?id=1416",
  evidenceType: "legacy_global_ecological_reference" as const,
  sourceScientificName: name,
  parameters: {
    temperatureC: {
      optimalMin: 24,
      optimalMax: 30,
      absoluteMin: 8,
      absoluteMax: 48,
    },
    annualRainfallMm: {
      optimalMin: 600,
      optimalMax: 1500,
      absoluteMin: 300,
      absoluteMax: 2600,
    },
    soilPh: {
      optimalMin: 5.5,
      optimalMax: 7.5,
      absoluteMin: 4.3,
      absoluteMax: 8.5,
    },
    soilTexture: { optimal: "medium, light", absolute: "heavy, medium, light" },
    soilDepth: { optimal: "deep", absolute: "medium" },
    soilSalinity: { optimal: "low", absolute: "low" },
    soilDrainage: { optimal: "well", absolute: "well" },
    light: {
      optimalMin: "very bright",
      optimalMax: "very bright",
      absoluteMin: "cloudy",
      absoluteMax: "very bright",
    },
    photoperiod: null,
    cropCycleDays: { min: 150, max: 365 },
  },
  qualityFlags: [],
  limitations: [
    "Global legacy reference; pH method and salinity extract unspecified.",
  ],
});
const profile = (id: string): ResearchedCropProfile => ({
  profileId: id,
  botanicalName: id === "amaranth" ? null : "Mangifera indica",
  sourceCommodities: [id === "amaranth" ? "Grain amaranth" : "Mango"],
  identityStatus:
    id === "amaranth" ? "identity_pending" : "species_reference_available",
  ecocrop: id === "amaranth" ? null : ecological(),
  ecocropVariants:
    id === "amaranth"
      ? [
          {
            botanicalName: "Amaranthus cruentus",
            identitySelected: false,
            applicability: "Market name does not select this species.",
            reference: ecological("Amaranthus cruentus"),
          },
          {
            botanicalName: "Amaranthus hypochondriacus",
            identitySelected: false,
            applicability: "Separate species alternative.",
            reference: ecological("Amaranthus hypochondriacus"),
          },
        ]
      : [],
  regionalEvidence:
    id === "mango"
      ? [
          {
            parameter: "planting_window",
            value: "July–December",
            unit: "months",
            scope: {
              geography: "Tamil Nadu extension reference",
              conditions: "Tamil Nadu; not a national calendar",
            },
            sourceUrl:
              "https://agritech.tnau.ac.in/horticulture/horti_fruits_mango.html",
            locator: "Season of planting",
            retrievedAt: "2026-10-30",
            executableRecommendation: false,
          },
          {
            parameter: "fertilizer_reference",
            value: "Sixth-year conventional tree table; HDP differs.",
            unit: "per tree",
            scope: {
              geography: "Tamil Nadu",
              conditions:
                "P/K form unestablished; age/system-specific reference",
            },
            sourceUrl:
              "https://agritech.tnau.ac.in/horticulture/horti_fruits_mango.html",
            locator: "Manures and fertilizers",
            retrievedAt: "2026-10-30",
            executableRecommendation: false,
          },
        ]
      : [],
  gaps: ["No field-specific fertilizer prescription."],
});
async function fixture(page: Page) {
  const items = [
    entry("mango", "Mango"),
    entry("buffalo", "Buffalo", "livestock"),
    entry("amaranth", "Grain amaranth", "crop_group"),
    ...Array.from({ length: 254 }, (_, i) =>
      entry(`source-${i}`, `Priced source name ${String(i).padStart(3, "0")}`),
    ),
  ];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === "/api/v1/commodities"
        ? {
            snapshot: {
              id: "saved-2026-10-30",
              checkedAt: "2026-10-30T09:00:00Z",
              complete: true,
              commodityCount: 257,
              rowCount: 1000,
              sourceUrl: source,
              limitations: ["Snapshot of returned provider pages only."],
            },
            total: 257,
            offset: 0,
            limit: 300,
            items,
          }
        : path.startsWith("/api/v1/commodity-profiles/")
          ? profile(path.split("/").at(-1)!)
          : path === "/api/v1/session"
            ? { authenticated: true, csrfToken: "test" }
            : path === "/api/v1/farms"
              ? { farms: [] }
              : path === "/api/v1/crops"
                ? { crops: [] }
                : path === "/api/v1/ai/activity"
                  ? { invocations: [] }
                  : {};
    await route.fulfill({ json: env(data) });
  });
}
test("the actual inventory is independent of the old screening list, with all market names and crop filtering", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/catalogue");
  await page.getByRole("button", { name: /Browse the full catalogue/ }).click();
  await expect(page.getByLabel("Commodity group")).toHaveValue("crops");
  await expect(
    page.getByRole("button", { name: "Open Buffalo profile" }),
  ).toHaveCount(0);
  await page.getByLabel("Commodity group").selectOption("all");
  await expect(
    page.getByRole("button", { name: "Open Buffalo profile" }),
  ).toBeVisible();
  await page.getByLabel("Search crops").fill("Priced source name 253");
  await expect(
    page.getByRole("button", { name: "Open Priced source name 253 profile" }),
  ).toBeVisible();
  await expect(
    page.getByText(/257 exact source names in this snapshot/),
  ).toBeVisible();
});
test("profile renders source facts, scoped fertilizer reference, raw quote units and retrieval date", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/catalogue");
  await page.getByRole("button", { name: /Browse the full catalogue/ }).click();
  await page.getByRole("button", { name: "Open Mango profile" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("July–December · months")).toBeVisible();
  await expect(
    dialog.getByText("Tamil Nadu; not a national calendar"),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "Sixth-year conventional tree table; HDP differs. · per tree",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText("P/K form unestablished; age/system-specific reference"),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      /Source section: Season of planting · retrieved 30 Oct 2026/,
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText("source modal field · unit not declared"),
  ).toBeVisible();
  await expect(dialog.getByText(/Snapshot retrieved/)).toBeVisible();
  await expect(dialog.getByText("Legacy global scope")).toBeVisible();
});
test("ambiguous species references stay separate and unselected rather than inheriting one profile", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/catalogue");
  await page.getByRole("button", { name: /Browse the full catalogue/ }).click();
  await page
    .getByRole("button", { name: "Open Grain amaranth profile" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Species-specific reference candidates"),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "The market name does not resolve one botanical species. These references stay separate and are not selected for farm matching.",
    ),
  ).toBeVisible();
  await dialog
    .locator(".commodity-species-variant")
    .filter({ hasText: "Amaranthus cruentus" })
    .locator("summary")
    .click();
  await expect(
    dialog
      .locator(".commodity-species-variant")
      .filter({ hasText: "Amaranthus cruentus" })
      .getByText("24–30 °C"),
  ).toBeVisible();
  await expect(
    dialog
      .locator(".commodity-species-variant")
      .filter({ hasText: "Amaranthus hypochondriacus" })
      .getByText("24–30 °C"),
  ).not.toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Compare sourced requirements" }),
  ).toHaveCount(0);
});
