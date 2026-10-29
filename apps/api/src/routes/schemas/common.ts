import { z } from "zod";

export const MODES = ["live", "replay", "synthetic"] as const;

export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    requestId: z.string(),
    mode: z.enum(MODES),
    asOf: z.string(),
    data: data.nullable(),
    warnings: z.array(z.string()),
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).nullable(),
  });
}

export const errorEnvelopeSchema = envelopeSchema(z.null());
export const uuidParam = z.object({ id: z.uuid() });
