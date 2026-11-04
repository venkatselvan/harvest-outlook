import {z} from 'zod';

/**
 * Future-look illustration contracts (Today satellite view). A future look is a generated illustration of a typical
 * stage, made by editing a real Sentinel-2 scene inside the field outline; it is never an observation or a prediction.
 * The worker job `today.future-look` and the owner-private routes under /api/v1/farms/:id/future-look serve these shapes.
 */

export const FutureLookStatus = z.enum(['queued', 'running', 'ready', 'failed', 'unavailable']);
export type FutureLookStatus = z.infer<typeof FutureLookStatus>;

/**
 * 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md section 11): `stage` = a typical look of a stage (target date = the stage start,
 * or today when the stage is current); `gap` = the predicted look of this field on a date after the latest real scene (at
 * most one per crop cycle per calendar week). Both are code-guided Meta image edits, never observations.
 */
/** 2026-11-04 (EVARA_ACTIONS_SPEC.md 3.2): 'journey' = one stage of a crop journey (an arbitrary crop's cycle on this field), owned by a crop_journeys row. */
export const FutureLookKind = z.enum(['stage', 'gap', 'journey']);
export type FutureLookKind = z.infer<typeof FutureLookKind>;

/**
 * Body of POST /api/v1/farms/:id/ndvi/:itemId/future (optional; an empty body is a `stage` request). `targetDate` is required
 * for `gap`: it must be after the source scene date and at most 120 days after today (Asia/Kolkata); the stored target is the
 * start (Monday) of its week, or the day after the source scene when that is later. `stageId` stays in the query string and
 * is required for `stage` only.
 */
export const FutureLookRequestBody = z.object({
  kind: FutureLookKind.default('stage'),
  targetDate: z.iso.date().optional(),
  /**
   * 2026-11-04: `gap` only. True asks for a new look for a week that already has a queued, running or ready one: the
   * existing row is re-armed (a new attempt from the latest usable scene; the earlier image is replaced) instead of being
   * returned as `deduplicated`. The per-cycle daily cap still applies; automatic requests never set it.
   */
  regenerate: z.boolean().optional(),
}).strict();
export type FutureLookRequestBody = z.infer<typeof FutureLookRequestBody>;

export const FutureLookRequestResult = z.object({
  assetId: z.uuid().nullable(),
  status: FutureLookStatus,
  /** failure/unavailability code, else null. */
  reason: z.string().max(80).nullable(),
  cycleId: z.string().max(120).nullable(),
  stageId: z.string().max(80),
  /** True when an existing asset was returned instead of a new generation being queued. */
  deduplicated: z.boolean(),
  /** 2026-11-03: the kind and stored target date of the asset (absent on results without an asset). */
  kind: FutureLookKind.optional(),
  targetDate: z.iso.date().nullable().optional(),
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
  /** 2026-11-03: rows made before prompt v2 are `stage` with a null targetDate and guidance. */
  kind: FutureLookKind,
  /** The date the look is for (gap: the week start or the day after the source scene; stage: the stage start or the request day). */
  targetDate: z.iso.date().nullable(),
  /** The code-written guidance sentence that went into the prompt (no NDVI number). */
  guidance: z.string().max(400).nullable(),
  /** 2026-11-04: the crop journey this asset belongs to (kind 'journey'); null otherwise; absent on older rows. */
  journeyId: z.uuid().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type FutureLookAsset = z.infer<typeof FutureLookAsset>;
