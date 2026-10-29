import { z } from 'zod';
import {
  DateRange,
  DecimalString,
  EvidenceState,
  Id,
  IsoDateTime,
  Mode,
  ReasonCode,
  SchemaVersion,
  Sha256Hex,
  SpatialScope,
} from './common';
import { ValueRecord } from './evidence';
import { LanguageCode } from './identity';
import { Condition, ReviewStatus, Season } from './rules';
import { ToolName } from './tool-names';

const DurationRange = z
  .object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() })
  .strict()
  .refine((d) => d.min <= d.max, { message: 'min must be <= max' });

/**
 * BUILD_SPEC 5.1 StageDefinition. Duration is always a range; there is no
 * single fixed day count. Thermal-time stages require validated parameters.
 * `repeat` describes repeated harvests/pickings after the first occurrence.
 */
export const StageDefinition = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    mode: Mode,
    cropId: Id,
    varietyId: Id.nullable(),
    scope: SpatialScope,
    seasons: z.array(Season),
    stageId: Id,
    name: z.string().min(1),
    order: z.number().int().nonnegative(),
    /** Stage that must finish before this one starts; null = starts at planting. */
    startsAfter: Id.nullable(),
    prerequisites: z.array(Id),
    method: z.enum(['calendar_days', 'thermal_time']),
    durationDays: DurationRange,
    thermal: z
      .object({ baseTempC: z.number(), gddMin: z.number().positive(), gddMax: z.number().positive(), validated: z.literal(true), evidenceIds: z.array(Id).min(1) })
      .strict()
      .nullable(),
    isHarvest: z.boolean(),
    repeat: z
      .object({ intervalDays: DurationRange, maxOccurrences: z.number().int().min(2) })
      .strict()
      .nullable(),
    evidenceIds: z.array(Id),
    limitations: z.array(z.string().min(1)),
    reviewStatus: ReviewStatus,
  })
  .strict()
  .refine((s) => s.method !== 'thermal_time' || s.thermal !== null, { message: 'thermal_time requires validated thermal parameters' })
  .refine((s) => s.repeat === null || s.isHarvest, { message: 'repeat is only allowed on harvest stages' });
export type StageDefinition = z.infer<typeof StageDefinition>;

export const NamedInput = z.object({ key: z.string().min(1), value: ValueRecord }).strict();
export const Assumption = z
  .object({ id: Id, description: z.string().min(1), value: ValueRecord.nullable(), evidenceIds: z.array(Id) })
  .strict();
export const VersionRef = z.object({ id: Id, version: z.union([z.number().int(), z.string().min(1)]) }).strict();

/**
 * Immutable plan snapshot. `contentHash` is the sha256 of the canonical JSON of
 * every field except `contentHash` itself (see @harvest/domain hash.ts).
 * Revisions create a new snapshot with `parentId` set; history is never edited.
 */
export const PlanSnapshot = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    parentId: Id.nullable(),
    parentContentHash: Sha256Hex.nullable(),
    ownerId: Id,
    farmId: Id,
    cropId: Id,
    productId: Id,
    createdAt: IsoDateTime,
    decidedAt: IsoDateTime,
    mode: Mode,
    sourceSnapshotId: Id,
    confirmedInputs: z.array(NamedInput),
    assumptions: z.array(Assumption),
    ruleVersions: z.array(VersionRef),
    modelVersions: z.array(VersionRef),
    outputIds: z.array(Id),
    contentHash: Sha256Hex,
  })
  .strict()
  .refine((p) => (p.parentId === null) === (p.parentContentHash === null), {
    message: 'parentId and parentContentHash must both be set or both be null',
  })
  .readonly();
export type PlanSnapshot = z.infer<typeof PlanSnapshot>;

export const ActionTask = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    planId: Id,
    planContentHash: Sha256Hex,
    taskType: z.enum(['prepare_land', 'plant', 'irrigate', 'scout', 'weed', 'nutrient', 'protect', 'harvest', 'sell', 'record_observation', 'other']),
    timing: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('window'), window: DateRange }).strict(),
      z.object({ kind: z.literal('condition'), condition: Condition, description: z.string().min(1) }).strict(),
    ]),
    dependsOn: z.array(Id),
    /** Only present when a sourced or calculated justification exists. */
    amount: ValueRecord.nullable(),
    evidenceIds: z.array(Id),
    reasonCode: ReasonCode,
    state: z.enum(['pending', 'due', 'done', 'skipped', 'cancelled']),
    completionEvidence: z.object({ journalEntryIds: z.array(Id), mediaIds: z.array(Id) }).strict().nullable(),
    mode: Mode,
  })
  .strict()
  .refine((t) => t.amount === null || t.amount.evidenceIds.length > 0 || t.amount.evidenceState === 'derived', {
    message: 'an amount needs evidence or a derived calculation',
  });
export type ActionTask = z.infer<typeof ActionTask>;

export const Quantile = z
  .object({ level: z.number().gt(0).lt(1), value: z.number().finite() })
  .strict();

/** Quantiles with strictly increasing levels and non-decreasing values. */
export const QuantileSet = z
  .array(Quantile)
  .min(1)
  .superRefine((qs, ctx) => {
    for (let i = 1; i < qs.length; i++) {
      const prev = qs[i - 1]!;
      const cur = qs[i]!;
      if (!(cur.level > prev.level)) ctx.addIssue({ code: 'custom', path: [i, 'level'], message: 'quantile levels must be strictly increasing' });
      if (cur.value < prev.value) ctx.addIssue({ code: 'custom', path: [i, 'value'], message: 'quantile values must be non-decreasing (crossing)' });
    }
  });

export const ForecastArtifact = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    mode: Mode,
    evidenceState: z.literal('forecast'),
    productId: Id,
    marketIds: z.array(Id).min(1),
    target: z
      .object({
        statistic: z.enum(['weekly_median_modal', 'weekly_arrival_weighted_modal', 'other_documented']),
        definition: z.string().min(1),
        unit: z.literal('INR/kg'),
      })
      .strict(),
    issuedAt: IsoDateTime,
    trainingCutoff: IsoDateTime,
    horizonDays: z.number().int().nonnegative(),
    modelId: Id,
    modelKind: z.enum(['baseline_last_value', 'baseline_seasonal', 'statistical_candidate']),
    baselineIds: z.array(Id),
    predictions: z
      .array(
        z
          .object({
            period: DateRange,
            quantiles: QuantileSet,
            /** Non-negativity is checked; a negative model output must be reported, not clipped silently. */
            negativeQuantilesReported: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    evaluation: z.object({ reportId: Id, scope: z.string().min(1) }).strict().nullable(),
    featureVersions: z.array(VersionRef),
    missingness: z.object({ fractionMissingWeeks: z.number().min(0).max(1), notes: z.array(z.string()) }).strict(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.trainingCutoff > f.issuedAt) ctx.addIssue({ code: 'custom', path: ['trainingCutoff'], message: 'training cutoff after issue time' });
    f.predictions.forEach((p, i) => {
      if (p.quantiles.some((q) => q.value < 0) && !p.negativeQuantilesReported) {
        ctx.addIssue({ code: 'custom', path: ['predictions', i, 'quantiles'], message: 'negative price quantile must be flagged negativeQuantilesReported' });
      }
    });
  });
export type ForecastArtifact = z.infer<typeof ForecastArtifact>;

export const JournalEntry = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    clientEntryId: Id,
    ownerId: Id,
    farmId: Id,
    planId: Id.nullable(),
    mode: Mode,
    version: z.number().int().positive(),
    observedAt: IsoDateTime,
    uploadedAt: IsoDateTime.nullable(),
    mediaIds: z.array(Id),
    note: z.string().max(10000).nullable(),
    transcript: z
      .object({ text: z.string(), language: LanguageCode, provider: z.string().min(1).nullable(), editedByFarmer: z.boolean() })
      .strict()
      .nullable(),
    factIds: z.array(Id),
    expenses: z.array(z.object({ amountInr: DecimalString, category: z.string().min(1), description: z.string().nullable() }).strict()),
    actionIds: z.array(Id),
    processingStatus: z.enum(['draft', 'submitted', 'processing', 'ready', 'failed']),
  })
  .strict();
export type JournalEntry = z.infer<typeof JournalEntry>;

/**
 * Original (as stated), proposed (by model/rule), confirmed (by owner action).
 * Only status 'confirmed' with a confirmed value may update a plan.
 */
export const JournalFact = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    entryId: Id,
    ownerId: Id,
    field: z.string().min(1),
    original: ValueRecord.nullable(),
    proposed: z
      .object({ value: ValueRecord, proposer: z.enum(['meta_model', 'rule', 'farmer']), modelId: z.string().nullable(), agentRunId: Id.nullable() })
      .strict()
      .nullable(),
    confirmed: ValueRecord.nullable(),
    status: z.enum(['proposed', 'confirmed', 'rejected', 'superseded']),
    confirmedAt: IsoDateTime.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .refine((f) => (f.status === 'confirmed') === (f.confirmed !== null && f.confirmedAt !== null), {
    message: 'confirmed status requires confirmed value and confirmedAt (and vice versa)',
  });
export type JournalFact = z.infer<typeof JournalFact>;

const VisualCommon = {
  schemaVersion: SchemaVersion,
  id: Id,
  ownerId: Id,
  mode: Mode,
  originalMediaId: Id.nullable(),
  regionId: Id.nullable(),
  cropId: Id,
  stageId: Id,
  qa: z.object({ status: z.enum(['pending', 'passed', 'failed']), checks: z.array(z.object({ name: z.string(), passed: z.boolean() }).strict()) }).strict(),
  storageKey: z.string().min(1),
  cacheKey: z.string().min(1),
  createdAt: IsoDateTime,
};

/** Generated imagery is always illustrative: literal true, evidenceState illustrative. */
export const VisualAsset = z.discriminatedUnion('origin', [
  z
    .object({
      ...VisualCommon,
      origin: z.literal('generated'),
      illustrative: z.literal(true),
      evidenceState: z.literal('illustrative'),
      provider: z.string().min(1),
      modelId: z.string().min(1),
      promptTemplateId: Id,
      promptTemplateHash: Sha256Hex,
      briefHash: Sha256Hex,
      jobId: Id,
    })
    .strict(),
  z
    .object({
      ...VisualCommon,
      origin: z.literal('licensed_reference'),
      illustrative: z.boolean(),
      evidenceState: z.enum(['illustrative', 'observed']),
      licence: z.string().min(1),
      attribution: z.string().min(1),
      sourceUrl: z.url().nullable(),
    })
    .strict(),
  z
    .object({
      ...VisualCommon,
      origin: z.literal('farmer_photo'),
      illustrative: z.literal(false),
      evidenceState: z.literal('observed'),
      journalEntryId: Id,
      capturedAt: IsoDateTime.nullable(),
    })
    .strict(),
]);
export type VisualAsset = z.infer<typeof VisualAsset>;

export const AgentTrace = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    requestId: Id,
    ownerId: Id,
    mode: Mode,
    redactedInputs: z.record(z.string(), z.unknown()),
    modelId: z.string().min(1),
    prompts: z.array(z.object({ templateId: Id, version: z.string().min(1), hash: Sha256Hex }).strict()),
    toolCalls: z.array(
      z
        .object({
          callId: Id,
          tool: ToolName,
          inputHash: Sha256Hex,
          resultId: Id.nullable(),
          status: z.enum(['ok', 'rejected', 'error', 'timeout']),
          latencyMs: z.number().int().nonnegative(),
          errorCode: z.string().nullable(),
        })
        .strict(),
    ),
    resultIds: z.array(Id),
    validations: z.array(z.object({ step: z.enum(['schema', 'ownership_mode', 'numeric_refs', 'claim_evidence', 'high_risk', 'decision']), passed: z.boolean(), code: z.string().nullable() }).strict()),
    errors: z.array(z.object({ code: z.string().min(1), message: z.string().max(2000) }).strict()),
    rounds: z.number().int().nonnegative(),
    repairAttempts: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).strict(),
    cost: z.object({ estimatedUsd: DecimalString, settledUsd: DecimalString.nullable() }).strict(),
    startedAt: IsoDateTime,
    evidenceStatesShown: z.array(EvidenceState),
  })
  .strict();
export type AgentTrace = z.infer<typeof AgentTrace>;

