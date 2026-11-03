import { z } from 'zod';

/**
 * Every top-level serialized record carries this literal. Bump only with a
 * migration note; Python analytics validates against the exported JSON Schema.
 */
export const SCHEMA_VERSION = '1.0' as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** Server-controlled runtime mode (BUILD_SPEC 3). Never accepted from a client query. */
export const Mode = z.enum(['live', 'replay', 'synthetic']);
export type Mode = z.infer<typeof Mode>;

/** PRD 4 product evidence states. Independent from ValidationStatus. */
export const EvidenceState = z.enum([
  'observed',
  'farmer_reported',
  'derived',
  'forecast',
  'scenario',
  'illustrative',
  'unavailable',
]);
export type EvidenceState = z.infer<typeof EvidenceState>;

export const ValidationStatus = z.enum(['validated', 'grounded', 'unsupported', 'pending', 'rejected']);
// 'grounded' (D28): excerpt machine-verified present on the cited page; meaning/scope review pending. Not 'validated'.
export type ValidationStatus = z.infer<typeof ValidationStatus>;

/** Stable identifier: non-empty, no whitespace, bounded length. */
export const Id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/, 'identifier must be non-empty and contain no whitespace');
export type Id = z.infer<typeof Id>;

/** snake_case machine reason code. */
export const ReasonCode = z.string().regex(/^[a-z][a-z0-9_]{1,80}$/, 'reasonCode must be snake_case');

/** Hex sha256 digest. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex sha256');

function isValidCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Agricultural calendar date, ISO YYYY-MM-DD (timezone carried separately). */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isValidCalendarDate, 'invalid calendar date');
export type IsoDate = z.infer<typeof IsoDate>;

/** Timestamp with explicit offset or Z (BUILD_SPEC 4: UTC with offsets in storage). */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** IANA timezone name, e.g. Asia/Kolkata. */
export const TimeZone = z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/);

/**
 * Canonical units. Source units are preserved separately as free strings
 * (`sourceUnit`) and are never inferred from magnitude.
 */
export const Unit = z.enum([
  'ha',
  'acre',
  'kg',
  'quintal',
  't',
  'INR',
  'INR/kg',
  'INR/quintal',
  'INR/ha',
  'mm',
  'L',
  'm3',
  'kg/ha',
  'kg/acre',
  'days',
  'celsius',
  'percent',
  'm',
  'cm',
  'g',
  'months',
  /** 2026-11-02 (farm briefing): dimensionless satellite index (NDVI, NDMI, NDRE, NDWI, EVI, SAVI, GNDVI, LSWI). */
  'index',
  'GJ',
  'kgCO2e',
  'tCO2e',
  'pH',
  'dS/m',
  'ppm',
  'mg/kg',
  'mm/week',
]);
export type Unit = z.infer<typeof Unit>;

/**
 * Decimal string for currency and other exact quantities. JSON numbers are
 * avoided for INR so that arithmetic stays decimal-safe across languages.
 */
export const DecimalString = z
  .string()
  .regex(/^-?(0|[1-9]\d*)(\.\d{1,6})?$/, 'expected a decimal string with at most 6 fractional digits');
export type DecimalString = z.infer<typeof DecimalString>;

/** A numeric input: JSON number or exact decimal string (preferred for INR). */
export const NumericLike = z.union([z.number().finite(), DecimalString]);
export type NumericLike = z.infer<typeof NumericLike>;

export const SpatialLevel = z.enum(['farm', 'district', 'state', 'market', 'region', 'national']);
export type SpatialLevel = z.infer<typeof SpatialLevel>;

/** Spatial scope of a value or record. `ids` reference stable district/market/state IDs. */
export const SpatialScope = z
  .object({
    level: SpatialLevel,
    ids: z.array(Id).min(1),
    boundaryVersion: z.string().min(1).optional(),
  })
  .strict();
export type SpatialScope = z.infer<typeof SpatialScope>;

/** GeoJSON point, WGS84, coordinate order [longitude, latitude]. */
export const GeoPoint = z
  .object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    accuracyM: z.number().nonnegative().nullable(),
    basis: z.enum(['gps', 'geocoded', 'centroid_proxy', 'manual_pin', 'source_reported']),
  })
  .strict();
export type GeoPoint = z.infer<typeof GeoPoint>;

export const DateRange = z
  .object({ start: IsoDate, end: IsoDate })
  .strict()
  .refine((r) => r.start <= r.end, { message: 'start must be on or before end' });
export type DateRange = z.infer<typeof DateRange>;

/** Structured API error codes (BUILD_SPEC 11). Stable; add only, never repurpose. */
export const ApiErrorCode = z.enum([
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'version_conflict',
  'idempotency_mismatch',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'budget_exceeded',
  'mode_mismatch',
  'capability_unavailable',
  'speech_synthesis_not_supported',
  'provider_unavailable',
  'provider_error',
  'job_cancelled',
  'internal_error',
  'replay_leakage',
  'idempotency_payload_mismatch',
  'csrf_invalid',
  'approved_text_mismatch',
  'validation_error',
  'bad_request',
  'origin_not_allowed',
  'origin_required',
  'file_required',
  'invalid_image',
  'image_too_large',
  'audio_required',
  'audio_too_long',
  'audio_too_short',
  'client_cancelled',
  'degenerate_region',
  'farm_context_invalid',
  'idempotency_in_progress',
  'invalid_actual',
  'invalid_estimate',
  'invalid_idempotency_key',
  'invalid_usage_estimate',
  'job_conflict',
  'job_finished',
  'orientation_not_applied',
  'plan_has_no_stages',
  'provider_auth_failed',
  'provider_bad_response',
  'provider_rate_limited',
  'provider_rejected_input',
  'region_required',
  'region_version_mismatch',
  'reservation_not_found',
  'reservation_state_conflict',
  'too_many_stages',
  'transform_mismatch',
  'unknown_stage',
  'unpriced_model',
  // 2026-11-03 fields inside a farm (FIELDS_MULTICROP_SOIL_SPEC.md 3): unknown field id (404); plant crop without a field on a farm with fields (400).
  'field_not_found',
  'field_required',
  // 2026-11-03: a predicted-look request on a farm with fields must name the crop cycle (400).
  'cycle_required',
  // 2026-11-03 field operations (FIELD_OPERATIONS_SPEC.md 4.5, 5.1): a client entry id reused for different data (409; also
  // raised by the command center, which earlier surfaced as bad_request with originalCode); an issue location outside the
  // farm or field polygon (400).
  'idempotency_conflict',
  'location_outside_boundary',
  // 2026-11-03 season report (FIELD_OPERATIONS_SPEC.md 8.1): the named crop cycle is not on this farm, or the farm has no crop to report (404).
  'cycle_not_found',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z
  .object({
    code: ApiErrorCode,
    message: z.string().min(1).max(2000),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiError>;

export const ApiWarning = z
  .object({
    code: ReasonCode,
    message: z.string().min(1).max(2000),
  })
  .strict();
export type ApiWarning = z.infer<typeof ApiWarning>;

/**
 * Standard response envelope. When `error` is present `data` must be null.
 * `asOf` is the server time the response represents; cached real responses
 * keep their original issue time inside `data` and add a `cached_response` warning.
 */
export function apiEnvelope<T extends z.ZodType>(data: T) {
  return z
    .object({
      schemaVersion: SchemaVersion,
      requestId: Id,
      mode: Mode,
      asOf: IsoDateTime,
      data: data.nullable(),
      warnings: z.array(ApiWarning),
      error: ApiError.nullable(),
    })
    .strict()
    .superRefine((envIn, ctx) => {
      const env = envIn as unknown as { data: unknown; error: unknown };
      if (env.error !== null && env.data !== null) {
        ctx.addIssue({ code: 'custom', path: ['data'], message: 'data must be null when error is set' });
      }
      if (env.error === null && env.data === null) {
        ctx.addIssue({ code: 'custom', path: ['error'], message: 'error is required when data is null' });
      }
    });
}
export type ApiEnvelope<T> = {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  mode: Mode;
  asOf: string;
  data: T | null;
  warnings: ApiWarning[];
  error: ApiError | null;
};

/** Record of one runtime model call, embedded in year-plan and soil-report results. */
export const ModelInvocation = z
  .object({
    id: z.uuid(),
    provider: z.literal('meta'),
    requestedModel: z.string(),
    model: z.string().nullable(),
    purpose: z.string(),
    status: z.enum(['running', 'succeeded', 'failed']),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    processing: z.literal('standard'),
    requestedStorage: z.literal(false),
    responseDeleted: z.boolean().nullable(),
  })
  .strict();
export type ModelInvocation = z.infer<typeof ModelInvocation>;
