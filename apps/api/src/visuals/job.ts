import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { ApiError } from "../services/errors";
import type { Budget } from "../services/budget";
import { readContent } from "../services/media";
import type { StorageAdapter } from "../storage/types";
import { loadBriefs, type VisualBrief } from "./brief";
import { buildContext, type VisualContext } from "./context";
import { MAX_KEYFRAMES, MAX_SENT_SIDE, STABLE_SCHEMATIC_REASONS, VISUAL_JOB_TYPE, type SchematicReason } from "./labels";
import { editImage, MuseImageError } from "./muse-image";
import { evaluateScene } from "./qa";
import { adoptReusable, findByCacheKeys, toOut, upsertAsset, type AssetRow, type UpsertAsset, type VisualAssetOut } from "./repository";

export const PROVIDER = "meta";

export const keyframesPayload = z
  .object({
    planId: z.uuid(),
    mediaId: z.uuid(),
    regionVersion: z.number().int().min(0),
    stageIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_KEYFRAMES).optional(),
    sessionId: z.uuid().nullable().optional(),
  })
  .strict();
export type KeyframesPayload = z.infer<typeof keyframesPayload>;

export interface VisualJobDeps {
  pool: Pool;
  config: Config;
  storage: StorageAdapter;
  budget: Budget;
  /** Defaults to the curated briefs on disk. */
  briefs?: Map<string, VisualBrief>;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface KeyframesResult {
  cacheHit: boolean;
  mode: "live" | "replay" | "synthetic";
  providerCalls: number;
  cancelled: boolean;
  assets: VisualAssetOut[];
  /** Estimated = reserved worst case; settled = images actually returned x unit price. Both null when no budget was touched. */
  cost: { reservedUsd: number; settledUsd: number; images: number; outcome: "settled" | "released" | "uncertain" } | null;
}

let briefCache: Promise<Map<string, VisualBrief>> | null = null;
const defaultBriefs = () => (briefCache ??= loadBriefs());

/** Wire in the worker: `registerVisualHandlers(handlers, { pool, config, storage, budget })`. */
export function registerVisualHandlers<J extends { id: string; owner_id: string | null; payload: unknown }, C extends { heartbeat: (p?: number) => Promise<void> }>(
  registry: Record<string, (job: J, ctx: C) => Promise<unknown>>,
  deps: VisualJobDeps,
): void {
  registry[VISUAL_JOB_TYPE] = (job, ctx) => runVisualKeyframes(deps, job, ctx);
}

const isCacheHit = (r: AssetRow | undefined): boolean => !!r && (r.status === "ready" || (r.status === "schematic" && STABLE_SCHEMATIC_REASONS.has(r.failure_reason ?? "")));

function gateReason(v: VisualContext, config: Config): SchematicReason | null {
  if (v.effectiveMode === "synthetic") return "synthetic_mode";
  if (v.effectiveMode === "replay") return "replay_mode";
  if (!config.MODEL_API_KEY) return "provider_unavailable";
  return null;
}

export async function runVisualKeyframes(
  deps: VisualJobDeps,
  job: { id: string; owner_id: string | null; payload: unknown },
  ctx: { heartbeat: (progress?: number) => Promise<void> },
): Promise<KeyframesResult> {
  const { pool, config, storage, budget } = deps;
  const parsed = keyframesPayload.safeParse(job.payload);
  if (!parsed.success || !job.owner_id) throw Object.assign(new Error("invalid visuals.keyframes payload"), { retryable: false });
  const p = parsed.data;
  const ownerId = job.owner_id;
  const briefs = deps.briefs ?? (await defaultBriefs());
  const v = await buildContext({ pool, config, briefs }, ownerId, p);
  const model = config.META_IMAGE_MODEL;

  const keys = [...v.assetKeys.values()];
  // Free reuse first: keyframes this owner already generated for another plan with identical inputs.
  await adoptReusable(pool, ownerId, v.planId, keys, job.id);
  const existing = new Map((await findByCacheKeys(pool, ownerId, v.planId, keys)).map((r) => [r.cache_key, r]));
  const todo = v.selected.filter((s) => !isCacheHit(existing.get(v.assetKeys.get(s.stageId)!)));
  const finish = async (extra: Pick<KeyframesResult, "providerCalls" | "cancelled" | "cost">): Promise<KeyframesResult> => {
    const rows = await findByCacheKeys(pool, ownerId, v.planId, keys);
    const byKey = new Map(rows.map((r) => [r.cache_key, r]));
    const assets = v.selected.map((s) => byKey.get(v.assetKeys.get(s.stageId)!)).filter((r): r is AssetRow => !!r).map(toOut);
    return { cacheHit: todo.length === 0, mode: v.effectiveMode, assets, ...extra };
  };
  // Cache hit: zero provider calls, zero budget, same rows.
  if (todo.length === 0) return finish({ providerCalls: 0, cancelled: false, cost: null });

  const base = (stageId: string, cacheKey: string): Omit<UpsertAsset, "kind" | "status" | "provider" | "providerRequestId" | "qa" | "storageKey" | "width" | "height" | "failureReason" | "id"> & { id: string } => {
    const bs = v.brief?.stages.find((b) => b.stageId === stageId);
    return {
      id: existing.get(cacheKey)?.id ?? randomUUID(),
      ownerId,
      planId: v.planId,
      sourceMediaId: v.mediaId,
      mode: v.effectiveMode,
      stageId,
      cacheKey,
      cropId: v.cropId,
      model,
      promptVersion: v.brief?.promptVersion ?? null,
      promptTemplateHash: bs?.promptTemplateHash ?? null,
      briefHash: v.brief?.briefHash ?? null,
      regionVersion: v.keyInputs.regionVersion,
      jobId: job.id,
    };
  };
  const writeSchematic = (stageId: string, cacheKey: string, reason: SchematicReason) =>
    upsertAsset(pool, { ...base(stageId, cacheKey), kind: "schematic", status: "schematic", provider: null, providerRequestId: null, qa: null, storageKey: null, width: null, height: null, failureReason: reason });
  const writeFailed = (stageId: string, cacheKey: string, reason: string, requestId: string | null = null) =>
    upsertAsset(pool, { ...base(stageId, cacheKey), kind: "illustrative", status: "failed", provider: PROVIDER, providerRequestId: requestId, qa: null, storageKey: null, width: null, height: null, failureReason: reason });

  // Stages without a source-backed brief never reach the image model: the brief is the only biology source.
  const gen = [];
  const gate = gateReason(v, config);
  for (const s of todo) {
    const key = v.assetKeys.get(s.stageId)!;
    if (!v.brief?.stages.some((b) => b.stageId === s.stageId)) await writeSchematic(s.stageId, key, "no_brief");
    else if (gate) await writeSchematic(s.stageId, key, gate);
    else gen.push(s);
  }
  if (gen.length === 0) return finish({ providerCalls: 0, cancelled: false, cost: null });

  const content = await readContent(pool, storage, ownerId, v.mediaId, "normalized");
  const sentImg = await sharp(Buffer.from(content.data)).rotate().resize({ width: MAX_SENT_SIDE, height: MAX_SENT_SIDE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  const imageDataUrl = `data:image/jpeg;base64,${sentImg.data.toString("base64")}`;
  const size = `${sentImg.info.width}x${sentImg.info.height}`;
  await ctx.heartbeat(0.1);

  const unitUsd = budget.estimate(PROVIDER, model, { images: 1 }).usd ?? 0;
  // Worst case: every stage image plus one retry each.
  const reserveUsd = budget.estimate(PROVIDER, model, { images: gen.length * 2 }).usd ?? 0;
  let reservationId: string;
  try {
    ({ reservationId } = await budget.reserve({ ownerId, sessionId: p.sessionId ?? null, provider: PROVIDER, model, estimate: reserveUsd, jobId: job.id, requestId: job.id }));
  } catch (e) {
    if (e instanceof ApiError && e.code === "budget_exceeded") {
      for (const s of gen) await writeFailed(s.stageId, v.assetKeys.get(s.stageId)!, "budget_exceeded");
      return finish({ providerCalls: 0, cancelled: false, cost: null });
    }
    throw e;
  }

  let calls = 0;
  let billed = 0;
  let unknown = false;
  let cancelled = false;
  let lastRequestId: string | null = null;
  try {
    for (let i = 0; i < gen.length; i++) {
      const s = gen[i]!;
      const cacheKey = v.assetKeys.get(s.stageId)!;
      const cancelRow = await pool.query<{ cancel_requested: boolean }>("SELECT cancel_requested FROM jobs WHERE id=$1", [job.id]);
      if (cancelRow.rows[0]?.cancel_requested) {
        cancelled = true;
        break;
      }
      const prompt = v.brief!.stages.find((b) => b.stageId === s.stageId)!.promptTemplate;
      const b = base(s.stageId, cacheKey);
      try {
        calls++;
        const res = await editImage({
          baseUrl: config.META_BASE_URL,
          apiKey: config.MODEL_API_KEY!,
          model,
          prompt,
          imageDataUrl,
          size,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        });
        billed++; // the provider returned an image: billable even if we cannot use it
        lastRequestId = res.requestId;
        let png: { data: Buffer; info: { width: number; height: number } };
        try {
          png = await sharp(res.png, { failOn: "error" }).png().toBuffer({ resolveWithObject: true });
        } catch {
          await writeFailed(s.stageId, cacheKey, "output_undecodable", res.requestId);
          continue;
        }
        const qa = await evaluateScene({ base: sentImg.data, output: png.data, polygon: v.polygon });
        const storageKey = `visuals/${b.id}/keyframe.png`;
        await storage.put({ ownerId, key: storageKey }, png.data);
        const row = await upsertAsset(pool, { ...b, kind: "illustrative", status: "ready", provider: PROVIDER, providerRequestId: res.requestId, qa, storageKey, width: png.info.width, height: png.info.height, failureReason: null });
        if (!row) await storage.delete({ ownerId, key: storageKey }).catch(() => undefined); // a concurrent job already stored this key
      } catch (e) {
        if (e instanceof MuseImageError) {
          if (e.outcomeUnknown) unknown = true;
          if (e.opts.requestId) lastRequestId = e.opts.requestId;
          await writeFailed(s.stageId, cacheKey, `provider_${e.kind}`, e.opts.requestId ?? null).catch(() => undefined);
        } else {
          await writeFailed(s.stageId, cacheKey, "internal_error").catch(() => undefined);
        }
      }
      await ctx.heartbeat(0.1 + (0.85 * (i + 1)) / gen.length);
    }
  } catch (e) {
    unknown = unknown || calls > 0;
    await budget.markUncertain(reservationId).catch(() => undefined);
    throw e;
  }

  const settledUsd = billed * unitUsd;
  let outcome: "settled" | "released" | "uncertain";
  if (unknown) {
    // Never settle below a possibly-billed outcome; keep the worst case reserved until it can be checked.
    await budget.markUncertain(reservationId).catch(() => undefined);
    outcome = "uncertain";
  } else if (billed === 0) {
    await budget.release(reservationId).catch(() => undefined);
    outcome = "released";
  } else {
    await budget.settle(reservationId, settledUsd, lastRequestId, { images: billed, reservedWorstCaseUsd: reserveUsd, model }, "estimated");
    outcome = "settled";
  }
  return finish({ providerCalls: calls, cancelled, cost: { reservedUsd: reserveUsd, settledUsd, images: billed, outcome } });
}
