import { z } from "zod";

const stateId = z.string().regex(/^IN-[A-Z]{2}$/, "state id must look like IN-KA");
const areaId = z.string().regex(/^IN-[A-Za-z0-9-]{2,100}$/, "district id must look like IN-KA-hassan");

export const dimensionKey = z.enum(["waterFit", "timeToFirstIncome", "harvestWindows", "evidenceQuality", "marketAccess", "economics"]);

export const comparisonBody = z
  .object({
    farmId: z.uuid().optional(),
    location: z.object({ stateId, districtId: areaId.optional() }).strict().optional(),
    planting: z.object({ month: z.number().int().min(1).max(12), date: z.iso.date().optional() }).strict(),
    irrigation: z.enum(["rainfed", "supplemental", "irrigated", "unknown"]),
    soil: z
      .object({ drainage: z.enum(["poor", "moderate", "good"]).optional(), texture: z.enum(["sand", "loamy_sand", "sandy_loam", "loam", "silt_loam", "clay_loam", "silty_clay", "clay"]).optional(), ph: z.number().min(0).max(14).optional() })
      .strict()
      .optional(),
    rainfallSeasonalMm: z.number().min(0).max(20000).optional(),
    elevationM: z.number().min(-500).max(9000).optional(),
    area: z.object({ amount: z.number().positive().max(1_000_000), unit: z.enum(["ha", "acre"]) }).strict().optional(),
    budgetInrPerHa: z.number().min(0).max(100_000_000).optional(),
    excludedCropIds: z.array(z.string().min(1).max(100)).max(50).default([]),
    cropIds: z.array(z.string().min(1).max(100)).max(50).optional(),
    assumedPrices: z
      .array(
        z
          .object({ productId: z.string().min(1).max(100), amountInrPerKg: z.number().positive().max(1_000_000), lowInrPerKg: z.number().positive().max(1_000_000).optional(), highInrPerKg: z.number().positive().max(1_000_000).optional() })
          .strict()
          .refine((p) => (p.lowInrPerKg ?? p.amountInrPerKg) <= p.amountInrPerKg && p.amountInrPerKg <= (p.highInrPerKg ?? p.amountInrPerKg), { message: "price must satisfy low <= central <= high" }),
      )
      .max(60)
      .default([]),
    preferencePolicy: z.object({ weights: z.record(dimensionKey, z.number().min(0).max(10)) }).strict().optional(),
  })
  .strict()
  .refine((b) => b.farmId !== undefined || b.location !== undefined, { message: "location or farmId is required", path: ["location"] })
  .refine((b) => !b.planting.date || Number(b.planting.date.slice(5, 7)) === b.planting.month, { message: "planting.date must fall in planting.month", path: ["planting", "date"] });
export type ComparisonBody = z.infer<typeof comparisonBody>;

export const cropIdParam = z.object({ id: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/) });
export const districtsQuery = z.object({ state: stateId.optional() });
export const anyData = z.unknown();
