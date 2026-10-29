import { z } from 'zod';
import { Id, IsoDate, IsoDateTime, Mode, SchemaVersion, SpatialScope } from './common';

export const CoverageCapability = z.enum([
  'screening_supported',
  'historical_reference_available',
  'forecast_evaluated',
  'visual_journey_supported',
  'observation_interpretation_experimental',
]);
export type CoverageCapability = z.infer<typeof CoverageCapability>;

export const SupportStatus = z.enum(['supported', 'partial', 'unsupported', 'unknown']);
export type SupportStatus = z.infer<typeof SupportStatus>;

const count = z.number().int().nonnegative();
const fraction = z.number().min(0).max(1);

/**
 * Typed per-capability measured quality. There is deliberately no single
 * confidence number (BUILD_SPEC 5.1): each capability reports what was measured.
 */
export const ScreeningQuality = z
  .object({
    approvedRules: count,
    candidateRules: count,
    labelledChecksPassed: count,
    labelledChecksTotal: count,
  })
  .strict();
export const HistoricalReferenceQuality = z
  .object({
    firstDate: IsoDate,
    lastDate: IsoDate,
    observationCount: count,
    weeksWithData: count,
    weeksInRange: count,
    seasonsCovered: count,
  })
  .strict();
export const ForecastQuality = z
  .object({
    metric: z.enum(['mae', 'scaled_mae', 'quantile_loss', 'weighted_interval_score']),
    value: z.number().nonnegative(),
    baselineId: Id,
    baselineValue: z.number().nonnegative().nullable(),
    intervalNominal: fraction.nullable(),
    intervalEmpiricalCoverage: fraction.nullable(),
    testSamples: count,
    testSeasons: count,
    abstentions: count,
    evaluationReportId: Id,
  })
  .strict();
export const VisualJourneyQuality = z
  .object({
    stagesSourced: count,
    stagesTotal: count,
    assetsQaPassed: count,
    assetsTotal: count,
  })
  .strict();
export const ObservationInterpretationQuality = z
  .object({
    labelledExamples: count,
    agreementRate: fraction.nullable(),
    abstentionRate: fraction.nullable(),
    evaluationReportId: Id.nullable(),
  })
  .strict();

const CoverageCommon = {
  schemaVersion: SchemaVersion,
  id: Id,
  mode: Mode,
  cropId: Id,
  productId: Id.nullable(),
  region: SpatialScope,
  season: z.string().min(1).nullable(),
  irrigation: z.string().min(1).nullable(),
  marketId: Id.nullable(),
  horizonDays: z.number().int().nonnegative().nullable(),
  supportStatus: SupportStatus,
  sourceVersions: z.array(z.string().min(1)),
  modelVersions: z.array(z.string().min(1)),
  assessedAt: IsoDateTime,
  reviewBy: IsoDate,
  expiresAt: IsoDate.nullable(),
  missingReason: z.string().min(1).nullable(),
};

function variant<C extends string, Q extends z.ZodType>(capability: C, quality: Q) {
  return z.object({ ...CoverageCommon, capability: z.literal(capability), measuredQuality: quality.nullable() }).strict();
}

export const CoverageRecord = z
  .discriminatedUnion('capability', [
    variant('screening_supported', ScreeningQuality),
    variant('historical_reference_available', HistoricalReferenceQuality),
    variant('forecast_evaluated', ForecastQuality),
    variant('visual_journey_supported', VisualJourneyQuality),
    variant('observation_interpretation_experimental', ObservationInterpretationQuality),
  ])
  .superRefine((c, ctx) => {
    const positive = c.supportStatus === 'supported' || c.supportStatus === 'partial';
    if (positive && c.measuredQuality === null) {
      ctx.addIssue({ code: 'custom', path: ['measuredQuality'], message: 'supported/partial coverage requires measured quality' });
    }
    if (!positive && c.missingReason === null) {
      ctx.addIssue({ code: 'custom', path: ['missingReason'], message: 'unsupported/unknown coverage requires missingReason' });
    }
    if (c.capability === 'forecast_evaluated' && positive) {
      if (c.productId === null || c.marketId === null || c.horizonDays === null) {
        ctx.addIssue({ code: 'custom', message: 'forecast_evaluated support requires productId, marketId and horizonDays' });
      }
    }
    if (c.expiresAt !== null && c.expiresAt < c.assessedAt.slice(0, 10)) {
      ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt precedes assessedAt' });
    }
  });
export type CoverageRecord = z.infer<typeof CoverageRecord>;
