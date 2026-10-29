import { z } from './common.ts';

const Ids = z.array(z.string().min(1));
const Month = z.number().int().min(1).max(12);
export const Season = z.enum(['kharif', 'rabi', 'zaid', 'perennial']);
export const Irrigation = z.enum(['rainfed', 'supplemental', 'irrigated', 'any', 'unspecified']);

export const RegionalContext = z
  .object({
    contextId: z.string().min(1),
    geography: z.object({ level: z.enum(['state', 'region', 'national']), ids: z.array(z.string().min(1)).min(1) }).strict(),
    /** Set for single-state contexts; null for multi-state/region/national statements. */
    stateId: z.string().nullable(),
    districtIds: z.array(z.string()).nullable(),
    season: Season,
    plantingWindow: z.object({ fromMonth: Month, toMonth: Month, evidenceIds: Ids.min(1) }).strict(),
    durationDays: z.object({ min: z.number().nullable(), max: z.number().nullable(), evidenceIds: Ids.min(1) }).strict().nullable(),
    irrigation: Irrigation,
    irrigationEvidenceIds: Ids,
    waterNeedClass: z.object({ class: z.enum(['low', 'medium', 'high']), evidenceIds: Ids.min(1) }).strict().nullable(),
    soilNotes: z.object({ text: z.string().min(1), evidenceIds: Ids.min(1) }).strict().nullable(),
    yieldReference: z
      .object({ min: z.number(), max: z.number(), unit: z.literal('kg/ha'), basis: z.literal('regional_reference'), productId: z.string(), evidenceIds: Ids.min(1) })
      .strict()
      .nullable(),
    labourClass: z.enum(['low', 'medium', 'high']).nullable(),
    harvestPattern: z.enum(['single', 'repeated_picking', 'staggered']),
    notes: z.string(),
  })
  .strict();

export const CropProfile = z
  .object({
    cropId: z.string().min(1),
    identityRef: z.string().min(1),
    group: z.string().min(1),
    products: z.array(z.object({ productId: z.string(), name: z.string(), productBasis: z.string() }).strict()).min(1),
    regionalContexts: z.array(RegionalContext),
    exclusionsOrCautions: z.array(z.object({ text: z.string().min(1), evidenceIds: Ids.min(1) }).strict()),
    marketCoverageStatus: z.literal('unavailable_pending_price_access'),
    evidenceIds: Ids,
    qualification: z
      .object({
        identityResolved: z.boolean(),
        hasRegionalContext: z.boolean(),
        hasSourcedRequirements: z.boolean(),
        hasSeasonInfo: z.boolean(),
        marketStatusExplicit: z.boolean(),
        qualified: z.boolean(),
        missing: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type CropProfile = z.infer<typeof CropProfile>;
