import {z} from 'zod';
import {FutureLookStatus} from './future-look';
import {FieldId} from './workspace';

/**
 * Crop journey (2026-11-04, docs/research/EVARA_ACTIONS_SPEC.md section 3): an arbitrary crop's growth cycle on this field as
 * up to five generated stage illustrations (Meta image edits of the field's latest usable Sentinel-2 scene, else its latest
 * owner photo with a confirmed region, inside the field outline, QA-checked). Illustrations only: never field data, never a
 * prediction of yield or health. Stage dates come from the season-preview service (code).
 */
const isoDate = z.iso.date();

export const CropJourneyRequest = z.object({
 cropId: z.string().max(120),
 productId: z.string().max(200).optional(),
 fieldId: FieldId.optional(),
 /** Default: the stored crop-fit candidate's sowing for this crop on the field, else today (IST). */
 sowingDate: isoDate.optional(),
}).strict();
export type CropJourneyRequest = z.infer<typeof CropJourneyRequest>;

export const CropJourneyStageStatus = z.enum([...FutureLookStatus.options, 'schematic']);
export type CropJourneyStageStatus = z.infer<typeof CropJourneyStageStatus>;

export const CropJourneyStage = z.object({
 stageId: z.string().max(80),
 name: z.string().max(80),
 from: isoDate,
 to: isoDate,
 /** The date the illustration is for (the stage start, or the first stage's sowing date). */
 targetDate: isoDate,
 /** True for the stages chosen for an image (first, last and up to three between); false = schematic only. */
 illustrated: z.boolean(),
 status: CropJourneyStageStatus,
 reason: z.string().max(80).nullable(),
 assetId: z.uuid().nullable(),
 /** Owner-private path on this API (GET /farms/:id/future-look/:assetId/image), only when ready. */
 imagePath: z.string().nullable(),
 /** The code-written guidance sentence that went into the prompt. */
 guidance: z.string().max(400).nullable(),
 label: z.string().max(120),
}).strict();
export type CropJourneyStage = z.infer<typeof CropJourneyStage>;

export const CropJourneyStatus = z.enum(['queued', 'running', 'ready', 'partial', 'failed', 'unavailable']);
export type CropJourneyStatus = z.infer<typeof CropJourneyStatus>;

export const CropJourney = z.object({
 journeyId: z.uuid(),
 farmId: z.uuid(),
 fieldId: FieldId.nullable(),
 cropId: z.string().max(120),
 cropName: z.string().max(120),
 productId: z.string().max(200).nullable(),
 sowingDate: isoDate,
 status: CropJourneyStatus,
 /** Why the journey is unavailable or failed as a whole (runtime_mode, no_source_image, budget, daily_cap, ...); null otherwise. */
 reason: z.string().max(80).nullable(),
 source: z.object({kind: z.enum(['satellite', 'photo', 'none']), itemId: z.string().max(200).nullable(), date: isoDate.nullable()}).strict(),
 /** True when an existing journey (same crop, field and IST day) was returned instead of a new one being queued. */
 deduplicated: z.boolean(),
 stages: z.array(CropJourneyStage).min(1).max(12),
 disclaimer: z.string().max(300),
 limitations: z.array(z.string().max(300)).max(10),
 createdAt: z.iso.datetime(),
 updatedAt: z.iso.datetime(),
}).strict();
export type CropJourney = z.infer<typeof CropJourney>;
