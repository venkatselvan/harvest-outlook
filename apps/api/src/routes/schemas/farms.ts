import { z } from "zod";

export const FACT_BASES = ["farmer_reported", "lab_test", "district_proxy", "derived", "unknown"] as const;
export const LOCATION_PRECISIONS = ["district", "approximate", "precise"] as const;

const factValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

export const factInput = z.object({
  value: factValue,
  unit: z.string().trim().max(32).optional(),
  basis: z.enum(FACT_BASES).default("unknown"),
  confirmed: z.boolean().default(false),
  source: z.string().trim().max(200).optional(),
  recordedAt: z.iso.datetime().optional(),
});

const factKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "fact keys are snake_case, up to 64 characters");
export const factsInput = z.record(factKey, factInput).refine((o) => Object.keys(o).length <= 50, "at most 50 facts per request");

export const locationInput = z
  .object({
    districtId: z.string().trim().min(1).max(64),
    districtName: z.string().trim().min(1).max(120),
    stateCode: z.string().trim().min(1).max(16).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    precision: z.enum(LOCATION_PRECISIONS).default("district"),
  })
  .superRefine((l, ctx) => {
    const has = l.lat !== undefined || l.lon !== undefined;
    if ((l.lat === undefined) !== (l.lon === undefined)) ctx.addIssue({ code: "custom", message: "lat and lon must be given together", path: ["lat"] });
    if (has && l.precision === "district") ctx.addIssue({ code: "custom", message: "coordinates require precision approximate or precise", path: ["precision"] });
    if (!has && l.precision !== "district") ctx.addIssue({ code: "custom", message: "precision approximate/precise requires lat and lon", path: ["precision"] });
  });

export const createFarmBody = z.object({
  name: z.string().trim().min(1).max(120),
  location: locationInput,
  areaHectares: z.number().positive().max(1_000_000).optional(),
  facts: factsInput.optional(),
});

export const patchFarmBody = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    location: locationInput.optional(),
    areaHectares: z.number().positive().max(1_000_000).nullable().optional(),
    facts: factsInput.optional(),
  })
  .refine((b) => b.name !== undefined || b.location !== undefined || b.areaHectares !== undefined || b.facts !== undefined, "no changes supplied");

export const factOut = z.object({
  factId: z.string(),
  value: z.unknown(),
  unit: z.string().nullable(),
  basis: z.enum(FACT_BASES),
  confirmed: z.boolean(),
  source: z.string().nullable(),
  recordedAt: z.string(),
});

export const farmOut = z.object({
  id: z.string(),
  name: z.string(),
  location: z.object({
    districtId: z.string().nullable(),
    districtName: z.string().nullable(),
    stateCode: z.string().nullable(),
    lat: z.number().nullable(),
    lon: z.number().nullable(),
    precision: z.enum(LOCATION_PRECISIONS),
  }),
  areaHectares: z.number().nullable(),
  version: z.number(),
  facts: z.record(z.string(), factOut),
  factHistory: z.array(factOut.extend({ key: z.string(), superseded: z.boolean() })).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const farmListOut = z.object({ farms: z.array(farmOut) });
export const deleteFarmOut = z.object({
  deleted: z.literal(true),
  mediaObjectsRemoved: z.number(),
  storageObjectsFailed: z.number(),
});

export type CreateFarmBody = z.infer<typeof createFarmBody>;
export type PatchFarmBody = z.infer<typeof patchFarmBody>;
export type FarmOut = z.infer<typeof farmOut>;
