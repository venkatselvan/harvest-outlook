import { z } from "zod";
import { MAX_KEYFRAMES } from "../../visuals/labels";

export const visualsBody = z
  .object({
    mediaId: z.uuid(),
    regionVersion: z.number().int().min(0),
    stageIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_KEYFRAMES).optional(),
  })
  .strict();

export const assetState = z.enum(["ready", "failed", "schematic", "queued"]);

export const visualAssetOut = z.object({
  assetId: z.string(),
  planId: z.string(),
  stageId: z.string().nullable(),
  state: assetState,
  kind: z.enum(["illustrative", "schematic"]),
  illustrative: z.literal(true),
  evidenceState: z.literal("illustrative"),
  label: z.string(),
  reason: z.string().nullable(),
  qa: z.object({ passed: z.boolean(), reasons: z.array(z.string()) }).nullable(),
  qaWarning: z.string().nullable(),
  contentPath: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  sourceMediaId: z.string().nullable(),
  regionVersion: z.number().nullable(),
  mode: z.enum(["live", "replay", "synthetic"]),
  createdAt: z.string(),
});

export const startOut = z.object({
  jobId: z.string().nullable(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "cached"]),
  cached: z.boolean(),
  deduplicated: z.boolean(),
  assets: z.array(visualAssetOut).optional(),
  label: z.string(),
});

export const stageVisual = z.object({
  stageId: z.string(),
  name: z.string(),
  order: z.number(),
  state: assetState,
  /** Label to show with this stage's picture; schematic wording when no generated image exists. */
  label: z.string(),
  asset: visualAssetOut.nullable(),
});

export const listOut = z.object({
  planId: z.string(),
  /** True while a visuals job for this plan is queued or running. */
  generating: z.boolean(),
  stages: z.array(stageVisual),
});
