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
 *   requires_review with truth unknown.
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
  const missing = v === null || v === undefined;
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

/** Scope applicability: region AND season AND irrigation, each three-valued. */
export function scopeApplies(rule: CropRule, ctx: RuleContext): Evaluation {
  const region: Evaluation = (() => {
    if (rule.scope.regionIds.includes(NATIONAL_REGION_ID)) return { truth: 'true', unknownFields: [] };
    const d = ctx.location?.districtId ?? null;
    const s = ctx.location?.stateId ?? null;
    if ((d !== null && rule.scope.regionIds.includes(d)) || (s !== null && rule.scope.regionIds.includes(s))) return { truth: 'true', unknownFields: [] };
    if (d !== null && s !== null) return { truth: 'false', unknownFields: [] };
    const unk: RuleField[] = [];
    if (d === null) unk.push('location.districtId');
    if (s === null) unk.push('location.stateId');
    return { truth: 'unknown', unknownFields: unk };
  })();
  const season: Evaluation =
    rule.scope.seasons.length === 0
      ? { truth: 'true', unknownFields: [] }
      : ctx.season == null
        ? { truth: 'unknown', unknownFields: ['season'] }
        : { truth: rule.scope.seasons.includes(ctx.season) ? 'true' : 'false', unknownFields: [] };
  const irr: Evaluation =
    rule.scope.irrigation.length === 0
      ? { truth: 'true', unknownFields: [] }
      : ctx.irrigation?.category == null
        ? { truth: 'unknown', unknownFields: ['irrigation.category'] }
        : { truth: rule.scope.irrigation.includes(ctx.irrigation.category) ? 'true' : 'false', unknownFields: [] };
  return evaluateParts([region, season, irr]);
}

/** A rule may execute only if approved, or synthetic in synthetic mode. */
export function ruleExecutable(rule: CropRule, mode: Mode): { ok: true } | { ok: false; reasonCode: string } {
  if (rule.reviewStatus === 'disabled') return { ok: false, reasonCode: 'rule_disabled' };
  if (rule.mode !== mode) return { ok: false, reasonCode: 'rule_mode_mismatch' };
  if (rule.reviewStatus === 'candidate') return { ok: false, reasonCode: 'rule_not_approved' };
  if (rule.reviewStatus === 'synthetic' && mode !== 'synthetic') return { ok: false, reasonCode: 'synthetic_rule_outside_synthetic_mode' };
  return { ok: true };
}

export function evaluateRule(rule: CropRule, ctx: RuleContext, opts: { mode: Mode }): RuleEvaluationResult {
  const base = { ruleId: rule.id, ruleVersion: rule.version, cropId: rule.cropId };
  const exec = ruleExecutable(rule, opts.mode);
  if (!exec.ok) {
    return { ...base, truth: 'false', effect: 'not_applicable', reasons: [{ reasonCode: exec.reasonCode, source: 'gate' }], unknownFields: [], appliedExceptionId: null };
  }
  const applies = and(scopeApplies(rule, ctx), evaluateCondition(rule.when, ctx));
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

export interface CropScreening {
  cropId: string;
  outcome: ScreeningOutcome;
  results: RuleEvaluationResult[];
  cautions: RuleReason[];
  preferences: RuleReason[];
  unknownFields: RuleField[];
}

/**
 * Combine a crop's rule results:
 * - any definitive ineligible -> ineligible (agronomic exclusion is never overridden by price)
 * - else any requires_review -> requires_review
 * - else at least one definitive eligible -> eligible
 * - else (no applicable eligibility rule) -> unknown, never eligible by default.
 */
export function screenCrop(cropId: string, rules: CropRule[], ctx: RuleContext, opts: { mode: Mode }): CropScreening {
  const results = rules.filter((r) => r.cropId === cropId).map((r) => evaluateRule(r, ctx, opts));
  const has = (e: string) => results.some((r) => r.effect === e);
  const outcome: ScreeningOutcome = has('ineligible') ? 'ineligible' : has('requires_review') ? 'requires_review' : has('eligible') ? 'eligible' : 'unknown';
  return {
    cropId,
    outcome,
    results,
    cautions: results.filter((r) => r.effect === 'caution').flatMap((r) => r.reasons),
    preferences: results.filter((r) => r.effect === 'prefer').flatMap((r) => r.reasons),
    unknownFields: uniq(results.flatMap((r) => r.unknownFields)),
  };
}
