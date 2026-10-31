import type { BasisRef, HarvestPriceOutlook, PriceEstimate, RescoreYearPlan, ScoreComponents, YearPlanOption, YearPlanSlot } from '@harvest/contracts';
import * as data from './data';
import { coveredDays, enumerateCandidates, enumerateSequences, makeSlotPlan, predecessorOf, shortHash, transitionScorer, type CandidateSet } from './candidates';
import { addDays, clippedDays, daysBetween, isCalendarDate, isoWeek, monthOf, overlaps } from './dates';
import { collectInputKeys, priceHarvestDate, slotPriceKey, type Inputs, type PriceInputKey } from './inputs';
import {
  ASSUMPTIONS, assumptionBasis, clip, confidenceScore, irrigationClass, marginRate, POSITIVE_CODES, priceScore, REASON_TEXT, reasonCodes, sequenceScore, slotDisplayScore, slotScore,
  soilRotationScore, waterFit, yieldScore, type ConfidenceFlags, type PriceScoreResult, type PriceSlotFacts, type ReasonCode, type RotationScoreResult, type WaterFitResult, type YieldScoreResult,
} from './scoring';
import type { Candidate, EngineContext, Sequence, SlotPlan } from './types';
import { placeWindows, windowForDate } from './windows';

/** Normalisation shared by every option of one review; persist it with the review so farmer edits rescore on the same scale. */
export interface ScoringNorm { maxMarginRate: number | null }

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
  revenue: { low: number; high: number } | null;
  profit: { low: number; high: number } | null;
  uncertainties: string[];
  basis: BasisRef[];
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const where = (ctx: EngineContext) => ({ stateId: ctx.stateId, districtId: ctx.districtId });
const cropName = (ctx: EngineContext, id: string) => ctx.names?.crop?.[id] ?? data.cropDisplayName(id);
const productName = (ctx: EngineContext, cropId: string, id: string) => ctx.names?.product?.[id] ?? data.productDisplayName(cropId, id);
const irrigationOf = (ctx: EngineContext, inputs: Inputs) => irrigationClass(inputs.irrigationCategory) ?? ctx.irrigation;

interface SlotFacts { yieldRef: data.YieldRef | null; override: number | null; cost: data.CostRef | null; loss: { pct: number; sourceId: string | null } | null; facts: PriceSlotFacts; outlook: HarvestPriceOutlook | null; key: string }
function slotFacts(ctx: EngineContext, inputs: Inputs, plan: SlotPlan): SlotFacts {
  const yieldRef = data.yieldFor(plan.cropId, plan.productId, { ...where(ctx), season: plan.season });
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
  for (const plan of slots) {
    const f = slotFacts(ctx, inputs, plan);
    const p50 = f.outlook?.status === 'available' ? f.outlook.p50 : null;
    const r = marginRate(f.facts, p50);
    if (r !== null && r > 0 && (max === null || r > max)) max = r;
  }
  return { maxMarginRate: max };
}

function evaluationBasis(ctx: EngineContext, inputs: Inputs, plan: SlotPlan, f: SlotFacts, water: WaterFitResult): BasisRef[] {
  const out: BasisRef[] = [...plan.basis];
  if (f.yieldRef) {
    for (const id of f.yieldRef.sourceIds) {
      const s = data.yieldCostSource(id);
      out.push({ kind: 'yield_reference', label: `Yield: ${s?.title ?? id}`.slice(0, 200), sourceId: id, url: s?.url ?? null, scope: f.yieldRef.region, note: `${f.yieldRef.season} ${f.yieldRef.years.join(', ')}; P25-P75 of the years used; reference ${f.yieldRef.referenceKgPerHa} kg/ha (best state year)`.slice(0, 1000) });
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

/** Sequence-independent evaluation of one slot (spec 5.1); deterministic for identical inputs. */
export function evaluateSlot(ctx: EngineContext, inputs: Inputs, plan: SlotPlan, norm: ScoringNorm): EvaluatedSlot {
  const f = slotFacts(ctx, inputs, plan);
  const water = waterFit({ sowing: plan.sowing, harvestLatest: plan.harvest.latest, waterNeedMm: data.waterNeedMm(plan.cropId) }, inputs.climatologyRainByMonth, irrigationOf(ctx, inputs), data.rainfedSuitable(plan.cropId), inputs.neighbourhoodActiveMonths, inputs.neighbourhoodObservedMonths);
  const yieldS = yieldScore({ yieldOverrideKgPerHa: f.override }, f.yieldRef, plan.windowFit, water.value);
  const price = priceScore(f.facts, f.outlook, inputs.annualMeans.get(plan.productId) ?? null, norm.maxMarginRate);
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
  const revenue = yieldRange && priceRange ? { low: Math.round(yieldRange.low * priceRange.low * keep), high: Math.round(yieldRange.high * priceRange.high * keep) } : null;
  const profit = revenue && f.cost ? { low: revenue.low - f.cost.deductionPerHa, high: revenue.high - f.cost.deductionPerHa } : null;
  const components = { price: price.value, yield: yieldS.value, water: water.value, confidence: confidence.value };
  return {
    plan, yieldRef: f.yieldRef, yieldRange, yieldBasis: f.override !== null ? 'farmer' : f.yieldRef?.basis ?? null, cost: f.cost, loss: f.loss, priceKey: f.key, outlook: o,
    price, yield: yieldS, water, confidence, confidenceFlags: flags, slotScore: slotScore(components), codes: [...codes], revenue, profit,
    uncertainties: evaluationUncertainties(ctx, plan, f, water, inputs.asOf), basis: evaluationBasis(ctx, inputs, plan, f, water),
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
  if (t.phMismatch) text += '; confirmed soil pH is outside the cited range';
  return `${text}.`.slice(0, 1000);
}

function priceEstimate(ev: EvaluatedSlot): PriceEstimate | null {
  const o = ev.outlook;
  if (!o) return null;
  const w = isoWeek(priceHarvestDate(ev.plan.harvest));
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

/** Stable slot id of the fixed current cycle. */
export const fixedSlotId = (ctx: EngineContext): string | null => (ctx.fixedSlot ? `slot-${shortHash(ctx.fixedSlot.key)}` : null);

const DOMINANT_LABEL = { price: 'Price-led', yield: 'Yield-led', soilRotation: 'Soil enrichment', water: 'Water fit' } as const;

interface BuildMeta { origin: YearPlanOption['origin']; idSeed: string; warnings: string[]; slotIds?: Map<string, string> | undefined; extraCodes?: Map<string, ReasonCode[]> | undefined }
export interface ScoredOption { option: YearPlanOption; value: number }

function buildOption(ctx: EngineContext, inputs: Inputs, plans: SlotPlan[], evaluate: (p: SlotPlan) => EvaluatedSlot, meta: BuildMeta): ScoredOption {
  const h = ctx.horizon;
  const horizonDays = daysBetween(h.from, h.to);
  const rot = (prev: string | null, next: string) => soilRotationScore(prev ? data.rotationFacts(prev) : null, data.rotationFacts(next), data.legumeCredit, inputs.soilPh);
  const evals = plans.map(evaluate);
  const counted: number[] = [];
  const slots: YearPlanSlot[] = plans.map((plan, i) => {
    const ev = evals[i]!;
    const prev = plan.fixed ? ctx.previousCropId : predecessorOf(ctx, plans.slice(0, i), plan.sowing);
    const t = rot(prev, plan.cropId);
    if (!plan.fixed) counted.push(t.value);
    const components: ScoreComponents = { price: ev.price.value, yield: ev.yield.value, soilRotation: t.value, water: ev.water.value, confidence: ev.confidence.value };
    const codes = reasonCodes({ codes: [...ev.codes, ...t.reasonCodes, ...(meta.extraCodes?.get(plan.key) ?? [])], flags: plan.flags, windowScope: plan.window?.scope ?? null, fixed: plan.fixed }, components);
    return {
      slotId: meta.slotIds?.get(plan.key) ?? `slot-${shortHash(plan.key)}`, cropId: plan.cropId, productId: plan.productId,
      cropName: cropName(ctx, plan.cropId).slice(0, 120), productName: productName(ctx, plan.cropId, plan.productId).slice(0, 120),
      establishmentMethod: plan.method ? plan.method.slice(0, 80) : null, fixed: plan.fixed, sowing: plan.sowing, harvest: { ...plan.harvest },
      occupancy: { from: plan.occupancy.from, to: plan.occupancy.to }, durationDays: { ...plan.durationDays }, yieldKgPerHa: ev.yieldRange, yieldBasis: ev.yieldBasis,
      price: priceEstimate(ev), cost: ev.cost?.estimate ?? null, revenuePerHa: ev.revenue, profitPerHa: ev.profit,
      score: Math.round(clip(slotDisplayScore(components), 0, 1) * 10000) / 100,
      components: { price: round4(clip(components.price, 0, 1)), yield: round4(clip(components.yield, 0, 1)), soilRotation: round4(clip(components.soilRotation, 0, 1)), water: round4(clip(components.water, 0, 1)), confidence: round4(clip(components.confidence, 0, 1)) },
      confidence: ev.confidence.label, transitionNote: transitionNote(ctx, prev, plan.cropId, t), reasonCodes: codes,
      uncertainties: ev.uncertainties.slice(0, 10).map((u) => u.slice(0, 1000)), basis: dedupeBasis(ev.basis),
    };
  });
  const rotationFit = counted.length ? counted.reduce((a, b) => a + b, 0) / counted.length : ASSUMPTIONS.neutralRotationFit.value;
  const weights = plans.map((p) => clippedDays(p.occupancy.from, p.occupancy.to, h.from, h.to));
  const idleDays = horizonDays - coveredDays(plans.map((p) => p.occupancy), h);
  const seq = sequenceScore({ slots: plans.map((_, i) => ({ weightDays: weights[i]!, slotScore: evals[i]!.slotScore })), horizonDays, rotationFit, idleDays });
  const wsum = weights.reduce((a, b) => a + b, 0);
  const wmean = (pick: (e: EvaluatedSlot) => number) => (wsum > 0 ? evals.reduce((s, e, i) => s + weights[i]! * pick(e), 0) / wsum : 0);
  const components: ScoreComponents = { price: round4(clip(wmean((e) => e.price.value), 0, 1)), yield: round4(clip(wmean((e) => e.yield.value), 0, 1)), soilRotation: round4(clip(rotationFit, 0, 1)), water: round4(clip(wmean((e) => e.water.value), 0, 1)), confidence: round4(clip(wmean((e) => e.confidence.value), 0, 1)) };
  const suggested = slots.filter((s) => !s.fixed);
  const reasons = POSITIVE_CODES.filter((c) => suggested.some((s) => s.reasonCodes.includes(c))).slice(0, 3).map((code) => ({ code, text: REASON_TEXT[code] }));
  const sum = (pick: (s: YearPlanSlot) => { low: number; high: number } | null) => (slots.every((s) => pick(s)) ? { low: slots.reduce((a, s) => a + pick(s)!.low, 0), high: slots.reduce((a, s) => a + pick(s)!.high, 0) } : null);
  const totalRevenuePerHa = sum((s) => s.revenuePerHa);
  const totalProfitPerHa = sum((s) => s.profitPerHa);
  const warnings = [...meta.warnings];
  for (const s of slots) {
    if (!s.cost) warnings.push(`${s.cropName}: cost of cultivation not sourced; profit not shown.`);
    if (!s.price || s.price.status !== 'available') warnings.push(`${s.cropName}: no harvest-week price range.`);
    if (!s.yieldKgPerHa) warnings.push(`${s.cropName}: no regional yield for this product form.`);
  }
  if (ctx.fixedSlot && ctx.fixedSlot.harvestBasis !== 'recorded') warnings.push(`${cropName(ctx, ctx.fixedSlot.cropId)}: harvest date not recorded; the field is held until ${ctx.fixedSlot.occupancy.to} as a precaution.`);
  if (!totalRevenuePerHa || !totalProfitPerHa) warnings.push('Plan totals are shown only when every slot has a price, yield and cost.');
  const dominant = (['price', 'yield', 'soilRotation', 'water'] as const).reduce((best, k) => (components[k] > components[best] ? k : best), 'price' as 'price' | 'yield' | 'soilRotation' | 'water');
  const option: YearPlanOption = {
    optionId: `${meta.origin === 'farmer_edit' ? 'edit' : 'opt'}-${shortHash(meta.idSeed)}`, label: DOMINANT_LABEL[dominant], origin: meta.origin, score: seq.score, components,
    slots, idleMonths: Math.round(clip(seq.idleMonths, 0, 12) * 100) / 100, reasons, totalRevenuePerHa, totalProfitPerHa,
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
export const cropSignature = (o: YearPlanOption): string => o.slots.filter((s) => !s.fixed).map((s) => `${s.cropId}/${s.productId}`).join('>');

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
 * Diverse shortlist (spec 4.5): from the top 12 distinct crop sequences by score (date variants of one sequence count
 * once), best overall, best soil enrichment, best water fit and best price, then the next best whose first suggested
 * crop differs from those already picked, then the next best by score until `n`. Each pick is labelled by why it was
 * picked.
 */
export function shortlist(options: readonly YearPlanOption[], n = 8): YearPlanOption[] {
  const top = distinctOptions(options).slice(0, 12);
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
  if (!data.agronomyCrop(e.cropId)) warnings.push(`${name}: no agronomy record; no sourced window or duration.`);
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
  const plan = makeSlotPlan(ctx, {
    key: `edit:${e.cropId}|${e.productId}|${method ?? 'any'}|${e.sowing}|${harvest.latest}`, cropId: e.cropId, productId: e.productId, method: method ?? cls?.method ?? null, sowing: e.sowing, harvest,
    season: hit?.window.season ?? data.seasonOfMonth(monthOf(e.sowing)), durationDays: span, duration: cls, hit,
  });
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
  for (const e of edits) { const p = planEdit(ctx, inputs, e, [], []); if (p) plans.push(p); }
  return collectInputKeys(plans);
}

// ------------------------------------------------------------------ full run

export const ENGINE_LIMITATIONS: readonly string[] = [
  'Yields are regional statistics (district, else state), not predictions for this field.',
  'Prices are wholesale mandi modal references for the harvest weeks of past years, not farm-gate prices or forecasts; no commission or market fee is deducted (not sourced).',
  'Post-harvest losses are not sourced; revenue is not reduced for them.',
  'Water fit compares climatological rain plus an assumed irrigation allowance with the crop water need; it is not a field water balance.',
  'Sowing windows come from 2011 district contingency plans and university season tables; provisional windows are marked.',
  'Rice-fallow relay sowing and perennial crops are not part of annual sequences.',
];

export interface EngineRunOptions { maxSequences?: number | undefined; maxSlots?: number | undefined; keep?: number | undefined; shortlistSize?: number | undefined; candidateSet?: CandidateSet | undefined }
export interface EngineRun { candidateSet: CandidateSet; norm: ScoringNorm; sequencesConsidered: number; options: YearPlanOption[]; shortlist: YearPlanOption[]; limitations: string[] }

/** Keys to prefetch for a run: the fixed slot and every candidate. */
export function runInputKeys(ctx: EngineContext, set: CandidateSet): PriceInputKey[] {
  return collectInputKeys([...(ctx.fixedSlot ? [ctx.fixedSlot] : []), ...set.candidates]);
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
  return { candidateSet: set, norm, sequencesConsidered: sequences.length, options: distinctOptions(options).slice(0, opts.keep ?? 12), shortlist: shortlist(options, opts.shortlistSize ?? 8), limitations };
}
