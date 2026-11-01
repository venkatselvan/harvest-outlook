import type { SeasonPreview } from "@harvest/contracts";

/**
 * SYNTHETIC season preview fixtures for tests and the e2e spec (not real prices, weather or yields). The shape follows
 * the SeasonPreview contract; the numbers are round values chosen to be checked by eye.
 */
export const FIXTURE_FARM_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_PLAN_ID = "rot-pigeon";

const week = (i: number) => new Date(Date.UTC(2027, 4, 10) + i * 7 * 86_400_000).toISOString().slice(0, 10);

export function seasonPreviewFixture(over: Partial<SeasonPreview> = {}): SeasonPreview {
  return {
    farmId: FIXTURE_FARM_ID, planId: FIXTURE_PLAN_ID, origin: "saved_season", cropId: "pigeon-pea", cropName: "Pigeon pea", productId: "pigeon-pea-whole", productName: "Whole",
    establishmentMethod: null, kind: "crop", companion: null, today: "2026-11-01", sowing: "2027-05-16", harvest: { earliest: "2027-11-20", latest: "2027-12-10" }, fieldAreaHa: 1.2,
    timeline: {
      cropId: "pigeon-pea", productId: "pigeon-pea-whole", establishmentMethod: null, anchorDate: "2027-05-16",
      stages: [
        { id: "initial", name: "Establishment", from: "2027-05-16", to: "2027-06-30", basis: "fao_generic" },
        { id: "development", name: "Vegetative growth", from: "2027-07-01", to: "2027-09-15", basis: "fao_generic" },
        { id: "mid", name: "Flowering and pod fill", from: "2027-09-16", to: "2027-11-19", basis: "fao_generic" },
      ],
      harvest: { earliest: "2027-11-20", latest: "2027-12-10" },
      basis: { kind: "duration", label: "Synthetic duration", sourceId: null, url: null, scope: null, note: null },
    },
    weather: {
      status: "typical",
      months: [
        { month: "2027-05-01", label: "May 2027", rainMm: 64, tMaxC: 31, tMinC: 20, days: 16 },
        { month: "2027-06-01", label: "Jun 2027", rainMm: 150, tMaxC: 28, tMinC: 19, days: 30 },
        { month: "2027-07-01", label: "Jul 2027", rainMm: 210, tMaxC: 27, tMinC: 19, days: 31 },
      ],
      source: { sourceId: "open-meteo-archive", years: { from: 2016, to: 2025 } },
      note: "Typical conditions from past years' normals; not a forecast.",
    },
    water: { fit: 0.62, needMm: 650, rainMm: 540, verdict: "Typical rain covers part of the need; plan water for dry spells." },
    price: {
      status: "available", unit: "INR/kg", harvestWeek: "2027-W47", p50: 70, likely: { low: 66, high: 75 }, scopeLabel: "Hassan district mandis, wholesale mandi modal price", yearsUsed: [2023, 2024, 2025],
      path: Array.from({ length: 34 }, (_, i) => ({ weekStart: week(i), p50: i === 5 ? null : 60 + i * 0.5, likely: i === 5 ? null : { low: 58 + i * 0.5, high: 62 + i * 0.5 } })),
      reason: null,
    },
    marketNow: { p50: 72.5, date: "2026-10-30", markets: 3, scopeLabel: "Hassan district mandis, last 14 trading days to 30 Oct 2026" },
    yieldKgPerHa: { low: 500, high: 900 }, yieldBasis: "state", yieldForFieldKg: { low: 600, high: 1080 },
    cost: { a2flPerHa: 30000, c2PerHa: 45000, authority: "cacp", year: "2022-23", region: "KA" },
    profitPerHa: { central: 15000, likely: { low: 8000, high: 22000 }, possible: { low: -2000, high: 30000 } },
    profitForField: { central: 18000, likely: { low: 9600, high: 26400 }, possible: { low: -2400, high: 36000 } },
    score: 64.2, components: { price: 0.7, yield: 0.5, soilRotation: 0.8, water: 0.62, confidence: 0.6 }, reasonCodes: ["legume_after_heavy_feeder"],
    steps: [
      { kind: "stage", title: "Establishment", from: "2027-05-16", to: "2027-06-30", detail: "Generic stage shares.", source: null },
      { kind: "care", title: "Thin to one plant per hill", from: "2027-06-05", to: "2027-06-10", detail: "Synthetic care step.", source: { id: "synthetic-care", publisher: "Synthetic publisher" } },
      { kind: "harvest", title: "Harvest window", from: "2027-11-20", to: "2027-12-10", detail: null, source: null },
    ],
    soil: {
      status: "compared",
      checks: [
        { parameter: "ph", label: "pH", value: 6.4, unit: null, rating: "medium", need: null, verdict: "ok", note: "Within the crop range.", assumption: null, markerId: null, sampleId: null, collectionDate: null, ratingSource: null },
      ] as unknown as NonNullable<SeasonPreview["soil"]>["checks"],
    },
    basis: [],
    limitations: ["Planned season: a calculated reference from the stage calendar, typical weather of past years and historical prices. Nothing here is a forecast or an observation."],
    ...over,
  };
}

/** Nothing available: no stage calendar, no normals, no product, no review, no soil report, no steps. */
export function seasonPreviewEmptyFixture(): SeasonPreview {
  return seasonPreviewFixture({
    planId: null, origin: "custom", cropId: "sunn-hemp", cropName: "Sunn hemp", productId: null, productName: null, kind: "green_manure", harvest: null, timeline: null,
    weather: { status: "unavailable", months: [], source: null, note: "Typical conditions from past years' normals; not a forecast. Unavailable: the farm has no map point, so normals cannot be read." },
    water: null, price: null, marketNow: null, yieldKgPerHa: null, yieldBasis: null, yieldForFieldKg: null, cost: null, profitPerHa: null, profitForField: null, score: null, components: null,
    reasonCodes: [], steps: [], soil: { status: "no_report", checks: [] }, limitations: [],
  });
}
