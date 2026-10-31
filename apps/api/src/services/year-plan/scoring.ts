import type { BasisRef, HarvestPriceOutlook, ScoreComponents } from '@harvest/contracts';
import { daysInMonth, daysPerMonth } from './dates';
import type { IrrigationClass, SlotFlags } from './types';

/**
 * Year-plan scoring, docs/research/ROTATION_SCORING.md section 5. Pure functions: every input is passed in, nothing is
 * read from files, the database or a model. Component scores are 0..1; weights are fixed by the user (price 40,
 * yield 30) and the orchestrator (soil and rotation 15, water 10, confidence 5).
 *
 * ASSUMPTIONS lists every engine number that is not taken from a cited source. Each one surfaces as a BasisRef of
 * kind 'model' (assumptionBasis) wherever it changes a result.
 */
export const ASSUMPTIONS = {
  landPrepGapDays: { value: 10, text: 'Land preparation gap between a harvest and the next sowing when no source gives one (spec 4.2 default).' },
  irrigationAllowanceMm: { value: { none: 0, protective: 150, assured: 600 }, text: 'Irrigation water available per crop season by category: none 0, protective 150 mm, assured 600 mm (spec 5.1); farmer-editable later.' },
  irrigationCategoryMap: { value: { rainfed: 'none', supplemental: 'protective', irrigated: 'assured' }, text: 'Repo irrigation categories map to allowance classes: rainfed -> none, supplemental -> protective, irrigated -> assured. An unrecorded category gets no allowance and no rainfed cap.' },
  unknownHarvestBufferDays: { value: 15, text: 'A current cycle or saved season without a recorded harvest date is assumed to run to sowing + the longest sourced duration + 15 days (conservative), then the land preparation gap.' },
  unknownDurationDays: { value: 180, text: 'A current cycle or saved season with neither a recorded harvest date nor a sourced duration is assumed to occupy the field for 180 days (plus the buffer and gap). Recording the harvest date replaces this.' },
  durationClassMergeDays: { value: 15, text: 'Cultivar duration rows of one method whose ranges overlap or lie within 15 days are merged into one duration class; farther apart they stay separate (for example short and long pigeon pea).' },
  sowingStepDays: { value: 7, text: 'Sowing dates are stepped weekly from the start of each sourced window (spec 4.1).' },
  windowFit: { value: { district: 1, state: 0.8, provisional: 0.5, outside: 0 }, text: 'Window fit: 1 inside a district window, 0.8 inside a state or neighbouring-district window only, 0.5 for a provisional window, 0 outside (spec 5.1).' },
  yieldYears: { value: 3, text: 'Local yield is the median of the last 3 available years at the most specific level (spec 5.1).' },
  minYieldYears: { value: 2, text: 'A level (district or state) needs at least 2 years for a median and P25-P75 range; a single published year is used only as a reference point with no spread.' },
  yieldRatioClip: { value: 1.2, text: 'Local / reference yield is clipped to 0..1.2 and rescaled to 0..1 (spec 5.1).' },
  referenceYield: { value: 'state_best_year', text: 'Reference yield is the best state year of the same product form; package-of-practice stated yields are not yet encoded in R1/R2.' },
  marketingDeduction: { value: 0, text: 'No sourced commission or market-fee percentage for Karnataka or Tamil Nadu; none is deducted and revenue is a wholesale reference.' },
  priceParts: { value: { margin: 25, timing: 15 }, text: 'Price component = (25 x margin-rate score + 15 x harvest-timing score) / 40 (spec 5.1).' },
  harvestTimingClip: { value: [0.5, 1.5], text: 'Harvest-week p50 / annual mean is clipped to 0.5..1.5 and rescaled to 0..1 (spec 5.1).' },
  priceHarvestDate: { value: 'midpoint', text: 'The harvest-week price uses the midpoint of the earliest and latest harvest dates.' },
  uncomputablePart: { value: 0, text: 'A score part whose input is missing (price or yield) scores 0 and is flagged; nothing is imputed. A missing cost is scored with missingCostRevenueFactor instead.' },
  waterNeedPoint: { value: 'midpoint', text: 'Crop water need is the midpoint of the sourced min-max seasonal need (FAO totals for the growing period).' },
  unknownWaterFit: { value: 0.5, text: 'When climatology or the crop water need is missing, water fit is a neutral 0.5 and flagged water_data_missing; it is not a measurement.' },
  rainfedCap: { value: 0.4, text: 'On a rainfed field a crop not marked rainfed-suitable scores at most 0.4 water fit (spec 5.1).' },
  ndviAdjustment: { value: 0.1, text: 'Neighbourhood NDVI adds +0.1 when at least half of the slot months are observed active months, and -0.1 only when months are known to be observed and none is active (cloud gaps are not inactivity).' },
  ndviMinMonths: { value: 2, text: 'The NDVI adjustment needs at least 2 slot months with observations.' },
  neutralRotationFit: { value: 0.5, text: 'With no known previous crop the transition scores 0 on the -1..1 scale (0.5 after rescaling).' },
  sameFamilyCitedSuccession: { value: 0.6, text: 'A same-family transition that a source explicitly recommends (for example maize then finger millet in Hassan) scores as a cited succession and is not pruned; a cited avoidAfter always wins.' },
  phMismatchMultiplier: { value: 0.5, text: 'Confirmed laboratory soil pH outside the crop\'s cited range halves the rescaled transition fit (spec 5.1). No crop in R1 carries a cited pH range yet.' },
  costPreference: { value: ['cacp', 'des', 'sau', 'other'], text: 'Cost rows: low-reliability rows excluded; prefer CACP > DES > SAU > other, then the most recent year. When only a C2-type total is published it is used for profit (conservative) and flagged.' },
  confidenceSourcedCost: { value: ['cacp', 'des', 'sau'], text: 'The confidence flag "CACP or SAU cost present" counts CACP, DES cost-of-cultivation (published in the CACP report annex) and SAU rows; other surveys do not count.' },
  confidenceBands: { value: { high: 0.8, medium: 0.5 }, text: 'Confidence label: High >= 0.8, Medium >= 0.5, else Low (spec 5.1).' },
  reasonThresholds: { value: { timingStrong: 1.1, timingWeak: 0.9, marginHigh: 0.75, waterGood: 0.8, waterPoor: 0.5 }, text: 'Reason-code thresholds (display only, they do not change scores).' },
  idlePenalty: { value: { perMonth: 0.02, freeMonths: 2 }, text: 'Idle penalty 0.02 per idle month beyond the first two; idle months are fractional (idle days / 30.4375) (spec 5.2).' },
  daysPerMonth: { value: 30.4375, text: 'Average month length used for margin per month of occupancy and idle months.' },
  harvestInsideHorizon: { value: true, text: 'A suggested slot must be sown on or after the first free day and harvested before the 12-month horizon ends; its land preparation gap may run past it.' },
  missingCostRevenueFactor: { value: 0.7, text: 'When the cost of cultivation is not sourced, the margin part scores the gross revenue rate (price p50 x yield p50 x (1 - loss) per month of occupancy, no cost deducted) relative to the largest gross revenue rate among the candidates, multiplied by 0.7 so an unsourced cost never outranks a sourced margin; the reason cost_not_sourced is shown and profit stays empty.' },
  districtYieldMaxAgeYears: { value: 6, text: 'District yield rows whose crop year (July to June) starts more than 6 years before the review crop year are not used as the district basis; recent state rows are used instead and the slot notes that the district figures are too old.' },
  shortlistCoverage: { value: { minHorizonShare: 0.4, minScoreShare: 0.7 }, text: 'Shortlist rule (2026-11-01): every shortlisted plan other than the top-scoring one must keep the field occupied for at least 40 percent of the 12-month horizon (occupied days = horizon days minus idle days, the current crop included) or score at least 70 percent of the top score. A plan that leaves most of the year idle therefore cannot be shown under a label such as Lowest water, Best price timing or Alternative. Qualifying plans are drawn from all distinct crop sequences, not only the 12 best by score; when fewer than three qualify, fewer plans are shown.' },
  fixedSlotWindowFit: { value: 1, text: 'The crop already growing in the field (the fixed slot) has window fit 1 and no outside_window reason: it is in the ground, so the sowing window no longer applies. Its price and yield parts still come from data.' },
} as const;
export type AssumptionKey = keyof typeof ASSUMPTIONS;

/** BasisRef for an engine assumption, so a number that is not sourced is still traceable. */
export function assumptionBasis(key: AssumptionKey): BasisRef {
  return { kind: 'model', label: `Engine assumption: ${key}`, sourceId: `year-plan-assumption:${key}`, url: null, scope: null, note: ASSUMPTIONS[key].text };
}

export const WEIGHTS = { price: 0.4, yield: 0.3, soilRotation: 0.15, water: 0.1, confidence: 0.05 } as const;

/** Fixed server list; Meta may only cite these codes. Texts carry no numbers (code renders numbers elsewhere). */
export const REASON_TEXT = {
  current_crop: 'This is the crop already growing in the field.',
  legume_after_heavy_feeder: 'A legume follows a heavy feeder and returns nitrogen to the soil.',
  heavy_feeder_after_legume: 'A heavy feeder follows a legume and uses the nitrogen it left.',
  cited_succession: 'A published source recommends this crop after the previous one.',
  lighter_after_heavy_feeder: 'A lighter feeder follows a heavy feeder.',
  family_break: 'The crop family changes from the previous crop.',
  price_timing_strong: 'Harvest falls in weeks when this product usually sells above its yearly average.',
  margin_rate_high: 'High expected margin for each month the field is used.',
  district_window: 'Sowing falls inside a district sowing window.',
  water_fit_good: 'Usual rain and the irrigation recorded cover the crop water need.',
  ndvi_season_match: 'Nearby fields are usually green in these months.',
  state_window_fallback: 'No district window was found; a state or neighbouring-district window is used.',
  provisional_window: 'The sowing window is provisional and awaits review.',
  outside_window: 'The sowing date is outside every sourced window.',
  conditional_irrigation: 'The sowing window assumes irrigation that is not recorded for this field.',
  price_timing_weak: 'Harvest falls in weeks when this product usually sells below its yearly average.',
  price_timing_unknown: 'The yearly average price is not available, so harvest timing is not scored.',
  price_insufficient: 'Price history is too short for a harvest-week price range.',
  yield_not_sourced: 'No regional yield of this product form is sourced.',
  yield_state_fallback: 'No usable district yield; the state yield is used.',
  yield_reference_only: 'Only a single published yield year exists; no year-to-year range.',
  yield_converted_rice_to_paddy: 'Published rice yield was converted to paddy with the official out-turn ratio.',
  cost_not_sourced: 'Cost of cultivation is not sourced, so profit is not shown.',
  cost_c2_only: 'Only a total cost including land rent is published; profit is conservative.',
  water_fit_poor: 'Usual rain and the irrigation recorded may not cover the crop water need.',
  water_data_missing: 'Rain normals or the crop water need are missing; water fit is neutral.',
  rainfed_unsuitable: 'The crop is not marked suitable for rainfed fields.',
  ndvi_season_contradiction: 'Nearby fields are usually bare in these months.',
  soil_ph_mismatch: 'Confirmed soil pH is outside the cited range for this crop.',
  low_data_confidence: 'Several inputs are missing or regional, so confidence is low.',
  avoid_after_violation: 'A source advises against this crop after the previous one.',
  same_family_repeat: 'The same crop family follows itself.',
  same_role_repeat: 'Same nutrient demand as the previous crop with no cited benefit.',
  occupancy_conflict: 'The dates overlap another season on this field.',
  harvest_assumed: 'The harvest date is an assumption; record it to replace it.',
} as const;
export type ReasonCode = keyof typeof REASON_TEXT;
export const REASON_CODES = Object.keys(REASON_TEXT) as ReasonCode[];
/** Positive codes, in the order they explain a plan. */
export const POSITIVE_CODES: readonly ReasonCode[] = ['legume_after_heavy_feeder', 'heavy_feeder_after_legume', 'cited_succession', 'price_timing_strong', 'margin_rate_high', 'district_window', 'water_fit_good', 'lighter_after_heavy_feeder', 'family_break', 'ndvi_season_match'];
const PRIORITY = new Map<ReasonCode, number>(REASON_CODES.map((c, i) => [c, i]));

export const clip = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function irrigationClass(category: string | null | undefined): IrrigationClass | null {
  switch ((category ?? '').trim().toLowerCase()) {
    case 'rainfed': case 'none': return 'none';
    case 'supplemental': case 'protective': return 'protective';
    case 'irrigated': case 'assured': return 'assured';
    default: return null;
  }
}

// ------------------------------------------------------------------ price (40 = margin 25 + timing 15)

export interface PriceSlotFacts {
  yieldP50: number | null;
  /** Cost deducted per ha (A2+FL, else a published C2-type total); null when not sourced. */
  costPerHa: number | null;
  postHarvestLossPct: number | null;
  /** Occupancy days (sowing to latest harvest plus the land preparation gap). */
  occupancyDays: number;
}
export interface PriceScoreResult { value: number; marginPart: number; timingPart: number; marginRate: number | null; revenueRate: number | null; timingRatio: number | null; reasonCodes: ReasonCode[] }

/** Expected gross margin per ha per month of occupancy: (p50 x yieldP50 x (1 - loss) - cost) / months. */
export function marginRate(slot: PriceSlotFacts, priceP50: number | null): number | null {
  if (priceP50 === null || slot.yieldP50 === null || slot.costPerHa === null || slot.occupancyDays <= 0) return null;
  const loss = (slot.postHarvestLossPct ?? 0) / 100;
  return (priceP50 * slot.yieldP50 * (1 - loss) - slot.costPerHa) / (slot.occupancyDays / ASSUMPTIONS.daysPerMonth.value);
}

/** Gross revenue per ha per month of occupancy, no cost deducted: p50 x yieldP50 x (1 - loss) / months. */
export function revenueRate(slot: PriceSlotFacts, priceP50: number | null): number | null {
  if (priceP50 === null || slot.yieldP50 === null || slot.occupancyDays <= 0) return null;
  const loss = (slot.postHarvestLossPct ?? 0) / 100;
  return (priceP50 * slot.yieldP50 * (1 - loss)) / (slot.occupancyDays / ASSUMPTIONS.daysPerMonth.value);
}

/** Missing cost: margin part = 0.7 x gross revenue rate / candidate maximum gross revenue rate (ASSUMPTIONS.missingCostRevenueFactor). */
export function priceScore(slot: PriceSlotFacts, outlook: HarvestPriceOutlook | null, annualMean: number | null, candidateMaxMarginRate: number | null, candidateMaxRevenueRate: number | null = null): PriceScoreResult {
  const p50 = outlook && outlook.status === 'available' ? outlook.p50 : null;
  if (p50 === null || !(p50 > 0)) return { value: 0, marginPart: 0, timingPart: 0, marginRate: null, revenueRate: null, timingRatio: null, reasonCodes: ['price_insufficient'] };
  const codes: ReasonCode[] = [];
  if (slot.costPerHa === null) codes.push('cost_not_sourced');
  if (slot.yieldP50 === null) codes.push('yield_not_sourced');
  const rate = marginRate(slot, p50);
  const revRate = revenueRate(slot, p50);
  const marginPart = slot.costPerHa === null
    ? (revRate === null || revRate <= 0 || candidateMaxRevenueRate === null || candidateMaxRevenueRate <= 0 ? 0 : ASSUMPTIONS.missingCostRevenueFactor.value * Math.min(1, revRate / candidateMaxRevenueRate))
    : (rate === null || rate <= 0 || candidateMaxMarginRate === null || candidateMaxMarginRate <= 0 ? 0 : Math.min(1, rate / candidateMaxMarginRate));
  const mean = annualMean ?? outlook!.annualMean;
  const [lo, hi] = ASSUMPTIONS.harvestTimingClip.value;
  let ratio: number | null = null;
  let timingPart = 0;
  if (mean !== null && mean > 0) {
    ratio = p50 / mean;
    timingPart = (clip(ratio, lo, hi) - lo) / (hi - lo);
  } else codes.push('price_timing_unknown');
  const t = ASSUMPTIONS.reasonThresholds.value;
  if (ratio !== null && ratio >= t.timingStrong) codes.push('price_timing_strong');
  if (ratio !== null && ratio <= t.timingWeak) codes.push('price_timing_weak');
  if (marginPart >= t.marginHigh) codes.push('margin_rate_high');
  const { margin, timing } = ASSUMPTIONS.priceParts.value;
  return { value: (margin * marginPart + timing * timingPart) / (margin + timing), marginPart, timingPart, marginRate: rate, revenueRate: revRate, timingRatio: ratio, reasonCodes: codes };
}

// ------------------------------------------------------------------ yield (30)

export interface YieldScoreResult { value: number; ratio: number | null; localKgPerHa: number | null; reasonCodes: ReasonCode[] }

/** yieldIndex = clip(local / reference, 0, 1.2) / 1.2 x windowFit x waterFit; a farmer override replaces the local yield. */
export function yieldScore(slot: { yieldOverrideKgPerHa?: number | null | undefined }, yieldRef: { p50: number; referenceKgPerHa: number } | null, windowFit: number, waterFit: number): YieldScoreResult {
  const local = slot.yieldOverrideKgPerHa ?? yieldRef?.p50 ?? null;
  const reference = yieldRef?.referenceKgPerHa ?? null;
  if (local === null || reference === null || !(reference > 0)) return { value: 0, ratio: null, localKgPerHa: local, reasonCodes: ['yield_not_sourced'] };
  const max = ASSUMPTIONS.yieldRatioClip.value;
  const ratio = clip(local / reference, 0, max);
  return { value: (ratio / max) * windowFit * waterFit, ratio, localKgPerHa: local, reasonCodes: [] };
}

// ------------------------------------------------------------------ soil and rotation (15)

export type RotationRole = 'nitrogen_fixer' | 'heavy_feeder' | 'moderate_feeder' | 'light_feeder';
export interface LegumeCredit { min: number; max: number; specificity: string | null; successorCrop: string | null; source: string | null }
export interface CropLink { cropId: string | null; family: string | null; source: string | null; context: string | null }
export interface RotationFacts {
  cropId: string;
  family: string | null;
  role: RotationRole | null;
  roleSource: 'agronomy' | 'pool' | null;
  avoidAfter: CropLink[];
  successors: CropLink[];
  predecessors: CropLink[];
  phRange: { min: number; max: number; source: string | null } | null;
}
export type RotationRule = 'avoid_after' | 'same_family' | 'legume_after_heavy_feeder' | 'heavy_feeder_after_legume' | 'cited_succession' | 'lighter_after_heavy_feeder' | 'same_role' | 'family_break' | 'no_rule' | 'unknown_previous';
export interface RotationScoreResult { raw: number; value: number; rule: RotationRule; reasonCodes: ReasonCode[]; sources: string[]; sameFamily: boolean; phMismatch: boolean }
/** Transitions dropped during enumeration (spec 4.4); kept and scored -1 for farmer edits. */
export const PRUNED_RULES: ReadonlySet<RotationRule> = new Set(['avoid_after', 'same_family']);

export function citedSuccession(prev: RotationFacts, next: RotationFacts): CropLink | null {
  return prev.successors.find((l) => l.cropId === next.cropId) ?? next.predecessors.find((l) => l.cropId === prev.cropId) ?? null;
}

function rotationRule(prev: RotationFacts, next: RotationFacts, legumeCredits: (cropId: string) => LegumeCredit | null): { raw: number; rule: RotationRule; sources: string[] } {
  const avoid = next.avoidAfter.find((a) => (a.cropId !== null && a.cropId === prev.cropId) || (a.family !== null && a.family === prev.family));
  if (avoid) return { raw: -1, rule: 'avoid_after', sources: avoid.source ? [avoid.source] : [] };
  const cited = citedSuccession(prev, next);
  const sameFamily = prev.family !== null && prev.family === next.family;
  if (sameFamily && !cited) return { raw: -1, rule: 'same_family', sources: [] };
  const nextCredit = legumeCredits(next.cropId);
  const prevCredit = legumeCredits(prev.cropId);
  if (next.role === 'nitrogen_fixer' && prev.role === 'heavy_feeder' && nextCredit) return { raw: 1, rule: 'legume_after_heavy_feeder', sources: [nextCredit.source ?? '', cited?.source ?? ''].filter(Boolean) };
  if (next.role === 'heavy_feeder' && prev.role === 'nitrogen_fixer' && prevCredit) return { raw: 1, rule: 'heavy_feeder_after_legume', sources: [prevCredit.source ?? '', cited?.source ?? ''].filter(Boolean) };
  if (cited) return { raw: ASSUMPTIONS.sameFamilyCitedSuccession.value, rule: 'cited_succession', sources: cited.source ? [cited.source] : [] };
  if (prev.role === 'heavy_feeder' && (next.role === 'moderate_feeder' || next.role === 'light_feeder')) return { raw: 0.3, rule: 'lighter_after_heavy_feeder', sources: [] };
  if (prev.role !== null && prev.role === next.role) return { raw: 0, rule: 'same_role', sources: [] };
  if (prev.family !== null && next.family !== null && prev.family !== next.family) return { raw: 0.3, rule: 'family_break', sources: [] };
  return { raw: 0, rule: 'no_rule', sources: [] };
}

const RULE_CODES: Record<RotationRule, ReasonCode[]> = {
  avoid_after: ['avoid_after_violation'], same_family: ['same_family_repeat'], legume_after_heavy_feeder: ['legume_after_heavy_feeder', 'family_break'],
  heavy_feeder_after_legume: ['heavy_feeder_after_legume', 'family_break'], cited_succession: ['cited_succession'], lighter_after_heavy_feeder: ['lighter_after_heavy_feeder'],
  same_role: ['same_role_repeat'], family_break: ['family_break'], no_rule: [], unknown_previous: [],
};

/**
 * Transition score per spec 5.1, first matching rule wins: cited avoidAfter -1; same family without a cited succession
 * -1; legume after heavy feeder or heavy feeder after legume with a cited N credit +1; cited succession +0.6; lighter
 * feeder after heavy feeder +0.3; same role 0; family break +0.3. Rescaled from -1..1 to 0..1; a confirmed soil pH
 * outside the crop's cited range halves the rescaled value.
 */
export function soilRotationScore(prev: RotationFacts | null, next: RotationFacts, legumeCredits: (cropId: string) => LegumeCredit | null, soilPh: number | undefined): RotationScoreResult {
  const r = prev ? rotationRule(prev, next, legumeCredits) : { raw: 0, rule: 'unknown_previous' as const, sources: [] };
  let value = prev ? (r.raw + 1) / 2 : ASSUMPTIONS.neutralRotationFit.value;
  const codes = [...RULE_CODES[r.rule]];
  if (r.rule === 'family_break' || r.rule === 'cited_succession' || r.rule === 'lighter_after_heavy_feeder') {
    if (prev && prev.family !== null && next.family !== null && prev.family !== next.family && !codes.includes('family_break')) codes.push('family_break');
  }
  const ph = next.phRange;
  const phMismatch = soilPh !== undefined && ph !== null && (soilPh < ph.min || soilPh > ph.max);
  if (phMismatch) { value *= ASSUMPTIONS.phMismatchMultiplier.value; codes.push('soil_ph_mismatch'); }
  return { raw: r.raw, value, rule: r.rule, reasonCodes: codes, sources: r.sources, sameFamily: !!prev && prev.family !== null && prev.family === next.family, phMismatch };
}

// ------------------------------------------------------------------ water and climate (10)

export interface WaterSlotFacts { sowing: string; harvestLatest: string; waterNeedMm: { min: number; max: number } | null }
export interface WaterFitResult { value: number; known: boolean; needMm: number | null; rainMm: number | null; allowanceMm: number; availableMm: number | null; ndviAdjustment: number; capped: boolean; reasonCodes: ReasonCode[] }

/** Climatological rain over [sowing, harvestLatest), pro-rating each calendar month's normal by its days. */
export function rainOver(sowing: string, harvestLatest: string, rainByMonth: readonly number[]): number | null {
  if (rainByMonth.length !== 12 || rainByMonth.some((v) => !Number.isFinite(v) || v < 0)) return null;
  return daysPerMonth(sowing, harvestLatest).reduce((sum, m) => sum + rainByMonth[m.month - 1]! * (m.days / daysInMonth(m.year, m.month)), 0);
}

export function ndviAdjustment(sowing: string, harvestLatest: string, activeMonths: readonly number[] | null, observedMonths: readonly number[] | null | undefined): { value: number; code: ReasonCode | null } {
  if (!activeMonths) return { value: 0, code: null };
  const months = [...new Set(daysPerMonth(sowing, harvestLatest).map((m) => m.month))];
  const considered = observedMonths ? months.filter((m) => observedMonths.includes(m)) : months;
  if (considered.length < ASSUMPTIONS.ndviMinMonths.value) return { value: 0, code: null };
  const active = considered.filter((m) => activeMonths.includes(m)).length;
  const adj = ASSUMPTIONS.ndviAdjustment.value;
  if (active / considered.length >= 0.5) return { value: adj, code: 'ndvi_season_match' };
  if (observedMonths && active === 0) return { value: -adj, code: 'ndvi_season_contradiction' };
  return { value: 0, code: null };
}

/** waterFit = clip((rain + irrigation allowance) / need, 0, 1) + NDVI adjustment; rainfed cap 0.4 for crops not marked rainfed-suitable. */
export function waterFit(slot: WaterSlotFacts, climatologyRainMm: readonly number[] | null, irrigationCategory: IrrigationClass | null, rainfedSuitable: boolean | null, neighbourhoodActiveMonths: readonly number[] | null, neighbourhoodObservedMonths?: readonly number[] | null): WaterFitResult {
  const allowance = irrigationCategory ? ASSUMPTIONS.irrigationAllowanceMm.value[irrigationCategory] : 0;
  const need = slot.waterNeedMm ? (slot.waterNeedMm.min + slot.waterNeedMm.max) / 2 : null;
  const rain = climatologyRainMm ? rainOver(slot.sowing, slot.harvestLatest, climatologyRainMm) : null;
  const known = need !== null && need > 0 && rain !== null;
  const codes: ReasonCode[] = [];
  let value = known ? clip((rain + allowance) / need, 0, 1) : ASSUMPTIONS.unknownWaterFit.value;
  if (!known) codes.push('water_data_missing');
  const ndvi = ndviAdjustment(slot.sowing, slot.harvestLatest, neighbourhoodActiveMonths, neighbourhoodObservedMonths);
  value = clip(value + ndvi.value, 0, 1);
  if (ndvi.code) codes.push(ndvi.code);
  const capped = irrigationCategory === 'none' && rainfedSuitable !== true && value > ASSUMPTIONS.rainfedCap.value;
  if (irrigationCategory === 'none' && rainfedSuitable !== true) { value = Math.min(value, ASSUMPTIONS.rainfedCap.value); codes.push('rainfed_unsuitable'); }
  const t = ASSUMPTIONS.reasonThresholds.value;
  if (known && value >= t.waterGood) codes.push('water_fit_good');
  if (known && value < t.waterPoor) codes.push('water_fit_poor');
  return { value, known, needMm: need, rainMm: rain, allowanceMm: allowance, availableMm: rain === null ? null : rain + allowance, ndviAdjustment: ndvi.value, capped, reasonCodes: codes };
}

// ------------------------------------------------------------------ data confidence (5)

export interface ConfidenceFlags { priceVerified: boolean; districtYield: boolean; costSourced: boolean; durationSourced: boolean; districtWindow: boolean }
export function confidenceScore(flags: ConfidenceFlags): { value: number; label: 'high' | 'medium' | 'low' } {
  const vals = [flags.priceVerified, flags.districtYield, flags.costSourced, flags.durationSourced, flags.districtWindow];
  const value = vals.filter(Boolean).length / vals.length;
  const b = ASSUMPTIONS.confidenceBands.value;
  return { value, label: value >= b.high ? 'high' : value >= b.medium ? 'medium' : 'low' };
}

// ------------------------------------------------------------------ slot and sequence

/** Sequence-level slot score (spec 5.2): soil and rotation enter at sequence level, so they are not in here. */
export function slotScore(c: Pick<ScoreComponents, 'price' | 'yield' | 'water' | 'confidence'>): number {
  return WEIGHTS.price * c.price + WEIGHTS.yield * c.yield + WEIGHTS.water * c.water + WEIGHTS.confidence * c.confidence;
}
/** Per-slot display score 0..1 including the slot's own transition fit (all five weights). */
export function slotDisplayScore(c: ScoreComponents): number {
  return slotScore(c) + WEIGHTS.soilRotation * c.soilRotation;
}

export interface SequenceTerms { slots: readonly { weightDays: number; slotScore: number }[]; horizonDays: number; rotationFit: number; idleDays: number }
export interface SequenceScoreResult { value: number; score: number; base: number; idleMonths: number; idlePenalty: number }

/** score = sum (occupancyDays / horizonDays) x slotScore + 0.15 x rotationFit - 0.02 per idle month beyond two; reported 0..100. */
export function sequenceScore(t: SequenceTerms): SequenceScoreResult {
  const base = t.horizonDays > 0 ? t.slots.reduce((s, x) => s + (x.weightDays / t.horizonDays) * x.slotScore, 0) : 0;
  const idleMonths = Math.max(0, t.idleDays) / ASSUMPTIONS.daysPerMonth.value;
  const { perMonth, freeMonths } = ASSUMPTIONS.idlePenalty.value;
  const idlePenalty = perMonth * Math.max(0, idleMonths - freeMonths);
  const value = base + WEIGHTS.soilRotation * t.rotationFit - idlePenalty;
  return { value, score: Math.round(clip(value, 0, 1) * 10000) / 100, base, idleMonths, idlePenalty };
}

/** Reason codes for one slot from its collected codes, flags and components, ordered by the fixed priority, at most 8. */
export function reasonCodes(slot: { codes: readonly ReasonCode[]; flags: SlotFlags; windowScope: 'district' | 'state' | null; fixed: boolean }, components: ScoreComponents): ReasonCode[] {
  const out = new Set<ReasonCode>(slot.codes);
  if (slot.fixed) out.add('current_crop');
  if (slot.flags.provisionalWindow) out.add('provisional_window');
  else if (slot.windowScope === 'district') out.add('district_window');
  if (slot.flags.stateWindowFallback) out.add('state_window_fallback');
  if (slot.flags.outsideWindow) out.add('outside_window');
  if (slot.flags.conditional) out.add('conditional_irrigation');
  if (slot.flags.harvestAssumed) out.add('harvest_assumed');
  if (components.confidence < ASSUMPTIONS.confidenceBands.value.medium) out.add('low_data_confidence');
  return [...out].sort((a, b) => PRIORITY.get(a)! - PRIORITY.get(b)!).slice(0, 8);
}
