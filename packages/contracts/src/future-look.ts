import {z} from 'zod';

/**
 * Future-look illustration contracts (Today satellite view). A future look is a generated illustration of a typical
 * stage, made by editing a real Sentinel-2 scene inside the field outline; it is never an observation or a prediction.
 * The worker job `today.future-look` and the owner-private routes under /api/v1/farms/:id/future-look serve these shapes.
 */

export const FutureLookStatus = z.enum(['queued', 'running', 'ready', 'failed', 'unavailable']);
export type FutureLookStatus = z.infer<typeof FutureLookStatus>;

export const FutureLookRequestResult = z.object({
  assetId: z.uuid().nullable(),
  status: FutureLookStatus,
  /** failure/unavailability code, else null. */
  reason: z.string().max(80).nullable(),
  cycleId: z.string().max(120).nullable(),
  stageId: z.string().max(80),
  /** True when an existing asset was returned instead of a new generation being queued. */
  deduplicated: z.boolean(),
}).strict();
export type FutureLookRequestResult = z.infer<typeof FutureLookRequestResult>;

export const FutureLookQa = z.object({
  version: z.string(),
  passed: z.boolean(),
  reasons: z.array(z.enum(['output_undecodable', 'aspect_mismatch', 'outside_region_too_small', 'scene_changed_outside_field'])),
  scores: z.object({
    outsideChannelMad: z.object({r: z.number(), g: z.number(), b: z.number()}).strict().nullable(),
    outsideMaxChannelMad: z.number().nullable(),
    insideMeanAbsDiff: z.number().nullable(),
    outsideFraction: z.number().nullable(),
    aspectError: z.number().nullable(),
    outputWidth: z.number().int().nullable(),
    outputHeight: z.number().int().nullable(),
  }).strict(),
  thresholds: z.object({outsideChannelMadMax: z.number(), boundaryMarginPx: z.number().int(), aspectTolerance: z.number(), minOutsideFraction: z.number(), grid: z.string()}).strict(),
}).strict();
export type FutureLookQa = z.infer<typeof FutureLookQa>;

export const FutureLookAsset = z.object({
  assetId: z.uuid(),
  farmId: z.uuid(),
  cycleId: z.string(),
  stageId: z.string(),
  stageName: z.string(),
  cropId: z.string(),
  cropName: z.string(),
  sourceItemId: z.string(),
  sourceAcquiredAt: z.iso.datetime().nullable(),
  /** Real acquisition date (UTC calendar date) of the scene the illustration was derived from. */
  derivedFromDate: z.iso.date().nullable(),
  status: FutureLookStatus,
  failureReason: z.string().nullable(),
  label: z.string(),
  disclaimer: z.string(),
  /** Owner-private path on this API, only when ready. */
  imagePath: z.string().nullable(),
  qa: FutureLookQa.nullable(),
  /** Requested model id; the image edit response does not echo a model. */
  model: z.string().nullable(),
  /** Null = not applicable: the image edit endpoint returns no response id, so there is nothing to delete. */
  responseDeleted: z.boolean().nullable(),
  promptVersion: z.string(),
  attempt: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type FutureLookAsset = z.infer<typeof FutureLookAsset>;
