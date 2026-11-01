import type { BasisRef, HarvestPriceOutlook, IntercropCompanion, PriceEstimate, RescoreYearPlan, ScoreComponents, YearPlanGap, YearPlanOption, YearPlanSlot } from '@harvest/contracts';
import { estimateProfit, estimateProfitMulti, sumEstimates, type ProfitEstimate, type Quantiles3 } from '../estimate';
import * as data from './data';
import { coveredDays, enumerateCandidates, enumerateSequences, makeIntercropSlotPlan, makeSlotPlan, predecessorOf, rotationId, shortHash, trailingIdleDays, transitionScorer, type CandidateSet } from './candidates';
import { addDays, clippedDays, daysBetween, isCalendarDate, isoWeek, monthOf, overlaps } from './dates';
import { collectInputKeys, priceHarvestDate, pricedSlots, priceKey, slotPriceKey, type Inputs, type PriceInputKey } from './inputs';
import {
  ASSUMPTIONS, assumptionBasis, clip, confidenceScore, irrigationClass, marginRate, revenueRate, POSITIVE_CODES, priceScore, REASON_TEXT, reasonCodes, sequenceScore, slotDisplayScore, slotScore,
  soilRotationScore, soilYieldFactor, waterFit, yieldScore, type ConfidenceFlags, type PriceScoreResult, type PriceSlotFacts, type ReasonCode, type RotationScoreResult, type WaterFitResult, type YieldScoreResult,
} from './scoring';
import type { Candidate, EngineContext, HarvestRange, IrrigationClass, PlacedWindow, Sequence, SlotPlan } from './types';
import { irrigationCompat, placeWindows, windowForDate } from './windows';

/** Normalisation shared by every option of one review; persist it with the review so farmer edits rescore on the same scale. */
export interface ScoringNorm {
  maxMarginRate: number | null;
  /** Largest positive gross revenue rate (no cost deducted); scores slots whose cost is not sourced. */
  maxRevenueRate?: number | null | undefined;
}

export interface EvaluatedSlot {
  plan: SlotPlan;
  yieldRef: data.YieldRef | null;
  yieldRange: { low: number; high: number } | null;
  yieldBasis: YearPlanSlot['yieldBasis'];
  cost: data.CostRef | null;
  loss: { pct: number; sourceId: string | null } | null;
  priceKey: string;
  outlook: HarvestPriceOutlook | null;
  price: PriceScoreResult;
  yield: YieldScoreResult;
  water: WaterFitResult;
  confidence: { value: number; label: 'high' | 'medium' | 'low' };
  confidenceFlags: ConfidenceFlags;
  /** Sequence-level slot score (price, yield, water, confidence). */
  slotScore: number;
  codes: ReasonCode[];
  /** Likely band (p25 to p75) of the simulated revenue and profit per ha (round 2); null when not computable. */
  revenue: { low: number; high: number } | null;
  profit: { low: number; high: number } | null;
  /** Simulated estimates and the draw matrix (services/estimate.ts), seeded by the slot key. */
  estimate: ProfitEstimate;
  uncertainties: string[];
  basis: BasisRef[];
  /** Round 3: the companion of an intercrop slot (sole-crop yield range, its outlook, cost and the system shares). */
  companion?: CompanionEval | undefined;
}
export interface CompanionEval {
  systemId: string; cropId: string; productId: string; yieldRef: data.YieldRef | null; yieldRange: { low: number; high: number } | null; yieldBasis: YearPlanSlot['yieldBasis'];
  outlook: HarvestPriceOutlook | null; priceKey: string; harvest: HarvestRange; cost: data.CostRef | null; yieldIndex: number; revenueShare: number | null; combinedCostPerHa: number | null; costAssumed: boolean;
  /** The companion's A2+FL scaled by its seed-rate (else row) share, INR/ha; null when its cost is not sourced. */
  costPerHa: number | null;
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const where = (ctx: EngineContext) => ({ stateId: ctx.stateId, districtId: ctx.districtId });
const cropName = (ctx: EngineContext, id: string) => ctx.names?.crop?.[id] ?? data.cropDisplayName(id);
const productName = (ctx: EngineContext, cropId: string, id: string) => ctx.names?.product?.[id] ?? data.productDisplayName(cropId, id);
const irrigationOf = (ctx: EngineContext, inputs: Inputs) => irrigationClass(inputs.irrigationCategory) ?? ctx.irrigation;

interface SlotFacts { yieldRef: data.YieldRef | null; override: number | null; cost: data.CostRef | null; loss: { pct: number; sourceId: string | null } | null; facts: PriceSlotFacts; outlook: HarvestPriceOutlook | null; key: string }
function slotFacts(ctx: EngineContext, inputs: Inputs, plan: SlotPlan): SlotFacts {
  const yieldRef = data.yieldFor(plan.cropId, plan.productId, { ...where(ctx), season: plan.season, asOf: ctx.asOf });
  const override = inputs.yieldOverrides?.get(plan.productId) ?? null;
  const cost = data.costFor(plan.cropId, where(ctx));
  const loss = data.postHarvestLoss(plan.cropId);
  const key = slotPriceKey(plan);
  return {
    yieldRef, override, cost, loss, key, outlook: inputs.priceOutlooks.get(key) ?? null,
    facts: { yieldP50: override ?? yieldRef?.p50 ?? null, costPerHa: cost?.deductionPerHa ?? null, postHarvestLossPct: loss?.pct ?? null, occupancyDays: daysBetween(plan.occupancy.from, plan.occupancy.to) },
  };
}

/** Largest positive margin rate among the slots (spec 5.1 normalisation); null when none can be computed. */
export function marginNormaliser(ctx: EngineContext, slots: Iterable<SlotPlan>, inputs: Inputs): ScoringNorm {
  let max: number | null = null;
  let maxRev: number | null = null;
  for (const plan of slots) {
    const f = slotFacts(ctx, inputs, plan);
    if (plan.kind === 'intercrop' && plan.intercrop) {
      const t = intercropTotals(plan, f, companionFacts(ctx, inputs, plan));
      const months = f.facts.occupancyDays / ASSUMPTIONS.daysPerMonth.value;
      const r = t.revenue !== null && t.cost !== null && months > 0 ? (t.revenue - t.cost) / months : null;
      const g = t.revenue !== null && months > 0 ? t.revenue / months : null;
      if (r !== null && r > 0 && (max === null || r > max)) max = r;
      if (g !== null && g > 0 && (maxRev === null || g > maxRev)) maxRev = g;
      continue;
    }
    const p50 = f.outlook?.status === 'available' ? f.outlook.p50 : null;
    const r = marginRate(f.facts, p50);
    if (r !== null && r > 0 && (max === null || r > max)) max = r;
    const g = revenueRate(f.facts, p50);
    if (g !== null && g > 0 && (maxRev === null || g > maxRev)) maxRev = g;
  }
  return { maxMarginRate: max, maxRevenueRate: maxRev };
}

function evaluationBasis(ctx: EngineContext, inputs: Inputs, plan: SlotPlan, f: SlotFacts, water: WaterFitResult): BasisRef[] {
  const out: BasisRef[] = [...plan.basis];
  if (f.yieldRef) {
    for (const id of f.yieldRef.sourceIds) {
      const s = data.yieldCostSource(id);
      out.push({ kind: 'yield_reference', label: `Yield: ${s?.title ?? id}`.slice(0, 200), sourceId: id, url: s?.url ?? null, scope: f.yieldRef.region, note: `${f.yieldRef.season} ${f.yieldRef.years.join(', ')}; P25-P75 of the years used; reference ${f.yieldRef.referenceKgPerHa} kg/ha (${f.yieldRef.referenceBasis === 'state_median' ? 'state median of recent years' : 'best state year; no state median'})`.slice(0, 1000) });
    }
    if (f.yieldRef.conversion) {
      const s = data.yieldCostSource(f.yieldRef.conversion.sourceId);
      out.push({ kind: 'yield_reference', label: `Rice to paddy out-turn: ${s?.title ?? 'official norm'}`.slice(0, 200), sourceId: f.yieldRef.conversion.sourceId, url: s?.url ?? null, scope: null, note: `${f.yieldRef.conversion.factor} kg paddy per kg rice${f.yieldRef.conversion.locator ? `; ${f.yieldRef.conversion.locator}` : ''}` });
    }
  }
  if (f.cost) {
    const s = data.yieldCostSource(f.cost.sourceId);
    out.push({ kind: 'cost_reference', label: `Cost of cultivation: ${s?.title ?? f.cost.sourceId ?? 'source'}`.slice(0, 200), sourceId: f.cost.sourceId, url: s?.url ?? null, scope: f.cost.estimate.region, note: `${f.cost.estimate.authority?.toUpperCase() ?? ''} ${f.cost.estimate.year ?? 'year not printed'}; ${f.cost.deductionBasis === 'a2fl' ? 'A2+FL' : 'C2-type total'} ${f.cost.deductionPerHa} INR/ha${f.cost.locator ? `; ${f.cost.locator}` : ''}`.slice(0, 1000) });
  }
  if (f.outlook) {
    const o = f.outlook;
    out.push({ kind: 'price_history', label: o.basisLabel.slice(0, 200), sourceId: `price-outlook:${f.key}`, url: null, scope: `${o.scope.level}: ${[o.scope.districtName, o.scope.stateName].filter(Boolean).join(', ')}`.slice(0, 120), note: `${o.method}; ISO week ${o.harvestWeek.week} +/- ${o.weekWindow}; years ${o.yearsUsed.join(', ') || 'none'}; p25-p75 from leave-one-year-out residuals`.slice(0, 1000) });
  }
  const need = data.waterNeedMm(plan.cropId);
  if (need?.source) for (const s of data.agronomySources(need.source).slice(0, 1)) out.push({ kind: 'water', label: `Water need: ${s.title ?? s.id}`.slice(0, 200), sourceId: s.id, url: s.url, scope: null, note: `${need.min}-${need.max} mm per season; midpoint used` });
  if (inputs.climatologySource && inputs.climatologyRainByMonth) out.push({ kind: 'climatology', label: 'Rain normals for the field point', sourceId: inputs.climatologySource.sourceId, url: null, scope: null, note: `Daily normals ${inputs.climatologySource.years.from}-${inputs.climatologySource.years.to}, summed by month` });
  out.push(assumptionBasis('irrigationAllowanceMm'));
  if (!water.known) out.push(assumptionBasis('unknownWaterFit'));
  if (water.ndviAdjustment !== 0) out.push({ kind: 'ndvi', label: 'Neighbourhood vegetation activity (Sentinel-2 NDVI, 1 km buffer)', sourceId: null, url: null, scope: null, note: 'Indicates green months nearby, never crop identity' });
  return out;
}

function evaluationUncertainties(ctx: EngineContext, plan: SlotPlan, f: SlotFacts, water: WaterFitResult, asOf: string): string[] {
  // Yield and cost notes are joined into one line each so price and water notes survive the 10-line cap.
  const out = [...plan.uncertainties];
  if (f.yieldRef) { if (f.yieldRef.notes.length) out.push(`Yield: ${f.yieldRef.notes.join(' ')}`); }
  else if (f.override === null) out.push(data.yieldGapReason(plan.cropId, plan.productId, ctx.stateId));
  if (f.cost) { if (f.cost.notes.length) out.push(`Cost: ${f.cost.notes.join(' ')}`); }
  else out.push(data.costGapReason(plan.cropId, ctx.stateId));
  if (f.outlook && f.outlook.asOf !== asOf) out.push(`The price outlook was computed for ${f.outlook.asOf}, not for this review date (${asOf}).`);
  if (!f.outlook) out.push('The harvest-week price was not loaded for this date.');
  else if (f.outlook.status !== 'available') out.push(`No harvest-week price range: ${f.outlook.missingReason ?? 'insufficient history'}.`);
  else if (f.outlook.scope.fallbackNote) out.push(f.outlook.scope.fallbackNote);
  if (!water.known) out.push('Rain normals or the crop water need are missing; water fit is neutral (0.5).');
  if (water.capped) out.push('Rainfed field and the crop is not marked rainfed-suitable: water fit is capped at 0.4.');
  return [...new Set(out)];
}

const ESTIMATE_BASIS: BasisRef = {
  kind: 'model', label: 'Profit estimate: lognormal yield x harvest-week price, 2000 seeded draws', sourceId: 'estimate:lognormal-yield-price-v1', url: null, scope: null,
  note: 'Yield and price are independent lognormals with medians at the regional yield p50 and the price p50 and sigma = ln(p75/p25)/1.349; cost is deterministic. Likely = middle half of the simulated outcomes (p25 to p75); possible = 10th to 90th percentile; rounded to Rs 100.',
};

/**
 * Green manure slot (ROUND2_SPEC 1.2 item 4, ASSUMPTIONS.greenManureScoring): no product, price and yield parts 0,
 * revenue exactly 0, profit minus the sourced seed cost (plus field operations when sourced), water fit as for crops,
 * confidence over the four flags that apply. No price lookup is made for it.
 */
function evaluateGreenManure(ctx: EngineContext, inputs: Inputs, plan: SlotPlan): EvaluatedSlot {
  const g = data.greenManure(plan.cropId);
  const cost = data.greenManureCost(plan.cropId);
  const credit = data.legumeCredit(plan.cropId);
  const water = waterFit({ sowing: plan.sowing, harvestLatest: plan.harvest.latest, waterNeedMm: data.waterNeedMm(plan.cropId) }, inputs.climatologyRainByMonth, irrigationOf(ctx, inputs), data.rainfedSuitable(plan.cropId), inputs.neighbourhoodActiveMonths, inputs.neighbourhoodObservedMonths);
  const fullyCosted = !!cost && (g?.fieldOpsCostPerHa?.value ?? ASSUMPTIONS.greenManureFieldOpsCostPerHa.value) !== null;
  const districtWindow = plan.window?.scope === 'district' && !plan.window.provisional;
  const applicable = [plan.durationSourced, districtWindow, credit !== null, fullyCosted];
  const value = applicable.filter(Boolean).length / applicable.length;
  const bands = ASSUMPTIONS.confidenceBands.value;
  const confidence = { value, label: (value >= bands.high ? 'high' : value >= bands.medium ? 'medium' : 'low') as 'high' | 'medium' | 'low' };
  const price: PriceScoreResult = { value: 0, marginPart: 0, timingPart: 0, marginRate: null, revenueRate: null, timingRatio: null, reasonCodes: [] };
  const yieldS: YieldScoreResult = { value: 0, ratio: null, localKgPerHa: null, soilFactor: 1, reasonCodes: [] };
  const estimate = estimateProfit({ seed: plan.key, yieldKgPerHa: null, pricePerKg: null, costPerHa: cost?.deductionPerHa ?? null, areaHa: ctx.scenario.fieldAreaHa, noRevenue: true });
  const components = { price: 0, yield: 0, water: water.value, confidence: value };
  const uncertainties = [...plan.uncertainties, 'Green manure: grown and ploughed in; it has no product and earns nothing. Its value is the nitrogen and organic matter left for the next crop.'];
  if (g?.provisional) uncertainties.push('Green manure figures come from state package-of-practice pages and a district contingency plan (provisional).');
  if (cost) uncertainties.push(`Cost: ${cost.notes.join(' ')}`); else uncertainties.push('Green manure seed rate or seed price is not sourced; no cost.');
  if (!water.known) uncertainties.push('The green manure water need is not sourced; water fit is neutral (0.5).');
  if (water.capped) uncertainties.push('Rainfed field and the green manure is not marked rainfed-suitable: water fit is capped at 0.4.');
  const basis: BasisRef[] = [...plan.basis];
  if (credit) for (const s of data.agronomySources(credit.source).slice(0, 1)) basis.push({ kind: 'rotation', label: `Green manure nitrogen: ${s.title ?? s.id}`.slice(0, 200), sourceId: s.id, url: s.url, scope: null, note: `${credit.min === credit.max ? credit.min : `${credit.min}-${credit.max}`} kg N/ha in the biomass at 60 days${s.locator ? `; ${s.locator}` : ''}`.slice(0, 1000) });
  if (cost) for (const s of data.agronomySources(cost.locator).slice(0, 1)) basis.push({ kind: 'cost_reference', label: `Green manure seed price: ${s.title ?? s.id}`.slice(0, 200), sourceId: s.id, url: s.url, scope: cost.estimate.region, note: cost.notes.join(' ').slice(0, 1000) });
  const seedRate = g?.seedRateKgPerHa?.source;
  if (seedRate) for (const s of data.agronomySources(seedRate).slice(0, 1)) basis.push({ kind: 'cost_reference', label: `Green manure seed rate: ${s.title ?? s.id}`.slice(0, 200), sourceId: s.id, url: s.url, scope: null, note: `${g!.seedRateKgPerHa!.min}-${g!.seedRateKgPerHa!.max} kg/ha${s.locator ? `; ${s.locator}` : ''}`.slice(0, 1000) });
  if (!fullyCosted) basis.push(assumptionBasis('greenManureFieldOpsCostPerHa'));
  basis.push(assumptionBasis('greenManureScoring'));
  if (inputs.climatologySource && inputs.climatologyRainByMonth) basis.push({ kind: 'climatology', label: 'Rain normals for the field point', sourceId: inputs.climatologySource.sourceId, url: null, scope: null, note: `Daily normals ${inputs.climatologySource.years.from}-${inputs.climatologySource.years.to}, summed by month` });
  if (!water.known) basis.push(assumptionBasis('unknownWaterFit'));
  return {
    plan, yieldRef: null, yieldRange: null, yieldBasis: null, cost, loss: null, priceKey: slotPriceKey(plan), outlook: null, price, yield: yieldS, water, confidence,
    confidenceFlags: { priceVerified: false, districtYield: false, costSourced: fullyCosted, durationSourced: plan.durationSourced, districtWindow },
    slotScore: slotScore(components), codes: ['green_manure', ...water.reasonCodes], revenue: estimate.revenuePerHa ? { ...estimate.revenuePerHa.likely } : null,
    profit: estimate.profitPerHa ? { ...estimate.profitPerHa.likely } : null, estimate, uncertainties: [...new Set(uncertainties)], basis,
  };
}

/** Sequence-independent evaluation of one slot (spec 5.1); deterministic for identical inputs. */
export function evaluateSlot(ctx: EngineContext, inputs: Inputs, plan: SlotPlan, norm: ScoringNorm): EvaluatedSlot {
  if (plan.kind === 'green_manure') return evaluateGreenManure(ctx, inputs, plan);
  if (plan.kind === 'intercrop' && plan.intercrop) return evaluateIntercrop(ctx, inputs, plan, norm);
  return evaluateCrop(ctx, inputs, plan, norm);
}

/** ASSUMPTIONS.soilYieldFactors from the confirmed soil comparison at the crop's regional yield p50 (factor 1 without a report). */
function soilFactorFor(inputs: Inputs, cropId: string, yieldP50: number | null) {
  return soilYieldFactor(inputs.soilChecks?.(cropId, yieldP50) ?? null);
}
function soilBasis(name: string, s: ReturnType<typeof soilYieldFactor>): BasisRef {
  return { kind: 'soil', label: `Soil limits the ${name.toLowerCase()} yield part`.slice(0, 200), sourceId: null, url: null, scope: null, note: `Confirmed soil test against the crop uptake: ${s.limiting.map((c) => `${c.label} ${c.verdict}`).join(', ')}; yield part x ${s.value.toFixed(2)}${s.raw < s.value ? ' (floor)' : ''}.`.slice(0, 1000) };
}

function evaluateCrop(ctx: EngineContext, inputs: Inputs, plan: SlotPlan, norm: ScoringNorm): EvaluatedSlot {
  const f = slotFacts(ctx, inputs, plan);
  const water = waterFit({ sowing: plan.sowing, harvestLatest: plan.harvest.latest, waterNeedMm: data.waterNeedMm(plan.cropId) }, inputs.climatologyRainByMonth, irrigationOf(ctx, inputs), data.rainfedSuitable(plan.cropId), inputs.neighbourhoodActiveMonths, inputs.neighbourhoodObservedMonths);
  // Yield v2 (ROUND3_SPEC 4): no water fit inside the yield part; the soil factor from the confirmed soil checks instead.
  const soil = soilFactorFor(inputs, plan.cropId, f.override ?? f.yieldRef?.p50 ?? null);
  const yieldS = yieldScore({ yieldOverrideKgPerHa: f.override }, f.yieldRef, plan.windowFit, soil.value);
  const price = priceScore(f.facts, f.outlook, inputs.annualMeans.get(plan.productId) ?? null, norm.maxMarginRate, norm.maxRevenueRate ?? null);
  const flags: ConfidenceFlags = {
    priceVerified: f.outlook?.status === 'available' && f.outlook.yearsUsed.length >= 2,
    districtYield: f.override !== null || (f.yieldRef?.basis === 'district' && !f.yieldRef.stale),
    costSourced: !!f.cost && (ASSUMPTIONS.confidenceSourcedCost.value as readonly string[]).includes(f.cost.estimate.authority ?? ''),
    durationSourced: plan.durationSourced,
    districtWindow: plan.window?.scope === 'district' && !plan.window.provisional,
  };
  const confidence = confidenceScore(flags);
  const codes = new Set<ReasonCode>([...price.reasonCodes, ...yieldS.reasonCodes, ...water.reasonCodes]);
  if (!f.cost) codes.add('cost_not_sourced');
  else if (f.cost.deductionBasis === 'c2') codes.add('cost_c2_only');
  if (f.override === null && f.yieldRef?.basis === 'state') codes.add('yield_state_fallback');
  if (f.override === null && f.yieldRef?.basis === 'reference') codes.add('yield_reference_only');
  if (f.override === null && f.yieldRef?.conversion) codes.add('yield_converted_rice_to_paddy');
  const yieldRange = f.override !== null
    ? (f.yieldRef ? { low: Math.round(f.yieldRef.low * (f.override / f.yieldRef.p50)), high: Math.round(f.yieldRef.high * (f.override / f.yieldRef.p50)) } : { low: f.override, high: f.override })
    : f.yieldRef ? { low: f.yieldRef.low, high: f.yieldRef.high } : null;
  const o = f.outlook;
  const priceRange = o && o.status === 'available' && o.p25 !== null && o.p75 !== null ? { low: o.p25, high: o.p75 } : null;
  const keep = 1 - (f.loss?.pct ?? 0) / 100;
  const yieldP50 = f.override ?? f.yieldRef?.p50 ?? null;
  const estimate = estimateProfit({
    seed: plan.key, keep, costPerHa: f.cost?.deductionPerHa ?? null, areaHa: ctx.scenario.fieldAreaHa,
    yieldKgPerHa: yieldRange && yieldP50 !== null ? { p25: yieldRange.low, p50: yieldP50, p75: yieldRange.high } : null,
    pricePerKg: priceRange && o?.p50 != null ? { p25: priceRange.low, p50: o.p50, p75: priceRange.high } : null,
  });
  const revenue = estimate.revenuePerHa ? { ...estimate.revenuePerHa.likely } : null;
  const profit = estimate.profitPerHa ? { ...estimate.profitPerHa.likely } : null;
  const components = { price: price.value, yield: yieldS.value, water: water.value, confidence: confidence.value };
  const uncertainties = evaluationUncertainties(ctx, plan, f, water, inputs.asOf);
  const basis = evaluationBasis(ctx, inputs, plan, f, water);
  if (estimate.revenuePerHa) basis.push(ESTIMATE_BASIS);
  if (estimate.yieldSigmaAssumed) {
    uncertainties.push(`The yield has no year-to-year range; the profit simulation assumes a yield spread (sigma ${ASSUMPTIONS.singleYearYieldSigma.value}).`);
    basis.push(assumptionBasis('singleYearYieldSigma'));
  }
  if (soil.value < 1) {
    uncertainties.push(`Confirmed soil test: ${soil.limiting.map((c) => `${c.label} ${c.verdict}`).join(', ')}; the yield part is multiplied by ${soil.value.toFixed(2)} (engine assumption).`);
    basis.push(soilBasis(cropName(ctx, plan.cropId), soil), assumptionBasis('soilYieldFactors'));
  }
  if (f.override === null && f.yieldRef?.referenceBasis === 'state_best_year') basis.push(assumptionBasis('referenceYield'));
  return {
    plan, yieldRef: f.yieldRef, yieldRange, yieldBasis: f.override !== null ? 'farmer' : f.yieldRef?.basis ?? null, cost: f.cost, loss: f.loss, priceKey: f.key, outlook: o,
    price, yield: yieldS, water, confidence, confidenceFlags: flags, slotScore: slotScore(components), codes: [...codes], revenue, profit, estimate, uncertainties, basis,
  };
}

// ------------------------------------------------------------------ intercrop (round 3, ROUND3_SPEC 8.2)

interface CompanionFacts { yieldRef: data.YieldRef | null; override: number | null; cost: data.CostRef | null; loss: { pct: number; sourceId: string | null } | null; key: string; outlook: HarvestPriceOutlook | null; harvest: HarvestRange }
function companionFacts(ctx: EngineContext, inputs: Inputs, plan: SlotPlan): CompanionFacts {
  const ic = plan.intercrop!;
  const s = ic.system;
  const key = priceKey(s.companionProductId, priceHarvestDate(ic.companionHarvest));
  return {
    yieldRef: data.yieldFor(s.companionCropId, s.companionProductId, { ...where(ctx), season: plan.season, asOf: ctx.asOf }), override: inputs.yieldOverrides?.get(s.companionProductId) ?? null,
    cost: data.costFor(s.companionCropId, where(ctx)), loss: data.postHarvestLoss(s.companionCropId), key, outlook: inputs.priceOutlooks.get(key) ?? null, harvest: ic.companionHarvest,
  };
}
const shareMid = (r: { min: number; max: number }) => (r.min + r.max) / 2;
/** Expected revenue per ha of both products at the share midpoints, and the combined cost (ASSUMPTIONS.intercropCompanionCostRowShare). */
function intercropTotals(plan: SlotPlan, f: SlotFacts, c: CompanionFacts) {
  const s = plan.intercrop!.system;
  const mainP = f.outlook?.status === 'available' ? f.outlook.p50 : null;
  const compP = c.outlook?.status === 'available' ? c.outlook.p50 : null;
  const compY = c.override ?? c.yieldRef?.p50 ?? null;
  const mainRevenue = mainP !== null && f.facts.yieldP50 !== null ? mainP * f.facts.yieldP50 * shareMid(s.yieldShare.main) * (1 - (f.loss?.pct ?? 0) / 100) : null;
  const compRevenue = compP !== null && compY !== null ? compP * compY * shareMid(s.yieldShare.companion) * (1 - (c.loss?.pct ?? 0) / 100) : null;
  // Review L3 (2026-11-01): a seed-rate share without its own source is still the factor but counts as assumed.
  const seedShare = s.seedRateShare?.companion ?? null;
  const factor = seedShare ?? s.companionRowShare;
  const cost = f.cost && c.cost && factor !== null ? f.cost.deductionPerHa + c.cost.deductionPerHa * factor : null;
  return {
    mainRevenue, compRevenue, revenue: mainRevenue === null ? null : mainRevenue + (compRevenue ?? 0), cost, factor,
    costAssumed: !(seedShare !== null && s.seedRateShare?.sourced === true), seedShareUnsourced: seedShare !== null && s.seedRateShare?.sourced !== true,
    rowShareAssumed: seedShare === null && s.companionRowShareAssumed,
  };
}
const rangeOf = (ref: data.YieldRef | null, override: number | null) => (override !== null
  ? (ref ? { low: Math.round(ref.low * (override / ref.p50)), high: Math.round(ref.high * (override / ref.p50)) } : { low: override, high: override })
  : ref ? { low: ref.low, high: ref.high } : null);
const shareQuantiles = (r: { low: number; high: number } | null, p50: number | null, share: { min: number; max: number }): Quantiles3 | null =>
  (r && p50 !== null ? { p25: r.low * share.min, p50: p50 * shareMid(share), p75: r.high * share.max } : null);
const priceQuantiles = (o: HarvestPriceOutlook | null): Quantiles3 | null => (o && o.status === 'available' && o.p25 !== null && o.p75 !== null && o.p50 !== null ? { p25: o.p25, p50: o.p50, p75: o.p75 } : null);

/**
 * Intercrop slot: the main crop evaluated as a crop (window, water, confidence flags, timing), then revenue = both
 * products (share-scaled yields x price x keep), cost = main A2+FL + companion A2+FL x seed-rate share (else row share,
 * flagged), margin part from the combined figures, yield part = revenue-share-weighted mean of both yield indices, and
 * estimateProfitMulti for the ranges. Companion figures follow the same season and state rules as the main crop.
 */
function evaluateIntercrop(ctx: EngineContext, inputs: Inputs, plan: SlotPlan, norm: ScoringNorm): EvaluatedSlot {
  const base = evaluateCrop(ctx, inputs, plan, norm);
  const s = plan.intercrop!.system;
  const f = slotFacts(ctx, inputs, plan);
  const c = companionFacts(ctx, inputs, plan);
  const t = intercropTotals(plan, f, c);
  const months = f.facts.occupancyDays / ASSUMPTIONS.daysPerMonth.value;
  const rate = t.revenue !== null && t.cost !== null && months > 0 ? (t.revenue - t.cost) / months : null;
  const revRate = t.revenue !== null && months > 0 ? t.revenue / months : null;
  const mainPriced = !base.price.reasonCodes.includes('price_insufficient');
  const marginPart = !mainPriced ? 0 : t.cost === null
    ? (revRate === null || revRate <= 0 || !norm.maxRevenueRate ? 0 : ASSUMPTIONS.missingCostRevenueFactor.value * Math.min(1, revRate / norm.maxRevenueRate))
    : (rate === null || rate <= 0 || !norm.maxMarginRate ? 0 : Math.min(1, rate / norm.maxMarginRate));
  const { margin, timing } = ASSUMPTIONS.priceParts.value;
  const priceCodes: ReasonCode[] = base.price.reasonCodes.filter((x) => x !== 'margin_rate_high' && x !== 'cost_not_sourced');
  if (mainPriced && t.cost === null) priceCodes.push('cost_not_sourced');
  if (marginPart >= ASSUMPTIONS.reasonThresholds.value.marginHigh) priceCodes.push('margin_rate_high');
  const price: PriceScoreResult = { ...base.price, marginPart, marginRate: rate, revenueRate: revRate, value: mainPriced ? (margin * marginPart + timing * base.price.timingPart) / (margin + timing) : 0, reasonCodes: priceCodes };
  const compSoil = soilFactorFor(inputs, s.companionCropId, c.override ?? c.yieldRef?.p50 ?? null);
  const compYield = yieldScore({ yieldOverrideKgPerHa: c.override }, c.yieldRef, plan.windowFit, compSoil.value);
  const wM = t.mainRevenue, wC = t.compRevenue;
  const revenueShare = wM !== null && wC !== null && wM + wC > 0 ? wC / (wM + wC) : null;
  const yieldValue = revenueShare === null ? base.yield.value : (1 - revenueShare) * base.yield.value + revenueShare * compYield.value;
  const yieldS: YieldScoreResult = { ...base.yield, value: yieldValue, reasonCodes: [...new Set([...base.yield.reasonCodes, ...compYield.reasonCodes])] };
  const compRange = rangeOf(c.yieldRef, c.override);
  const keepM = 1 - (f.loss?.pct ?? 0) / 100, keepC = 1 - (c.loss?.pct ?? 0) / 100;
  const estimate = estimateProfitMulti({
    seed: plan.key, costPerHa: t.cost, areaHa: ctx.scenario.fieldAreaHa,
    terms: [
      { yieldKgPerHa: shareQuantiles(base.yieldRange, f.override ?? f.yieldRef?.p50 ?? null, s.yieldShare.main), pricePerKg: priceQuantiles(f.outlook), keep: keepM },
      { yieldKgPerHa: shareQuantiles(compRange, c.override ?? c.yieldRef?.p50 ?? null, s.yieldShare.companion), pricePerKg: priceQuantiles(c.outlook), keep: keepC },
    ],
  });
  const codes = new Set<ReasonCode>([...base.codes.filter((x) => !['cost_not_sourced', 'cost_c2_only', 'margin_rate_high', 'price_timing_strong', 'price_timing_weak', 'price_timing_unknown', 'price_insufficient'].includes(x)), ...price.reasonCodes, ...yieldS.reasonCodes, 'intercrop']);
  if (t.cost === null) codes.add('cost_not_sourced');
  else if (f.cost?.deductionBasis === 'c2' || c.cost?.deductionBasis === 'c2') codes.add('cost_c2_only');
  if (s.shareBasis === 'assumed') codes.add('intercrop_shares_assumed');
  if (t.cost !== null && t.costAssumed) codes.add('intercrop_cost_assumed');
  const comp = data.cropDisplayName(s.companionCropId);
  const uncertainties = [...base.uncertainties];
  if (!c.yieldRef && c.override === null) uncertainties.push(`Companion: ${data.yieldGapReason(s.companionCropId, s.companionProductId, ctx.stateId)}`);
  if (!c.outlook) uncertainties.push(`${comp}: the harvest-week price was not loaded; its revenue is not counted in the price part and no range is shown.`);
  else if (c.outlook.status !== 'available') uncertainties.push(`${comp}: no harvest-week price range (${c.outlook.missingReason ?? 'insufficient history'}); its revenue is not counted.`);
  if (t.cost !== null) uncertainties.push(`Cost: main ${f.cost!.deductionPerHa} + companion ${c.cost!.deductionPerHa} x ${Math.round(t.factor! * 1000) / 1000} (${t.costAssumed ? (t.seedShareUnsourced ? 'seed-rate share without its own source, assumed' : t.rowShareAssumed ? 'default row share, assumed' : 'row share, assumed') : 'sourced seed-rate share'}) = ${Math.round(t.cost)} INR/ha.`);
  else if (f.cost && !c.cost) uncertainties.push(`${data.costGapReason(s.companionCropId, ctx.stateId)} The intercrop cost and profit are not shown.`);
  if (s.shareBasis === 'assumed') uncertainties.push(`Intercrop yield shares are assumed: ${s.shareNote ?? 'research fallback'}.`);
  if (s.nitrogenCredit && !s.nitrogenCredit.sourced) uncertainties.push(`The system's nitrogen credit of ${s.nitrogenCredit.min}${s.nitrogenCredit.max !== s.nitrogenCredit.min ? `-${s.nitrogenCredit.max}` : ''} kg/ha has no source of its own; the next crop gets no legume credit from it.`);
  // Review L7 (2026-11-01): a state-wide system whose notes name a command area or district (e.g. Bhadra command, IN-KA).
  if (s.localityNote && !(ctx.districtId && s.regions.includes(ctx.districtId))) uncertainties.push(`System reported for ${s.localityNote} in the state, not this district.`);
  const basis = [...base.basis.filter((b) => b.sourceId !== 'estimate:lognormal-yield-price-v1')];
  for (const id of c.yieldRef?.sourceIds.slice(0, 1) ?? []) { const src = data.yieldCostSource(id); basis.push({ kind: 'yield_reference', label: `Companion yield: ${src?.title ?? id}`.slice(0, 200), sourceId: id, url: src?.url ?? null, scope: c.yieldRef!.region, note: `${c.yieldRef!.season} ${c.yieldRef!.years.join(', ')}; sole-crop yield before the share`.slice(0, 1000) }); }
  if (c.cost) { const src = data.yieldCostSource(c.cost.sourceId); basis.push({ kind: 'cost_reference', label: `Companion cost: ${src?.title ?? c.cost.sourceId ?? 'source'}`.slice(0, 200), sourceId: c.cost.sourceId, url: src?.url ?? null, scope: c.cost.estimate.region, note: `${c.cost.deductionBasis === 'a2fl' ? 'A2+FL' : 'C2-type total'} ${c.cost.deductionPerHa} INR/ha` }); }
  if (c.outlook) basis.push({ kind: 'price_history', label: `Companion price: ${c.outlook.basisLabel}`.slice(0, 200), sourceId: `price-outlook:${c.key}`, url: null, scope: `${c.outlook.scope.level}: ${[c.outlook.scope.districtName, c.outlook.scope.stateName].filter(Boolean).join(', ')}`.slice(0, 120), note: `ISO week ${c.outlook.harvestWeek.week}; years ${c.outlook.yearsUsed.join(', ') || 'none'}` });
  if (t.cost !== null && t.costAssumed && !t.seedShareUnsourced) basis.push(assumptionBasis('intercropCompanionCostRowShare'));
  if (t.cost !== null && t.rowShareAssumed) basis.push(assumptionBasis('intercropDefaultCompanionRowShare'));
  if (s.shareBasis === 'assumed') basis.push(assumptionBasis('intercropFallbackShares'));
  if (estimate.revenuePerHa) basis.push(ESTIMATE_BASIS);
  if (estimate.yieldSigmaAssumed && !base.estimate.yieldSigmaAssumed) basis.push(assumptionBasis('singleYearYieldSigma'));
  const components = { price: price.value, yield: yieldS.value, water: base.water.value, confidence: base.confidence.value };
  return {
    ...base, price, yield: yieldS, slotScore: slotScore(components), codes: [...codes], estimate,
    revenue: estimate.revenuePerHa ? { ...estimate.revenuePerHa.likely } : null, profit: estimate.profitPerHa ? { ...estimate.profitPerHa.likely } : null,
    uncertainties: [...new Set(uncertainties)], basis,
    companion: {
      systemId: s.id, cropId: s.companionCropId, productId: s.companionProductId, yieldRef: c.yieldRef, yieldRange: compRange, yieldBasis: c.override !== null ? 'farmer' : c.yieldRef?.basis ?? null,
      outlook: c.outlook, priceKey: c.key, harvest: c.harvest, cost: c.cost, yieldIndex: compYield.value, revenueShare, combinedCostPerHa: t.cost, costAssumed: t.costAssumed,
      costPerHa: c.cost && t.factor !== null ? Math.round(c.cost.deductionPerHa * t.factor) : null,
    },
  };
}

export function evaluateCandidates(ctx: EngineContext, candidates: readonly Candidate[], inputs: Inputs, norm: ScoringNorm): Map<string, EvaluatedSlot> {
  return new Map(candidates.map((c) => [c.candidateId, evaluateSlot(ctx, inputs, c, norm)]));
}

// ------------------------------------------------------------------ options

const RULE_TEXT: Record<RotationScoreResult['rule'], string> = {
  avoid_after: 'a source advises against this order', same_family: 'same crop family as the previous crop', legume_after_heavy_feeder: 'legume after a heavy feeder',
  heavy_feeder_after_legume: 'heavy feeder after a legume', cited_succession: 'a cited recommended succession', lighter_after_heavy_feeder: 'lighter feeder after a heavy feeder',
  same_role: 'same nutrient demand as the previous crop', family_break: 'different crop family', no_rule: 'no rotation evidence either way', unknown_previous: 'previous crop not recorded',
};
function transitionNote(ctx: EngineContext, prev: string | null, next: string, t: RotationScoreResult): string | null {
  if (!prev) return null;
  let text = `After ${cropName(ctx, prev).toLowerCase()}: ${RULE_TEXT[t.rule]}`;
  const credit = t.rule === 'legume_after_heavy_feeder' ? data.legumeCredit(next) : t.rule === 'heavy_feeder_after_legume' ? data.legumeCredit(prev) : null;
  if (credit) text += `; cited residual nitrogen ${credit.min === credit.max ? credit.min : `${credit.min}-${credit.max}`} kg N/ha (${credit.specificity ?? 'specificity not stated'}, ${credit.source})`;
  if (t.rule === 'cited_succession' && t.sameFamily) text += ' (same family, kept because a source recommends it)';
  if (t.sources.length && t.rule !== 'legume_after_heavy_feeder' && t.rule !== 'heavy_feeder_after_legume') text += `; ${t.sources.join('; ')}`;
  if (t.greenManureBonus) text += `; green manure ploughed in before sowing (+${ASSUMPTIONS.greenManureSuccessorBonus.value} soil and rotation fit, engine assumption)`;
  if (t.phMismatch) text += '; confirmed soil pH is outside the cited range';
  return `${text}.`.slice(0, 1000);
}

function priceEstimate(ev: EvaluatedSlot): PriceEstimate | null {
  return priceEstimateOf(ev.outlook, ev.plan.harvest);
}
function priceEstimateOf(o: HarvestPriceOutlook | null, harvest: HarvestRange): PriceEstimate | null {
  if (!o) return null;
  const w = isoWeek(priceHarvestDate(harvest));
  return {
    status: o.status, unit: 'INR/kg', p50: o.status === 'available' ? o.p50 : null, range: o.status === 'available' && o.p25 !== null && o.p75 !== null ? { low: o.p25, high: o.p75 } : null,
    harvestWeek: `${w.year}-W${String(w.week).padStart(2, '0')}`, yearsUsed: o.yearsUsed, observations: o.observations,
    scope: { level: o.scope.level, stateName: o.scope.stateName, districtName: o.scope.districtName, marketCount: o.scope.marketCount }, reason: o.missingReason,
  };
}

function dedupeBasis(xs: BasisRef[]): BasisRef[] {
  const seen = new Set<string>();
  return xs.filter((b) => { const k = `${b.kind}|${b.sourceId}|${b.note}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
}

/**
 * Round 3: the contract companion block of an intercrop slot (YearPlanSlot.companion and CropFitCandidate.companion); null
 * for any other slot. Shared with crop fit so both show the same figures.
 */
export function slotCompanion(ctx: EngineContext, plan: SlotPlan, ev: EvaluatedSlot): IntercropCompanion | null {
  const ic = plan.intercrop;
  if (!ic || !ev.companion) return null;
  const s = ic.system;
  return {
    systemId: ic.systemId.slice(0, 120), cropId: ev.companion.cropId.slice(0, 120), productId: ev.companion.productId.slice(0, 200),
    cropName: cropName(ctx, ev.companion.cropId).slice(0, 120), productName: productName(ctx, ev.companion.cropId, ev.companion.productId).slice(0, 120),
    rowRatio: s.rowRatio.slice(0, 20), arrangement: s.arrangement,
    yieldShare: { main: { low: s.yieldShare.main.min, high: s.yieldShare.main.max }, companion: { low: s.yieldShare.companion.min, high: s.yieldShare.companion.max } },
    shareBasis: s.shareBasis, yieldKgPerHa: ev.companion.yieldRange, yieldBasis: ev.companion.yieldBasis, price: priceEstimateOf(ev.companion.outlook, ev.companion.harvest),
    costPerHa: ev.companion.costPerHa,
    nitrogenCreditKgPerHa: s.nitrogenCredit ? { low: s.nitrogenCredit.min, high: s.nitrogenCredit.max } : null,
    source: s.source ? { id: s.source.id.slice(0, 80), title: (s.source.title ?? s.source.id).slice(0, 200), url: s.source.url, locator: s.source.locator ? s.source.locator.slice(0, 200) : null } : null,
  };
}

/** Stable slot id of the fixed current cycle. */
export const fixedSlotId = (ctx: EngineContext): string | null => (ctx.fixedSlot ? `slot-${shortHash(ctx.fixedSlot.key)}` : null);

const DOMINANT_LABEL = { price: 'Price-led', yield: 'Yield-led', soilRotation: 'Soil enrichment', water: 'Water fit' } as const;

interface BuildMeta { origin: YearPlanOption['origin']; idSeed: string; warnings: string[]; slotIds?: Map<string, string> | undefined; extraCodes?: Map<string, ReasonCode[]> | undefined }
export interface ScoredOption { option: YearPlanOption; value: number }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** "25 Mar" from an ISO date. */
export const dayMonth = (d: string): string => `${Number(d.slice(8, 10))} ${MONTHS[monthOf(d) - 1]}`;
const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * Code-written reason for an idle gap [from, to) (ROUND2_SPEC 1.2 item 3), first match wins: (1) no pool crop has a
 * usable sourced window touching the gap (names the next window opening on or after `to`); (2) windows exist but none
 * fits the field's irrigation; (3) a compatible pool crop could be sown in the gap and harvested before the next slot
 * but scored lower. When compatible windows exist but no such crop finishes before the next slot, that is said instead.
 */
export function gapReason(ctx: EngineContext, irrigation: IrrigationClass | null, from: string, to: string): string {
  const last = addDays(to, -1);
  // Pool crops and the pool's green manure crops (round 2) both count.
  const pool = [...data.poolEntries().filter((e) => data.agronomyCrop(e.cropId)).map((e) => ({ cropId: e.cropId, productId: e.productIds[0] ?? null })), ...data.greenManureEntries().map((g) => ({ cropId: g.cropId, productId: g.cropId }))]
    .filter((e) => !ctx.excludedCropIds.includes(e.cropId));
  const hits: { cropId: string; productId: string | null; w: PlacedWindow; ok: boolean }[] = [];
  for (const e of pool) for (const w of placeWindows(data.windowsFor(e.cropId, where(ctx)), { from, to })) hits.push({ cropId: e.cropId, productId: e.productId, w, ok: irrigationCompat(w.condition, irrigation).ok });
  if (!hits.length) {
    let next: PlacedWindow | null = null;
    for (const e of pool) for (const w of placeWindows(data.windowsFor(e.cropId, where(ctx)), { from: to, to: addDays(to, 366) })) if (w.from >= to && (!next || w.from < next.from)) next = w;
    return `No sourced sowing window for a pool crop between ${dayMonth(from)} and ${dayMonth(last)} on this field; ${next ? `the next windows open ${dayMonth(next.from)} (${next.season})` : 'no later window opens within a year'}.`;
  }
  const ok = hits.filter((h) => h.ok);
  if (!ok.length) {
    const first = [...hits].sort((a, b) => a.w.from.localeCompare(b.w.from))[0]!;
    if (irrigation === 'none' && hits.every((h) => h.w.condition.toLowerCase() === 'irrigated')) return `${capitalise(first.w.season)} sowing here needs irrigation; the field is recorded as rainfed.`;
    return `The sowing windows between ${dayMonth(from)} and ${dayMonth(last)} are irrigated or rice-fallow relay windows that do not fit this field.`;
  }
  const gapDays = ASSUMPTIONS.landPrepGapDays.value;
  let best: { cropId: string; sowing: string } | null = null;
  let earliest: string | null = null;
  for (const h of ok) {
    const sowing = h.w.from > from ? h.w.from : from;
    if (sowing > (h.w.to < last ? h.w.to : last)) continue;
    if (earliest === null || sowing < earliest) earliest = sowing;
    const cls = data.durationFor(h.cropId, null, ctx.stateId, h.productId)[0];
    if (cls && addDays(sowing, cls.max + gapDays) <= to && (!best || sowing < best.sowing || (sowing === best.sowing && h.cropId < best.cropId))) best = { cropId: h.cropId, sowing };
  }
  if (best) return `${cropName(ctx, best.cropId)} could be sown from ${dayMonth(best.sowing)} but scored lower than this plan; edit the plan to add it.`;
  return `Pool crops could be sown from ${dayMonth(earliest ?? from)} but none would be harvested before the next crop on ${dayMonth(to)}.`;
}

const gapMemo = new WeakMap<EngineContext, Map<string, string>>();
/** Idle gaps of ASSUMPTIONS.gapReportDays or more before each suggested slot; `to` is the slot's first day (exclusive end). */
export function planGaps(ctx: EngineContext, inputs: Inputs, plans: readonly SlotPlan[]): YearPlanGap[] {
  const irrigation = irrigationOf(ctx, inputs);
  let memo = gapMemo.get(ctx);
  if (!memo) { memo = new Map(); gapMemo.set(ctx, memo); }
  const ends = [...(ctx.fixedSlot ? [ctx.fixedSlot.occupancy.to] : []), ...ctx.occupied.map((o) => o.to)];
  const out: YearPlanGap[] = [];
  const suggested = plans.filter((p) => !p.fixed).sort((a, b) => a.occupancy.from.localeCompare(b.occupancy.from));
  for (const slot of suggested) {
    let from = ctx.earliestSowing;
    for (const e of ends) if (e <= slot.occupancy.from && e > from) from = e;
    const days = daysBetween(from, slot.occupancy.from);
    if (days >= ASSUMPTIONS.gapReportDays.value) {
      const k = `${from}|${slot.occupancy.from}|${irrigation ?? ''}`;
      let reason = memo.get(k);
      if (reason === undefined) { reason = gapReason(ctx, irrigation, from, slot.occupancy.from); memo.set(k, reason); }
      out.push({ from, to: slot.occupancy.from, days, reason: reason.slice(0, 300) });
    }
    ends.push(slot.occupancy.to);
  }
  return out.slice(0, 6);
}

/** Two short lines for the fixed slot's strip (ROUND2_SPEC 1.2 item 7); the long sentence stays in its uncertainties. */
export function fixedSlotNote(ctx: EngineContext): string | null {
  const fs = ctx.fixedSlot;
  if (!fs) return null;
  const h = fs.harvest;
  const when = h.earliest === h.latest ? dayMonth(h.earliest) : `${dayMonth(h.earliest)} to ${dayMonth(h.latest)}`;
  const basis = fs.harvestBasis === 'recorded' ? 'recorded' : fs.timelineEstimate ? 'estimated from the sowing date' : fs.harvestBasis === 'sourced_duration' ? 'estimated from the sourced crop duration' : 'assumed; record the harvest date';
  return `Harvest expected ${when} (${basis})\nNext crop from ${dayMonth(fs.occupancy.to)}`;
}

function fixedSlotSentence(ctx: EngineContext): string | null {
  const fs = ctx.fixedSlot;
  if (!fs || fs.harvestBasis === 'recorded') return null;
  return fs.timelineEstimate
    ? `${cropName(ctx, fs.cropId)}: harvest date not recorded; estimated from the recorded sowing date and the crop's stage model (${fs.harvest.earliest} to ${fs.harvest.latest}), and the field is held until ${fs.occupancy.to}.`
    : `${cropName(ctx, fs.cropId)}: harvest date not recorded; the field is held until ${fs.occupancy.to} as a precaution.`;
}

function buildOption(ctx: EngineContext, inputs: Inputs, plans: SlotPlan[], evaluate: (p: SlotPlan) => EvaluatedSlot, meta: BuildMeta): ScoredOption {
  const h = ctx.horizon;
  const horizonDays = daysBetween(h.from, h.to);
  const area = ctx.scenario.fieldAreaHa !== null && Number.isFinite(ctx.scenario.fieldAreaHa) && ctx.scenario.fieldAreaHa > 0 ? ctx.scenario.fieldAreaHa : null;
  const rot = (prev: string | null, next: string) => soilRotationScore(prev ? data.rotationFacts(prev) : null, data.rotationFacts(next), data.legumeCredit, inputs.soilPh);
  const evals = plans.map(evaluate);
  const counted: number[] = [];
  const fixedSentence = fixedSlotSentence(ctx);
  const slots: YearPlanSlot[] = plans.map((plan, i) => {
    const ev = evals[i]!;
    const prev = plan.fixed ? ctx.previousCropId : predecessorOf(ctx, plans.slice(0, i), plan.sowing);
    const t = rot(prev, plan.cropId);
    if (!plan.fixed) counted.push(t.value);
    const components: ScoreComponents = { price: ev.price.value, yield: ev.yield.value, soilRotation: t.value, water: ev.water.value, confidence: ev.confidence.value };
    const codes = reasonCodes({ codes: [...ev.codes, ...t.reasonCodes, ...(meta.extraCodes?.get(plan.key) ?? [])], flags: plan.flags, windowScope: plan.window?.scope ?? null, fixed: plan.fixed }, components);
    const credit = data.legumeCredit(rotationId(plan));
    const ic = plan.intercrop;
    const share = ic ? ic.system.yieldShare.main : null;
    const companion = slotCompanion(ctx, plan, ev);
    const uncertainties = plan.fixed && fixedSentence ? [fixedSentence, ...ev.uncertainties] : ev.uncertainties;
    const basis = t.greenManureBonus ? [...ev.basis, assumptionBasis('greenManureSuccessorBonus')] : ev.basis;
    return {
      slotId: meta.slotIds?.get(plan.key) ?? `slot-${shortHash(plan.key)}`, cropId: plan.cropId, productId: plan.productId,
      cropName: cropName(ctx, plan.cropId).slice(0, 120), productName: productName(ctx, plan.cropId, plan.productId).slice(0, 120),
      establishmentMethod: plan.method ? plan.method.slice(0, 80) : null, kind: plan.kind ?? 'crop', ...(companion ? { companion } : {}), nitrogenCreditKgPerHa: credit ? { low: credit.min, high: credit.max } : null,
      fixed: plan.fixed, sowing: plan.sowing, harvest: { ...plan.harvest },
      occupancy: { from: plan.occupancy.from, to: plan.occupancy.to }, durationDays: { ...plan.durationDays }, yieldKgPerHa: ev.yieldRange, yieldBasis: ev.yieldBasis,
      yieldForFieldKg: ev.yieldRange && area ? { low: Math.round(ev.yieldRange.low * (share?.min ?? 1) * area), high: Math.round(ev.yieldRange.high * (share?.max ?? 1) * area) } : null,
      price: priceEstimate(ev), cost: ev.cost?.estimate ?? null, revenuePerHa: ev.revenue, profitPerHa: ev.profit,
      revenueEstimate: ev.estimate.revenuePerHa, profitEstimate: ev.estimate.profitPerHa, profitForField: ev.estimate.profitForField,
      score: Math.round(clip(slotDisplayScore(components), 0, 1) * 10000) / 100,
      components: { price: round4(clip(components.price, 0, 1)), yield: round4(clip(components.yield, 0, 1)), soilRotation: round4(clip(components.soilRotation, 0, 1)), water: round4(clip(components.water, 0, 1)), confidence: round4(clip(components.confidence, 0, 1)) },
      confidence: ev.confidence.label, transitionNote: plan.fixed ? fixedSlotNote(ctx) : transitionNote(ctx, prev, plan.cropId, t), reasonCodes: codes,
      uncertainties: uncertainties.slice(0, 10).map((u) => u.slice(0, 1000)), basis: dedupeBasis(basis),
    };
  });
  const rotationFit = counted.length ? counted.reduce((a, b) => a + b, 0) / counted.length : ASSUMPTIONS.neutralRotationFit.value;
  const weights = plans.map((p) => clippedDays(p.occupancy.from, p.occupancy.to, h.from, h.to));
  const occupancies = plans.map((p) => p.occupancy);
  const idleDays = horizonDays - coveredDays(occupancies, h);
  const seq = sequenceScore({ slots: plans.map((_, i) => ({ weightDays: weights[i]!, slotScore: evals[i]!.slotScore })), horizonDays, rotationFit, idleDays, trailingIdleDays: trailingIdleDays(occupancies, h) });
  const wsum = weights.reduce((a, b) => a + b, 0);
  const wmean = (pick: (e: EvaluatedSlot) => number) => (wsum > 0 ? evals.reduce((s, e, i) => s + weights[i]! * pick(e), 0) / wsum : 0);
  const components: ScoreComponents = { price: round4(clip(wmean((e) => e.price.value), 0, 1)), yield: round4(clip(wmean((e) => e.yield.value), 0, 1)), soilRotation: round4(clip(rotationFit, 0, 1)), water: round4(clip(wmean((e) => e.water.value), 0, 1)), confidence: round4(clip(wmean((e) => e.confidence.value), 0, 1)) };
  const suggested = slots.filter((s) => !s.fixed);
  const reasons = POSITIVE_CODES.filter((c) => suggested.some((s) => s.reasonCodes.includes(c))).slice(0, 3).map((code) => ({ code, text: REASON_TEXT[code] }));
  // Totals from the same draw matrix (sum per draw, then quantiles); the per-ha range fields carry the likely band.
  const totals = sumEstimates(evals.map((e) => e.estimate.draws), area);
  const warnings = [...meta.warnings];
  for (const s of slots) {
    if (s.kind === 'green_manure') {
      if (!s.cost) warnings.push(`${s.cropName}: seed cost not sourced; plan totals not shown.`);
      else if (evals.some((e) => e.plan.key === plans[slots.indexOf(s)]!.key && !e.confidenceFlags.costSourced)) warnings.push(`${s.cropName}: cost is the seed only; sowing and ploughing in are not costed (no sourced figure).`);
      continue;
    }
    if (!s.cost) warnings.push(`${s.cropName}: cost of cultivation not sourced; profit not shown.`);
    if (!s.price || s.price.status !== 'available') warnings.push(`${s.cropName}: no harvest-week price range.`);
    if (!s.yieldKgPerHa) warnings.push(`${s.cropName}: no regional yield for this product form.`);
  }
  if (!totals.revenuePerHa || !totals.profitPerHa) warnings.push('Plan totals are shown only when every slot has a price, yield and cost.');
  const dominant = (['price', 'yield', 'soilRotation', 'water'] as const).reduce((best, k) => (components[k] > components[best] ? k : best), 'price' as 'price' | 'yield' | 'soilRotation' | 'water');
  const option: YearPlanOption = {
    optionId: `${meta.origin === 'farmer_edit' ? 'edit' : 'opt'}-${shortHash(meta.idSeed)}`, label: DOMINANT_LABEL[dominant], origin: meta.origin, score: seq.score, components,
    slots, idleMonths: Math.round(clip(seq.idleMonths, 0, 12) * 100) / 100, idlePenaltyPoints: Math.round(clip(seq.idlePenalty, 0, 1) * 10000) / 100, reasons,
    totalRevenuePerHa: totals.revenuePerHa ? { ...totals.revenuePerHa.likely } : null, totalProfitPerHa: totals.profitPerHa ? { ...totals.profitPerHa.likely } : null,
    totalRevenueEstimate: totals.revenuePerHa, totalProfitEstimate: totals.profitPerHa, totalProfitForField: totals.profitForField, fieldAreaHa: area,
    gaps: planGaps(ctx, inputs, plans),
    warnings: [...new Set(warnings)].slice(0, 10).map((w) => w.slice(0, 1000)), editable: true,
  };
  return { option, value: seq.value };
}

function evaluator(ctx: EngineContext, inputs: Inputs, norm: ScoringNorm, cache: Map<string, EvaluatedSlot>) {
  return (p: SlotPlan): EvaluatedSlot => {
    let e = cache.get(p.key);
    if (!e) { e = evaluateSlot(ctx, inputs, p, norm); cache.set(p.key, e); }
    return e;
  };
}

/** Scores sequences (fixed slot first) into options sorted by score (spec 5.2). */
export function scoreSequences(ctx: EngineContext, sequences: readonly Sequence[], inputs: Inputs, opts: { norm?: ScoringNorm | undefined; evaluations?: Map<string, EvaluatedSlot> | undefined } = {}): YearPlanOption[] {
  const norm = opts.norm ?? marginNormaliser(ctx, new Map(sequences.flatMap((s) => s.slots.map((c) => [c.candidateId, c] as const))).values(), inputs);
  const evaluate = evaluator(ctx, inputs, norm, opts.evaluations ?? new Map());
  const fixed = ctx.fixedSlot ? [ctx.fixedSlot] : [];
  const fixedId = fixedSlotId(ctx);
  const slotIds = fixedId && ctx.fixedSlot ? new Map([[ctx.fixedSlot.key, fixedId]]) : undefined;
  return sequences.map((s) => buildOption(ctx, inputs, [...fixed, ...s.slots], evaluate, { origin: 'deterministic', idSeed: s.slots.map((c) => c.candidateId).join('>'), warnings: [], slotIds }))
    .sort((a, b) => b.value - a.value || a.option.optionId.localeCompare(b.option.optionId)).map((x) => x.option);
}

const firstCrop = (o: YearPlanOption) => o.slots.find((s) => !s.fixed)?.cropId ?? null;
/** Crop/product order of the suggested slots; date variants of one sequence share it. */
export const cropSignature = (o: YearPlanOption): string => o.slots.filter((s) => !s.fixed).map((s) => `${s.cropId}/${s.productId}${s.companion ? `+${s.companion.systemId}` : ''}`).join('>');

/** Options sorted by score with only the best date variant of each crop signature kept. */
export function distinctOptions(options: readonly YearPlanOption[]): YearPlanOption[] {
  const seen = new Set<string>();
  return [...options].sort((a, b) => b.score - a.score || a.optionId.localeCompare(b.optionId)).filter((o) => {
    const sig = cropSignature(o);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

/**
 * Share of the horizon a plan keeps the field occupied (current crop included), from its idle months. Uses the same
 * idle-day count as the idle penalty; `horizonDays` defaults to 365.
 */
export const horizonShare = (o: Pick<YearPlanOption, 'idleMonths'>, horizonDays = 365): number =>
  horizonDays > 0 ? clip(1 - (o.idleMonths * ASSUMPTIONS.daysPerMonth.value) / horizonDays, 0, 1) : 0;

/** ASSUMPTIONS.shortlistCoverage: the top plan always qualifies; any other needs 40 % of the horizon or 70 % of the top score. */
export function coverageQualifies(o: YearPlanOption, top: YearPlanOption | undefined, horizonDays = 365): boolean {
  if (!top || o.optionId === top.optionId) return true;
  const { minHorizonShare, minScoreShare } = ASSUMPTIONS.shortlistCoverage.value;
  return horizonShare(o, horizonDays) >= minHorizonShare - 1e-9 || o.score >= minScoreShare * top.score - 1e-9;
}

/**
 * Diverse shortlist (spec 4.5): from the 12 best distinct crop sequences by score (date variants of one sequence count
 * once) that pass the coverage rule (ASSUMPTIONS.shortlistCoverage), best overall, best soil enrichment, best water fit
 * and best price, then the next best whose first suggested crop differs from those already picked, then the next best
 * by score until `n`. Each pick is labelled by why it was picked. Plans that fail the coverage rule are never shortlisted.
 */
export function shortlist(options: readonly YearPlanOption[], n = 8, horizonDays = 365): YearPlanOption[] {
  const distinct = distinctOptions(options);
  const top = distinct.filter((o) => coverageQualifies(o, distinct[0], horizonDays)).slice(0, 12);
  const picked: YearPlanOption[] = [];
  const take = (o: YearPlanOption | undefined, label: string) => { if (o && picked.length < n && !picked.some((p) => p.optionId === o.optionId)) picked.push({ ...o, label }); };
  const bestBy = (k: keyof ScoreComponents) => top.filter((o) => !picked.some((p) => p.optionId === o.optionId)).sort((a, b) => b.components[k] - a.components[k] || b.score - a.score || a.optionId.localeCompare(b.optionId))[0];
  take(top[0], 'Best overall');
  take(bestBy('soilRotation'), 'Soil enrichment');
  take(bestBy('water'), 'Best water fit');
  take(bestBy('price'), 'Best price timing');
  for (const o of top) {
    const fc = firstCrop(o);
    if (fc !== null && !picked.some((p) => firstCrop(p) === fc)) take(o, 'Different first crop');
  }
  for (const o of top) take(o, 'Alternative');
  return picked;
}

// ------------------------------------------------------------------ farmer edits

type Edit = RescoreYearPlan['slots'][number];

function planEdit(ctx: EngineContext, inputs: Inputs, e: Edit, warnings: string[], codes: ReasonCode[]): SlotPlan | null {
  const name = cropName(ctx, e.cropId);
  if (!isCalendarDate(e.sowing)) { warnings.push(`${name}: sowing date ${e.sowing} is not a calendar date; slot left out.`); return null; }
  const gm = data.isGreenManure(e.cropId);
  let system: data.IntercropSystem | null = null;
  if (e.kind === 'intercrop') {
    system = e.systemId ? data.intercropSystems(where(ctx)).find((s) => s.id === e.systemId && s.mainCropId === e.cropId) ?? null : null;
    if (!system) warnings.push(`${name}: intercrop system ${e.systemId ?? '(none)'} is not known for this field and crop; scored as the sole main crop.`);
  }
  if (e.kind === 'green_manure' && !gm) { warnings.push(`${name}: not a green manure crop in green-manure.json; slot left out.`); return null; }
  if (gm && e.productId !== e.cropId) warnings.push(`${name}: a green manure has no product; the product is ignored.`);
  if (!gm && !data.agronomyCrop(e.cropId)) warnings.push(`${name}: no agronomy record; no sourced window or duration.`);
  const method = e.establishmentMethod ?? null;
  const classes = data.durationFor(e.cropId, method, ctx.stateId, e.productId);
  let cls = classes[0] ?? null;
  let harvest: SlotPlan['harvest'];
  if (e.harvestLatest) {
    const days = daysBetween(e.sowing, e.harvestLatest);
    cls = classes.find((c) => days >= c.min && days <= c.max) ?? cls;
    if (days < 0) { warnings.push(`${name}: harvest date is before sowing; slot left out.`); return null; }
    if (cls && (days < cls.min || days > cls.max)) { warnings.push(`${name}: the edited harvest date gives ${days} days; the sourced duration is ${cls.min}-${cls.max} days.`); codes.push('harvest_assumed'); }
    harvest = { earliest: cls && addDays(e.sowing, cls.min) < e.harvestLatest ? addDays(e.sowing, cls.min) : e.harvestLatest, latest: e.harvestLatest };
  } else if (cls) {
    if (classes.length > 1) warnings.push(`${name}: several sourced durations exist; the shortest (${cls.min}-${cls.max} days) is used. Enter a harvest date to choose another.`);
    harvest = { earliest: addDays(e.sowing, cls.min), latest: addDays(e.sowing, cls.max) };
  } else { warnings.push(`${name}: no sourced duration; enter a harvest date. Slot left out.`); return null; }
  const placed = placeWindows(data.windowsFor(e.cropId, where(ctx)), { from: addDays(e.sowing, -400), to: addDays(e.sowing, 400) });
  const hit = windowForDate(e.sowing, placed, irrigationOf(ctx, inputs));
  if (!hit) warnings.push(`${name}: sowing on ${e.sowing} is outside every sourced window for this field.`);
  else if (hit.window.provisional) warnings.push(`${name}: sowing falls in a provisional window only.`);
  const span = { low: daysBetween(e.sowing, harvest.earliest), high: daysBetween(e.sowing, harvest.latest) };
  const parts = {
    key: `edit:${system ? `intercrop:${system.id}|` : ''}${e.cropId}|${gm ? e.cropId : e.productId}|${method ?? 'any'}|${e.sowing}|${harvest.latest}`, kind: gm ? 'green_manure' as const : 'crop' as const, cropId: e.cropId, productId: gm ? e.cropId : e.productId, method: gm ? null : method ?? cls?.method ?? null, sowing: e.sowing, harvest,
    season: hit?.window.season ?? data.seasonOfMonth(monthOf(e.sowing)), durationDays: span, duration: cls, hit,
  };
  const plan = system && !gm ? makeIntercropSlotPlan(ctx, { ...parts, system }) : makeSlotPlan(ctx, parts);
  if (e.harvestLatest && cls && (span.high < cls.min || span.high > cls.max)) plan.flags.harvestAssumed = true;
  return plan;
}

/**
 * Re-scores a farmer-edited plan by code, without a model call (RescoreYearPlan). Windows, durations, occupancy and
 * transitions are re-validated; problems become warnings and lower scores (window fit 0 outside a window, -1 for an
 * avoided or same-family transition), never a refusal. The current cycle stays fixed as slot 1. Pass the review's
 * persisted norm so the price component keeps the scale of the original options.
 */
export function rescoreOption(ctx: EngineContext, inputs: Inputs, edits: readonly Edit[], opts: { norm?: ScoringNorm | undefined } = {}): YearPlanOption {
  const warnings: string[] = [];
  const extraCodes = new Map<string, ReasonCode[]>();
  const slotIds = new Map<string, string>();
  const fixedId = fixedSlotId(ctx);
  const plans: SlotPlan[] = [];
  if (ctx.fixedSlot && fixedId) { plans.push(ctx.fixedSlot); slotIds.set(ctx.fixedSlot.key, fixedId); }
  for (const e of [...edits].sort((a, b) => a.sowing.localeCompare(b.sowing) || a.cropId.localeCompare(b.cropId))) {
    const fx = ctx.fixedSlot;
    if (fx && (e.slotId === fixedId || (e.cropId === fx.cropId && e.sowing === fx.sowing))) {
      if (e.cropId !== fx.cropId || e.productId !== fx.productId || e.sowing !== fx.sowing || (e.harvestLatest && e.harvestLatest !== fx.harvest.latest)) warnings.push('The current crop cannot be changed here; it is kept as recorded.');
      continue;
    }
    const codes: ReasonCode[] = [];
    const plan = planEdit(ctx, inputs, e, warnings, codes);
    if (!plan) continue;
    const name = cropName(ctx, plan.cropId);
    if (plan.sowing < ctx.asOf) warnings.push(`${name}: sowing date ${plan.sowing} is in the past.`);
    if (plan.harvest.latest >= ctx.horizon.to) warnings.push(`${name}: harvest falls after the 12-month plan horizon.`);
    for (const o of ctx.occupied) if (overlaps(plan.occupancy.from, plan.occupancy.to, o.from, o.to)) { warnings.push(`${name} overlaps a saved season or cycle (${cropName(ctx, o.cropId)}, ${o.from} to ${o.to}).`); codes.push('occupancy_conflict'); }
    const prior = plans.at(-1);
    if (prior && overlaps(plan.occupancy.from, plan.occupancy.to, prior.occupancy.from, prior.occupancy.to)) { warnings.push(`${name} starts before the field is free after ${cropName(ctx, prior.cropId).toLowerCase()} (${prior.occupancy.to}).`); codes.push('occupancy_conflict'); }
    extraCodes.set(plan.key, codes);
    if (e.slotId) slotIds.set(plan.key, e.slotId);
    plans.push(plan);
  }
  const rot = transitionScorer();
  plans.forEach((p, i) => {
    if (p.fixed) return;
    const prev = predecessorOf(ctx, plans.slice(0, i), p.sowing);
    const r = prev ? rot(prev, p.cropId) : null;
    if (r?.rule === 'avoid_after') warnings.push(`${cropName(ctx, p.cropId)} after ${cropName(ctx, prev!).toLowerCase()}: a source advises against this order.`);
    if (r?.rule === 'same_family') warnings.push(`${cropName(ctx, p.cropId)} after ${cropName(ctx, prev!).toLowerCase()}: same crop family.`);
    const before = plans.slice(0, i).filter((x) => !x.fixed).at(-1);
    if (before?.kind === 'green_manure' && daysBetween(before.occupancy.to, p.sowing) > ASSUMPTIONS.greenManureMaxLeadDays.value) warnings.push(`${cropName(ctx, p.cropId)} is sown more than ${ASSUMPTIONS.greenManureMaxLeadDays.value} days after the green manure is ploughed in; much of its nitrogen may be lost.`);
    if (p.kind === 'green_manure' && i === plans.length - 1) warnings.push(`${cropName(ctx, p.cropId)} is the last slot; a green manure is meant to feed a following crop.`);
  });
  if (plans.length > 6) { warnings.push('Only the first six slots are kept.'); plans.length = 6; }
  if (!plans.length) throw new Error('rescoreOption: no slot could be placed');
  const norm = opts.norm ?? marginNormaliser(ctx, plans, inputs);
  if (!opts.norm) warnings.push('Price margin is normalised within this edited plan only.');
  const evaluate = evaluator(ctx, inputs, norm, new Map());
  return buildOption(ctx, inputs, plans, evaluate, { origin: 'farmer_edit', idSeed: plans.map((p) => p.key).join('>'), warnings, slotIds, extraCodes }).option;
}

/** Price keys for every slot of a farmer edit (fixed slot included), so packet 2 can prefetch before rescoreOption. */
export function editInputKeys(ctx: EngineContext, inputs: Inputs, edits: readonly Edit[]): PriceInputKey[] {
  const plans: SlotPlan[] = ctx.fixedSlot ? [ctx.fixedSlot] : [];
  for (const e of edits) { const p = planEdit(ctx, inputs, e, [], []); if (p && p.kind !== 'green_manure') plans.push(p); }
  return collectInputKeys(pricedSlots(plans));
}

// ------------------------------------------------------------------ full run

export const ENGINE_LIMITATIONS: readonly string[] = [
  'Yields are regional statistics (district, else state), not predictions for this field.',
  'Prices are wholesale mandi modal references for the harvest weeks of past years, not farm-gate prices or forecasts; no commission or market fee is deducted (not sourced).',
  'Post-harvest losses are not sourced; revenue is not reduced for them.',
  'Water fit compares climatological rain plus an assumed irrigation allowance with the crop water need; it is not a field water balance.',
  'Sowing windows come from 2011 district contingency plans and university season tables; provisional windows are marked.',
  'Rice-fallow relay sowing and perennial crops are not part of annual sequences.',
  'Green manure figures (days to incorporation, nitrogen, seed cost) come from state package-of-practice pages and are provisional; their cost is the seed only.',
  'Intercrop yield shares are research figures for the stated row ratio; the companion\'s price and cost are the sole-crop figures scaled by the share.',
];

export interface EngineRunOptions { maxSequences?: number | undefined; maxSlots?: number | undefined; keep?: number | undefined; shortlistSize?: number | undefined; candidateSet?: CandidateSet | undefined }
export interface EngineRun {
  candidateSet: CandidateSet; norm: ScoringNorm; sequencesConsidered: number; options: YearPlanOption[]; shortlist: YearPlanOption[]; limitations: string[];
  /** Round 2: best distinct sequences whose first suggested slot is a green manure, by score (for the fourth plan). */
  greenManureFirst: YearPlanOption[];
}

/** Keys to prefetch for a run: the fixed slot and every candidate. */
export function runInputKeys(ctx: EngineContext, set: CandidateSet): PriceInputKey[] {
  return collectInputKeys(pricedSlots([...(ctx.fixedSlot ? [ctx.fixedSlot] : []), ...set.candidates]));
}

/** Candidates -> normalisation -> slot evaluation -> sequences -> scored options (top `keep` distinct crop sequences, default 12) -> shortlist. */
export function runYearPlanEngine(ctx: EngineContext, inputs: Inputs, opts: EngineRunOptions = {}): EngineRun {
  const set = opts.candidateSet ?? enumerateCandidates(ctx);
  const norm = marginNormaliser(ctx, set.candidates, inputs);
  const evaluations = new Map<string, EvaluatedSlot>();
  const evaluate = evaluator(ctx, inputs, norm, evaluations);
  const sequences = enumerateSequences(ctx, set.candidates, { maxSequences: opts.maxSequences, maxSlots: opts.maxSlots, slotValue: (c) => evaluate(c).slotScore });
  // Occupied field with no free window left in the horizon: the honest plan is the current crop alone.
  const scored = sequences.length || !ctx.fixedSlot ? sequences : [{ sequenceId: 'seq-current-crop-only', slots: [] }];
  const options = scoreSequences(ctx, scored, inputs, { norm, evaluations });
  const limitations = [...ENGINE_LIMITATIONS, ...ctx.warnings, ...set.notes];
  // Saved seasons can fill every free month after the growing crop (for example after applying a plan): say so plainly.
  if (!sequences.length && ctx.fixedSlot && ctx.occupied.length) {
    const list = ctx.occupied.map((o) => `${cropName(ctx, o.cropId).toLowerCase()} ${dayMonth(o.from)} to ${dayMonth(o.to)}`).join(', ');
    limitations.push(`Saved seasons on this field (${list}) fill the months after the growing crop, so no new crop fits and only the growing crop is shown; remove or move a saved season to see other plans.`);
  }
  const distinct = distinctOptions(options);
  const greenManureFirst = distinct.filter((o) => o.slots.find((s) => !s.fixed)?.kind === 'green_manure').slice(0, 6);
  return { candidateSet: set, norm, sequencesConsidered: sequences.length, options: distinct.slice(0, opts.keep ?? 12), shortlist: shortlist(options, opts.shortlistSize ?? 8, daysBetween(ctx.horizon.from, ctx.horizon.to)), limitations, greenManureFirst };
}
