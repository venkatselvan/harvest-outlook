import { z } from 'zod';
import { GeoPoint, Id, Mode, SchemaVersion, Unit } from './common';

/** Initial qualified UI/voice languages (PRD 5). Others are accepted as BCP-47 codes. */
export const KnownLanguage = z.enum(['en', 'ta', 'hi']);
export const LanguageCode = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'expected a BCP-47 language tag');
export type LanguageCode = z.infer<typeof LanguageCode>;

export const Alias = z
  .object({
    text: z.string().min(1).max(200),
    language: LanguageCode,
    script: z.string().min(1).optional(),
    kind: z.enum(['common', 'local', 'market', 'botanical', 'trade', 'transliteration']),
    sourceIds: z.array(Id).default([]),
  })
  .strict();
export type Alias = z.infer<typeof Alias>;

/**
 * Physical form in which a product is measured or priced. Products of the same
 * crop with different bases (paddy vs milled, kapas vs lint, green vs dry chilli,
 * fresh vs dry ginger) are distinct and never interchangeable without a sourced
 * conversion.
 */
export const ProductBasis = z.enum([
  'fresh',
  'dry',
  'green',
  'grain',
  'paddy',
  'milled',
  'kapas',
  'lint',
  'seed',
  'tuber',
  'bulb',
  'rhizome',
  'pod',
  'kernel',
  'fruit',
  'whole',
  'split',
  'other',
]);
export type ProductBasis = z.infer<typeof ProductBasis>;

export const SourceMapping = z
  .object({
    sourceId: Id,
    nativeCode: z.string().min(1).nullable(),
    nativeName: z.string().min(1),
    productId: Id.nullable(),
    status: z.enum(['mapped', 'unresolved', 'rejected']),
    note: z.string().optional(),
  })
  .strict();

export const CropProduct = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    cropId: Id,
    name: z.string().min(1),
    productBasis: ProductBasis,
    grade: z.string().min(1).nullable(),
    aliases: z.array(Alias),
    massUnit: z.literal('kg'),
    priceUnit: z.literal('INR/kg'),
    sourceMappings: z.array(SourceMapping),
    mode: Mode,
  })
  .strict();
export type CropProduct = z.infer<typeof CropProduct>;

export const Variety = z
  .object({ id: Id, name: z.string().min(1), aliases: z.array(Alias), sourceIds: z.array(Id) })
  .strict();

export const CropIdentity = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    botanicalName: z.string().min(1).nullable(),
    commonNames: z.array(Alias).min(1),
    aliases: z.array(Alias),
    varieties: z.array(Variety),
    productIds: z.array(Id).min(1),
    sourceMappings: z.array(SourceMapping),
    mode: Mode,
  })
  .strict();
export type CropIdentity = z.infer<typeof CropIdentity>;

export const DistrictRef = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    nativeName: z.string().min(1),
    stateId: Id,
    stateName: z.string().min(1),
    boundaryVersion: z.string().min(1),
    sourceCodes: z.record(z.string(), z.string()),
    centroid: GeoPoint.nullable(),
    timeZone: z.string().default('Asia/Kolkata'),
    mode: Mode,
  })
  .strict();
export type DistrictRef = z.infer<typeof DistrictRef>;

export const MarketRef = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    nativeName: z.string().min(1),
    districtId: Id.nullable(),
    stateId: Id,
    boundaryVersion: z.string().min(1),
    sourceCodes: z.record(z.string(), z.string()),
    location: GeoPoint.nullable(),
    priceUnitsReported: z.array(Unit),
    mode: Mode,
  })
  .strict();
export type MarketRef = z.infer<typeof MarketRef>;
