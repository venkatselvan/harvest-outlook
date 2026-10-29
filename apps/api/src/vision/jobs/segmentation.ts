import sharp from "sharp";
import { z } from "zod";
import type { Config } from "../../config";
import type { Pool } from "../../db/pool";
import type { Budget } from "../../services/budget";
import { ApiError } from "../../services/errors";
import { getMedia, readContent } from "../../services/media";
import type { StorageAdapter } from "../../storage/types";
import { callSam, SamHttpError } from "../sam/client";
import { interpretSamText } from "../sam/interpret";
import { samOptionsFromEnv, type SamOptions } from "../sam/options";
import { buildPromptText } from "../sam/prompt";
import { planSentImage } from "../sam/transform";

export const SEGMENT_JOB_TYPE = "vision.segment";
export const SAM_LABEL = "AI suggestion — illustrative outline, confirm or correct";

const unit = z.number().finite().min(0).max(1);
export const promptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("concept"), text: z.string().trim().min(1).max(40) }).strict(),
  z.object({ kind: z.literal("box"), x0: unit, y0: unit, x1: unit, y1: unit }).strict(),
  z.object({ kind: z.literal("points"), points: z.array(z.object({ x: unit, y: unit, positive: z.boolean().optional() }).strict()).min(1).max(16) }).strict(),
]);

export const segmentPayloadSchema = z.object({ mediaId: z.uuid(), prompt: promptSchema, sessionId: z.uuid().nullable().optional() });
export type SegmentPayload = z.infer<typeof segmentPayloadSchema>;

export type UnavailableReason = "provider_not_configured" | "synthetic_mode" | "replay_mode" | "budget_exceeded";

export interface SegmentResult {
  status: "ok" | "no_match" | "unavailable";
  reason?: UnavailableReason | string;
  label: string;
  modelId?: string;
  /** Size of the image sent to SAM and the factors from the normalized derivative to it. */
  imageSizeUsed?: { width: number; height: number; scaleX: number; scaleY: number };
  /** Best proposal (same as proposals[0]); normalized 0..1 in the normalized derivative frame. */
  polygon?: [number, number][];
  /** Segmentation score only; never crop identity or accuracy. */
  segmentationScore?: number | null;
  proposals?: { polygon: [number, number][]; source: "mask" | "box"; segmentationScore: number | null; areaFraction: number }[];
  rejected?: { reason: string }[];
  warnings?: string[];
  providerRequestId?: string | null;
}

export interface SegmentationDeps {
  pool: Pool;
  config: Config;
  storage: StorageAdapter;
  budget: Budget;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  options?: SamOptions;
}

interface MinimalJob {
  id: string;
  owner_id: string | null;
  payload: unknown;
}
interface MinimalCtx {
  heartbeat: (progress?: number) => Promise<void>;
}

class RetryableSamError extends Error {
  readonly retryable = true;
}

/** Wire in worker: registerSegmentationHandler(handlers, { pool, config, storage, budget }). */
export function registerSegmentationHandler<J extends MinimalJob, C extends MinimalCtx>(registry: Record<string, (job: J, ctx: C) => Promise<unknown>>, deps: SegmentationDeps): void {
  registry[SEGMENT_JOB_TYPE] = (job, ctx) => runSegmentation(deps, job, ctx);
}

export async function runSegmentation(
  deps: SegmentationDeps,
  job: { id: string; owner_id: string | null; payload: unknown },
  ctx: { heartbeat: (progress?: number) => Promise<void> },
): Promise<SegmentResult> {
  const { pool, config, storage, budget } = deps;
  const options = deps.options ?? samOptionsFromEnv();
  const model = config.META_SEGMENT_MODEL;
  const unavailable = (reason: UnavailableReason): SegmentResult => ({ status: "unavailable", reason, label: SAM_LABEL, modelId: model });

  // Mode and credential gates come first: no media read, no reservation, no network.
  if (config.RUNTIME_MODE === "synthetic") return unavailable("synthetic_mode");
  if (config.RUNTIME_MODE === "replay") return unavailable("replay_mode");
  if (!config.MODEL_API_KEY) return unavailable("provider_not_configured");

  const parsed = segmentPayloadSchema.safeParse(job.payload);
  if (!parsed.success || !job.owner_id) throw Object.assign(new Error("invalid segmentation payload"), { retryable: false });
  const { mediaId, prompt, sessionId } = parsed.data;
  const ownerId = job.owner_id;

  const media = await getMedia(pool, ownerId, mediaId);
  if (!media) throw Object.assign(new Error("media not found for owner"), { retryable: false });
  const content = await readContent(pool, storage, ownerId, mediaId, "normalized");
  const derivMeta = await sharp(Buffer.from(content.data)).metadata();
  if (!derivMeta.width || !derivMeta.height) throw Object.assign(new Error("derivative undecodable"), { retryable: false });
  const plan = planSentImage(derivMeta.width, derivMeta.height, options.maxImageSide);
  const jpeg = await sharp(Buffer.from(content.data)).resize({ width: plan.width, height: plan.height, fit: "fill" }).jpeg({ quality: 85 }).toBuffer();
  const imageDataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const text = buildPromptText(prompt, { width: plan.width, height: plan.height });
  await ctx.heartbeat(0.2);

  const cancelled = await pool.query<{ cancel_requested: boolean }>("SELECT cancel_requested FROM jobs WHERE id=$1", [job.id]);
  if (cancelled.rows[0]?.cancel_requested) throw Object.assign(new Error("cancelled before dispatch"), { retryable: false });

  const estimate = budget.estimate("meta", model, { images: 1 }).usd ?? 0;
  let reservationId: string;
  try {
    ({ reservationId } = await budget.reserve({ ownerId, sessionId: sessionId ?? null, provider: "meta", model, estimate, jobId: job.id, requestId: job.id }));
  } catch (e) {
    if (e instanceof ApiError && e.code === "budget_exceeded") return { ...unavailable("budget_exceeded") };
    throw e;
  }

  let call;
  try {
    call = await callSam({ baseUrl: config.META_BASE_URL, apiKey: config.MODEL_API_KEY, model, text, imageDataUrl, options, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  } catch (e) {
    if (e instanceof SamHttpError) {
      if (e.outcomeUnknown) await budget.markUncertain(reservationId).catch(() => undefined);
      else await budget.release(reservationId).catch(() => undefined);
      // Outcome unknown: never auto-retry an expensive call; the farmer can request again.
      const err = e.retryable && !e.outcomeUnknown ? new RetryableSamError(e.message) : Object.assign(new Error(e.message), { retryable: false });
      throw err;
    }
    await budget.markUncertain(reservationId).catch(() => undefined);
    throw Object.assign(new Error("segmentation failed"), { retryable: false });
  }
  await budget.settle(reservationId, estimate, call.providerRequestId, { images: 1, providerUsage: call.usage ?? null }, "estimated");
  await ctx.heartbeat(0.8);

  const interp = interpretSamText(call.text, plan, options);
  const best = interp.proposals[0];
  const base = {
    label: SAM_LABEL,
    modelId: model,
    imageSizeUsed: { width: plan.width, height: plan.height, scaleX: plan.scaleX, scaleY: plan.scaleY },
    warnings: interp.warnings,
    rejected: interp.rejected,
    providerRequestId: call.providerRequestId,
  };
  if (!best) return { status: "no_match", reason: interp.objectCount === 0 ? "no_objects" : "all_rejected_by_quality_gate", ...base };
  return { status: "ok", ...base, polygon: best.polygon, segmentationScore: best.segmentationScore, proposals: interp.proposals };
}
