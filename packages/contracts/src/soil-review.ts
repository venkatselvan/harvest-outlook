import {z} from 'zod';
import {ModelInvocation} from './common';
import {NutrientNeed, SoilRating} from './crop-fit';

/**
 * Soil review (ROUND2_SPEC.md section 5): confirmed soil markers rated against cited soil-test bands (code), drawn as
 * biomarker bars, with a short Meta narrative written from code facts (digits only from the facts).
 */
const isoDate = z.iso.date();
const text = z.string().max(600);

export const SoilRatingBand = z.object({
 label: SoilRating,
 /** Inclusive lower bound (null = open). */
 from: z.number().nullable(),
 /** Exclusive upper bound (null = open), unless the source states otherwise in `note`. */
 to: z.number().nullable(),
 note: z.string().max(200).nullable(),
}).strict();

export const SoilRatingSource = z.object({id: z.string().max(80), title: z.string().max(200), url: z.url().nullable(), locator: z.string().max(200).nullable(), verified: z.boolean()}).strict();

export const SoilReading = z.object({
 markerId: z.string().max(100),
 sampleId: z.uuid(),
 reportId: z.uuid(),
 parameter: z.string().max(60),
 label: z.string().max(120),
 value: z.number().nullable(),
 unit: z.string().max(30).nullable(),
 /** The value converted to the rating unit when a conversion was needed. */
 ratedValue: z.number().nullable(),
 ratedUnit: z.string().max(30).nullable(),
 rating: SoilRating,
 status: z.enum(['rated', 'unrated', 'unit_mismatch', 'qualifier']),
 /** Set when the rating rests on an inferred form (for example "pool not printed; rated as available N, the usual soil health card form in kg/ha"). */
 assumption: z.string().max(300).nullable(),
 /** Why a marker is not rated (or a caveat on a rated one); shown per row. */
 note: z.string().max(300).nullable().optional(),
 bands: z.array(SoilRatingBand).max(8),
 /** Drawing axis covering every band with a margin. */
 axis: z.object({min: z.number(), max: z.number()}).strict().nullable(),
 source: SoilRatingSource.nullable(),
 collectionDate: isoDate.nullable(),
 method: z.string().max(300).nullable(),
 cropNeed: z.object({cropId: z.string().max(120), cropName: z.string().max(120), need: NutrientNeed.nullable(), note: text.nullable()}).strict().nullable(),
 nextCropNeed: z.object({cropId: z.string().max(120), cropName: z.string().max(120), need: NutrientNeed.nullable(), note: text.nullable()}).strict().nullable(),
}).strict();

export const SoilNarrative = z.object({
 lines: z.array(z.string().max(160)).max(5),
 afterHarvest: z.array(z.string().max(160)).max(3),
 nextCrop: z.array(z.string().max(160)).max(3),
}).strict();

export const SoilReview = z.object({
 reviewId: z.uuid().nullable(),
 jobId: z.uuid().nullable(),
 farmId: z.uuid(),
 contextHash: z.string().nullable(),
 status: z.enum(['pending', 'running', 'ready', 'unavailable', 'error', 'no_report']),
 stale: z.boolean(),
 generatedAt: z.iso.datetime().nullable(),
 modelInvocation: ModelInvocation.nullable(),
 readings: z.array(SoilReading).max(100),
 currentCrop: z.object({cycleId: z.string(), cropId: z.string(), cropName: z.string().max(120)}).strict().nullable(),
 nextCrop: z.object({cropId: z.string(), cropName: z.string().max(120), source: z.enum(['year_plan_applied', 'saved_season'])}).strict().nullable(),
 /** Code facts the narrative was written from. */
 facts: z.array(z.string().max(200)).max(12),
 narrative: SoilNarrative.nullable(),
 narrativeOrigin: z.enum(['model', 'deterministic']).nullable(),
 ratingsVersion: z.string().max(40),
 limitations: z.array(text),
}).strict();

export type SoilRatingBand = z.infer<typeof SoilRatingBand>;
export type SoilRatingSource = z.infer<typeof SoilRatingSource>;
export type SoilReading = z.infer<typeof SoilReading>;
export type SoilNarrative = z.infer<typeof SoilNarrative>;
export type SoilReview = z.infer<typeof SoilReview>;
