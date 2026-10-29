import { z } from "zod";

export const REGION_SOURCES = ["manual", "sam_confirmed"] as const;

const unit = z.number().finite().min(0).max(1);

export const regionBody = z.object({
  /** Normalised 0..1 coordinates in the orientation-corrected original image. */
  polygon: z.array(z.tuple([unit, unit])).min(3).max(64),
  source: z.enum(REGION_SOURCES),
  transform: z.object({
    orientationApplied: z.boolean(),
    normalizedWidth: z.number().int().positive().max(20000),
    normalizedHeight: z.number().int().positive().max(20000),
  }),
});

export const mediaOut = z.object({
  id: z.string(),
  farmId: z.string().nullable(),
  contentType: z.string(),
  bytes: z.number(),
  sha256: z.string(),
  /** Stored pixel dimensions of the original file. */
  width: z.number(),
  height: z.number(),
  exifOrientation: z.number().nullable(),
  /** Dimensions after EXIF orientation is applied (the frame region polygons refer to). */
  orientedWidth: z.number(),
  orientedHeight: z.number(),
  normalized: z.object({ width: z.number(), height: z.number(), bytes: z.number(), contentType: z.literal("image/jpeg") }),
  /** Private, owner-only; never a public URL. */
  contentPath: z.string(),
  region: z
    .object({ polygon: z.array(z.tuple([z.number(), z.number()])), source: z.enum(REGION_SOURCES), transform: regionBody.shape.transform, version: z.number() })
    .nullable(),
  createdAt: z.string(),
});

export const contentQuery = z.object({ variant: z.enum(["original", "normalized"]).default("normalized") });
export type RegionBody = z.infer<typeof regionBody>;
export type MediaOut = z.infer<typeof mediaOut>;
