import { z } from 'zod';
import { DateRange, DecimalString, GeoPoint, Id, IsoDateTime, Mode, SchemaVersion } from './common';
import { IrrigationCategory, LabourLevel, SoilDrainage, SoilTexture } from './rules';

export const FactBasis = z.enum(['farmer_reported', 'lab_test', 'district_proxy', 'derived', 'unknown']);
export type FactBasis = z.infer<typeof FactBasis>;

export const FactSource = z
  .object({
    kind: z.enum(['farmer_text', 'farmer_voice', 'farmer_form', 'lab_report', 'public_dataset', 'calculation', 'journal_fact']),
    ref: z.string().min(1).nullable(),
    recordedAt: IsoDateTime,
  })
  .strict();

/**
 * Per-field provenance. A confirmed fact was explicitly confirmed by the owner
 * through a user action; the model can never set confirmed=true.
 * basis 'unknown' implies value null.
 */
export function fact<T extends z.ZodType>(value: T) {
  return z
    .object({
      value: value.nullable(),
      basis: FactBasis,
      confirmed: z.boolean(),
      source: FactSource.optional(),
    })
    .strict()
    .refine((f) => !(f.basis === 'unknown' && (f as unknown as { value: unknown }).value !== null), { message: 'basis unknown requires null value' })
    .refine((f) => (f as unknown as { value: unknown }).value === null || f.basis === 'unknown' || f.source !== undefined, {
      message: 'a known value requires a source',
    });
}

export const AreaValue = z.object({ amount: z.number().positive(), unit: z.enum(['ha', 'acre']) }).strict();
export const LocationValue = z
  .object({
    districtId: Id.nullable(),
    stateId: Id.nullable(),
    precision: z.enum(['state', 'district', 'village', 'gps']),
    point: GeoPoint.nullable(),
  })
  .strict();
export const BudgetValue = z
  .object({ amountInr: DecimalString, per: z.enum(['farm', 'ha']) })
  .strict();

export const FarmProfile = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    ownerId: Id,
    mode: Mode,
    version: z.number().int().positive(),
    updatedAt: IsoDateTime,
    location: fact(LocationValue),
    area: fact(AreaValue),
    soil: z
      .object({
        texture: fact(SoilTexture),
        drainage: fact(SoilDrainage),
        ph: fact(z.number().min(0).max(14)),
        availableWaterMmPerM: fact(z.number().positive()),
      })
      .strict(),
    water: z
      .object({
        category: fact(IrrigationCategory),
        capacityMmPerWeek: fact(z.number().nonnegative()),
      })
      .strict(),
    plantingWindow: fact(DateRange),
    budget: fact(BudgetValue),
    labour: fact(LabourLevel),
    experience: fact(z.string().min(1).max(500)),
    accessibleMarketIds: fact(z.array(Id)),
    excludedCropIds: fact(z.array(Id)),
  })
  .strict();
export type FarmProfile = z.infer<typeof FarmProfile>;
