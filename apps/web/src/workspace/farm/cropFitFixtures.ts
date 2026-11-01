import type { CropFitCandidate, CropFitReview, SoilCheck } from "@harvest/contracts";

/**
 * SYNTHETIC test fixtures for the crop fit view (unit tests only; never shown as data). Shapes follow the
 * CropFitReview contract and every fixture is parsed with CropFitReview.parse in cropFit.test.tsx. Numbers are
 * invented for layout and state tests, not market, yield or soil observations.
 */
export const FIXTURE_FARM_ID = "00000000-0000-4000-8000-000000000f17";
const REVIEW_ID = "00000000-0000-4000-8000-0000000000a1";
const JOB_ID = "00000000-0000-4000-8000-0000000000b1";
const SAMPLE_ID = "00000000-0000-4000-8000-0000000000c1";

const check = (over: Partial<SoilCheck> & Pick<SoilCheck, "parameter" | "label" | "rating" | "verdict">): SoilCheck => ({
  value: null, unit: null, need: null, note: null, assumption: null, markerId: `m-${over.parameter}`, sampleId: SAMPLE_ID, collectionDate: "2026-09-20",
  ratingSource: { id: "synthetic-bands", title: "Synthetic rating bands (test)", url: "https://example.org/bands" }, ...over,
});
export const SOIL_CHECKS: SoilCheck[] = [
  check({ parameter: "ph", label: "Soil pH", value: 7.2, unit: "pH", rating: "neutral", verdict: "watch", note: "Outside the cited range for this crop, pH 6 to 6.5 (synthetic source)." }),
  check({ parameter: "nitrogen_unspecified", label: "Nitrogen (pool not printed)", value: 278, unit: "kg/ha", rating: "low", need: "high", verdict: "short", assumption: "Pool not printed; rated as available N (test)." }),
  check({ parameter: "phosphorus_total", label: "Total phosphorus", value: 16, unit: "kg/ha", rating: "medium", need: "medium", verdict: "watch" }),
  check({ parameter: "potassium_total", label: "Total potassium", value: 186, unit: "kg/ha", rating: "medium", need: "low", verdict: "ok" }),
  check({ parameter: "electrical_conductivity", label: "Salinity (EC)", value: 0.86, unit: "dS/m", rating: "normal", verdict: "unknown", note: "No sourced crop requirement to compare with." }),
];

let rank = 0;
export function fixtureCandidate(over: Partial<CropFitCandidate> & Pick<CropFitCandidate, "cropId" | "productId" | "cropName" | "productName">): CropFitCandidate {
  rank += 1;
  return {
    establishmentMethod: "direct_sowing", rank, score: 70 - rank * 3,
    components: { price: 0.62, yield: 0.71, soilRotation: 0.65, water: 0.8, confidence: 0.6 },
    sowing: "2027-02-04", harvest: { earliest: "2027-05-15", latest: "2027-06-04" }, durationDays: { low: 100, high: 120 },
    window: { scope: "district", season: "summer", fit: 1, shiftedDays: 0 },
    yieldKgPerHa: { low: 3800, high: 4500 }, yieldBasis: "district",
    price: { status: "available", unit: "INR/kg", p50: 24, range: { low: 20, high: 29 }, harvestWeek: "2027-W21", yearsUsed: [2023, 2024, 2025], observations: 120, scope: { level: "state", stateName: "Karnataka", districtName: null, marketCount: 3 }, reason: null },
    marketNow: { p50: 22.5, date: "2026-10-30", markets: 4, scopeLabel: "Hassan district mandis, last 14 trading days to 30 Oct 2026" },
    cost: { a2flPerHa: 52000, c2PerHa: null, authority: "cacp", year: "2022-23", region: "IN-KA" },
    profitPerHa: { central: 41000, likely: { low: 26000, high: 58000 }, possible: { low: 14000, high: 76000 } },
    profitForField: { central: 6600, likely: { low: 4200, high: 9300 }, possible: { low: 2200, high: 12200 } },
    soil: { status: "compared", checks: SOIL_CHECKS },
    water: { fit: 0.8, needMm: 500, rainMm: 310, verdict: "Usual rain 310 mm plus 150 mm irrigation against a need of 500 mm." },
    rotation: { previousCropId: "paddy", rule: "family_break", note: "After paddy: different crop family." },
    confidence: "medium", reasonCodes: ["price_timing_strong", "district_window", "family_break"],
    uncertainties: ["Synthetic fixture uncertainty."],
    basis: [{ kind: "yield_reference", label: "Yield: synthetic test source", sourceId: "synthetic-yield", url: "https://example.org/yield", scope: "IN-KA-hassan", note: null }],
    ...over,
  };
}

rank = 0;
const maize = fixtureCandidate({ cropId: "maize", productId: "maize-grain", cropName: "Maize", productName: "Grain" });
const groundnut = fixtureCandidate({ cropId: "groundnut", productId: "groundnut-pod", cropName: "Groundnut", productName: "Pod", reasonCodes: ["legume_after_heavy_feeder", "family_break", "water_fit_good"], rotation: { previousCropId: "paddy", rule: "legume_after_heavy_feeder", note: "After paddy: legume after a heavy feeder." } });
const onion = fixtureCandidate({ cropId: "onion", productId: "onion-bulb", cropName: "Onion", productName: "Bulb", establishmentMethod: "transplanting", window: { scope: "state", season: "summer", fit: 0.8, shiftedDays: 6 }, reasonCodes: ["margin_rate_high", "state_window_fallback", "window_shifted"], sowing: "2027-02-10" });
const chilliDry = fixtureCandidate({ cropId: "chilli", productId: "chilli-dry", cropName: "Chilli", productName: "Dry", cost: null, profitPerHa: null, profitForField: null, reasonCodes: ["cost_not_sourced", "district_window"] });
const sorghum = fixtureCandidate({ cropId: "sorghum", productId: "sorghum-grain", cropName: "Sorghum", productName: "Grain", marketNow: null, price: null, yieldKgPerHa: null, yieldBasis: null, profitPerHa: null, profitForField: null, reasonCodes: ["yield_not_sourced", "price_insufficient"] });
export const CANDIDATES = [maize, groundnut, onion, chilliDry, sorghum];

const base: CropFitReview = {
  reviewId: REVIEW_ID, jobId: JOB_ID, contextHash: "synthetic-hash", status: "ready", stale: false,
  request: { mode: "next", season: null, sowing: null }, resolvedSowing: "2027-02-04", previousCropId: "paddy", currentCycleId: "cyc-paddy", fieldAreaHa: 0.16,
  generatedAt: "2026-11-01T06:00:00.000Z",
  modelInvocation: { id: "00000000-0000-4000-8000-0000000000d1", provider: "meta", requestedModel: "muse-spark", model: "muse-spark-1.3", purpose: `crop_fit/${FIXTURE_FARM_ID}`, status: "succeeded", startedAt: "2026-11-01T06:00:01.000Z", finishedAt: "2026-11-01T06:00:04.000Z", processing: "standard", requestedStorage: false, responseDeleted: true },
  picks: [
    { cropId: "groundnut", productId: "groundnut-pod", rank: 1, headline: "A legume that gives back nitrogen after paddy", reasons: [{ code: "legume_after_heavy_feeder", text: "It follows paddy and returns nitrogen to the soil." }, { code: "water_fit_good", text: "Usual rain and your irrigation cover its water need." }, { code: "family_break", text: "It breaks the cereal run on this field." }] },
    { cropId: "maize", productId: "maize-grain", rank: 2, headline: "Harvest lands in usually strong price weeks", reasons: [{ code: "price_timing_strong", text: "Its harvest usually meets above-average prices." }, { code: "district_window", text: "Sowing falls in the district window." }] },
    { cropId: "onion", productId: "onion-bulb", rank: 3, headline: "High margin for the months it uses", reasons: [{ code: "margin_rate_high", text: "Strong expected margin for each month in the field." }] },
  ],
  pickOrigin: "model", candidates: CANDIDATES, weights: { price: 40, yield: 30, soilRotation: 15, water: 10, confidence: 5 }, soilReportStatus: "confirmed",
  summary: "Meta picked three of 5 crops scored by code (synthetic fixture).", limitations: ["Synthetic fixture limitation."],
};
export const readyModelReview: CropFitReview = base;
export const unavailableModelReview: CropFitReview = {
  ...base, pickOrigin: "deterministic", modelInvocation: null,
  picks: [
    { cropId: "maize", productId: "maize-grain", rank: 1, headline: "Maize: harvest lands in usually strong price weeks", reasons: [{ code: "price_timing_strong", text: "Harvest falls in weeks when this product usually sells above its yearly average." }] },
    { cropId: "groundnut", productId: "groundnut-pod", rank: 2, headline: "Groundnut: a legume that returns nitrogen after a heavy feeder", reasons: [] },
    { cropId: "onion", productId: "onion-bulb", rank: 3, headline: "Onion: high expected margin for the months it uses", reasons: [] },
  ],
  limitations: ["Model unavailable (provider_timeout); showing the calculated top three. Ask again later for model picks."],
};
export const calculatedReview: CropFitReview = { ...unavailableModelReview, limitations: ["Meta is not used in this runtime mode; the picks are calculated."] };
export const pendingReview: CropFitReview = { ...base, status: "pending", picks: [], pickOrigin: null, candidates: [], modelInvocation: null, generatedAt: null, summary: "Scoring every pool crop for this sowing date.", limitations: [] };
export const runningReview: CropFitReview = { ...unavailableModelReview, status: "running", limitations: [] };
export const seasonReview: CropFitReview = { ...base, request: { mode: "season", season: "kharif", sowing: null }, resolvedSowing: "2027-04-01" };
export const dateFreshReview: CropFitReview = { ...base, request: { mode: "date", season: null, sowing: "2027-05-17" }, resolvedSowing: "2027-05-17", previousCropId: null, currentCycleId: null, fieldAreaHa: null, candidates: CANDIDATES.map((c) => ({ ...c, profitForField: null, soil: { status: "no_report" as const, checks: [] } })), soilReportStatus: "none" };
export const emptyReview: CropFitReview = { ...base, status: "unavailable", picks: [], pickOrigin: null, candidates: [], modelInvocation: null, request: { mode: "date", season: null, sowing: "2026-11-03" }, resolvedSowing: "2026-11-03", summary: "No pool crop has a sourced sowing window within 21 days of 3 Nov 2026 on this field.", limitations: ["Not ranked (maize, paddy): No sourced sowing window within 21 days of 3 Nov 2026."] };
