import { z } from 'zod';
export const FIELD_PHOTO_LIMIT = 6;
/**
 * Photo coverage (docs/research/PHOTO_COVERAGE_SPEC.md). SAM 3.1 finds image regions for three concepts and code turns
 * them into fractions of the photo. Fractions are shares of the IMAGE, not of the field area; not crop identity; not a
 * water level. `method` says how a fraction was measured:
 * - 'box': union of the proposal bounding boxes (overlaps counted once) divided by the image area. Boxes include
 *   background inside each outline, so this OVERSTATES the share of pixels. It is never pixel coverage.
 * - 'mask': union of decoded mask pixels divided by the image area. Not shipped while SAM masks stay unsupported
 *   (DECISIONS.md D44); reserved for when the mask decoder is adopted.
 * `confidence` is the mean SAM segmentation score of the counted regions (0..1), a model score, not an accuracy.
 * `summary` is written by Muse Spark from these numbers only (never the pixels); null when not written or rejected.
 */
export const PHOTO_COVERAGE_PROMPT_VERSION = 'photo-coverage-v2';
export const PhotoCoverageClassKey = z.enum(['crop', 'weed', 'water']);
export const FieldPhotoCoverageClass = z.object({
  key: PhotoCoverageClassKey, label: z.string(),
  fraction: z.number().min(0).max(1).nullable().describe('Share of the PHOTO (0..1), never field area. With method "box" it is the union of outline boxes divided by the photo area: boxes include background, so it overstates the pixel share.'),
  regions: z.number().int().nonnegative(), confidence: z.number().min(0).max(1).nullable(),
  phrases: z.array(z.string()).max(5).describe('SAM concept phrases actually sent for this class, in order; the share is from the last one. The label is a display name, not necessarily a phrase that was searched.'),
});
export const FieldPhotoCoverage = z.object({
  photoId: z.uuid(), status: z.enum(['queued', 'running', 'ready', 'failed', 'unavailable']),
  method: z.enum(['mask', 'box']).nullable().describe('"box": union of SAM proposal boxes / photo area (overstates pixel share; never pixel coverage). "mask": union of decoded mask pixels / photo area (not shipped while SAM masks are unsupported, DECISIONS.md D44).'),
  modelId: z.string().nullable(), summaryModelId: z.string().nullable(),
  classes: z.array(FieldPhotoCoverageClass).max(3),
  summary: z.string().max(600).nullable(),
  limitations: z.array(z.string()),
  failureReason: z.string().nullable(), promptVersion: z.literal(PHOTO_COVERAGE_PROMPT_VERSION), createdAt: z.string(),
  outdated: z.boolean().describe('True when the photo date or the crop of the cycle changed after this measurement; the crop search phrase or the calendar stage in the summary may no longer apply.'),
});
export type FieldPhotoCoverage = z.infer<typeof FieldPhotoCoverage>;
/** Failures known to have produced no measurement; a new explicit request may retry them. */
export const canRetryPhotoCoverage = (reason: string | null | undefined): boolean =>
  ['budget_exceeded', 'provider_unavailable', 'provider_auth', 'provider_bad_request', 'provider_rate_limited', 'provider_server', 'provider_unreachable', 'cancelled', 'photo_unavailable', 'worker_interrupted'].includes(reason ?? '');
export const FieldPhoto = z.object({
  id: z.uuid(), mediaId: z.uuid(), capturedOn: z.iso.date(), createdAt: z.string(),
  imagePath: z.string(), journalEntryId: z.uuid().nullable().optional(),
  coverage: FieldPhotoCoverage.nullable().optional(),
});
export type FieldPhoto = z.infer<typeof FieldPhoto>;
export const FIELD_PHOTO_PROMPT_VERSION = 'field-photo-v2';
export const FieldPhotoGuidance = z.object({
  sourceStage: z.string(), targetStage: z.string(), elapsedDays: z.number().int().nonnegative(),
  targetAgeDays: z.number().int(), growth: z.string(),
  weather: z.object({
    kind: z.enum(['observed', 'forecast', 'typical', 'unavailable']),
    summary: z.string(), rainMm: z.number().nullable(), tMinC: z.number().nullable(), tMaxC: z.number().nullable(),
    sunshineHours: z.number().nullable(), source: z.string().nullable(), issuedAt: z.string().nullable(),
  }),
  interval: z.object({from: z.iso.date(), to: z.iso.date(), observedDays: z.number().int(), forecastDays: z.number().int(), typicalDays: z.number().int(), missingDays: z.number().int(), rainMm: z.number().nullable(), meanTempC: z.number().nullable()}),
  change: z.string(), limitations: z.array(z.string()), sources: z.array(z.string()),
});
export type FieldPhotoGuidance = z.infer<typeof FieldPhotoGuidance>;
export const FieldPhotoPrediction = z.object({
  id: z.uuid(), photoId: z.uuid(), sourceDate: z.iso.date(), targetDate: z.iso.date(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'unavailable']),
  imagePath: z.string().nullable(), failureReason: z.string().nullable(),
  createdAt: z.string().optional(), evidenceRevision: z.string().optional(),
  promptVersion: z.string().optional(), outdated: z.boolean().optional(), guidance: FieldPhotoGuidance.nullable().optional(),
});
export type FieldPhotoPrediction = z.infer<typeof FieldPhotoPrediction>;
export const FieldPhotoGallery = z.object({ photos: z.array(FieldPhoto).max(FIELD_PHOTO_LIMIT), predictions: z.array(FieldPhotoPrediction), observations: z.array(FieldPhoto).optional() });
export type FieldPhotoGallery = z.infer<typeof FieldPhotoGallery>;
export const SaveFieldPhotos = z.object({ photos: z.array(z.object({ mediaId: z.uuid(), capturedOn: z.iso.date() }).strict()).min(1).max(FIELD_PHOTO_LIMIT) }).strict();
export type SaveFieldPhotos = z.infer<typeof SaveFieldPhotos>;
/** Only failures known to have returned no image may be retried automatically by a new explicit request. */
export const canRetryFieldPhotoPrediction = (reason: string | null | undefined): boolean =>
  ['budget_exceeded', 'provider_unavailable', 'provider_auth', 'provider_bad_request', 'provider_rate_limited', 'provider_server', 'provider_filtered', 'cancelled', 'image_did_not_progress', 'image_framing_changed'].includes(reason ?? '');
