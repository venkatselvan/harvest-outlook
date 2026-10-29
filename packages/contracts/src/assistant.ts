import { z } from 'zod';
import { DateRange, Id, IsoDate, IsoDateTime, ReasonCode, SchemaVersion, Sha256Hex, SpatialScope, Unit } from './common';
import { CoverageRecord } from './coverage';
import { EconomicsInput, EconomicsResult } from './economics';
import { ValueRecord } from './evidence';
import { FarmProfile } from './farm';
import { LanguageCode, ProductBasis } from './identity';
import { JobState } from './jobs';
import { ForecastArtifact, JournalFact } from './plans';
import { RuleEvaluationResult, RuleField, ScreeningOutcome } from './rules';
import { ToolName } from './tool-names';
import { WaterBalanceResult } from './water';

export { ToolName };

/**
 * Tool inputs never carry ownerId or mode: both are server-derived (BUILD_SPEC 9).
 * Ids referencing owned resources are authorized server-side on every call.
 */
const Normalized = z.number().min(0).max(1);

export const ToolSchemas = {
  resolve_crop_identity: {
    input: z
      .object({
        text: z.string().min(1).max(200),
        language: LanguageCode,
        context: z.object({ districtId: Id.optional(), stateId: Id.optional() }).strict().optional(),
      })
      .strict(),
    output: z
      .object({
        candidates: z.array(
          z
            .object({
              cropId: Id,
              productId: Id.nullable(),
              matchedAlias: z.string(),
              aliasLanguage: LanguageCode,
              matchKind: z.enum(['exact', 'normalized', 'prefix']),
              products: z.array(z.object({ productId: Id, productBasis: ProductBasis }).strict()),
            })
            .strict(),
        ),
        ambiguous: z.boolean(),
        unresolvedReason: z.string().nullable(),
      })
      .strict(),
  },
  get_farm_context: {
    input: z.object({ farmId: Id }).strict(),
    output: z.object({ farm: FarmProfile, proposedFacts: z.array(JournalFact) }).strict(),
  },
  retrieve_evidence: {
    input: z
      .object({
        cropIds: z.array(Id).max(10).optional(),
        regionIds: z.array(Id).max(20).optional(),
        topics: z.array(ReasonCode).max(10).optional(),
        availableBefore: IsoDateTime.optional(),
        limit: z.number().int().min(1).max(20),
      })
      .strict(),
    output: z
      .object({
        passages: z.array(
          z
            .object({
              evidenceId: Id,
              excerpt: z.string(),
              effectiveAvailableAt: IsoDateTime.nullable(),
              scope: SpatialScope,
              cropIds: z.array(Id),
              /** Promoted from the agent-local extension (D28/F8): only validated or machine-grounded evidence is citable. */
              validationStatus: z.enum(['validated', 'grounded']),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  screen_crops: {
    input: z
      .object({ contextId: Id, preferencePolicyId: Id.optional(), cropIds: z.array(Id).max(40).optional() })
      .strict(),
    output: z
      .object({
        results: z.array(
          z
            .object({
              cropId: Id,
              productIds: z.array(Id),
              outcome: ScreeningOutcome,
              ruleResults: z.array(RuleEvaluationResult),
              unknownFields: z.array(RuleField),
              coverage: z.array(CoverageRecord),
              dimensions: z.array(
                z
                  .object({
                    dimension: z.enum(['water_fit', 'budget_fit', 'time_to_first_income', 'labour_intensity', 'market_access', 'evidence_quality', 'economic_scenario']),
                    value: ValueRecord,
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  get_market_outlook: {
    input: z
      .object({ productId: Id, marketIds: z.array(Id).min(1).max(2), issueDate: IsoDate, harvestWindows: z.array(DateRange).min(1) })
      .strict(),
    output: z
      .object({
        forecasts: z.array(ForecastArtifact),
        references: z.array(ValueRecord),
        missing: z.array(z.object({ marketId: Id, reason: z.string().min(1) }).strict()),
      })
      .strict(),
  },
  calculate_scenarios: {
    input: z
      .object({
        planId: Id.optional(),
        contextId: Id.optional(),
        overrides: EconomicsInput.partial().omit({ schemaVersion: true }).optional(),
      })
      .strict()
      .refine((i) => (i.planId === undefined) !== (i.contextId === undefined), { message: 'exactly one of planId/contextId' }),
    output: z.object({ resultId: Id, result: EconomicsResult }).strict(),
  },
  calculate_water_balance: {
    input: z
      .object({
        planId: Id,
        weatherRefIds: z.array(Id).min(1),
        soilRefId: Id.nullable(),
        stageRefIds: z.array(Id).min(1),
        forecastRainPolicy: z.enum(['use_forecast', 'ignore_forecast']),
      })
      .strict(),
    output: z.object({ resultId: Id, result: WaterBalanceResult }).strict(),
  },
  interpret_observation: {
    input: z.object({ mediaIds: z.array(Id).min(1).max(4), farmId: Id, planId: Id.optional(), note: z.string().max(4000).optional() }).strict(),
    output: z
      .object({
        proposals: z.array(
          z
            .object({
              field: z.string().min(1),
              proposed: ValueRecord,
              uncertainty: z
                .object({ kind: z.enum(['model_self_report', 'segmentation_score', 'none']), value: z.number().nullable(), note: z.string() })
                .strict(),
              requiresConfirmation: z.literal(true),
            })
            .strict(),
        ),
        abstained: z.boolean(),
        abstainReason: z.string().nullable(),
      })
      .strict(),
  },
  propose_plan_revision: {
    input: z
      .object({
        planId: Id,
        expectedContentHash: Sha256Hex,
        changes: z.array(z.object({ key: z.string().min(1), to: ValueRecord }).strict()).min(1),
      })
      .strict(),
    output: z
      .object({
        diff: z.array(z.object({ key: z.string(), from: ValueRecord.nullable(), to: ValueRecord }).strict()),
        recomputeRequired: z.array(z.enum(['stages', 'economics', 'water', 'tasks', 'visuals'])),
        requiresUserConfirmation: z.literal(true),
        validationErrors: z.array(z.string()),
      })
      .strict(),
  },
  request_segmentation: {
    input: z
      .object({
        mediaId: Id,
        /** Matches POST /media/:id/segmentation (T10): a short concept, a normalised box, or normalised points. */
        prompt: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('concept'), text: z.string().trim().min(1).max(40) }).strict(),
          z.object({ kind: z.literal('box'), x0: Normalized, y0: Normalized, x1: Normalized, y1: Normalized }).strict(),
          z
            .object({ kind: z.literal('points'), points: z.array(z.object({ x: Normalized, y: Normalized, positive: z.boolean().optional() }).strict()).min(1).max(16) })
            .strict(),
        ]),
      })
      .strict(),
    output: z
      .object({ jobId: Id.nullable(), budgetGate: z.enum(['reserved', 'checked', 'denied']), manualFallbackAvailable: z.literal(true) })
      .strict(),
  },
  request_visual_keyframes: {
    input: z.object({ planId: Id, briefId: Id, stageIds: z.array(Id).min(1).max(8) }).strict(),
    output: z
      .object({ jobId: Id.nullable(), deduplicated: z.boolean(), allowedStageCount: z.number().int().nonnegative(), budgetGate: z.enum(['reserved', 'checked', 'denied']) })
      .strict(),
  },
  get_job_status: {
    input: z.object({ jobId: Id }).strict(),
    output: z
      .object({ jobId: Id, state: JobState, progress: z.number().min(0).max(1), resultIds: z.array(Id), errorCode: z.string().nullable() })
      .strict(),
  },
} as const satisfies Record<ToolName, { input: z.ZodType; output: z.ZodType }>;

export type ToolInput<N extends ToolName> = z.infer<(typeof ToolSchemas)[N]['input']>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof ToolSchemas)[N]['output']>;

/** RFC 6901 JSON Pointer. */
export const JsonPointer = z.string().regex(/^(\/([^~\/]|~[01])*)*$/, 'expected an RFC 6901 JSON pointer');

export const NumericRef = z
  .object({
    id: Id,
    toolResultId: Id,
    jsonPointer: JsonPointer,
    presentation: z
      .object({
        unit: Unit,
        /** Source unit at the pointer; conversion to `unit` must be a permitted tested conversion. */
        sourceUnit: Unit,
        rounding: z.object({ mode: z.enum(['decimals', 'significant']), digits: z.number().int().min(0).max(6) }).strict(),
        intervalLabel: z.enum(['none', 'low', 'central', 'high', 'quantile']).default('none'),
      })
      .strict(),
  })
  .strict();
export type NumericRef = z.infer<typeof NumericRef>;

/** Spatial granularity a claim is stated at (F8: promoted from the agent-local extension). */
export const ClaimGranularity = z.enum(['district', 'state', 'region', 'national']);
export type ClaimGranularity = z.infer<typeof ClaimGranularity>;

/**
 * A claim and the evidence cited for it. `cropIds`, `productIds` and `granularity` are declared scope
 * (F8: promoted from the agent-local extension); the server gate checks them against server-derived
 * plan scope and the evidence rows, never trusting the declaration alone.
 */
export const ClaimEvidenceRef = z
  .object({
    claimId: Id,
    text: z.string().min(1).max(1000),
    evidenceIds: z.array(Id).min(1),
    cropIds: z.array(Id).max(10).optional(),
    /** Catalogue product ids (e.g. ginger-dry) when the claim is about a product form. */
    productIds: z.array(Id).max(10).optional(),
    granularity: ClaimGranularity.optional(),
  })
  .strict();
export type ClaimEvidenceRef = z.infer<typeof ClaimEvidenceRef>;

export const AssistantIntent = z.enum([
  'explore_crops',
  'compare_crops',
  'plan_question',
  'journal_update',
  'market_question',
  'water_question',
  'observation',
  'clarification_needed',
  'out_of_scope',
]);

export const ToolRequest = z
  .object({ callId: Id, tool: ToolName, input: z.unknown() })
  .strict()
  .superRefine((r, ctx) => {
    const parsed = ToolSchemas[r.tool].input.safeParse(r.input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', path: ['input', ...issue.path], message: issue.message });
      }
    }
  });
export type ToolRequest = z.infer<typeof ToolRequest>;

export const StructuredAssistantOutput = z
  .object({
    schemaVersion: SchemaVersion,
    intent: AssistantIntent,
    language: LanguageCode,
    proposedFacts: z.array(
      z.object({ field: z.string().min(1), value: ValueRecord, sourceSpan: z.string().max(500).nullable(), requiresConfirmation: z.literal(true) }).strict(),
    ),
    clarifications: z.array(
      z.object({ id: Id, question: z.string().min(1).max(500), field: z.string().nullable(), options: z.array(z.string()).max(6) }).strict(),
    ),
    toolRequests: z.array(ToolRequest).max(12),
    answerBlocks: z.array(
      z
        .object({
          id: Id,
          kind: z.enum(['text', 'numeric', 'warning', 'limitation', 'evidence']),
          text: z.string().min(1).max(4000),
          numericRefIds: z.array(Id),
          claimIds: z.array(Id),
        })
        .strict(),
    ),
    numericRefs: z.array(NumericRef),
    claimEvidenceRefs: z.array(ClaimEvidenceRef),
    proposedPlanChange: ToolSchemas.propose_plan_revision.input.optional(),
    limitations: z.array(z.string().min(1).max(1000)),
  })
  .strict()
  .superRefine((o, ctx) => {
    const refIds = new Set(o.numericRefs.map((r) => r.id));
    const claimIds = new Set(o.claimEvidenceRefs.map((c) => c.claimId));
    o.answerBlocks.forEach((b, i) => {
      b.numericRefIds.forEach((id, j) => {
        if (!refIds.has(id)) ctx.addIssue({ code: 'custom', path: ['answerBlocks', i, 'numericRefIds', j], message: `unknown numericRef ${id}` });
      });
      b.claimIds.forEach((id, j) => {
        if (!claimIds.has(id)) ctx.addIssue({ code: 'custom', path: ['answerBlocks', i, 'claimIds', j], message: `unknown claim ${id}` });
      });
      if (b.kind === 'numeric' && b.numericRefIds.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['answerBlocks', i], message: 'numeric block requires numericRefIds' });
      }
    });
  });
export type StructuredAssistantOutput = z.infer<typeof StructuredAssistantOutput>;
