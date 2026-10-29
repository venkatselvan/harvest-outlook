import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { envelope } from "../envelope";
import { privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import { ApiError, notFound } from "../services/errors";
import { parseIdempotencyKey, runIdempotent } from "../services/idempotency";
import { enqueue, getJob, type JobRecord } from "../services/jobs";
import { buildContext, loadPlanStages } from "../visuals/context";
import { ILLUSTRATIVE_LABEL, SCHEMATIC_LABEL, VISUAL_JOB_TYPE } from "../visuals/labels";
import { loadBriefs, type VisualBrief } from "../visuals/brief";
import { adoptReusable, findByCacheKeys, getOwned, listLatestPerStage, toOut } from "../visuals/repository";
import { STABLE_SCHEMATIC_REASONS } from "../visuals/labels";
import type { StorageAdapter } from "../storage/types";
import { envelopeSchema, uuidParam } from "./schemas/common";
import { listOut, startOut, visualsBody } from "./schemas/visuals";
import { StorageError } from "../storage/types";

export interface VisualRouteDeps {
  config: Config;
  pool: Pool;
  storage: StorageAdapter;
  /** Defaults to the curated briefs on disk. */
  briefs?: Map<string, VisualBrief>;
}

/** A finished job is reusable unless it failed or was cancelled; the asset rows (not the job) carry the cache. */
const reusable = (j: JobRecord): boolean => j.state !== "failed" && j.state !== "cancelled";

/** Register with `app.register(registerVisualRoutes, { config, pool, storage })`. */
export async function registerVisualRoutes(app: FastifyInstance, deps: VisualRouteDeps) {
  const { config, pool, storage } = deps;
  const briefsP = deps.briefs ? Promise.resolve(deps.briefs) : loadBriefs();
  app.addHook("onRequest", privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/v1/plans/:id/visuals",
    {
      schema: {
        tags: ["visuals"],
        description:
          "Queues the illustrative growth keyframes (visuals.keyframes) for a plan's stages from the owner's photo and confirmed region. " +
          "Cached assets (same photo, region version, crop, stage definitions, brief and model) return immediately with no provider call. " +
          "Without a model key, or in synthetic/replay mode, the stages become labelled schematics. Generated images are illustrative, never observations. Supports Idempotency-Key.",
        params: uuidParam,
        body: visualsBody,
        response: { 200: envelopeSchema(startOut), 202: envelopeSchema(startOut) },
      },
    },
    async (req, reply) => {
      const { ownerId, sessionId } = requireAuth(req);
      const idem = parseIdempotencyKey(req.headers["idempotency-key"]);
      const exec = async () => {
        const v = await buildContext({ pool, config, briefs: await briefsP }, ownerId, { planId: req.params.id, ...req.body });
        const keys = [...v.assetKeys.values()];
        await adoptReusable(pool, ownerId, v.planId, keys, null);
        const rows = await findByCacheKeys(pool, ownerId, v.planId, keys);
        const byKey = new Map(rows.map((x) => [x.cache_key, x]));
        const allCached = v.selected.every((s) => {
          const row = byKey.get(v.assetKeys.get(s.stageId)!);
          return !!row && (row.status === "ready" || (row.status === "schematic" && STABLE_SCHEMATIC_REASONS.has(row.failure_reason ?? "")));
        });
        if (allCached) {
          return { status: 200, body: envelope(req.id, config.RUNTIME_MODE, { jobId: null, state: "cached" as const, cached: true, deduplicated: true, assets: rows.map(toOut), label: ILLUSTRATIVE_LABEL }) };
        }
        const payload = { planId: req.params.id, mediaId: req.body.mediaId, regionVersion: req.body.regionVersion, ...(req.body.stageIds ? { stageIds: req.body.stageIds } : {}), sessionId };
        // Always the content-derived key: a client Idempotency-Key only replays this HTTP response (runIdempotent below), it
        // never creates a second paid job for content that is already queued or running.
        const base = `vk:${v.jobKey.slice(0, 48)}`;
        const enqueueOne = async (key: string) => {
          try {
            return await enqueue(pool, VISUAL_JOB_TYPE, payload, ownerId, key);
          } catch (e) {
            // Same content requested from another session: the job is the same, only the budget session differs.
            if (!(e instanceof ApiError) || e.code !== "idempotency_payload_mismatch") throw e;
            const ex = await pool.query<{ id: string }>("SELECT id FROM jobs WHERE owner_id=$1 AND idempotency_key=$2", [ownerId, key]);
            const job = ex.rows[0] ? await getJob(pool, ownerId, ex.rows[0].id) : null;
            if (!job) throw e;
            return { job, created: false };
          }
        };
        let out = await enqueueOne(base);
        for (let n = 1; !out.created && !reusable(out.job) && n <= 20; n++) out = await enqueueOne(`${base}:r${n}`);
        return { status: 202, body: envelope(req.id, config.RUNTIME_MODE, { jobId: out.job.id, state: out.job.state, cached: false, deduplicated: !out.created, label: ILLUSTRATIVE_LABEL }) };
      };
      const out = await runIdempotent(pool, { ownerId, key: idem, route: "POST /api/v1/plans/:id/visuals", hashInput: { planId: req.params.id, ...req.body }, resourceRefs: { mediaId: req.body.mediaId } }, exec);
      return reply.code(out.status === 200 ? 200 : 202).send(out.body as never);
    },
  );

  r.get(
    "/api/v1/plans/:id/visuals",
    {
      schema: {
        tags: ["visuals"],
        description:
          "Per-stage visual state for an owned plan: ready (generated, illustrative), failed, schematic, or queued while a job runs. " +
          "A failed or missing keyframe never blocks the plan; the schematic label applies. qaWarning is set when scene QA found the picture changed outside the planting region.",
        params: uuidParam,
        response: { 200: envelopeSchema(listOut) },
      },
    },
    async (req) => {
      const { ownerId } = requireAuth(req);
      const plan = await loadPlanStages(pool, ownerId, req.params.id);
      const latest = new Map((await listLatestPerStage(pool, ownerId, plan.planId)).map((x) => [x.stage_key!, x]));
      const active = await pool.query(
        "SELECT 1 FROM jobs WHERE owner_id=$1 AND type=$2 AND state IN ('queued','running') AND payload->>'planId' = $3 LIMIT 1",
        [ownerId, VISUAL_JOB_TYPE, plan.planId],
      );
      const generating = (active.rowCount ?? 0) > 0;
      const stages = plan.stages.map((s) => {
        const row = latest.get(s.stageId);
        const state = row && row.status === "ready" ? ("ready" as const) : generating ? ("queued" as const) : row ? row.status : ("schematic" as const);
        return {
          stageId: s.stageId,
          name: s.name,
          order: s.order,
          state,
          label: state === "ready" ? ILLUSTRATIVE_LABEL : SCHEMATIC_LABEL,
          asset: row ? toOut(row) : null,
        };
      });
      return envelope(req.id, config.RUNTIME_MODE, { planId: plan.planId, generating, stages });
    },
  );

  r.get(
    "/api/v1/visuals/:id/content",
    {
      schema: {
        tags: ["visuals"],
        description: "Streams a generated keyframe PNG to its owner only (Cache-Control: private). Other owners', schematic and failed assets are 404.",
        params: uuidParam,
      },
    },
    async (req, reply) => {
      const row = await getOwned(pool, requireAuth(req).ownerId, req.params.id);
      if (!row || row.status !== "ready" || !row.storage_key) throw notFound("Visual asset");
      let data: Uint8Array;
      try {
        data = await storage.get({ ownerId: row.owner_id, key: row.storage_key });
      } catch (e) {
        if (e instanceof StorageError) throw notFound("Visual asset");
        throw e;
      }
      return reply.header("cache-control", "private, max-age=3600").header("content-type", "image/png").header("content-disposition", "inline").header("x-content-type-options", "nosniff").send(Buffer.from(data));
    },
  );
}
