import {z} from 'zod';
import {ModelInvocation} from './common';
import {BasisRef, CostEstimate, DateWindow, HarvestWindow, IntercropCompanion, NumberEstimate, NumberRange, PriceEstimate, ScoreComponents, ScoreWeights, YearPlanReason} from './year-plan';

/**
 * Crop fit v2 (ROUND2_SPEC.md section 4): every pool crop scored for one sowing date on this field with the year-plan
 * slot scoring, compared with the confirmed soil markers, and Meta's top three picks with reasons.
 */
const isoDate = z.iso.date();
const text = z.string().max(600);

export const CropFitMode = z.enum(['next', 'season', 'date']);
export const CropSeason = z.enum(['kharif', 'rabi', 'summer']);

export const SoilRating = z.enum(['very_low', 'low', 'medium', 'high', 'very_high', 'strongly_acidic', 'acidic', 'neutral', 'alkaline', 'strongly_alkaline', 'normal', 'critical', 'injurious', 'deficient', 'sufficient', 'unrated']);
export const NutrientNeed = z.enum(['low', 'medium', 'high']);

/** One confirmed field marker compared with the crop's need. */
export const SoilCheck = z.object({
 parameter: z.string().max(60),
 label: z.string().max(80),
 value: z.number().nullable(),
 unit: z.string().max(30).nullable(),
 rating: SoilRating,
 need: NutrientNeed.nullable(),
 verdict: z.enum(['ok', 'watch', 'short', 'unknown']),
 note: text.nullable(),
 /** Set when the soil rating rests on an inferred form (see SoilReading.assumption). */
 assumption: z.string().max(300).nullable(),
 markerId: z.string().max(100).nullable(),
 sampleId: z.uuid().nullable(),
 collectionDate: isoDate.nullable(),
 ratingSource: z.object({id: z.string().max(80), title: z.string().max(200), url: z.url().nullable()}).strict().nullable(),
}).strict();

export const CropFitCandidate = z.object({
 cropId: z.string().max(120),
 productId: z.string().max(200),
 cropName: z.string().max(120),
 productName: z.string().max(120),
 establishmentMethod: z.string().max(80).nullable(),
 /** Round 3: an intercrop candidate is the main crop (these fields) plus `companion`. Absent = 'crop'. */
 kind: z.enum(['crop', 'intercrop']).optional(),
 companion: IntercropCompanion.nullable().optional(),
 rank: z.number().int().positive(),
 /** The year-plan per-slot display score for this crop at this sowing date (identical to the plan's slot score). */
 score: z.number().min(0).max(100),
 /** Round 3 (ROUND3_SPEC.md section 5): score minus the wait penalty for the idle time before sowing; the ranking key. */
 rankScore: z.number().min(0).max(100).optional(),
 /** Idle days between the field release (or the requested date) and this sowing date, and the penalty in score points. */
 waitDays: z.number().int().nonnegative().nullable().optional(),
 waitPenalty: z.number().min(0).max(100).nullable().optional(),
 /** Labels of the current year plan's options whose first suggested slot is this crop and product. */
 yearPlanLabels: z.array(z.string().max(60)).max(5).optional(),
 /** The farm's own history with this crop (recorded cycles), for the swap sheet. */
 grownBefore: z.object({cycles: z.number().int().nonnegative(), lastSowing: isoDate.nullable(), lastHarvest: isoDate.nullable()}).strict().nullable().optional(),
 components: ScoreComponents,
 sowing: isoDate,
 harvest: HarvestWindow,
 durationDays: NumberRange,
 /**
  * Saved-season swap (docs/research/YEAR_PLAN_SAVED_SEASONS.md): the engine's occupancy of this candidate on the field, sowing
  * to release (the later of the main and companion harvest plus the land-preparation gap), so a swap can be checked against
  * the other saved seasons with the engine's own rule; and the companion's harvest window for an intercrop (null otherwise),
  * so the saved season keeps the field until the companion is harvested, as apply does.
  */
 occupancy: DateWindow.optional(),
 companionHarvest: HarvestWindow.nullable().optional(),
 window: z.object({scope: z.enum(['district', 'state']), season: CropSeason, fit: z.number().min(0).max(1), shiftedDays: z.number().int()}).strict().nullable(),
 yieldKgPerHa: NumberRange.nullable(),
 yieldBasis: z.enum(['district', 'state', 'reference', 'farmer']).nullable(),
 /** Round 3: yieldKgPerHa times the field area; null when the area is unknown. */
 yieldForFieldKg: NumberRange.nullable().optional(),
 price: PriceEstimate.nullable(),
 /** Latest state or district mandi p50 over the last 14 trading days, INR/kg. */
 marketNow: z.object({p50: z.number(), date: isoDate, markets: z.number().int().nonnegative(), scopeLabel: z.string().max(160)}).strict().nullable(),
 cost: CostEstimate.nullable(),
 profitPerHa: NumberEstimate.nullable(),
 profitForField: NumberEstimate.nullable(),
 soil: z.object({status: z.enum(['no_report', 'compared']), checks: z.array(SoilCheck).max(12)}).strict(),
 water: z.object({fit: z.number().min(0).max(1), needMm: z.number().nullable(), rainMm: z.number().nullable(), verdict: z.string().max(160)}).strict(),
 rotation: z.object({previousCropId: z.string().nullable(), rule: z.string().max(60), note: text.nullable()}).strict(),
 confidence: z.enum(['high', 'medium', 'low']),
 reasonCodes: z.array(z.string().max(60)).max(10),
 uncertainties: z.array(text).max(10),
 basis: z.array(BasisRef).max(20),
}).strict();

export const CropFitPick = z.object({
 cropId: z.string().max(120),
 productId: z.string().max(200),
 /** Round 3: the intercrop system of the picked candidate, so a crop ranked both alone and as an intercrop is matched exactly; null for a sole crop. */
 systemId: z.string().max(120).nullable().optional(),
 rank: z.number().int().min(1).max(3),
 /** At most 12 words, no digits; written by Meta or by code (pickOrigin). */
 headline: z.string().max(120),
 reasons: z.array(YearPlanReason).max(3),
}).strict();

export const CropFitRequest = z.object({
 mode: CropFitMode,
 season: CropSeason.nullable(),
 sowing: isoDate.nullable(),
 /** Round 3: previous-crop override for mode=date (the swap sheet passes the crop before the edited slot); null = the field's own history. */
 after: z.string().max(120).nullable().optional(),
}).strict();

export const CropFitReview = z.object({
 reviewId: z.uuid().nullable(),
 jobId: z.uuid().nullable(),
 contextHash: z.string().nullable(),
 status: z.enum(['pending', 'running', 'ready', 'unavailable', 'error']),
 stale: z.boolean(),
 request: CropFitRequest,
 /** The sowing date the ranking used (resolved from the mode). */
 resolvedSowing: isoDate.nullable(),
 previousCropId: z.string().nullable(),
 currentCycleId: z.string().nullable(),
 fieldAreaHa: z.number().nullable(),
 generatedAt: z.iso.datetime().nullable(),
 modelInvocation: ModelInvocation.nullable(),
 picks: z.array(CropFitPick).max(3),
 pickOrigin: z.enum(['model', 'deterministic']).nullable(),
 candidates: z.array(CropFitCandidate).max(40),
 /** Round 3: the ready year plan review the candidates were cross-referenced with (yearPlanLabels), when one exists. */
 yearPlanReviewId: z.uuid().nullable().optional(),
 weights: ScoreWeights,
 soilReportStatus: z.enum(['none', 'unconfirmed', 'confirmed']),
 summary: text,
 limitations: z.array(text),
}).strict();

export type CropFitMode = z.infer<typeof CropFitMode>;
export type CropSeason = z.infer<typeof CropSeason>;
export type SoilRating = z.infer<typeof SoilRating>;
export type NutrientNeed = z.infer<typeof NutrientNeed>;
export type SoilCheck = z.infer<typeof SoilCheck>;
export type CropFitCandidate = z.infer<typeof CropFitCandidate>;
export type CropFitPick = z.infer<typeof CropFitPick>;
export type CropFitRequest = z.infer<typeof CropFitRequest>;
export type CropFitReview = z.infer<typeof CropFitReview>;
