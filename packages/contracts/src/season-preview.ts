import {z} from 'zod';
import {SoilCheck} from './crop-fit';
import {FieldId} from './workspace';
import {BasisRef, CostEstimate, HarvestWindow, IntercropCompanion, NumberEstimate, NumberRange, ScoreComponents, StageTimeline} from './year-plan';

/**
 * Season preview (ROUND3_SPEC.md section 7): what a planned season would look like on this field, in the shape of the
 * Today view but for a future sowing date. Everything is a calculated reference (stage calendar, typical weather of past
 * years, the historical seasonal price path, the year-plan slot scoring); nothing here is a forecast or an observation.
 */
const isoDate = z.iso.date();
const text = z.string().max(600);

export const SeasonPreviewQuery = z.object({
 /** A saved season (workspace rotationPlans id). When set, the other fields are read from it. */
 planId: z.string().max(120).optional(),
 cropId: z.string().max(120).optional(),
 productId: z.string().max(200).optional(),
 sowing: isoDate.optional(),
 harvestLatest: isoDate.optional(),
 establishmentMethod: z.string().max(80).optional(),
 /** Intercrop system id (intercropping.json) when previewing an intercrop slot. */
 systemId: z.string().max(120).optional(),
 /** 2026-11-03: preview on this field (its cycles, saved seasons, year plan and area); absent = the whole farm. */
 fieldId: FieldId.optional(),
}).strict();

export const SeasonPreviewMonth = z.object({
 /** First day of the month. */
 month: isoDate,
 label: z.string().max(20),
 rainMm: z.number().nullable(),
 tMaxC: z.number().nullable(),
 tMinC: z.number().nullable(),
 /** Days of the month inside the season. */
 days: z.number().int().min(0).max(31),
}).strict();

export const SeasonPreviewPricePoint = z.object({weekStart: isoDate, p50: z.number().nullable(), likely: NumberRange.nullable()}).strict();

export const SeasonPreviewStep = z.object({
 kind: z.enum(['care', 'stage', 'harvest']),
 title: z.string().max(160),
 from: isoDate,
 to: isoDate,
 detail: z.string().max(1000).nullable(),
 source: z.object({id: z.string().max(80), publisher: z.string().max(200)}).strict().nullable(),
}).strict();

export const SeasonPreview = z.object({
 farmId: z.uuid(),
 planId: z.string().max(120).nullable(),
 origin: z.enum(['saved_season', 'custom']),
 cropId: z.string().max(120),
 cropName: z.string().max(120),
 productId: z.string().max(200).nullable(),
 productName: z.string().max(120).nullable(),
 establishmentMethod: z.string().max(80).nullable(),
 kind: z.enum(['crop', 'green_manure', 'intercrop']),
 companion: IntercropCompanion.nullable(),
 today: isoDate,
 sowing: isoDate,
 harvest: HarvestWindow.nullable(),
 fieldAreaHa: z.number().nullable(),
 timeline: StageTimeline.nullable(),
 weather: z.object({
  status: z.enum(['typical', 'unavailable']),
  months: z.array(SeasonPreviewMonth).max(14),
  source: z.object({sourceId: z.string().max(120), years: z.object({from: z.number().int(), to: z.number().int()}).strict()}).strict().nullable(),
  note: text,
 }).strict(),
 water: z.object({fit: z.number().min(0).max(1), needMm: z.number().nullable(), rainMm: z.number().nullable(), verdict: z.string().max(160)}).strict().nullable(),
 price: z.object({
  status: z.enum(['available', 'insufficient']),
  unit: z.literal('INR/kg'),
  harvestWeek: z.string().max(10).nullable(),
  p50: z.number().nullable(),
  likely: NumberRange.nullable(),
  scopeLabel: z.string().max(160),
  yearsUsed: z.array(z.number().int()),
  /** Weekly historical seasonal reference from sowing to four weeks after the latest harvest, at most 60 points. */
  path: z.array(SeasonPreviewPricePoint).max(60),
  reason: z.string().max(80).nullable(),
 }).strict().nullable(),
 marketNow: z.object({p50: z.number(), date: isoDate, markets: z.number().int().nonnegative(), scopeLabel: z.string().max(160)}).strict().nullable(),
 yieldKgPerHa: NumberRange.nullable(),
 yieldBasis: z.enum(['district', 'state', 'reference', 'farmer']).nullable(),
 yieldForFieldKg: NumberRange.nullable(),
 cost: CostEstimate.nullable(),
 profitPerHa: NumberEstimate.nullable(),
 profitForField: NumberEstimate.nullable(),
 score: z.number().min(0).max(100).nullable(),
 components: ScoreComponents.nullable(),
 reasonCodes: z.array(z.string().max(60)).max(10),
 steps: z.array(SeasonPreviewStep).max(40),
 soil: z.object({status: z.enum(['no_report', 'compared']), checks: z.array(SoilCheck).max(12)}).strict().nullable(),
 basis: z.array(BasisRef).max(30),
 limitations: z.array(text),
 /** 2026-11-03: the field previewed (`?fieldId=`); absent = the whole farm. */
 fieldId: FieldId.optional(),
}).strict();

export type SeasonPreviewQuery = z.infer<typeof SeasonPreviewQuery>;
export type SeasonPreviewMonth = z.infer<typeof SeasonPreviewMonth>;
export type SeasonPreviewStep = z.infer<typeof SeasonPreviewStep>;
export type SeasonPreview = z.infer<typeof SeasonPreview>;
