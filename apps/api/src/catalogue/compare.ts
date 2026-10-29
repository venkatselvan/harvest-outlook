import type { CropRule, Mode, RuleContext, RuleEvaluationResult, RuleField, StageDefinition } from "@harvest/contracts";
import { addDays, calculateScenarios, computeStageWindows, convertDecimal, screenCrop, type VerdictBasis } from "@harvest/domain";
import type { CropProfile, RegionalContext } from "./files";
import type { CatalogueSnapshot } from "./snapshot";

export const DIMENSION_KEYS = ["waterFit", "timeToFirstIncome", "harvestWindows", "evidenceQuality", "marketAccess", "economics"] as const;
export type DimensionKey = (typeof DIMENSION_KEYS)[number];
export const UNSUPPORTED_DIMENSIONS = [
  { key: "budgetFit", missingReason: "no_sourced_cost_of_cultivation_in_catalogue" },
  { key: "labourIntensity", missingReason: "no_sourced_labour_class_in_catalogue" },
] as const;

export interface ComparisonInput {
  location: { stateId: string | null; districtId?: string | null };
  planting: { month: number; date?: string | null };
  irrigation: "rainfed" | "supplemental" | "irrigated" | "unknown";
  soil?: { drainage?: "poor" | "moderate" | "good" | undefined; texture?: string | undefined; ph?: number | undefined } | undefined;
  rainfallSeasonalMm?: number | undefined;
  elevationM?: number | undefined;
  area?: { amount: number; unit: "ha" | "acre" } | null | undefined;
  budgetInrPerHa?: number | null | undefined;
  excludedCropIds?: string[] | undefined;
  assumedPrices?: { productId: string; amountInrPerKg: number; lowInrPerKg?: number | undefined; highInrPerKg?: number | undefined }[] | undefined;
  cropIds?: string[] | undefined;
  weights?: Partial<Record<DimensionKey, number>> | undefined;
}

export type Outcome = "eligible" | "requires_review" | "unknown" | "ineligible" | "excluded_by_farmer";
const OUTCOME_ORDER: Record<Outcome, number> = { eligible: 0, requires_review: 1, unknown: 2, ineligible: 3, excluded_by_farmer: 4 };

export interface Dimension {
  status: "known" | "unknown" | "unavailable";
  value: unknown;
  basis: string | null;
  missingReason: string | null;
  evidenceIds: string[];
}
const known = (value: unknown, basis: string, evidenceIds: string[]): Dimension => ({ status: "known", value, basis, missingReason: null, evidenceIds });
const unknown = (missingReason: string, status: "unknown" | "unavailable" = "unknown"): Dimension => ({ status, value: null, basis: null, missingReason, evidenceIds: [] });

export interface RuleLine {
  ruleId: string;
  /** Engine result: `requires_review` whenever truth is unknown, whatever the rule's own effect. */
  effect: string;
  /** F4: the rule's declared effect (eligible, ineligible, prefer, caution, requires_review). */
  ruleEffect: string;
  truth: string;
  reasonCodes: string[];
  appliedExceptionId: string | null;
  reviewStatus: string;
  reviewer: string | null;
  regionIds: string[];
  evidenceIds: string[];
  unknownFields: RuleField[];
}

export interface UnresolvedConditionLine {
  field: RuleField;
  ruleId: string;
  exceptionId: string | null;
  effectIfTrue: string;
  evidenceIds: string[];
  why: string | null;
}

export interface CompareItem {
  rank: number;
  cropId: string;
  productId: string;
  cropName: string;
  productName: string;
  productBasis: string;
  group: string;
  localNames: string[];
  outcome: Outcome;
  screening: {
    reasons: RuleLine[];
    unknownFields: RuleField[];
    appliedRuleIds: string[];
    evidenceIds: string[];
    candidateRuleIds: string[];
    noApplicableRule: boolean;
    /** F4 additions (additive): why the outcome is what it is, and the soft conditions left open. */
    verdictBasis: VerdictBasis;
    unresolvedConditions: UnresolvedConditionLine[];
    confidenceNote: { resolvedRules: number; unresolvedRules: number; unresolvedFields: number; text: string };
  };
  context: { contextId: string; regionIds: string[]; season: string; irrigation: string; regionMatch: "state_or_region" | "national"; plantingMonthInWindow: boolean } | null;
  referenceContexts: { contextId: string; regionIds: string[]; season: string; note: string }[];
  season: string | null;
  plantingWindow: { fromMonth: number; toMonth: number; evidenceIds: string[] } | null;
  repeatedPicking: boolean | null;
  harvestPattern: string | null;
  dimensions: Record<DimensionKey, Dimension>;
  completeness: { known: number; total: number };
  yieldReference: { minKgPerHa: number; maxKgPerHa: number; basis: string; productId: string; appliesToProduct: boolean; label: string; evidenceIds: string[] } | null;
  costBasis: { state: "unavailable"; label: string };
  priceReference: { state: "unavailable"; label: string; missingReason: string };
  downside: { computable: boolean; text: string };
  mostConsequentialMissingInput: { field: string; why: string } | null;
  evidenceCoverage: { sourcedRequirements: number; evidenceRecords: number; validationPending: boolean };
}

export interface ComparisonOutput {
  asOf: string;
  mode: Mode;
  input: ComparisonInput & { resolvedContext: RuleContext };
  rulePolicy: { executed: string[]; candidateRulesExecuted: boolean };
  dimensionKeys: readonly DimensionKey[];
  unsupportedDimensions: typeof UNSUPPORTED_DIMENSIONS;
  weightsUsed: Record<DimensionKey, number>;
  rankingBasis: string;
  items: CompareItem[];
  counts: Record<Outcome, number>;
}

const monthIn = (m: number, from: number, to: number) => (from <= to ? m >= from && m <= to : m >= from || m <= to);
const MISSING_WHY: Record<string, string> = {
  "irrigation.category": "Whether the field is rainfed, supplementally or fully irrigated decides which sourced planting window and water condition applies.",
  "soil.drainage": "Poor drainage is a documented risk for several crops (for example soft rot in ginger); it is not known for this field.",
  "rainfall.seasonalMm": "Seasonal rainfall decides whether rainfed cultivation meets the source's stated requirement.",
  "elevation.m": "The source gives an elevation range; the field elevation is not known.",
  "location.districtId": "A district can carry a regional exception to a state-wide rule.",
  "location.stateId": "Sourced planting windows are state or region specific.",
  "soil.texture": "Soil texture is used by soil preference rules.",
  "planting.month": "Sourced planting windows are stated by month.",
  season: "Some rules are scoped to a season.",
  assumed_price: "No price access is available; supplying your own assumed price enables a gross harvest value range.",
  regional_context: "No sourced planting context covers this state; the crop cannot be screened locally.",
};
const MISSING_PRIORITY = ["location.stateId", "irrigation.category", "soil.drainage", "rainfall.seasonalMm", "elevation.m", "location.districtId", "soil.texture"];

export function buildRuleContext(i: ComparisonInput): RuleContext {
  const ctx: RuleContext = {
    location: { stateId: i.location.stateId, districtId: i.location.districtId ?? null },
    planting: { month: i.planting.month, date: i.planting.date ?? null },
    irrigation: { category: i.irrigation === "unknown" ? null : i.irrigation },
  };
  if (i.soil) ctx.soil = { drainage: i.soil.drainage ?? null, texture: (i.soil.texture as never) ?? null, ph: i.soil.ph ?? null };
  if (i.rainfallSeasonalMm !== undefined) ctx.rainfall = { seasonalMm: i.rainfallSeasonalMm };
  if (i.elevationM !== undefined) ctx.elevation = { m: i.elevationM };
  if (i.area) ctx.farm = { areaHa: convertDecimal(i.area.amount, i.area.unit, "ha").toNumber() };
  if (i.budgetInrPerHa != null) ctx.budget = { inrPerHa: i.budgetInrPerHa };
  return ctx;
}

function regionMatch(c: RegionalContext, loc: ComparisonInput["location"]): "state_or_region" | "national" | null {
  if (loc.stateId && c.geography.ids.includes(loc.stateId)) return "state_or_region";
  if (c.geography.ids.includes("IN")) return "national";
  return null;
}

function pickContext(profile: CropProfile, input: ComparisonInput) {
  let best: { c: RegionalContext; match: "state_or_region" | "national"; score: number } | null = null;
  for (const c of profile.regionalContexts) {
    const match = regionMatch(c, input.location);
    if (!match) continue;
    let score = match === "state_or_region" ? 10 : 0;
    if (monthIn(input.planting.month, c.plantingWindow.fromMonth, c.plantingWindow.toMonth)) score += 4;
    if (input.irrigation === "unknown") score += 1;
    else if (c.irrigation === input.irrigation) score += 2;
    else if (c.irrigation === "any" || c.irrigation === "unspecified") score += 1;
    if (!best || score > best.score) best = { c, match, score };
  }
  return best;
}

/** Executable rule set. Approved rules run in any mode; candidates only in synthetic mode, relabelled as synthetic. */
export function executableRules(entries: CatalogueSnapshot["rules"], mode: Mode): { rules: CropRule[]; reviewOf: Map<string, { status: string; reviewer: string | null; sourceId: string }>; candidateIds: Set<string> } {
  const rules: CropRule[] = [];
  const reviewOf = new Map<string, { status: string; reviewer: string | null; sourceId: string }>();
  const candidateIds = new Set<string>();
  for (const { rule, reviewer, sourceId } of entries) {
    reviewOf.set(rule.id, { status: rule.reviewStatus, reviewer, sourceId });
    // T05b product ids (`ginger.fresh`) -> catalogue ids (`ginger-fresh`); only consulted for scope.productSpecific rules.
    const productId = rule.productId == null ? rule.productId : rule.productId.replace(".", "-");
    if (rule.reviewStatus === "approved") rules.push({ ...rule, productId, mode });
    else if (rule.reviewStatus === "candidate" && mode === "synthetic") {
      candidateIds.add(rule.id);
      rules.push({ ...rule, productId, mode, reviewStatus: "synthetic" });
    }
  }
  return { rules, reviewOf, candidateIds };
}

const nominalDate = (month: number, now: Date): string => {
  const y = now.getUTCMonth() + 1 <= month ? now.getUTCFullYear() : now.getUTCFullYear() + 1;
  return `${y}-${String(month).padStart(2, "0")}-01`;
};

function stagesFor(snap: CatalogueSnapshot, cropId: string, input: ComparisonInput): StageDefinition[] {
  const hit = snap.stages.filter((s) => s.cropId === cropId && s.scope.ids.some((id) => id === input.location.districtId || id === input.location.stateId));
  if (!hit.length) return [];
  const byScope = new Map<string, StageDefinition[]>();
  for (const s of hit) byScope.set(s.scope.ids.join(","), [...(byScope.get(s.scope.ids.join(",")) ?? []), s]);
  return [...byScope.values()][0]!.sort((a, b) => a.order - b.order);
}

function waterFit(c: RegionalContext | null, irrigation: ComparisonInput["irrigation"]): Dimension {
  if (!c) return unknown("no_sourced_context_for_region");
  if (irrigation === "unknown") return unknown("farmer_irrigation_unknown");
  if (c.waterNeedClass) {
    const need = c.waterNeedClass.class;
    const v = need === "low" ? "matches" : need === "medium" ? (irrigation === "rainfed" ? "partial" : "matches") : irrigation === "irrigated" ? "matches" : irrigation === "supplemental" ? "partial" : "mismatch";
    return known({ fit: v, waterNeedClass: need, farmerIrrigation: irrigation }, "water_need_class", c.waterNeedClass.evidenceIds);
  }
  if (c.irrigation === "any" || c.irrigation === "unspecified") return unknown("source_does_not_state_irrigation_condition");
  const v = c.irrigation === irrigation ? "matches" : c.irrigation === "irrigated" && irrigation !== "irrigated" ? "mismatch" : "partial";
  return known({ fit: v, sourceContextIrrigation: c.irrigation, farmerIrrigation: irrigation }, "source_context_irrigation_not_water_requirement", c.irrigationEvidenceIds);
}

export function compareCrops(snap: CatalogueSnapshot, input: ComparisonInput, opts: { mode: Mode; now?: Date }): ComparisonOutput {
  const now = opts.now ?? new Date();
  const ruleCtx = buildRuleContext(input);
  const { rules, reviewOf, candidateIds } = executableRules(snap.rules, opts.mode);
  const weights = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, input.weights?.[k] ?? 1])) as Record<DimensionKey, number>;
  const plantingDate = input.planting.date ?? nominalDate(input.planting.month, now);
  const plantingDateBasis = input.planting.date ? "farmer_date" : "first_of_month_assumed";
  const priceFor = (productId: string) => input.assumedPrices?.find((p) => p.productId === productId);
  const excluded = new Set(input.excludedCropIds ?? []);
  const items: CompareItem[] = [];

  for (const profile of snap.profiles) {
    if (input.cropIds?.length && !input.cropIds.includes(profile.cropId)) continue;
    const identity = snap.identities.find((i) => i.id === profile.cropId);
    const picked = pickContext(profile, input);
    const ctx = picked?.c ?? null;
    const stages = stagesFor(snap, profile.cropId, input);
    for (const prod of profile.products) {
      // Product scoping and region exclusion are decided by the engine (agronomic rules apply to every product of the crop).
      const cropRules = rules.filter((r) => r.cropId === profile.cropId);
      const sc = screenCrop(profile.cropId, cropRules, ruleCtx, { mode: opts.mode, productId: prod.productId });
      const applied = sc.results.filter((r: RuleEvaluationResult) => r.effect !== "not_applicable");
      const lines: RuleLine[] = applied.map((r) => {
        const rule = cropRules.find((x) => x.id === r.ruleId)!;
        const rv = reviewOf.get(r.ruleId);
        return {
          ruleId: r.ruleId, effect: r.effect, ruleEffect: rule.effect.type, truth: r.truth, reasonCodes: r.reasons.map((x) => x.reasonCode), appliedExceptionId: r.appliedExceptionId,
          reviewStatus: rv?.status ?? "unknown", reviewer: rv?.reviewer ?? null, regionIds: rule.scope.regionIds, evidenceIds: rule.evidenceIds, unknownFields: r.unknownFields,
        };
      });
      const noApplicableRule = applied.length === 0;
      const outcome: Outcome = excluded.has(profile.cropId) ? "excluded_by_farmer" : sc.outcome;

      // ---- dimensions
      const dims = {} as Record<DimensionKey, Dimension>;
      dims.waterFit = waterFit(ctx, input.irrigation);
      let durMin: number | null = null;
      let durMax: number | null = null;
      let durBasis = "";
      let durEvidence: string[] = [];
      if (stages.length) {
        const pre = stages.filter((s) => !s.isHarvest);
        durMin = pre.reduce((a, s) => a + s.durationDays.min, 0);
        durMax = pre.reduce((a, s) => a + s.durationDays.max, 0);
        durBasis = "stage_definitions_sum_to_harvest_open";
        durEvidence = [...new Set(stages.flatMap((s) => s.evidenceIds))];
      } else if (ctx?.durationDays) {
        durMin = ctx.durationDays.min;
        durMax = ctx.durationDays.max;
        durBasis = "crop_duration_in_sourced_context";
        durEvidence = ctx.durationDays.evidenceIds;
      }
      dims.timeToFirstIncome =
        durMin !== null
          ? known({ minDays: durMin, maxDays: durMax, note: "Crop duration to harvest; first picking of a repeated-picking crop can come earlier." }, durBasis, durEvidence)
          : unknown(ctx ? (ctx.durationDays ? "only_an_upper_bound_is_published" : "no_sourced_duration_in_context") : "no_sourced_context_for_region");
      const repeated = ctx ? ctx.harvestPattern === "repeated_picking" : null;
      if (durMin !== null && durMax !== null) {
        let earliest: string, latest: string;
        const w = stages.length ? computeStageWindows(stages, { earliest: plantingDate, latest: plantingDate }) : null;
        if (w && w.status === "ok" && w.harvestWindows[0]) {
          earliest = w.harvestWindows[0].earliestStart;
          latest = addDays(plantingDate, durMax);
        } else {
          earliest = addDays(plantingDate, durMin);
          latest = addDays(plantingDate, durMax);
        }
        dims.harvestWindows = known({ earliest, latest, repeatedPicking: repeated, plantingDate, plantingDateBasis, note: "Harvest opens at the earliest date; it may continue after the latest date." }, durBasis, durEvidence);
      } else dims.harvestWindows = unknown(durMin === null ? "duration_unknown" : "duration_upper_or_lower_bound_missing");
      const sourced = ctx ? [ctx.plantingWindow.evidenceIds.length > 0, !!ctx.durationDays, !!ctx.soilNotes, ctx.irrigationEvidenceIds.length > 0, !!ctx.yieldReference].filter(Boolean).length : 0;
      const ctxEvidence = ctx ? [...new Set([...ctx.plantingWindow.evidenceIds, ...(ctx.durationDays?.evidenceIds ?? []), ...(ctx.soilNotes?.evidenceIds ?? []), ...ctx.irrigationEvidenceIds, ...(ctx.yieldReference?.evidenceIds ?? [])])] : [];
      const pending = ctxEvidence.some((id) => snap.evidence.get(id)?.validationStatus !== "validated");
      dims.evidenceQuality = known({ sourcedRequirements: sourced, of: 5, evidenceRecords: ctxEvidence.length, validationPending: ctx ? pending : true, regionalContext: ctx !== null }, "count_of_sourced_requirements_in_context", ctxEvidence);
      dims.marketAccess = unknown("price_access_key_gated", "unavailable");

      // ---- yield and economics
      const y = ctx?.yieldReference ?? null;
      const yieldApplies = !!y && y.productId === prod.productId;
      const price = priceFor(prod.productId);
      let downside = { computable: false, text: "" };
      if (y && yieldApplies && price) {
        const central = (y.min + y.max) / 2;
        const area = input.area ?? null;
        const res = calculateScenarios({
          schemaVersion: "1.0", productId: prod.productId, area: area ? { amount: area.amount, unit: area.unit } : null,
          yield: { productBasis: prod.productBasis, unit: "kg/ha", amount: { low: y.min, central, high: y.max }, evidenceState: "derived", evidenceIds: y.evidenceIds },
          marketableFraction: { low: 1, central: 1, high: 1 },
          harvests: [{ periodId: "h1", period: { start: plantingDate, end: plantingDate }, shareOfYield: 1 }],
          prices: [{ periodId: "h1", productBasis: prod.productBasis, unit: "INR/kg", amount: { low: price.lowInrPerKg ?? price.amountInrPerKg, central: price.amountInrPerKg, high: price.highInrPerKg ?? price.amountInrPerKg }, evidenceState: "farmer_reported", marketId: null, evidenceIds: [] }],
          conversion: null,
          costs: { cashProduction: null, harvest: null, saleAndTransport: null, fullEconomic: null },
          unpricedItems: ["cash_production_cost", "harvest_cost", "sale_and_transport_cost", "full_economic_cost"],
        });
        if (res.scenarios.length) {
          const scenarios = res.scenarios.map((s) => ({ name: s.name, grossHarvestValueInrPerHa: s.perHa.grossRevenueInr, marketableKgPerHa: s.perHa.marketableKgTotal, totalGrossInr: s.total?.grossRevenueInr ?? null }));
          dims.economics = known(
            { scenarios, netReturn: "unavailable_costs_not_sourced", status: res.status, missingInputs: res.missingInputs, assumptions: [...res.assumptions, "Marketable fraction assumed 1 (no harvest or grading loss); this is an assumption, not a sourced value.", "Price is the farmer's own assumption, not a market observation."], methodVersion: res.methodVersion },
            "farmer_assumed_price_times_source_yield_reference", y.evidenceIds,
          );
          const low = scenarios.find((s) => s.name === "low")!;
          downside = { computable: true, text: `Low scenario: ${y.min} kg/ha at INR ${price.lowInrPerKg ?? price.amountInrPerKg}/kg gives a gross harvest value of INR ${low.grossHarvestValueInrPerHa} per ha before any cost. Costs are not sourced, so net return is not computed.` };
        } else dims.economics = unknown(`economics_${res.status}`);
      } else {
        dims.economics = unknown(!y ? "no_sourced_yield_reference" : !yieldApplies ? "yield_basis_differs_from_product_conversion_not_sourced" : "no_price_supplied_and_price_access_pending");
        downside = {
          computable: false,
          text: y && yieldApplies ? `A downside scenario needs a price. Source yield reference spans ${y.min}-${y.max} kg/ha; no price series is available, and no price was supplied.` : "A downside scenario is not computable: no yield reference for this product in the matching context.",
        };
      }

      const completenessKnown = DIMENSION_KEYS.filter((k) => dims[k].status === "known").length;
      const unknownCounts = new Map<string, number>();
      for (const f of sc.unknownFields) unknownCounts.set(f, (unknownCounts.get(f) ?? 0) + 1);
      let missing: CompareItem["mostConsequentialMissingInput"] = null;
      const pickF = MISSING_PRIORITY.find((f) => unknownCounts.has(f));
      if (!ctx && outcome !== "excluded_by_farmer") missing = { field: "regional_context", why: MISSING_WHY.regional_context! };
      else if (pickF) missing = { field: pickF, why: MISSING_WHY[pickF]! };
      else if (dims.economics.status !== "known") missing = { field: "assumed_price", why: MISSING_WHY.assumed_price! };

      items.push({
        rank: 0, cropId: profile.cropId, productId: prod.productId,
        cropName: identity?.commonNames[0]?.text ?? profile.cropId, productName: prod.name, productBasis: prod.productBasis, group: profile.group,
        localNames: (identity?.aliases ?? []).filter((a) => a.kind === "local" || a.kind === "market").map((a) => a.text),
        outcome,
        screening: { reasons: lines, unknownFields: sc.unknownFields, appliedRuleIds: lines.map((l) => l.ruleId), evidenceIds: [...new Set(lines.flatMap((l) => l.evidenceIds))], candidateRuleIds: lines.map((l) => l.ruleId).filter((id) => candidateIds.has(id)), noApplicableRule,
          verdictBasis: sc.verdictBasis,
          unresolvedConditions: sc.unresolvedConditions.map((u) => ({ ...u, why: MISSING_WHY[u.field] ?? null })),
          confidenceNote: sc.confidenceNote,
        },
        context: ctx && picked ? { contextId: ctx.contextId, regionIds: ctx.geography.ids, season: ctx.season, irrigation: ctx.irrigation, regionMatch: picked.match, plantingMonthInWindow: monthIn(input.planting.month, ctx.plantingWindow.fromMonth, ctx.plantingWindow.toMonth) } : null,
        referenceContexts: ctx ? [] : profile.regionalContexts.map((c) => ({ contextId: c.contextId, regionIds: c.geography.ids, season: c.season, note: "Sourced for another region; not applied to this location." })),
        season: ctx?.season ?? null,
        plantingWindow: ctx ? { fromMonth: ctx.plantingWindow.fromMonth, toMonth: ctx.plantingWindow.toMonth, evidenceIds: ctx.plantingWindow.evidenceIds } : null,
        repeatedPicking: repeated, harvestPattern: ctx?.harvestPattern ?? null,
        dimensions: dims, completeness: { known: completenessKnown, total: DIMENSION_KEYS.length },
        yieldReference: y ? { minKgPerHa: y.min, maxKgPerHa: y.max, basis: y.basis, productId: y.productId, appliesToProduct: yieldApplies, label: yieldApplies ? "Source-backed regional or varietal reference, not a farm yield" : `Reference is for ${y.productId}; not applied to ${prod.productId} (no sourced conversion)`, evidenceIds: y.evidenceIds } : null,
        costBasis: { state: "unavailable", label: "Cost of cultivation: not sourced in the catalogue" },
        priceReference: { state: "unavailable", label: "Unavailable — price access pending", missingReason: "price_access_key_gated" },
        downside, mostConsequentialMissingInput: missing,
        evidenceCoverage: { sourcedRequirements: sourced, evidenceRecords: ctxEvidence.length, validationPending: pending },
      });
    }
  }

  // ---- ranking: outcome, then completeness, then weighted score over known numeric dimensions (tie-break only)
  const mins = items.map((i) => (i.dimensions.timeToFirstIncome.status === "known" ? (i.dimensions.timeToFirstIncome.value as { minDays: number }).minDays : null)).filter((x): x is number => x !== null);
  const lo = Math.min(...mins);
  const hi = Math.max(...mins);
  const score = (i: CompareItem): number => {
    let num = 0;
    let den = 0;
    const w = i.dimensions.waterFit;
    if (w.status === "known") { num += weights.waterFit * ({ matches: 1, partial: 0.5, mismatch: 0 }[(w.value as { fit: "matches" | "partial" | "mismatch" }).fit]); den += weights.waterFit; }
    const t = i.dimensions.timeToFirstIncome;
    if (t.status === "known") { num += weights.timeToFirstIncome * (hi === lo ? 1 : 1 - ((t.value as { minDays: number }).minDays - lo) / (hi - lo)); den += weights.timeToFirstIncome; }
    const e = i.dimensions.evidenceQuality;
    if (e.status === "known") { num += weights.evidenceQuality * ((e.value as { sourcedRequirements: number }).sourcedRequirements / 5); den += weights.evidenceQuality; }
    return den === 0 ? 0 : num / den;
  };
  items.sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome] || b.completeness.known - a.completeness.known || score(b) - score(a) || a.cropName.localeCompare(b.cropName) || a.productId.localeCompare(b.productId));
  items.forEach((i, k) => (i.rank = k + 1));
  const counts = { eligible: 0, requires_review: 0, unknown: 0, ineligible: 0, excluded_by_farmer: 0 } as Record<Outcome, number>;
  for (const i of items) counts[i.outcome]++;
  return {
    asOf: now.toISOString(), mode: opts.mode,
    input: { ...input, resolvedContext: ruleCtx },
    rulePolicy: { executed: ["approved"].concat(opts.mode === "synthetic" ? ["candidate (synthetic mode only)"] : []), candidateRulesExecuted: opts.mode === "synthetic" },
    dimensionKeys: DIMENSION_KEYS, unsupportedDimensions: UNSUPPORTED_DIMENSIONS, weightsUsed: weights,
    rankingBasis: "Screening outcome first, then number of known dimensions, then a weighted mean over known water-fit, time and evidence-quality values (tie-break only; not shown as a score). Unknown dimensions are never scored as zero.",
    items, counts,
  };
}
