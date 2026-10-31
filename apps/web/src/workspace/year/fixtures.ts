import type {
  ApplyYearPlanResult,
  BasisRef,
  FarmWorkspace,
  PriceTrend,
  ScoreComponents,
  YearPlanOption,
  YearPlanReview,
  YearPlanSlot,
} from "@harvest/contracts";

/**
 * SYNTHETIC fixtures for the Year plan view: unit tests, Playwright route mocks and the mocked screenshots.
 *
 * The numbers are loosely shaped like public Karnataka figures (CACP A2+FL costs 2021-22, DES state yields, mandi price
 * levels) so the layout is exercised with realistic magnitudes, but they are NOT sourced values, NOT model output and
 * must never be shown as live data. Revenue and profit are derived here by plain arithmetic (yield x price - A2+FL) so
 * each fixture is internally consistent. Reasons and uncertainties are illustrative text.
 */

export const FIXTURE_FARM_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_REVIEW_ID = "44444444-4444-4444-8444-444444444444";
export const FIXTURE_FRESH_REVIEW_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "66666666-6666-4666-8666-666666666666";
const INVOCATION_ID = "77777777-7777-4777-8777-777777777777";

const ref = (kind: BasisRef["kind"], label: string, scope: string | null = null, note: string | null = null): BasisRef => ({
  kind,
  label,
  sourceId: `fixture-${kind}`,
  url: null,
  scope,
  note,
});

interface SlotSpec {
  slotId: string;
  cropId: string;
  productId: string;
  cropName: string;
  productName: string;
  method?: string | null;
  fixed?: boolean;
  sowing: string;
  harvest: [string, string];
  /** Latest harvest plus the land-preparation gap. */
  occupancyTo: string;
  duration: [number, number];
  yieldKg: [number, number] | null;
  yieldBasis?: YearPlanSlot["yieldBasis"];
  /** [low, p50, high] INR/kg and the harvest ISO week, or "insufficient" when the series is too short. */
  price: { range: [number, number, number]; week: string; observations: number; markets: number } | "insufficient";
  cost: { a2fl: number; c2: number; year: string } | null;
  score: number;
  components: ScoreComponents;
  confidence: YearPlanSlot["confidence"];
  transitionNote?: string | null;
  reasonCodes: string[];
  uncertainties: string[];
}

function slot(spec: SlotSpec): YearPlanSlot {
  const price = spec.price === "insufficient" ? null : spec.price;
  const revenue =
    spec.yieldKg && price
      ? { low: Math.round(spec.yieldKg[0] * price.range[0]), high: Math.round(spec.yieldKg[1] * price.range[2]) }
      : null;
  const profit = revenue && spec.cost ? { low: revenue.low - spec.cost.a2fl, high: revenue.high - spec.cost.a2fl } : null;
  return {
    slotId: spec.slotId,
    cropId: spec.cropId,
    productId: spec.productId,
    cropName: spec.cropName,
    productName: spec.productName,
    establishmentMethod: spec.method ?? null,
    fixed: spec.fixed ?? false,
    sowing: spec.sowing,
    harvest: { earliest: spec.harvest[0], latest: spec.harvest[1] },
    occupancy: { from: spec.sowing, to: spec.occupancyTo },
    durationDays: { low: spec.duration[0], high: spec.duration[1] },
    yieldKgPerHa: spec.yieldKg ? { low: spec.yieldKg[0], high: spec.yieldKg[1] } : null,
    yieldBasis: spec.yieldKg ? (spec.yieldBasis ?? "district") : null,
    price:
      spec.price === "insufficient"
        ? {
            status: "insufficient",
            unit: "INR/kg",
            p50: null,
            range: null,
            harvestWeek: null,
            yearsUsed: [2025],
            observations: 14,
            scope: { level: "state", stateName: "Karnataka", districtName: null, marketCount: 2 },
            reason: "price_history_insufficient",
          }
        : {
            status: "available",
            unit: "INR/kg",
            p50: spec.price.range[1],
            range: { low: spec.price.range[0], high: spec.price.range[2] },
            harvestWeek: spec.price.week,
            yearsUsed: [2023, 2024, 2025],
            observations: spec.price.observations,
            scope: { level: "state", stateName: "Karnataka", districtName: null, marketCount: spec.price.markets },
            reason: null,
          },
    cost: spec.cost
      ? { a2flPerHa: spec.cost.a2fl, c2PerHa: spec.cost.c2, authority: "cacp", year: spec.cost.year, region: "Karnataka" }
      : { a2flPerHa: null, c2PerHa: null, authority: null, year: null, region: null },
    revenuePerHa: revenue,
    profitPerHa: profit,
    score: spec.score,
    components: spec.components,
    confidence: spec.confidence,
    transitionNote: spec.transitionNote ?? null,
    reasonCodes: spec.reasonCodes,
    uncertainties: spec.uncertainties,
    basis: [
      ...(spec.yieldKg ? [ref("yield_reference", "DES district yields 2021-22 to 2023-24", "Hassan district")] : []),
      ...(price ? [ref("price_history", "Agmarknet modal prices 2023 to 2025", "Karnataka state pool")] : []),
      ...(spec.cost ? [ref("cost_reference", `CACP cost of cultivation ${spec.cost.year}`, "Karnataka")] : []),
      ref("sowing_window", "UAS Bengaluru package of practices", "Hassan district"),
      ref("duration", "Variety duration from the package of practices", null),
    ],
  };
}

const sum = (slots: YearPlanSlot[], key: "profitPerHa" | "revenuePerHa") =>
  slots.every((s) => s[key])
    ? {
        low: slots.reduce((t, s) => t + s[key]!.low, 0),
        high: slots.reduce((t, s) => t + s[key]!.high, 0),
      }
    : null;

function option(
  spec: Omit<YearPlanOption, "totalRevenuePerHa" | "totalProfitPerHa" | "warnings" | "editable"> &
    Partial<Pick<YearPlanOption, "warnings" | "editable">>,
): YearPlanOption {
  return {
    ...spec,
    totalRevenuePerHa: sum(spec.slots, "revenuePerHa"),
    totalProfitPerHa: sum(spec.slots, "profitPerHa"),
    warnings: spec.warnings ?? [],
    editable: spec.editable ?? true,
  };
}

// --- Slots -----------------------------------------------------------------------------------------------------------

const paddyGrowing = slot({
  slotId: "paddy-current",
  cropId: "paddy",
  productId: "paddy-grain",
  cropName: "Paddy",
  productName: "Grain",
  method: "transplanting",
  fixed: true,
  sowing: "2026-09-01",
  harvest: ["2026-11-10", "2026-11-18"],
  occupancyTo: "2026-11-28",
  duration: [70, 78],
  yieldKg: [4300, 5100],
  price: { range: [22, 23.6, 26], week: "2026-W47", observations: 2310, markets: 41 },
  cost: { a2fl: 71186, c2: 94060, year: "2021-22" },
  score: 70,
  components: { price: 0.62, yield: 0.78, soilRotation: 0.6, water: 0.7, confidence: 1 },
  confidence: "high",
  reasonCodes: ["current_crop"],
  uncertainties: ["Late rain at harvest can delay threshing and lower grain quality."],
});

const maizeRabi = slot({
  slotId: "a-maize",
  cropId: "maize",
  productId: "maize-grain",
  cropName: "Maize",
  productName: "Grain",
  method: "direct_sowing",
  sowing: "2026-12-01",
  harvest: ["2027-03-25", "2027-04-08"],
  occupancyTo: "2027-04-18",
  duration: [115, 128],
  yieldKg: [3600, 4400],
  price: { range: [21, 22.8, 25], week: "2027-W14", observations: 3920, markets: 58 },
  cost: { a2fl: 47853, c2: 66073, year: "2021-22" },
  score: 81,
  components: { price: 0.78, yield: 0.84, soilRotation: 0.55, water: 0.62, confidence: 0.8 },
  confidence: "high",
  transitionNote: "Different family from paddy",
  reasonCodes: ["price_timing_strong", "district_window"],
  uncertainties: [
    "A dry winter would cut maize yield unless the field gets at least two irrigations.",
    "Harvest-week prices have differed by about a fifth between years.",
    "Costs are 2021-22 sample-farm figures; inputs cost more now.",
  ],
});

const greenGramSummer = slot({
  slotId: "a-green-gram",
  cropId: "green-gram",
  productId: "green-gram-whole",
  cropName: "Green gram",
  productName: "Whole",
  method: "direct_sowing",
  sowing: "2027-04-25",
  harvest: ["2027-06-30", "2027-07-08"],
  occupancyTo: "2027-07-18",
  duration: [65, 72],
  yieldKg: [400, 540],
  price: { range: [72, 79, 88], week: "2027-W27", observations: 860, markets: 22 },
  cost: { a2fl: 28259, c2: 37112, year: "2021-22" },
  score: 66,
  components: { price: 0.58, yield: 0.62, soilRotation: 0.95, water: 0.7, confidence: 0.8 },
  confidence: "medium",
  transitionNote: "Legume after a heavy feeder",
  reasonCodes: ["legume_after_heavy_feeder"],
  uncertainties: ["Pre-monsoon showers at pod maturity can cause pods to shatter."],
});

const blackGramRabi = slot({
  slotId: "b-black-gram",
  cropId: "black-gram",
  productId: "black-gram-whole",
  cropName: "Black gram",
  productName: "Whole",
  method: "direct_sowing",
  sowing: "2026-11-28",
  harvest: ["2027-02-12", "2027-02-22"],
  occupancyTo: "2027-03-04",
  duration: [76, 86],
  yieldKg: [450, 600],
  price: { range: [70, 77, 85], week: "2027-W07", observations: 1140, markets: 27 },
  cost: { a2fl: 26528, c2: 35563, year: "2021-22" },
  score: 72,
  components: { price: 0.6, yield: 0.7, soilRotation: 1, water: 0.86, confidence: 0.8 },
  confidence: "high",
  transitionNote: "Pulse on residual moisture after paddy",
  reasonCodes: ["rice_fallow_pulse", "legume_after_cereal"],
  uncertainties: ["If the soil dries early after paddy, one light irrigation is needed at flowering."],
});

const maizeSummer = slot({
  slotId: "b-maize",
  cropId: "maize",
  productId: "maize-grain",
  cropName: "Maize",
  productName: "Grain",
  method: "direct_sowing",
  sowing: "2027-03-10",
  harvest: ["2027-06-22", "2027-07-05"],
  occupancyTo: "2027-07-15",
  duration: [105, 117],
  yieldKg: [3200, 4000],
  price: { range: [20, 22, 24], week: "2027-W26", observations: 3510, markets: 55 },
  cost: { a2fl: 47853, c2: 66073, year: "2021-22" },
  score: 74,
  components: { price: 0.66, yield: 0.74, soilRotation: 0.9, water: 0.52, confidence: 0.8 },
  confidence: "high",
  transitionNote: "Heavy feeder after a legume",
  reasonCodes: ["heavy_feeder_after_legume"],
  uncertainties: [
    "Summer maize needs assured irrigation in April and May.",
    "Fall armyworm pressure is higher in summer sowings.",
  ],
});

const chickpeaRabi = slot({
  slotId: "c-chickpea",
  cropId: "chickpea",
  productId: "chickpea-whole",
  cropName: "Chickpea",
  productName: "Whole",
  method: "direct_sowing",
  sowing: "2026-11-25",
  harvest: ["2027-02-25", "2027-03-08"],
  occupancyTo: "2027-03-18",
  duration: [92, 103],
  yieldKg: [600, 760],
  price: { range: [55, 59, 65], week: "2027-W09", observations: 2040, markets: 34 },
  cost: { a2fl: 30676, c2: 42468, year: "2021-22" },
  score: 63,
  components: { price: 0.5, yield: 0.66, soilRotation: 0.92, water: 0.97, confidence: 0.8 },
  confidence: "high",
  transitionNote: "Legume after paddy",
  reasonCodes: ["low_water_need", "legume_after_cereal"],
  uncertainties: [
    "Chickpea relies on stored moisture; a warm February shortens grain filling.",
    "Wilt is more likely if chickpea was grown on this field in the last two years.",
  ],
});

// --- Options ---------------------------------------------------------------------------------------------------------

export const bestOverall = option({
  optionId: "opt-best-overall",
  label: "Best overall",
  origin: "model",
  score: 78,
  components: { price: 0.74, yield: 0.81, soilRotation: 0.7, water: 0.66, confidence: 0.8 },
  slots: [paddyGrowing, maizeRabi, greenGramSummer],
  idleMonths: 1.4,
  reasons: [
    { code: "price_timing_strong", text: "Maize harvested in early April has sold above its yearly average in recent seasons." },
    { code: "legume_after_heavy_feeder", text: "Green gram after maize puts back some of the nitrogen the maize used." },
    { code: "district_window", text: "Every sowing date sits inside the Hassan district sowing windows." },
  ],
});

export const soilEnrichment = option({
  optionId: "opt-soil-enrichment",
  label: "Soil enrichment",
  origin: "model",
  score: 74,
  components: { price: 0.66, yield: 0.76, soilRotation: 0.92, water: 0.7, confidence: 0.8 },
  slots: [paddyGrowing, blackGramRabi, maizeSummer],
  idleMonths: 1.5,
  reasons: [
    { code: "rice_fallow_pulse", text: "Black gram grows on the moisture paddy leaves behind, with little extra water." },
    { code: "heavy_feeder_after_legume", text: "Maize after black gram can use the nitrogen the pulse leaves in the soil." },
    { code: "soil_ph_compatible", text: "Your confirmed soil pH suits all three crops." },
  ],
});

export const lowestWater = option({
  optionId: "opt-lowest-water",
  label: "Lowest water",
  origin: "model",
  score: 63,
  components: { price: 0.52, yield: 0.7, soilRotation: 0.8, water: 0.95, confidence: 0.8 },
  slots: [paddyGrowing, chickpeaRabi],
  idleMonths: 5.5,
  reasons: [
    { code: "low_water_need", text: "Chickpea grows on stored soil moisture and needs the least irrigation." },
    { code: "summer_fallow", text: "The field rests through summer, when wells in the area usually run low." },
    { code: "legume_after_cereal", text: "Chickpea after paddy leaves nitrogen for the next kharif crop." },
  ],
});

const modelInvocation = (status: "running" | "succeeded" | "failed", model: string | null) => ({
  id: INVOCATION_ID,
  provider: "meta" as const,
  requestedModel: "muse-spark-1.3",
  model,
  purpose: "year_plan/explain",
  status,
  startedAt: "2026-11-01T04:30:00Z",
  finishedAt: status === "running" ? null : "2026-11-01T04:30:09Z",
  processing: "standard" as const,
  requestedStorage: false as const,
  responseDeleted: status === "running" ? null : true,
});

const weights = { price: 40, yield: 30, soilRotation: 15, water: 10, confidence: 5 } as const;

/** Occupied field: paddy growing until mid-November 2026; horizon Sep 2026 to Sep 2027; three model-labelled options. */
export const occupiedReview: YearPlanReview = {
  reviewId: FIXTURE_REVIEW_ID,
  jobId: JOB_ID,
  contextHash: "fixture-occupied",
  status: "ready",
  stale: false,
  inputVersions: { farm: 3, workspace: 1 },
  generatedAt: "2026-11-01T04:30:10Z",
  retryAfter: null,
  modelInvocation: modelInvocation("succeeded", "muse-spark-1.3"),
  scenario: {
    kind: "occupied",
    horizon: { from: "2026-09-01", to: "2027-09-01" },
    currentCycleId: "paddy-cycle-2026",
    previousCropId: null,
    fieldAreaHa: 1.2,
    irrigationCategory: "protective",
    stateId: "IN-KA",
    districtId: "IN-KA-hassan",
    soilSummary: "Confirmed laboratory pH 6.4 (one sample).",
    neighbourhoodActiveMonths: [7, 8, 9, 10, 11, 12, 1],
  },
  weights,
  options: [bestOverall, soilEnrichment, lowestWater],
  candidatesConsidered: 214,
  summary: "Three crop sequences after the paddy now growing, built from sourced windows, yields, costs and mandi prices.",
  limitations: ["Synthetic fixture: not sourced values."],
  appliedOptionIds: [],
};

/** Fresh start from 1 Nov 2026 after a maize harvest. One slot has no usable price series, so its profit is null. */
const freshSesame = slot({
  slotId: "f-sesame",
  cropId: "sesame",
  productId: "sesame-seed",
  cropName: "Sesame",
  productName: "Seed",
  method: "direct_sowing",
  sowing: "2027-02-15",
  harvest: ["2027-05-10", "2027-05-22"],
  occupancyTo: "2027-06-01",
  duration: [84, 96],
  yieldKg: [600, 800],
  price: "insufficient",
  cost: null,
  score: 52,
  components: { price: 0, yield: 0.64, soilRotation: 0.65, water: 0.9, confidence: 0.4 },
  confidence: "low",
  transitionNote: "Light feeder after a legume",
  reasonCodes: ["low_water_need"],
  uncertainties: ["No sourced cost of cultivation for sesame in Karnataka.", "Too few recent sesame quotes in Karnataka mandis."],
});

export const freshReview: YearPlanReview = {
  ...occupiedReview,
  reviewId: FIXTURE_FRESH_REVIEW_ID,
  contextHash: "fixture-fresh",
  scenario: {
    ...occupiedReview.scenario,
    kind: "fresh",
    horizon: { from: "2026-11-01", to: "2027-11-01" },
    currentCycleId: null,
    previousCropId: "maize",
  },
  options: [
    option({
      optionId: "fresh-best-overall",
      label: "Best overall",
      origin: "model",
      score: 69,
      components: { price: 0.64, yield: 0.72, soilRotation: 0.84, water: 0.7, confidence: 0.6 },
      slots: [{ ...chickpeaRabi, slotId: "f-chickpea", sowing: "2026-11-10", harvest: { earliest: "2027-02-10", latest: "2027-02-20" }, occupancy: { from: "2026-11-10", to: "2027-03-02" } }, freshSesame],
      idleMonths: 5,
      reasons: [
        { code: "legume_after_heavy_feeder", text: "Chickpea after last season's maize restores some soil nitrogen." },
        { code: "low_water_need", text: "Both crops need little irrigation." },
        { code: "district_window", text: "Both sowing dates sit inside Hassan district windows." },
      ],
    }),
  ],
};

/** Generation started; the model call is running. No options yet. */
export const pendingReview: YearPlanReview = {
  ...occupiedReview,
  status: "pending",
  generatedAt: null,
  modelInvocation: modelInvocation("running", "muse-spark-1.3"),
  options: [],
  candidatesConsidered: 0,
  summary: "Building crop sequences for this field.",
};

/** The model call failed: the three code-built options are shown with template reasons. */
export const unavailableReview: YearPlanReview = {
  ...occupiedReview,
  status: "unavailable",
  modelInvocation: modelInvocation("failed", null),
  options: [bestOverall, soilEnrichment, lowestWater].map((o) => ({
    ...o,
    optionId: o.optionId.replace("opt-", "det-"),
    origin: "deterministic" as const,
  })),
};

/** Same review after the farm or saved seasons changed. */
export const staleReview: YearPlanReview = { ...occupiedReview, stale: true };

/** Nothing generated yet (GET before the first POST). */
export const emptyReview: YearPlanReview = {
  ...occupiedReview,
  reviewId: null,
  jobId: null,
  contextHash: null,
  status: "unavailable",
  generatedAt: null,
  modelInvocation: null,
  options: [],
  candidatesConsidered: 0,
  summary: "No year plan yet.",
};

/** Re-scored "Best overall" after the farmer swapped maize for sunflower sown late; code adds a window warning. */
export const rescoredBestOverall: YearPlanOption = (() => {
  const sunflower = slot({
    slotId: "edit-sunflower",
    cropId: "sunflower",
    productId: "sunflower-seed",
    cropName: "Sunflower",
    productName: "Seed",
    method: "direct_sowing",
    sowing: "2027-01-20",
    harvest: ["2027-04-25", "2027-05-05"],
    occupancyTo: "2027-05-15",
    duration: [95, 105],
    yieldKg: [900, 1250],
    price: { range: [52, 56, 61], week: "2027-W18", observations: 640, markets: 14 },
    cost: { a2fl: 39120, c2: 52480, year: "2021-22" },
    score: 58,
    components: { price: 0.56, yield: 0.6, soilRotation: 0.55, water: 0.6, confidence: 0.6 },
    confidence: "medium",
    transitionNote: "Different family from paddy",
    reasonCodes: ["state_window_only"],
    uncertainties: ["Sowing after mid-January risks flowering in the hottest weeks."],
  });
  return option({
    optionId: "opt-best-overall-edit-1",
    label: "Best overall",
    origin: "farmer_edit",
    score: 64,
    components: { price: 0.6, yield: 0.66, soilRotation: 0.68, water: 0.62, confidence: 0.7 },
    slots: [paddyGrowing, sunflower, { ...greenGramSummer, slotId: "a-green-gram", sowing: "2027-05-20", harvest: { earliest: "2027-07-25", latest: "2027-08-02" }, occupancy: { from: "2027-05-20", to: "2027-08-12" } }],
    idleMonths: 1.8,
    reasons: bestOverall.reasons,
    warnings: ["Sunflower: outside the district sowing window", "Green gram: harvest close to the monsoon peak"],
  });
})();

/** Workspace before and after applying "Best overall" (two seasons appended; paddy is already recorded as a cycle). */
export const workspaceBefore: FarmWorkspace = {
  farmId: FIXTURE_FARM_ID,
  version: 1,
  updatedAt: "2026-10-30T00:00:00Z",
  boundary: null,
  previousHarvest: { status: "none" },
  cycles: [
    {
      id: "paddy-cycle-2026",
      cropId: "paddy",
      cropName: "Paddy",
      productId: "paddy-grain",
      sowingDate: "2026-09-01",
      establishmentDate: "2026-09-01",
      establishmentMethod: "transplanting",
      stage: "growing",
    },
  ],
  rotationPlans: [],
};

export function appliedWorkspace(option: YearPlanOption, base: FarmWorkspace = workspaceBefore): FarmWorkspace {
  const added = option.slots
    .filter((s) => !s.fixed)
    .map((s) => ({
      id: `${option.optionId}-${s.slotId}`,
      year: Number(s.sowing.slice(0, 4)),
      season: Number(s.sowing.slice(5, 7)) >= 10 || Number(s.sowing.slice(5, 7)) <= 1 ? "Rabi" : Number(s.sowing.slice(5, 7)) <= 5 ? "Zaid" : "Kharif",
      cropId: s.cropId,
      cropName: s.cropName,
      productId: s.productId,
      productName: s.productName,
      plannedSowingDate: s.sowing,
      plannedHarvestDate: s.harvest.latest,
      notes: `From the year plan: ${option.label}`,
    }));
  const existing = new Set(base.rotationPlans.map((r) => r.id));
  return {
    ...base,
    version: base.version + 1,
    updatedAt: "2026-11-01T05:00:00Z",
    rotationPlans: [...base.rotationPlans, ...added.filter((r) => !existing.has(r.id))],
  };
}

export function applyResult(review: YearPlanReview, optionId: string, base: FarmWorkspace = workspaceBefore): ApplyYearPlanResult {
  const chosen = review.options.find((o) => o.optionId === optionId)!;
  return {
    workspace: appliedWorkspace(chosen, base),
    review: { ...review, appliedOptionIds: [...new Set([...review.appliedOptionIds, optionId])] },
  };
}

// --- Price trend -----------------------------------------------------------------------------------------------------

const TREND_MONTHS = Array.from({ length: 36 }, (_, i) => {
  const index = 10 + i; // November 2023 is month index 10 of 2023
  return `${2023 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
});

/**
 * 36 monthly medians, Nov 2023 to Oct 2026, with a seasonal swing (cheapest around `troughMonth`), a mild upward drift
 * and one missing month (Jun 2024) so the gap rendering is exercised. Deterministic.
 */
export function priceTrendFixture(productId: string, base = 21.5, swing = 0.12, troughMonth = 11): PriceTrend {
  const series = TREND_MONTHS.map((month, i) => {
    const m = Number(month.slice(5, 7));
    if (month === "2024-06") return { month, p50: null, n: 0, markets: 0 };
    const seasonal = 1 - swing * Math.cos(((m - troughMonth) / 12) * 2 * Math.PI);
    const p50 = Math.round(base * seasonal * (1 + 0.018 * (i / 12)) * 100) / 100;
    return { month, p50, n: 90 + ((i * 37) % 60), markets: 40 + (i % 9) };
  });
  const values = (from: number, to: number) =>
    series.slice(from, to).filter((p): p is { month: string; p50: number; n: number; markets: number } => p.p50 != null);
  const last = values(24, 36);
  const prior = values(12, 24);
  const paired = last.filter((p) => prior.some((q) => q.month.slice(5) === p.month.slice(5)));
  const mean = (xs: { p50: number }[]) => xs.reduce((t, p) => t + p.p50, 0) / xs.length;
  const lastMean = mean(paired);
  const priorMean = mean(prior.filter((q) => paired.some((p) => p.month.slice(5) === q.month.slice(5))));
  return {
    productId,
    status: "available",
    missingReason: null,
    scope: {
      level: "state",
      requestedLevel: "district",
      stateName: "Karnataka",
      districtName: null,
      marketCount: 58,
      marketIds: [],
      fallbackNote: "Hassan district has fewer than two years of quotes; Karnataka state pool used.",
    },
    unit: "INR/kg",
    priceBasis: "wholesale_mandi_modal",
    basisLabel: "Mandi reference (wholesale), not a farm-gate price",
    limitations: ["Synthetic fixture: not sourced values."],
    months: 36,
    asOf: "2026-11-01",
    from: "2023-11-01",
    to: "2026-10-31",
    series,
    yoy: {
      lastMonthsWithData: last.length,
      priorMonthsWithData: prior.length,
      pairedMonths: paired.length,
      lastMean: Math.round(lastMean * 100) / 100,
      priorMean: Math.round(priorMean * 100) / 100,
      changePct: Math.round(((lastMean - priorMean) / priorMean) * 1000) / 10,
    },
    yoyMissingReason: null,
    coverage: {
      observations: series.reduce((t, p) => t + p.n, 0),
      markets: 58,
      firstDate: "2023-11-02",
      lastDate: "2026-10-30",
      validDays: 980,
      excludedRows: 0,
    },
  };
}

/** A product without enough history: the sheet must say "No price series yet", never a number. */
export function insufficientTrendFixture(productId: string): PriceTrend {
  const full = priceTrendFixture(productId);
  return {
    ...full,
    status: "insufficient",
    missingReason: "price_history_insufficient",
    series: full.series.map((p) => ({ ...p, p50: null, n: 0, markets: 0 })),
    yoy: null,
    yoyMissingReason: "Fewer than 9 months with quotes in each of the last two years.",
  };
}

export const maizeTrend = priceTrendFixture("maize-grain");
