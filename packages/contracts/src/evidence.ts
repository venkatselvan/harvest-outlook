import { z } from 'zod';
import {
  NumericLike,
  EvidenceState,
  Id,
  IsoDate,
  IsoDateTime,
  Mode,
  SchemaVersion,
  Sha256Hex,
  SpatialScope,
  Unit,
  ValidationStatus,
} from './common';

/** Where inside the source the evidence sits. At least one locator is required. */
export const SourceLocator = z
  .object({
    page: z.number().int().positive().optional(),
    section: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
    row: z.string().min(1).optional(),
  })
  .strict()
  .refine((l) => Object.keys(l).length > 0, { message: 'at least one of page/section/table/row is required' });

export const EvidenceContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('excerpt'), text: z.string().min(1), language: z.string().min(2) }).strict(),
  z
    .object({
      kind: z.literal('structured_row'),
      row: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    })
    .strict(),
]);

/**
 * Availability for replay (BUILD_SPEC 4). `conservative_upper_bound` marks a
 * bound rather than a known time; `unverified` is rejected from strict replay.
 */
export const Availability = z
  .object({
    effectiveAvailableAt: IsoDateTime.nullable(),
    basis: z.enum(['verified_publication', 'first_observed', 'conservative_upper_bound', 'unverified']),
  })
  .strict()
  .refine((a) => a.basis === 'unverified' || a.effectiveAvailableAt !== null, {
    message: 'effectiveAvailableAt is required unless basis is unverified',
  });

export const LicenceStatus = z
  .object({
    licence: z.string().min(1),
    accessStatus: z.enum(['open', 'registration_required', 'permission_required', 'restricted', 'unknown']),
    redistributable: z.boolean(),
    attribution: z.string().optional(),
  })
  .strict();

export const ExtractionMethod = z
  .object({
    method: z.enum(['structured_api', 'native_text', 'native_table', 'ocr', 'model_assisted', 'manual']),
    version: z.string().min(1),
    reviewedBy: z.enum(['none', 'human', 'rule_check']).default('none'),
  })
  .strict();

/** BUILD_SPEC 5.1 EvidenceRecord. */
export const EvidenceRecord = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    mode: Mode,
    sourceUrl: z.url(),
    publisher: z.string().min(1),
    documentTitle: z.string().min(1),
    documentVersion: z.string().min(1).nullable(),
    contentHash: Sha256Hex,
    locator: SourceLocator,
    content: EvidenceContent,
    publishedAt: IsoDateTime.nullable(),
    availability: Availability,
    ingestedAt: IsoDateTime,
    revisedAt: IsoDateTime.nullable(),
    geography: SpatialScope,
    cropIds: z.array(Id),
    productIds: z.array(Id),
    units: z.array(Unit),
    sourceUnits: z.array(z.string().min(1)),
    licence: LicenceStatus,
    extraction: ExtractionMethod,
    validationStatus: ValidationStatus,
  })
  .strict();
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

const ValueCommon = {
  schemaVersion: SchemaVersion,
  evidenceState: EvidenceState,
  scope: SpatialScope,
  validFrom: IsoDate.nullable(),
  validTo: IsoDate.nullable(),
  issuedAt: IsoDateTime.nullable(),
  evidenceIds: z.array(Id),
  assumptionIds: z.array(Id),
  methodVersion: z.string().min(1).nullable(),
  validationStatus: ValidationStatus,
  missingReason: z.string().min(1).nullable(),
  /** Original unit string as published, preserved alongside the canonical unit. */
  sourceUnit: z.string().min(1).optional(),
};

const NumericValue = NumericLike;

const QuantityValue = z.object({ ...ValueCommon, kind: z.literal('quantity'), value: NumericValue.nullable(), unit: Unit }).strict();
const RangeValue = z
  .object({
    ...ValueCommon,
    kind: z.literal('range'),
    value: z.object({ low: NumericValue, high: NumericValue }).strict().nullable(),
    unit: Unit,
  })
  .strict();
const CategoryValue = z
  .object({ ...ValueCommon, kind: z.literal('category'), value: z.string().min(1).nullable(), unit: z.null() })
  .strict();
const TextValue = z
  .object({ ...ValueCommon, kind: z.literal('text'), value: z.string().min(1).nullable(), unit: z.null() })
  .strict();

/**
 * BUILD_SPEC 5.1 ValueRecord. Invariants:
 * - value null => missingReason required
 * - evidenceState unavailable => value null
 * - range low <= high; validFrom <= validTo
 * - unit is mandatory for quantity/range (never inferred).
 */
export const ValueRecord = z
  .discriminatedUnion('kind', [QuantityValue, RangeValue, CategoryValue, TextValue])
  .superRefine((v, ctx) => {
    if (v.value === null && v.missingReason === null) {
      ctx.addIssue({ code: 'custom', path: ['missingReason'], message: 'missingReason is required when value is null' });
    }
    if (v.evidenceState === 'unavailable' && v.value !== null) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'unavailable evidence must have a null value' });
    }
    if (v.validFrom !== null && v.validTo !== null && v.validFrom > v.validTo) {
      ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'validFrom must be on or before validTo' });
    }
    if (v.kind === 'range' && v.value !== null && Number(v.value.low) > Number(v.value.high)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'range low must be <= high' });
    }
  });
export type ValueRecord = z.infer<typeof ValueRecord>;
