import { StageDefinition } from "@harvest/contracts";
import { z } from "zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { ApiError, notFound } from "../services/errors";
import { payloadHash } from "../services/hash";
import { getMedia } from "../services/media";
import { findPlan, getOutputs } from "../plans/repository";
import type { VisualBrief } from "./brief";
import { MAX_KEYFRAMES } from "./labels";

type StageDef = z.infer<typeof StageDefinition>;

export interface PlanStages {
  planId: string;
  cropId: string;
  mode: "live" | "replay" | "synthetic";
  stages: StageDef[];
}

/** Stage definitions live in the plan's immutable `inputs` output. Owner-scoped; unknown plan is 404. */
export async function loadPlanStages(pool: Pool, ownerId: string, planId: string): Promise<PlanStages> {
  const plan = await findPlan(pool, ownerId, planId);
  if (!plan) throw notFound("Plan");
  const outs = await getOutputs(pool, ownerId, plan.snapshot.outputIds);
  const inputs = outs.find((o) => o.kind === "inputs");
  const parsed = z.array(StageDefinition).safeParse((inputs?.output as { stageDefinitions?: unknown } | undefined)?.stageDefinitions);
  if (!parsed.success || parsed.data.length === 0) throw new ApiError(422, "plan_has_no_stages", "The plan carries no stage definitions to illustrate");
  const stages = [...parsed.data].sort((a, b) => a.order - b.order);
  return { planId, cropId: stages[0]!.cropId, mode: plan.snapshot.mode, stages };
}

/**
 * Hash of the visual-relevant stage definition fields. Durations and thermal parameters are excluded on purpose:
 * they move dates, not what the illustration should show, so editing them must not regenerate paid images.
 */
export function stageDefinitionsHash(stages: StageDef[]): string {
  return payloadHash(stages.map((s) => ({ stageId: s.stageId, name: s.name, order: s.order, isHarvest: s.isHarvest, evidenceIds: [...s.evidenceIds].sort() })).sort((a, b) => a.order - b.order));
}

export function selectStages(all: StageDef[], stageIds?: string[]): StageDef[] {
  let sel = all;
  if (stageIds && stageIds.length > 0) {
    const want = new Set(stageIds);
    for (const id of want) if (!all.some((s) => s.stageId === id)) throw new ApiError(422, "unknown_stage", `Stage ${id} is not part of this plan`);
    sel = all.filter((s) => want.has(s.stageId));
  }
  if (sel.length > MAX_KEYFRAMES) throw new ApiError(422, "too_many_stages", `At most ${MAX_KEYFRAMES} keyframes can be generated per request; pass stageIds`);
  return sel;
}

export interface KeyInputs {
  mediaSha: string;
  regionVersion: number;
  cropId: string;
  stageDefsHash: string;
  promptVersion: string;
  briefHash: string;
  model: string;
  mode: string;
}

/**
 * Job-level dedup key: sha256 over photo, region, crop, stage definitions, brief version, model id and mode (+ the
 * requested stage set). It also carries the plan id: a job writes rows for one plan, so two plans never share a job.
 * The per-asset key below is plan-independent so a second or revised plan can adopt existing keyframes for free.
 */
export const jobCacheKey = (planId: string, k: KeyInputs, stageIds: string[]): string => payloadHash({ planId, ...k, stageIds: [...stageIds].sort() });
/** Per-asset key; also bound to the stage's own prompt template so editing one prompt invalidates only that stage. */
export const assetCacheKey = (k: KeyInputs, stageId: string, promptTemplateHash: string | null): string => payloadHash({ ...k, stageId, promptTemplateHash });

export interface VisualContext extends PlanStages {
  selected: StageDef[];
  brief: VisualBrief | null;
  keyInputs: KeyInputs;
  jobKey: string;
  assetKeys: Map<string, string>;
  mediaId: string;
  polygon: [number, number][];
  /** Effective mode: the more restrictive of the plan mode and the runtime mode. */
  effectiveMode: "live" | "replay" | "synthetic";
}

export function effectiveMode(planMode: PlanStages["mode"], runtime: Config["RUNTIME_MODE"]): "live" | "replay" | "synthetic" {
  if (planMode === "synthetic" || runtime === "synthetic") return "synthetic";
  if (planMode === "replay" || runtime === "replay") return "replay";
  return "live";
}

/** Resolves everything needed to compute cache keys; shared by the route (cache pre-check) and the job. */
export async function buildContext(
  deps: { pool: Pool; config: Config; briefs: Map<string, VisualBrief> },
  ownerId: string,
  req: { planId: string; mediaId: string; regionVersion: number; stageIds?: string[] | undefined },
): Promise<VisualContext> {
  const plan = await loadPlanStages(deps.pool, ownerId, req.planId);
  const media = await getMedia(deps.pool, ownerId, req.mediaId);
  if (!media) throw notFound("Media");
  if (!media.region) throw new ApiError(422, "region_required", "Confirm the planting region on the photo before generating a visual journey");
  if (media.region.version !== req.regionVersion) {
    throw new ApiError(409, "region_version_mismatch", "The planting region changed; reload the photo and retry", { currentRegionVersion: media.region.version });
  }
  const selected = selectStages(plan.stages, req.stageIds);
  const brief = deps.briefs.get(plan.cropId) ?? null;
  const mode = effectiveMode(plan.mode, deps.config.RUNTIME_MODE);
  const keyInputs: KeyInputs = {
    mediaSha: media.sha256,
    regionVersion: media.region.version,
    cropId: plan.cropId,
    stageDefsHash: stageDefinitionsHash(plan.stages),
    promptVersion: brief?.promptVersion ?? "none",
    briefHash: brief?.briefHash ?? "none",
    model: deps.config.META_IMAGE_MODEL,
    mode,
  };
  const assetKeys = new Map(selected.map((s) => [s.stageId, assetCacheKey(keyInputs, s.stageId, brief?.stages.find((b) => b.stageId === s.stageId)?.promptTemplateHash ?? null)]));
  return { ...plan, selected, brief, keyInputs, jobKey: jobCacheKey(plan.planId, keyInputs, selected.map((s) => s.stageId)), assetKeys, mediaId: media.id, polygon: media.region.polygon, effectiveMode: mode };
}
