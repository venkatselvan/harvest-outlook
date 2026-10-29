import {
  NATIONAL_REGION_ID,
  RULE_FIELD_TYPES,
  type Condition,
  type CropRule,
  type Mode,
  type RuleContext,
  type RuleEvaluationResult,
  type RuleField,
  type RuleReason,
  type ScreeningOutcome,
  type Truth,
} from '@harvest/contracts';

/**
 * Three-valued (Kleene) rule evaluation.
 *
 * - A missing/null context field makes a leaf UNKNOWN (except `known`, which is
 *   always decidable).
 * - all: false if any false, else unknown if any unknown, else true.
 * - any: true if any true, else unknown if any unknown, else false.
 * - not: swaps true/false, keeps unknown.
 * - Exceptions are ordered by precedence. The first TRUE exception overrides the
 *   rule effect, unless an earlier exception is UNKNOWN (then requires_review).
 *   Any UNKNOWN exception with no earlier TRUE one also yields requires_review,
 *   because the exception might apply.
 * - UNKNOWN applicability never yields eligible or ineligible; it yields
 *   requires_review with truth unknown. That per-rule requires_review is not an
 *   escalation by itself: screenCrop decides from the rule's declared effect
 *   whether an unknown rule blocks the verdict (HARD) or is listed as an
 *   unresolved condition (SOFT).
 */
export interface Evaluation {
  truth: Truth;
  unknownFields: RuleField[];
}

export function readField(ctx: RuleContext, field: RuleField): unknown {
  let cur: unknown = ctx;
  for (const part of field.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function cmp(a: unknown, b: number | string): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

export class RuleTypeError extends Error {}

function leafTruth(c: Exclude<Condition, { all: Condition[] } | { any: Condition[] } | { not: Condition }>, ctx: RuleContext): Evaluation {
  if (!(c.field in RULE_FIELD_TYPES)) throw new RuleTypeError(`field not allowlisted: ${c.field}`);
  const v = readField(ctx, c.field);
  // Weather values only count when observed or forecast; scenario/illustrative/derived/unavailable/etc. are not proof.
  const weatherState = ctx.weather?.evidenceState ?? null;
  const weatherUnproven = c.field.startsWith('weather.') && weatherState !== 'observed' && weatherState !== 'forecast';
  const missing = v === null || v === undefined || weatherUnproven;
  if (c.op === 'known') {
    const t = !missing === c.value;
    return { truth: t ? 'true' : 'false', unknownFields: [] };
  }
  if (missing) return { truth: 'unknown', unknownFields: [c.field] };
  const tf = (b: boolean): Evaluation => ({ truth: b ? 'true' : 'false', unknownFields: [] });
  const order = (b: number | string) => {
    const r = cmp(v, b);
    if (r === null) throw new RuleTypeError(`type mismatch comparing ${c.field}`);
    return r;
  };
  switch (c.op) {
    case 'eq':
      return tf(v === c.value);
    case 'in':
      return tf(c.value.some((x) => x === v));
    case 'gte':
      return tf(order(c.value) >= 0);
    case 'lte':
      return tf(order(c.value) <= 0);
    case 'between':
      return tf(order(c.value[0]) >= 0 && order(c.value[1]) <= 0);
  }
}

export function evaluateCondition(c: Condition, ctx: RuleContext): Evaluation {
  if ('all' in c) {
    const parts = c.all.map((x) => evaluateCondition(x, ctx));
    if (parts.some((p) => p.truth === 'false')) return { truth: 'false', unknownFields: [] };
    return combineUnknown(parts, 'true');
  }
  if ('any' in c) {
    const parts = c.any.map((x) => evaluateCondition(x, ctx));
    if (parts.some((p) => p.truth === 'true')) return { truth: 'true', unknownFields: [] };
    return combineUnknown(parts, 'false');
  }
  if ('not' in c) {
    const r = evaluateCondition(c.not, ctx);
    return { truth: r.truth === 'true' ? 'false' : r.truth === 'false' ? 'true' : 'unknown', unknownFields: r.unknownFields };
  }
  return leafTruth(c, ctx);
}

function combineUnknown(parts: Evaluation[], otherwise: Truth): Evaluation {
  const unknown = parts.filter((p) => p.truth === 'unknown');
  if (unknown.length > 0) return { truth: 'unknown', unknownFields: uniq(unknown.flatMap((p) => p.unknownFields)) };
  return { truth: otherwise, unknownFields: [] };
}

function and(a: Evaluation, b: Evaluation): Evaluation {
  return evaluateParts([a, b]);
}
function evaluateParts(parts: Evaluation[]): Evaluation {
  if (parts.some((p) => p.truth === 'false')) return { truth: 'false', unknownFields: [] };
  return combineUnknown(parts, 'true');
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

const STATE_ID = /^in-[a-z]{2}$/;
const DISTRICT_ID = /^(in-[a-z]{2})-.+$/;

/** Region-id options. `regionAliases` maps other spellings (e.g. `IN-KA-HAS`) to registry ids (`IN-KA-hassan`). */
export interface RegionOptions {
  regionAliases?: Readonly<Record<string, string>> | undefined;
}

/**
 * Canonical comparison key for a region id (F8, review R3a #9): trimmed and lower-cased; the farm form's
 * typed district `typed:KA:hassan` becomes `in-ka-hassan`; a bare state code `KA` becomes `in-ka`; then
 * an alias from the caller's registry is applied (aliases are never guessed: `IN-KA-HAS` only maps to
 * `IN-KA-hassan` when the registry says so).
 */
export function canonicalRegionId(id: string, opts: RegionOptions = {}): string {
  let c = id.trim().toLowerCase();
  const typed = /^typed:([a-z]{2}):(.+)$/.exec(c);
  if (typed) c = `in-${typed[1]}-${typed[2]}`;
  else if (/^[a-z]{2}$/.test(c) && c !== 'in') c = `in-${c}`;
  const aliases = opts.regionAliases;
  if (aliases) {
    for (const [from, to] of Object.entries(aliases)) {
      if (from.trim().toLowerCase() === c) return canonicalRegionId(to, {});
    }
  }
  return c;
}
const T: Evaluation = { truth: 'true', unknownFields: [] };
const F: Evaluation = { truth: 'false', unknownFields: [] };

/**
 * Region applicability, three-valued (see NATIONAL_REGION_ID in contracts):
 * - `IN` matches any location; an id equal to the farm's district or state matches.
 * - `IN-XX` (state) can only match the state: false when the state is known and differs.
 * - `IN-XX-name` (district) can only match the district: false when the district is known
 *   and differs, or when the farm's state is known and is not `IN-XX` (district lists that
 *   exclude the farm's district therefore do not apply).
 * - Other ids (agro-region, synthetic) are opaque: false only when district and state are both known.
 * A district id `IN-XX-name` in the context implies state `IN-XX` when stateId is missing.
 * Any id true -> true; else any unknown -> unknown; else false.
 */
export function regionApplies(regionIdsIn: string[], location: RuleContext['location'], opts: RegionOptions = {}): Evaluation {
  const national = NATIONAL_REGION_ID.toLowerCase();
  const regionIds = regionIdsIn.map((x) => canonicalRegionId(x, opts));
  if (regionIds.includes(national)) return T;
  const d = location?.districtId != null ? canonicalRegionId(location.districtId, opts) : null;
  const s = location?.stateId != null ? canonicalRegionId(location.stateId, opts) : d !== null ? (DISTRICT_ID.exec(d)?.[1] ?? null) : null;
  const per = regionIds.map((id): Evaluation => {
    if (id === d || id === s) return T;
    if (STATE_ID.test(id)) return s !== null ? F : { truth: 'unknown', unknownFields: ['location.stateId'] };
    const dm = DISTRICT_ID.exec(id);
    if (dm) {
      if (d !== null) return F;
      if (s !== null && STATE_ID.test(s) && s !== dm[1]) return F;
      return { truth: 'unknown', unknownFields: s === null ? ['location.districtId', 'location.stateId'] : ['location.districtId'] };
    }
    if (d !== null && s !== null) return F;
    const unk: RuleField[] = [];
    if (d === null) unk.push('location.districtId');
    if (s === null) unk.push('location.stateId');
    return { truth: 'unknown', unknownFields: unk };
  });
  if (per.some((p) => p.truth === 'true')) return T;
  return combineUnknown(per, 'false');
}

/** Scope applicability: region AND season AND irrigation, each three-valued. */
export function scopeApplies(rule: CropRule, ctx: RuleContext, opts: RegionOptions = {}): Evaluation {
  const region = regionApplies(rule.scope.regionIds, ctx.location, opts);
  const season: Evaluation =
    rule.scope.seasons.length === 0
      ? T
      : ctx.season == null
        ? { truth: 'unknown', unknownFields: ['season'] }
        : { truth: rule.scope.seasons.includes(ctx.season) ? 'true' : 'false', unknownFields: [] };
  const irr: Evaluation =
    rule.scope.irrigation.length === 0
      ? T
      : ctx.irrigation?.category == null
        ? { truth: 'unknown', unknownFields: ['irrigation.category'] }
        : { truth: rule.scope.irrigation.includes(ctx.irrigation.category) ? 'true' : 'false', unknownFields: [] };
  return evaluateParts([region, season, irr]);
}

/**
 * Product scoping. Rules are agronomic (crop-wide) unless `scope.productSpecific` is true; only then
 * does `productId` restrict the rule to that product. With no product requested every rule of the crop applies.
 */
export function ruleAppliesToProduct(rule: CropRule, productId: string | null | undefined): boolean {
  if (productId == null || rule.productId == null) return true;
  if (rule.scope.productSpecific !== true) return true;
  return rule.productId === productId;
}

/** A rule may execute only if approved, or synthetic in synthetic mode. */
export function ruleExecutable(rule: CropRule, mode: Mode): { ok: true } | { ok: false; reasonCode: string } {
  if (rule.reviewStatus === 'disabled') return { ok: false, reasonCode: 'rule_disabled' };
  if (rule.mode !== mode) return { ok: false, reasonCode: 'rule_mode_mismatch' };
  if (rule.reviewStatus === 'candidate') return { ok: false, reasonCode: 'rule_not_approved' };
  if (rule.reviewStatus === 'synthetic' && mode !== 'synthetic') return { ok: false, reasonCode: 'synthetic_rule_outside_synthetic_mode' };
  return { ok: true };
}

/** True when a condition tree contains the `known` operator. */
export function conditionUsesKnown(c: Condition): boolean {
  if ('all' in c) return c.all.some(conditionUsesKnown);
  if ('any' in c) return c.any.some(conditionUsesKnown);
  if ('not' in c) return conditionUsesKnown(c.not);
  return c.op === 'known';
}

/**
 * F8 (review R3a #10): `known` makes missing data decidable, so a rule that can produce a HARD effect
 * (its own effect or any exception's) must not use it anywhere: an unknown input would otherwise decide
 * eligibility. Returns the offending locations (empty = acceptable). Enforced at catalogue load and,
 * by default, at evaluation (the rule is then not executable).
 */
export function knownInHardRule(rule: CropRule): string[] {
  const hard = isHard(rule.effect.type) || rule.exceptions.some((e) => isHard(e.effect.type));
  if (!hard) return [];
  const out: string[] = [];
  if (conditionUsesKnown(rule.when)) out.push(`${rule.id}.when`);
  for (const e of rule.exceptions) if (conditionUsesKnown(e.when)) out.push(`${rule.id}.exceptions.${e.id}`);
  return out;
}

export interface EvaluateOptions extends RegionOptions {
  mode: Mode;
  /** Escape hatch for tests of legacy data only; default false (guard on). */
  allowKnownInHardRules?: boolean | undefined;
}

export function evaluateRule(rule: CropRule, ctx: RuleContext, opts: EvaluateOptions): RuleEvaluationResult {
  const base = { ruleId: rule.id, ruleVersion: rule.version, cropId: rule.cropId };
  const exec = ruleExecutable(rule, opts.mode);
  if (!exec.ok) {
    return { ...base, truth: 'false', effect: 'not_applicable', reasons: [{ reasonCode: exec.reasonCode, source: 'gate' }], unknownFields: [], appliedExceptionId: null };
  }
  if (opts.allowKnownInHardRules !== true && knownInHardRule(rule).length > 0) {
    return { ...base, truth: 'false', effect: 'not_applicable', reasons: [{ reasonCode: 'known_operator_in_hard_rule', source: 'gate' }], unknownFields: [], appliedExceptionId: null };
  }
  const applies = and(scopeApplies(rule, ctx, opts), evaluateCondition(rule.when, ctx));
  if (applies.truth === 'false') {
    return { ...base, truth: 'false', effect: 'not_applicable', reasons: [], unknownFields: [], appliedExceptionId: null };
  }

  // Exceptions are evaluated whenever the rule might apply.
  const unknownFields: RuleField[] = [...applies.unknownFields];
  let unresolved: RuleReason[] = [];
  for (const ex of rule.exceptions) {
    const r = evaluateCondition(ex.when, ctx);
    if (r.truth === 'true' && unresolved.length === 0) {
      if (applies.truth === 'true') {
        return { ...base, truth: 'true', effect: ex.effect.type, reasons: [{ reasonCode: ex.effect.reasonCode, source: 'exception', exceptionId: ex.id }], unknownFields: [], appliedExceptionId: ex.id };
      }
      // Rule applicability unknown but exception holds: still unresolved overall.
      return {
        ...base,
        truth: 'unknown',
        effect: 'requires_review',
        reasons: [
          { reasonCode: rule.effect.reasonCode, source: 'unknown_condition' },
          { reasonCode: ex.effect.reasonCode, source: 'exception', exceptionId: ex.id },
        ],
        unknownFields: uniq(unknownFields),
        appliedExceptionId: null,
      };
    }
    if (r.truth === 'unknown') {
      unresolved = [...unresolved, { reasonCode: ex.effect.reasonCode, source: 'unresolved_exception', exceptionId: ex.id }];
      unknownFields.push(...r.unknownFields);
    }
  }

  if (applies.truth === 'unknown' || unresolved.length > 0) {
    const reasons: RuleReason[] = [{ reasonCode: rule.effect.reasonCode, source: applies.truth === 'unknown' ? 'unknown_condition' : 'rule' }, ...unresolved];
    return { ...base, truth: 'unknown', effect: 'requires_review', reasons, unknownFields: uniq(unknownFields), appliedExceptionId: null };
  }
  return { ...base, truth: 'true', effect: rule.effect.type, reasons: [{ reasonCode: rule.effect.reasonCode, source: 'rule' }], unknownFields: [], appliedExceptionId: null };
}

/** HARD effects decide eligibility; SOFT effects annotate it (requires_review only escalates when true). */
export const HARD_EFFECTS = ['eligible', 'ineligible'] as const;
const isHard = (e: string) => e === 'eligible' || e === 'ineligible';

/** An applicable input that is not known and could change the screening once supplied. */
export interface UnresolvedCondition {
  field: RuleField;
  ruleId: string;
  /** Set when the unknown field belongs to an exception rather than the rule's own scope/condition. */
  exceptionId: string | null;
  /** Effect produced if the condition (rule, or the named exception) turns out true. */
  effectIfTrue: RuleEvaluationResult['effect'];
  evidenceIds: string[];
}

export type VerdictBasis =
  | 'hard_ineligible' // a HARD ineligible rule holds
  | 'hard_rule_unresolved' // a HARD rule (or an exception with a HARD effect) is unknown and could change the verdict
  | 'review_rule' // a requires_review rule holds (explicit, source-driven review)
  | 'hard_eligible' // at least one HARD eligible rule holds
  | 'no_applicable_hard_rule'; // nothing decides eligibility: unknown, never eligible by default

export interface CropScreening {
  cropId: string;
  productId: string | null;
  outcome: ScreeningOutcome;
  verdictBasis: VerdictBasis;
  results: RuleEvaluationResult[];
  /** Reasons of rules whose truth is true and effect is caution / prefer / requires_review. */
  cautions: RuleReason[];
  preferences: RuleReason[];
  reviews: RuleReason[];
  unknownFields: RuleField[];
  unresolvedConditions: UnresolvedCondition[];
  /** Counts of applicable (not not_applicable) rules by resolution; a count, not a probability. */
  confidenceNote: { resolvedRules: number; unresolvedRules: number; unresolvedFields: number; text: string };
}

/**
 * Effects a rule could still produce given the context, following exception precedence: a true exception
 * stops the walk (later exceptions and the rule's own effect are unreachable), unknown ones stay possible.
 */
function reachable(rule: CropRule, ctx: RuleContext): { effects: string[]; ownEffect: RuleEvaluationResult['effect']; exceptionUnknowns: UnresolvedCondition[] } {
  const effects: string[] = [];
  const exceptionUnknowns: UnresolvedCondition[] = [];
  for (const ex of rule.exceptions) {
    const r = evaluateCondition(ex.when, ctx);
    if (r.truth === 'false') continue;
    effects.push(ex.effect.type);
    if (r.truth === 'true') {
      // With no unresolved earlier exception, the rule (if it applies) produces this exception's effect.
      return { effects, ownEffect: exceptionUnknowns.length === 0 ? ex.effect.type : rule.effect.type, exceptionUnknowns };
    }
    for (const field of r.unknownFields) exceptionUnknowns.push({ field, ruleId: rule.id, exceptionId: ex.id, effectIfTrue: ex.effect.type, evidenceIds: ex.evidenceIds });
  }
  effects.push(rule.effect.type);
  return { effects, ownEffect: rule.effect.type, exceptionUnknowns };
}

function unresolvedFor(rule: CropRule, ctx: RuleContext, opts: RegionOptions = {}): UnresolvedCondition[] {
  const own = and(scopeApplies(rule, ctx, opts), evaluateCondition(rule.when, ctx));
  const { ownEffect, exceptionUnknowns } = reachable(rule, ctx);
  return [...own.unknownFields.map((field) => ({ field, ruleId: rule.id, exceptionId: null, effectIfTrue: ownEffect, evidenceIds: rule.evidenceIds })), ...exceptionUnknowns];
}

/**
 * Combine a crop's rule results for one product and context (HARD = eligible | ineligible; SOFT = prefer | caution | requires_review):
 * 1. any HARD ineligible holds -> ineligible (agronomic exclusion is never overridden by price)
 * 2. else a rule that could yield ineligible is unknown, or no HARD eligible holds while a rule that could yield eligible
 *    is unknown -> requires_review (eligibility itself is unresolved). An unknown rule whose only possible effect is
 *    eligible is redundant once another HARD eligible holds.
 * 3. else any requires_review rule holds -> requires_review (explicit, source-driven review)
 * 4. else at least one HARD eligible holds -> eligible
 * 5. else -> unknown (never eligible by default)
 * Unknown SOFT rules never change the verdict; they are listed in `unresolvedConditions`. An unknown input
 * therefore cannot become a positive recommendation (step 4 needs a true HARD eligible rule) nor a definitive
 * exclusion (step 1 needs truth true).
 */
export function screenCrop(cropId: string, rules: CropRule[], ctx: RuleContext, opts: EvaluateOptions & { productId?: string | null }): CropScreening {
  const productId = opts.productId ?? null;
  const own = rules.filter((r) => r.cropId === cropId && ruleAppliesToProduct(r, productId));
  const evaluated = own.map((rule) => ({ rule, res: evaluateRule(rule, ctx, opts) }));
  const results = evaluated.map((e) => e.res);
  const holds = (e: string) => results.some((r) => r.truth === 'true' && r.effect === e);
  const unknownRules = evaluated.filter((e) => e.res.truth === 'unknown' && e.res.effect !== 'not_applicable');
  const eligibleHolds = holds('eligible');
  const hardUnresolved = unknownRules.some(({ rule }) => {
    const pe = reachable(rule, ctx).effects;
    if (pe.includes('ineligible')) return true;
    return !eligibleHolds && pe.some(isHard);
  });
  let outcome: ScreeningOutcome;
  let verdictBasis: VerdictBasis;
  if (holds('ineligible')) [outcome, verdictBasis] = ['ineligible', 'hard_ineligible'];
  else if (hardUnresolved) [outcome, verdictBasis] = ['requires_review', 'hard_rule_unresolved'];
  else if (holds('requires_review')) [outcome, verdictBasis] = ['requires_review', 'review_rule'];
  else if (eligibleHolds) [outcome, verdictBasis] = ['eligible', 'hard_eligible'];
  else [outcome, verdictBasis] = ['unknown', 'no_applicable_hard_rule'];

  const unresolvedConditions = unknownRules.flatMap(({ rule }) => unresolvedFor(rule, ctx, opts));
  const resolved = results.filter((r) => r.truth === 'true').length;
  const unresolvedFields = uniq(unresolvedConditions.map((u) => u.field)).length;
  const byEffect = (e: string) => results.filter((r) => r.truth === 'true' && r.effect === e).flatMap((r) => r.reasons);
  return {
    cropId,
    productId,
    outcome,
    verdictBasis,
    results,
    cautions: byEffect('caution'),
    preferences: byEffect('prefer'),
    reviews: byEffect('requires_review'),
    unknownFields: uniq(results.flatMap((r) => r.unknownFields)),
    unresolvedConditions,
    confidenceNote: {
      resolvedRules: resolved,
      unresolvedRules: unknownRules.length,
      unresolvedFields,
      text: `${resolved} applicable rule(s) resolved, ${unknownRules.length} unresolved on ${unresolvedFields} unknown input(s).`,
    },
  };
}
