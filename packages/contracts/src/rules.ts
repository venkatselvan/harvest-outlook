import { z } from 'zod';
import { EvidenceState, Id, IsoDate, Mode, ReasonCode, SchemaVersion } from './common';

/**
 * Rule context shape (the only data a rule can read). Every leaf is optional
 * and nullable: an absent/null leaf is UNKNOWN in three-valued evaluation.
 */
export const Season = z.enum(['kharif', 'rabi', 'zaid', 'perennial']);
export type Season = z.infer<typeof Season>;
export const IrrigationCategory = z.enum(['rainfed', 'supplemental', 'irrigated']);
export type IrrigationCategory = z.infer<typeof IrrigationCategory>;
export const SoilDrainage = z.enum(['poor', 'moderate', 'good']);
export const SoilTexture = z.enum(['sand', 'loamy_sand', 'sandy_loam', 'loam', 'silt_loam', 'clay_loam', 'silty_clay', 'clay']);
export const LabourLevel = z.enum(['low', 'medium', 'high']);

const opt = <T extends z.ZodType>(t: T) => t.nullable().optional();

export const RuleContext = z
  .object({
    location: opt(z.object({ districtId: opt(Id), stateId: opt(Id) }).strict()),
    season: opt(Season),
    planting: opt(z.object({ month: opt(z.number().int().min(1).max(12)), date: opt(IsoDate) }).strict()),
    irrigation: opt(z.object({ category: opt(IrrigationCategory) }).strict()),
    soil: opt(
      z.object({ drainage: opt(SoilDrainage), texture: opt(SoilTexture), ph: opt(z.number().min(0).max(14)) }).strict(),
    ),
    water: opt(z.object({ capacityMmPerWeek: opt(z.number().nonnegative()) }).strict()),
    farm: opt(z.object({ areaHa: opt(z.number().positive()) }).strict()),
    budget: opt(z.object({ inrPerHa: opt(z.number().nonnegative()) }).strict()),
    labour: opt(z.object({ level: opt(LabourLevel) }).strict()),
    rainfall: opt(z.object({ seasonalMm: opt(z.number().nonnegative()) }).strict()),
    /**
     * Observed or forecast weather values. The numbers carry no meaning without
     * `evidenceState`; rule evaluation treats weather.* fields as unknown when it is absent.
     */
    weather: opt(
      z
        .object({
          dailyRainMm: opt(z.number().nonnegative()),
          forecastRainMm7d: opt(z.number().nonnegative()),
          evidenceState: opt(EvidenceState),
        })
        .strict(),
    ),
    elevation: opt(z.object({ m: opt(z.number()) }).strict()),
  })
  .strict();
export type RuleContext = z.infer<typeof RuleContext>;

/** Allowlisted field paths and their value types. Adding a field is a contract change. */
export const RULE_FIELD_TYPES = {
  'location.districtId': 'string',
  'location.stateId': 'string',
  season: 'string',
  'planting.month': 'number',
  'planting.date': 'date',
  'irrigation.category': 'string',
  'soil.drainage': 'string',
  'soil.texture': 'string',
  'soil.ph': 'number',
  'water.capacityMmPerWeek': 'number',
  'farm.areaHa': 'number',
  'budget.inrPerHa': 'number',
  'labour.level': 'string',
  'rainfall.seasonalMm': 'number',
  'elevation.m': 'number',
  /** Evaluated against observed or forecast values; context.weather.evidenceState must accompany them. */
  'weather.dailyRainMm': 'number',
  'weather.forecastRainMm7d': 'number',
} as const;
export type RuleField = keyof typeof RULE_FIELD_TYPES;
export const RuleField = z.enum(Object.keys(RULE_FIELD_TYPES) as [RuleField, ...RuleField[]]);
export type RuleFieldType = (typeof RULE_FIELD_TYPES)[RuleField];

export const Scalar = z.union([z.string().min(1), z.number().finite()]);
export type Scalar = z.infer<typeof Scalar>;
const Ordered = z.union([z.number().finite(), IsoDate]);

export type LeafCondition =
  | { field: RuleField; op: 'eq'; value: Scalar }
  | { field: RuleField; op: 'in'; value: Scalar[] }
  | { field: RuleField; op: 'gte' | 'lte'; value: number | string }
  | { field: RuleField; op: 'between'; value: [number | string, number | string] }
  | { field: RuleField; op: 'known'; value: boolean };
export type Condition = LeafCondition | { all: Condition[] } | { any: Condition[] } | { not: Condition };

const LeafConditionSchema = z.discriminatedUnion('op', [
  z.object({ field: RuleField, op: z.literal('eq'), value: Scalar }).strict(),
  z.object({ field: RuleField, op: z.literal('in'), value: z.array(Scalar).min(1) }).strict(),
  z.object({ field: RuleField, op: z.literal('gte'), value: Ordered }).strict(),
  z.object({ field: RuleField, op: z.literal('lte'), value: Ordered }).strict(),
  z.object({ field: RuleField, op: z.literal('between'), value: z.tuple([Ordered, Ordered]) }).strict(),
  z.object({ field: RuleField, op: z.literal('known'), value: z.boolean() }).strict(),
]);

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    LeafConditionSchema,
    z.object({ all: z.array(Condition).min(1) }).strict(),
    z.object({ any: z.array(Condition).min(1) }).strict(),
    z.object({ not: Condition }).strict(),
  ]),
) as z.ZodType<Condition>;

function valueMatchesType(v: unknown, t: RuleFieldType): boolean {
  if (t === 'number') return typeof v === 'number';
  if (t === 'date') return typeof v === 'string' && IsoDate.safeParse(v).success;
  return typeof v === 'string';
}

/** Collect type errors where a condition's literal does not fit its field type. */
export function conditionTypeErrors(c: Condition, path: (string | number)[] = []): { path: (string | number)[]; message: string }[] {
  if ('all' in c) return c.all.flatMap((x, i) => conditionTypeErrors(x, [...path, 'all', i]));
  if ('any' in c) return c.any.flatMap((x, i) => conditionTypeErrors(x, [...path, 'any', i]));
  if ('not' in c) return conditionTypeErrors(c.not, [...path, 'not']);
  const t = RULE_FIELD_TYPES[c.field];
  const bad = (m: string) => [{ path: [...path, 'value'], message: `${c.field} (${t}): ${m}` }];
  switch (c.op) {
    case 'known':
      return [];
    case 'eq':
      return valueMatchesType(c.value, t) ? [] : bad('value type mismatch');
    case 'in':
      return c.value.every((v) => valueMatchesType(v, t)) ? [] : bad('value type mismatch');
    case 'gte':
    case 'lte':
      if (t === 'string') return bad(`${c.op} not allowed on categorical field`);
      return valueMatchesType(c.value, t) ? [] : bad('value type mismatch');
    case 'between':
      if (t === 'string') return bad('between not allowed on categorical field');
      if (!c.value.every((v) => valueMatchesType(v, t))) return bad('value type mismatch');
      return c.value[0] <= c.value[1] ? [] : bad('between lower bound exceeds upper bound');
  }
}

export const RuleEffectType = z.enum(['eligible', 'ineligible', 'requires_review', 'prefer', 'caution']);
export type RuleEffectType = z.infer<typeof RuleEffectType>;
export const RuleEffect = z.object({ type: RuleEffectType, reasonCode: ReasonCode }).strict();
export type RuleEffect = z.infer<typeof RuleEffect>;

export const RuleException = z
  .object({
    id: Id,
    when: Condition,
    effect: RuleEffect,
    evidenceIds: z.array(Id),
    note: z.string().optional(),
  })
  .strict();
export type RuleException = z.infer<typeof RuleException>;

export const RuleAlternative = z
  .object({ cropId: Id, productId: Id.nullable(), reasonCode: ReasonCode })
  .strict();

export const ReviewStatus = z.enum(['synthetic', 'candidate', 'approved', 'disabled']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/**
 * National scope token. A region id equal to this value matches any location,
 * including an unknown one. Otherwise a region id matches the context's
 * districtId or stateId.
 *
 * Hierarchical id convention used by the screening engine: `IN-XX` (two
 * upper-case letters) is a state; `IN-XX-<name>` is a district of state `IN-XX`.
 * A state id can only match the context's stateId, and a district id cannot
 * match a farm known to be in another state, so these are decidable with an
 * unknown district. Any other id (agro-region, synthetic) is opaque: it can
 * only be ruled out when both districtId and stateId are known.
 */
export const NATIONAL_REGION_ID = 'IN' as const;

export const RuleScope = z
  .object({
    regionIds: z.array(Id).min(1),
    /** Empty array = not restricted by season. */
    seasons: z.array(Season),
    /** Empty array = not restricted by irrigation category. */
    irrigation: z.array(IrrigationCategory),
    /**
     * Product scoping. Absent/false: the rule is agronomic and applies to every
     * market product of the crop, even when `productId` names one product (the
     * T05b ginger rules name `ginger.fresh` but describe cultivation). Only when
     * true does `productId` restrict the rule to that product (market or
     * product-specific rules).
     */
    productSpecific: z.boolean().optional(),
  })
  .strict();
export type RuleScope = z.infer<typeof RuleScope>;

export const CropRule = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    version: z.number().int().positive(),
    mode: Mode,
    cropId: Id,
    productId: Id.nullable().optional(),
    scope: RuleScope,
    when: Condition,
    exceptions: z.array(RuleException),
    effect: RuleEffect,
    alternatives: z.array(RuleAlternative),
    evidenceIds: z.array(Id),
    reviewStatus: ReviewStatus,
  })
  .strict()
  .superRefine((r, ctx) => {
    for (const e of conditionTypeErrors(r.when, ['when'])) ctx.addIssue({ code: 'custom', ...e });
    r.exceptions.forEach((x, i) => {
      for (const e of conditionTypeErrors(x.when, ['exceptions', i, 'when'])) ctx.addIssue({ code: 'custom', ...e });
    });
    if (r.reviewStatus === 'synthetic' && r.mode !== 'synthetic') {
      ctx.addIssue({ code: 'custom', path: ['reviewStatus'], message: 'synthetic rules must have mode synthetic' });
    }
    if (r.mode !== 'synthetic' && r.reviewStatus === 'approved' && r.evidenceIds.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['evidenceIds'], message: 'approved live/replay rules require source evidence' });
    }
    if (r.mode !== 'synthetic' && r.evidenceIds.some((id) => id.startsWith('synthetic-'))) {
      ctx.addIssue({ code: 'custom', path: ['evidenceIds'], message: 'synthetic evidence cannot back a live/replay rule' });
    }
  });
export type CropRule = z.infer<typeof CropRule>;

/** Three-valued truth. */
export const Truth = z.enum(['true', 'false', 'unknown']);
export type Truth = z.infer<typeof Truth>;

export const RuleReason = z
  .object({
    reasonCode: ReasonCode,
    source: z.enum(['rule', 'exception', 'unknown_condition', 'unresolved_exception', 'gate']),
    exceptionId: Id.optional(),
  })
  .strict();
export type RuleReason = z.infer<typeof RuleReason>;

/**
 * Result of evaluating one rule. `effect` is `not_applicable` when the rule
 * does not apply or cannot execute in the requested mode. `eligible` and
 * `ineligible` only appear with truth `true`.
 */
export const RuleEvaluationResult = z
  .object({
    ruleId: Id,
    ruleVersion: z.number().int().positive(),
    cropId: Id,
    truth: Truth,
    effect: z.union([RuleEffectType, z.literal('not_applicable')]),
    reasons: z.array(RuleReason),
    unknownFields: z.array(RuleField),
    appliedExceptionId: Id.nullable(),
  })
  .strict()
  .refine((r) => !((r.effect === 'eligible' || r.effect === 'ineligible') && r.truth !== 'true'), {
    message: 'eligible/ineligible require truth true',
  });
export type RuleEvaluationResult = z.infer<typeof RuleEvaluationResult>;

export const ScreeningOutcome = z.enum(['eligible', 'ineligible', 'requires_review', 'unknown']);
export type ScreeningOutcome = z.infer<typeof ScreeningOutcome>;
