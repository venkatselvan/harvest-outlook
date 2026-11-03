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
import { FieldId } from './workspace';

export { ToolName };

/**
 * Tool inputs never carry ownerId or mode: both are server-derived (BUILD_SPEC 9).
 * Ids referencing owned resources are authorized server-side on every call.
 */
const Normalized = z.number().min(0).max(1);

/**
 * get_farm_briefing (2026-11-02, docs/research/ASSISTANT_FARM_BRIEFING_SPEC.md): the selected farm's current state composed by
 * code from read-only services. Every quantity is a unit record ({value, unit} or {value: {low, central?, high}, unit}) at a
 * pointer listed in the API's UNIT_RECORD_OWNERS; dates are ISO strings; no farm name, coordinates, owner or session ids.
 */
const BQ = z.object({ value: z.number(), unit: Unit }).strict();
const BR = z.object({ value: z.object({ low: z.number(), central: z.number().optional(), high: z.number() }).strict(), unit: Unit }).strict();
const bText = (n: number) => z.string().max(n);
const BriefingStep = z
  .object({ id: bText(160), kind: bText(40), title: bText(160), detail: bText(240).nullable(), dueFrom: IsoDate, dueTo: IsoDate, status: bText(20) })
  .strict();
const BriefingWeatherDay = z.object({ date: IsoDate, rainMm: BQ.nullable(), tMinC: BQ.nullable(), tMaxC: BQ.nullable() }).strict();
export const FarmBriefing = z
  .object({
    asOf: IsoDateTime,
    today: IsoDate,
    farm: z
      .object({
        districtId: bText(120).nullable(),
        districtName: bText(120).nullable(),
        stateId: bText(20).nullable(),
        stateName: bText(120).nullable(),
        area: BQ.nullable(),
        waterCategory: bText(60).nullable(),
        labour: bText(60).nullable(),
        budget: BQ.nullable(),
      })
      .strict(),
    cycle: z
      .object({
        cropId: bText(120),
        cropName: bText(120),
        productId: bText(200).nullable(),
        productName: bText(120).nullable(),
        sowingDate: IsoDate,
        establishmentDate: IsoDate.nullable(),
        establishmentMethod: bText(80).nullable(),
        workspaceStage: bText(20),
        dayOfSeason: BQ.nullable(),
        stageToday: z.object({ id: bText(80), name: bText(80), from: IsoDate, to: IsoDate, basis: bText(20) }).strict().nullable(),
        nextStage: z.object({ id: bText(80), name: bText(80), from: IsoDate, to: IsoDate }).strict().nullable(),
        harvestWindow: z.object({ earliest: IsoDate, latest: IsoDate }).strict().nullable(),
        daysToHarvest: BR.nullable(),
        timelineBasis: bText(200).nullable(),
        satellitePhase: z.object({ status: bText(20), phase: bText(20), asOf: IsoDate.nullable(), agreement: bText(20), summary: bText(300) }).strict().nullable(),
      })
      .strict()
      .nullable(),
    weather: z
      .object({
        source: bText(120).nullable(),
        issuedAt: IsoDateTime.nullable(),
        observed: z.array(BriefingWeatherDay).max(7),
        forecast: z.array(BriefingWeatherDay).max(7),
        rainLast7Days: BQ.nullable(),
        rainNext7Days: BQ.nullable(),
      })
      .strict()
      .nullable(),
    satellite: z
      .object({
        latestDate: IsoDate.nullable(),
        ndvi: BQ.nullable(),
        neighbourhoodNdvi: BQ.nullable(),
        typicalRange: BR.nullable(),
        verdict: bText(20).nullable(),
        clearShare: BQ.nullable(),
        previous: z.object({ date: IsoDate, ndvi: BQ }).strict().nullable(),
        indices: z.array(z.object({ name: bText(10), mean: BQ }).strict()).max(7),
        source: bText(200),
      })
      .strict()
      .nullable(),
    alerts: z
      .array(
        z
          .object({ id: bText(60), type: bText(20), severity: bText(10), title: bText(120), detail: bText(300), validFrom: IsoDate, validTo: IsoDate, suggestedStep: bText(300).nullable(), source: bText(200), sourceDate: IsoDate })
          .strict(),
      )
      .max(5),
    steps: z.object({ nextAction: BriefingStep.nullable(), upcoming: z.array(BriefingStep).max(8) }).strict(),
    price: z
      .object({
        status: bText(20),
        scopeLabel: bText(160),
        harvestDate: IsoDate.nullable(),
        harvestPrice: BQ.nullable(),
        likelyRange: BR.nullable(),
        latestObserved: z.object({ date: IsoDate, median: BQ }).strict().nullable(),
        outlook: bText(300).nullable(),
      })
      .strict()
      .nullable(),
    economics: z
      .object({
        harvest: z
          .object({ status: bText(20), reason: bText(120).nullable(), yieldForField: BR.nullable(), revenueForField: BR.nullable(), costPerHa: BQ.nullable(), profitForField: BR.nullable(), limitations: z.array(bText(240)).max(3) })
          .strict()
          .optional(),
        residue: z
          .object({
            status: bText(20),
            reason: bText(120).nullable(),
            residueName: bText(80).nullable(),
            surplusForField: BR.nullable(),
            options: z.array(z.object({ label: bText(80), incomeForField: BR.nullable() }).strict()).max(4),
            limitations: z.array(bText(240)).max(3),
          })
          .strict()
          .optional(),
        energy: z
          .object({ status: bText(20), reason: bText(120).nullable(), inputEnergyForField: BR.nullable(), residueEnergyForField: BR.nullable(), limitations: z.array(bText(240)).max(3) })
          .strict()
          .optional(),
        carbon: z
          .object({
            status: bText(20),
            reason: bText(120).nullable(),
            emissionsForField: BR.nullable(),
            largestTerm: z.object({ label: bText(80), amount: BR }).strict().nullable(),
            limitations: z.array(bText(240)).max(3),
          })
          .strict()
          .optional(),
      })
      .strict()
      .nullable(),
    soil: z
      .object({
        status: bText(20),
        samples: z.array(z.object({ reportDate: IsoDate.nullable(), collectionDate: IsoDate.nullable(), depth: BR.nullable() }).strict()).max(4),
        readings: z
          .array(z.object({ parameter: bText(60), label: bText(120), measured: BQ.nullable(), rating: bText(30), status: bText(20), assumption: bText(300).nullable() }).strict())
          .max(16),
        facts: z.array(bText(200)).max(12),
        narrative: z.array(bText(160)).max(11).nullable(),
        narrativeOrigin: bText(20).nullable(),
        ratedFor: z.object({ currentCrop: bText(120).nullable(), nextCrop: bText(120).nullable() }).strict(),
      })
      .strict()
      .nullable(),
    plans: z
      .object({
        status: bText(20),
        stale: z.boolean(),
        option: z
          .object({
            label: bText(60),
            chosen: z.boolean(),
            slots: z
              .array(
                z
                  .object({
                    cropName: bText(120),
                    productName: bText(120),
                    kind: bText(20),
                    fixed: z.boolean(),
                    sowing: IsoDate,
                    harvest: z.object({ earliest: IsoDate, latest: IsoDate }).strict(),
                    yield: BR.nullable(),
                    harvestPrice: BQ.nullable(),
                    cost: BQ.nullable(),
                    margin: BR.nullable(),
                  })
                  .strict(),
              )
              .max(6),
          })
          .strict()
          .nullable(),
        savedSeasons: z
          .array(z.object({ year: z.number().int(), season: bText(80), cropName: bText(120), productName: bText(120).nullable(), kind: bText(20), plannedSowingDate: IsoDate.nullable(), plannedHarvestDate: IsoDate.nullable() }).strict())
          .max(6),
        previousHarvest: z.object({ status: bText(20), cropName: bText(120).nullable(), harvestDate: IsoDate.nullable() }).strict().nullable(),
      })
      .strict()
      .nullable(),
    cropFit: z
      .object({ generatedAt: IsoDateTime.nullable(), picks: z.array(z.object({ rank: z.number().int(), cropId: bText(120), cropName: bText(120), productName: bText(120), reason: bText(160) }).strict()).max(3) })
      .strict()
      .nullable(),
    journal: z
      .object({
        entries: z
          .array(z.object({ date: IsoDate, kind: bText(40), text: bText(120).nullable(), quantity: BQ.nullable(), expense: BQ.nullable(), sale: BQ.nullable() }).strict())
          .max(8),
        totalsSinceSowing: z.object({ from: IsoDate, sales: BQ, expenses: BQ, entries: z.number().int().nonnegative() }).strict().nullable(),
      })
      .strict()
      .nullable(),
    /** 2026-11-03: fields inside the farm; viewedField names the field the briefing describes (12.5: the selected field, else the first field with a current crop), null when it describes the whole farm. */
    fields: z.object({ count: z.number().int().nonnegative(), viewedField: bText(80).nullable() }).strict().optional(),
    limitations: z.array(bText(300)).max(30),
  })
  .strict();
export type FarmBriefing = z.infer<typeof FarmBriefing>;

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
  get_farm_briefing: {
    /** 2026-11-03: fieldId = the field selected in the shell; the briefing then describes that field (12.5). */
    input: z.object({ farmId: Id, fieldId: FieldId.optional() }).strict(),
    output: FarmBriefing,
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
