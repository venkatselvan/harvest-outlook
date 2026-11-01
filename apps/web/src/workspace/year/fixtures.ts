import type {
  ApplyYearPlanResult,
  BasisRef,
  FarmWorkspace,
  IntercropCompanion,
  NumberEstimate,
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

// --- Round 2: four options, estimates with likely and possible bands, gaps, one green manure -------------------------
//
// SYNTHETIC like everything above. The old per-hectare ranges are taken as the "likely" band (p25 to p75); the central
// value is its middle and the "possible" band (p10 to p90) widens it by 60% of its width on each side. The server
// derives these from a seeded simulation; here they are plain arithmetic so the layout meets realistic magnitudes.
// Option totals add the slot estimates band by band, which is not how a simulation combines quantiles; it only keeps
// the ordering possible.low <= likely.low <= central <= likely.high <= possible.high.

export const FIXTURE_FIELD_AREA_HA = 0.16;
const r100 = (n: number) => Math.round(n / 100) * 100;

function estimateOf(range: { low: number; high: number }): NumberEstimate {
  const width = range.high - range.low;
  return {
    central: r100((range.low + range.high) / 2),
    likely: { low: r100(range.low), high: r100(range.high) },
    possible: { low: r100(range.low - 0.6 * width), high: r100(range.high + 0.6 * width) },
  };
}
const scaleEstimate = (e: NumberEstimate, factor: number): NumberEstimate => ({
  central: r100(e.central * factor),
  likely: { low: r100(e.likely.low * factor), high: r100(e.likely.high * factor) },
  possible: { low: r100(e.possible.low * factor), high: r100(e.possible.high * factor) },
});
const sumEstimates = (list: NumberEstimate[]): NumberEstimate => ({
  central: list.reduce((t, e) => t + e.central, 0),
  likely: { low: list.reduce((t, e) => t + e.likely.low, 0), high: list.reduce((t, e) => t + e.likely.high, 0) },
  possible: { low: list.reduce((t, e) => t + e.possible.low, 0), high: list.reduce((t, e) => t + e.possible.high, 0) },
});

/** The slot with revenue and profit estimates, their likely bands copied into the per-hectare ranges. */
function withEstimates(s: YearPlanSlot, areaHa = FIXTURE_FIELD_AREA_HA): YearPlanSlot {
  const revenue = s.revenuePerHa ? estimateOf(s.revenuePerHa) : null;
  const profit = s.profitPerHa ? estimateOf(s.profitPerHa) : null;
  return {
    ...s,
    revenuePerHa: revenue ? revenue.likely : null,
    profitPerHa: profit ? profit.likely : null,
    revenueEstimate: revenue,
    profitEstimate: profit,
    profitForField: profit ? scaleEstimate(profit, areaHa) : null,
  };
}

type OptionV2Spec = Omit<
  YearPlanOption,
  "totalRevenuePerHa" | "totalProfitPerHa" | "totalRevenueEstimate" | "totalProfitEstimate" | "totalProfitForField" | "fieldAreaHa" | "warnings" | "editable"
> &
  Partial<Pick<YearPlanOption, "warnings" | "editable">>;

function optionV2(spec: OptionV2Spec, areaHa: number | null = FIXTURE_FIELD_AREA_HA): YearPlanOption {
  const revenue = spec.slots.every((s) => s.revenueEstimate) ? sumEstimates(spec.slots.map((s) => s.revenueEstimate!)) : null;
  const profit = spec.slots.every((s) => s.profitEstimate) ? sumEstimates(spec.slots.map((s) => s.profitEstimate!)) : null;
  return {
    ...spec,
    totalRevenuePerHa: revenue ? revenue.likely : null,
    totalProfitPerHa: profit ? profit.likely : null,
    totalRevenueEstimate: revenue,
    totalProfitEstimate: profit,
    totalProfitForField: profit && areaHa != null ? scaleEstimate(profit, areaHa) : null,
    fieldAreaHa: areaHa,
    warnings: spec.warnings ?? [],
    editable: spec.editable ?? true,
  };
}

/** The crop already growing: two short lines for the calendar, the long sentence in the uncertainties. */
const paddyWithNotes = (nextCropFrom: string): YearPlanSlot =>
  withEstimates({
    ...paddyGrowing,
    transitionNote: `Harvest expected 10 Nov to 18 Nov (estimated from the sowing date)\nNext crop from ${nextCropFrom}`,
    uncertainties: [
      ...paddyGrowing.uncertainties,
      "Paddy: harvest date not recorded; estimated from the recorded sowing date and the crop's stage model (2026-11-10 to 2026-11-18), and the field is held until 2026-11-28.",
    ],
  });

const greenGramAfterGap = withEstimates({
  ...greenGramSummer,
  slotId: "a-green-gram",
  sowing: "2027-05-20",
  harvest: { earliest: "2027-07-25", latest: "2027-08-02" },
  occupancy: { from: "2027-05-20", to: "2027-08-12" },
});
const maizeAfterGap = withEstimates({
  ...maizeSummer,
  sowing: "2027-04-05",
  harvest: { earliest: "2027-07-20", latest: "2027-08-02" },
  occupancy: { from: "2027-04-05", to: "2027-08-12" },
});

/** Cowpea grown as a green manure and ploughed in: no product, no price, revenue 0, cost an assumption. */
const cowpeaManure: YearPlanSlot = {
  slotId: "g-cowpea-gm",
  cropId: "gm-cowpea",
  productId: "gm-cowpea",
  cropName: "Cowpea (green manure)",
  productName: "Green manure",
  establishmentMethod: "direct_sowing",
  kind: "green_manure",
  nitrogenCreditKgPerHa: { low: 60, high: 80 },
  fixed: false,
  sowing: "2027-01-08",
  harvest: { earliest: "2027-02-22", latest: "2027-03-08" },
  occupancy: { from: "2027-01-08", to: "2027-03-18" },
  durationDays: { low: 45, high: 60 },
  yieldKgPerHa: null,
  yieldBasis: null,
  price: null,
  cost: { a2flPerHa: 5200, c2PerHa: null, authority: "other", year: null, region: "Karnataka" },
  revenuePerHa: { low: 0, high: 0 },
  profitPerHa: { low: -5200, high: -5200 },
  revenueEstimate: { central: 0, likely: { low: 0, high: 0 }, possible: { low: 0, high: 0 } },
  profitEstimate: { central: -5200, likely: { low: -5200, high: -5200 }, possible: { low: -5200, high: -5200 } },
  profitForField: scaleEstimate({ central: -5200, likely: { low: -5200, high: -5200 }, possible: { low: -5200, high: -5200 } }, FIXTURE_FIELD_AREA_HA),
  score: 62,
  components: { price: 0, yield: 0, soilRotation: 0.95, water: 0.7, confidence: 0.5 },
  confidence: "medium",
  transitionNote: "Grown and ploughed in; leaves nitrogen for the next crop",
  reasonCodes: ["green_manure"],
  uncertainties: [
    "Seed, sowing and ploughing-in cost is an assumption, not a sourced figure.",
    "Needs a shower or one irrigation to establish.",
  ],
  basis: [ref("duration", "Days to ploughing in from the package of practices", null), ref("sowing_window", "UAS Bengaluru package of practices", "Karnataka")],
};
const maizeAfterManure = withEstimates({
  ...maizeSummer,
  slotId: "g-maize",
  sowing: "2027-03-25",
  harvest: { earliest: "2027-07-10", latest: "2027-07-22" },
  occupancy: { from: "2027-03-25", to: "2027-08-01" },
  transitionNote: "Heavy feeder after a green manure",
});

export const bestOverallV2 = optionV2({
  ...bestOverall,
  slots: [paddyWithNotes("1 Dec"), withEstimates(maizeRabi), greenGramAfterGap],
  idleMonths: 1.6,
  gaps: [
    {
      from: "2027-04-19",
      to: "2027-05-19",
      days: 31,
      reason: "No sourced sowing window for a pool crop between 19 Apr and 19 May on this field; the next windows open 20 May (kharif).",
    },
  ],
});
export const soilEnrichmentV2 = optionV2({
  ...soilEnrichment,
  slots: [paddyWithNotes("28 Nov"), withEstimates(blackGramRabi), maizeAfterGap],
  idleMonths: 1.9,
  gaps: [
    {
      from: "2027-03-05",
      to: "2027-04-04",
      days: 31,
      reason: "Summer sowing here needs irrigation; the field is recorded as rainfed.",
    },
  ],
  // The long sentence the engine used to put here; a calendar row must not draw it (the sheet lists it in full).
  warnings: [
    "Paddy: harvest date not recorded; estimated from the recorded sowing date and the crop's stage model (2026-11-10 to 2026-11-18), and the field is held until 2026-11-28.",
  ],
});
export const lowestWaterV2 = optionV2({
  ...lowestWater,
  slots: [paddyWithNotes("25 Nov"), withEstimates(chickpeaRabi)],
  idleMonths: 5.4,
  gaps: [],
});
export const greenManureFirst = optionV2({
  optionId: "opt-green-manure-first",
  label: "Green manure first",
  origin: "deterministic",
  score: 66,
  components: { price: 0.5, yield: 0.62, soilRotation: 0.95, water: 0.7, confidence: 0.7 },
  slots: [paddyWithNotes("8 Jan"), cowpeaManure, maizeAfterManure],
  idleMonths: 2.1,
  reasons: [
    { code: "green_manure", text: "A cowpea green manure leaves nitrogen in the soil before the maize." },
    { code: "heavy_feeder_after_legume", text: "Maize after a green manure can use the nitrogen it leaves." },
    { code: "district_window", text: "Every sowing date sits inside the Hassan district sowing windows." },
  ],
  gaps: [
    {
      from: "2026-11-29",
      to: "2027-01-07",
      days: 40,
      reason: "Black gram could be sown from 25 Nov but scored lower than this plan; edit the plan to add it.",
    },
  ],
});

/**
 * Round 2 review: four rows (three Meta-selected, the fourth calculated by code), field profit for 0.16 ha with likely
 * and possible bands, idle gaps with their reasons, a green manure slot, short fixed-crop lines.
 */
export const fourOptionReview: YearPlanReview = {
  ...occupiedReview,
  contextHash: "fixture-occupied-round2",
  scenario: { ...occupiedReview.scenario, fieldAreaHa: FIXTURE_FIELD_AREA_HA },
  options: [bestOverallV2, soilEnrichmentV2, lowestWaterV2, greenManureFirst],
  candidatesConsidered: 236,
  summary: "Four crop sequences after the paddy now growing, built from sourced windows, yields, costs and mandi prices.",
};

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

// --- Round 3: five options, an intercrop, field yield, a later horizon ------------------------------------------------

/** yieldForFieldKg for a slot: the per-hectare range times the field area, whole kilograms. */
const withFieldYield = (s: YearPlanSlot, areaHa = FIXTURE_FIELD_AREA_HA): YearPlanSlot => ({
  ...s,
  yieldForFieldKg: s.yieldKgPerHa ? { low: Math.round(s.yieldKgPerHa.low * areaHa), high: Math.round(s.yieldKgPerHa.high * areaHa) } : null,
});

/** Finger millet and pigeon pea in 8:1 rows; shares sourced in this synthetic fixture only. */
export const pigeonPeaCompanion: IntercropCompanion = {
  systemId: "finger-millet-pigeon-pea-8-1",
  cropId: "pigeon-pea",
  productId: "pigeon-pea-whole",
  cropName: "Pigeon pea",
  productName: "Whole",
  rowRatio: "8:1",
  arrangement: "row",
  yieldShare: { main: { low: 0.85, high: 0.95 }, companion: { low: 0.2, high: 0.3 } },
  shareBasis: "sourced",
  yieldKgPerHa: { low: 500, high: 700 },
  yieldBasis: "state",
  price: {
    status: "available",
    unit: "INR/kg",
    p50: 68,
    range: { low: 60, high: 78 },
    harvestWeek: "2027-W52",
    yearsUsed: [2023, 2024, 2025],
    observations: 90,
    scope: { level: "state", stateName: "Karnataka", districtName: null, marketCount: 3 },
    reason: null,
  },
  nitrogenCreditKgPerHa: { low: 15, high: 30 },
  source: { id: "fixture-intercrop", title: "Synthetic intercrop source (fixture)", url: null, locator: "Table 2" },
};

const fingerMilletIntercrop: YearPlanSlot = withFieldYield({
  ...withEstimates(
    slot({
      slotId: "i-finger-millet",
      cropId: "finger-millet",
      productId: "finger-millet-grain",
      cropName: "Finger millet",
      productName: "Grain",
      method: "direct_sowing",
      sowing: "2027-05-23",
      harvest: ["2027-09-20", "2027-10-05"],
      occupancyTo: "2027-10-15",
      duration: [115, 135],
      yieldKg: [1800, 2200],
      price: { range: [30, 34, 38], week: "2027-W40", observations: 800, markets: 20 },
      cost: { a2fl: 32500, c2: 46200, year: "2021-22" },
      score: 71,
      components: { price: 0.66, yield: 0.7, soilRotation: 0.8, water: 0.6, confidence: 0.6 },
      confidence: "medium",
      transitionNote: "Intercrop with a legume",
      reasonCodes: ["intercrop_sourced", "district_window"],
      uncertainties: ["The row ratio and shares are research figures; a different layout changes both yields."],
    }),
  ),
  kind: "intercrop",
  companion: pigeonPeaCompanion,
});

/** Added by code when no chosen plan holds the best-profit sequence: finger millet + pigeon pea, then chickpea. */
export const bestProfitIntercrop = optionV2({
  optionId: "opt-best-profit",
  label: "Best profit",
  origin: "deterministic",
  score: 70,
  components: { price: 0.66, yield: 0.7, soilRotation: 0.78, water: 0.6, confidence: 0.6 },
  slots: [paddyWithNotes("20 May"), fingerMilletIntercrop],
  idleMonths: 2.6,
  reasons: [{ code: "best_profit", text: "The highest profit for your field among the plans with a price, a yield and a cost for every crop." }],
  gaps: [{ from: "2027-03-01", to: "2027-05-22", days: 83, reason: "No sourced sowing window for a pool crop on this field before the May kharif windows." }],
});

const withFieldYields = (o: YearPlanOption): YearPlanOption => ({ ...o, slots: o.slots.map((s) => withFieldYield(s)) });

/** Round 3 review: five options (the fourth is the code-added Best profit intercrop plan), field yields on every crop. */
export const fiveOptionReview: YearPlanReview = {
  ...fourOptionReview,
  contextHash: "fixture-occupied-round3",
  options: [
    withFieldYields(bestOverallV2),
    withFieldYields(soilEnrichmentV2),
    withFieldYields(lowestWaterV2),
    withFieldYields(bestProfitIntercrop),
    withFieldYields(greenManureFirst),
  ],
  candidatesConsidered: 318,
  summary: "Five crop sequences after the paddy now growing, built from sourced windows, yields, costs and mandi prices.",
};

/** Best overall also holds the best-profit sequence, so it carries the secondary label and no extra plan is added. */
export const secondaryLabelReview: YearPlanReview = {
  ...fourOptionReview,
  options: [{ ...withFieldYields(bestOverallV2), secondaryLabels: ["Best profit"] }, ...fourOptionReview.options.slice(1)],
};

const NAVIGATION_YEAR_1 = { from: "2026-09-01", previousFrom: null, nextFrom: "2027-09-01", yearIndex: 0, maxYearIndex: 3 } as const;
/** The same current-horizon review with the server's horizon navigation ("Year 1 of 4"). */
export const navigableReview: YearPlanReview = { ...fiveOptionReview, navigation: { ...NAVIGATION_YEAR_1 } };

export const FIXTURE_FUTURE_REVIEW_ID = "88888888-8888-4888-8888-888888888888";
const chickpeaYearTwo = withFieldYield(
  withEstimates(
    slot({
      slotId: "y2-chickpea",
      cropId: "chickpea",
      productId: "chickpea-whole",
      cropName: "Chickpea",
      productName: "Whole",
      method: "direct_sowing",
      sowing: "2027-11-05",
      harvest: ["2028-02-20", "2028-03-05"],
      occupancyTo: "2028-03-15",
      duration: [100, 115],
      yieldKg: [800, 1100],
      price: { range: [58, 62, 70], week: "2028-W09", observations: 410, markets: 12 },
      cost: { a2fl: 28100, c2: 39400, year: "2021-22" },
      score: 69,
      components: { price: 0.64, yield: 0.66, soilRotation: 0.82, water: 0.7, confidence: 0.6 },
      confidence: "medium",
      transitionNote: "A legume after a cereal",
      reasonCodes: ["legume_after_cereal"],
      uncertainties: ["A late-season dry spell cuts chickpea yield."],
    }),
  ),
);
const yearTwoOverall = optionV2({
  optionId: "opt-y2-best-overall",
  label: "Best overall",
  origin: "model",
  score: 72,
  components: { price: 0.66, yield: 0.7, soilRotation: 0.8, water: 0.66, confidence: 0.62 },
  slots: [
    withFieldYield({
      ...fingerMilletIntercrop,
      slotId: "y2-finger-millet",
      sowing: "2027-09-10",
      harvest: { earliest: "2028-01-05", latest: "2028-01-20" },
      occupancy: { from: "2027-09-10", to: "2028-01-30" },
    }),
    {
      ...chickpeaYearTwo,
      sowing: "2028-02-10",
      harvest: { earliest: "2028-05-20", latest: "2028-06-05" },
      occupancy: { from: "2028-02-10", to: "2028-06-15" },
    },
  ],
  idleMonths: 0.9,
  reasons: [{ code: "legume_credit", text: "The pigeon pea companion leaves nitrogen for the chickpea." }],
  gaps: [],
});
const yearTwoSoil = optionV2({
  optionId: "opt-y2-soil",
  label: "Soil enrichment",
  origin: "model",
  score: 68,
  components: { price: 0.6, yield: 0.64, soilRotation: 0.9, water: 0.66, confidence: 0.62 },
  slots: [withFieldYield({ ...chickpeaYearTwo, slotId: "y2s-chickpea", sowing: "2027-10-20", harvest: { earliest: "2028-02-01", latest: "2028-02-15" }, occupancy: { from: "2027-10-20", to: "2028-02-25" } })],
  idleMonths: 6,
  reasons: [{ code: "legume_credit", text: "A legume year builds nitrogen for the next season." }],
  gaps: [],
});

/**
 * Year 2 (yearIndex 1): no fixed crop, the previous crop assumed from the year-1 "Best overall" plan, which is not saved.
 * Synthetic fixture; the sentence the UI shows comes from `assumedPredecessor`.
 */
export const futureReview: YearPlanReview = {
  ...fiveOptionReview,
  reviewId: FIXTURE_FUTURE_REVIEW_ID,
  contextHash: "fixture-future",
  scenario: {
    ...fiveOptionReview.scenario,
    kind: "future",
    horizon: { from: "2027-09-01", to: "2028-09-01" },
    yearIndex: 1,
    currentCycleId: null,
    previousCropId: "green-gram",
    assumedPredecessor: { cropId: "green-gram", cropName: "Green gram", basis: "year_plan_option", optionLabel: "Best overall", horizonFrom: "2026-09-01" },
  },
  options: [yearTwoOverall, yearTwoSoil],
  navigation: { from: "2027-09-01", previousFrom: "2026-09-01", nextFrom: "2028-09-01", yearIndex: 1, maxYearIndex: 3 },
  candidatesConsidered: 204,
  summary: "Follows the Best overall plan for Sep 2026 to Sep 2027 (not saved yet; save a plan to fix the order).",
  appliedOptionIds: [],
};
