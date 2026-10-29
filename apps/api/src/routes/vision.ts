import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { envelope } from "../envelope";
import { privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import { notFound } from "../services/errors";
import { payloadHash } from "../services/hash";
import { enqueue, type JobRecord } from "../services/jobs";
import { getMedia } from "../services/media";
import type { StorageAdapter } from "../storage/types";
import { SAM_LABEL, SEGMENT_JOB_TYPE } from "../vision/jobs/segmentation";
import { z } from "zod";
import { envelopeSchema, uuidParam } from "./schemas/common";
import { mediaOut } from "./schemas/media";
import { segmentationBody, segmentationOut } from "./schemas/vision";

/** A finished job is only reusable when it produced a usable answer; failures and 'unavailable' are re-runnable. */
function reusable(job: JobRecord): boolean {
  if (job.state === "failed" || job.state === "cancelled") return false;
  const r = job.result as { status?: string } | null;
  return !(job.state === "succeeded" && r?.status === "unavailable");
}

/** Register with `app.register(registerVisionRoutes, { config, pool, storage })`. */
export async function registerVisionRoutes(app: FastifyInstance, opts: { config: Config; pool: Pool; storage?: StorageAdapter }) {
  const { config, pool } = opts;
  app.addHook("onRequest", privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/v1/media/:id/segmentation",
    {
      schema: {
        tags: ["vision"],
        description:
          "Queues a SAM region proposal job (vision.segment) for an owned image. Prompt coordinates are normalised 0..1 in the normalised image. " +
          "Identical requests (same session, image hash, prompt, model) return the same job. The result is a proposal only: poll GET /jobs/:id, then confirm with PUT /media/:id/region (source sam_confirmed). " +
          "Without a model credential, or in synthetic/replay mode, the job succeeds with status 'unavailable'.",
        params: uuidParam,
        body: segmentationBody,
        response: { 202: envelopeSchema(segmentationOut) },
      },
    },
    async (req, reply) => {
      const { ownerId, sessionId } = requireAuth(req);
      const media = await getMedia(pool, ownerId, req.params.id);
      if (!media) throw notFound("Media");
      const model = config.META_SEGMENT_MODEL;
      const payload = { mediaId: media.id, prompt: req.body.prompt, sessionId };
      const base = `vseg:${payloadHash({ sessionId, sha: media.sha256, prompt: req.body.prompt, model }).slice(0, 48)}`;
      let out = await enqueue(pool, SEGMENT_JOB_TYPE, payload, ownerId, base);
      for (let n = 1; !out.created && !reusable(out.job) && n <= 20; n++) out = await enqueue(pool, SEGMENT_JOB_TYPE, payload, ownerId, `${base}:r${n}`);
      return reply.code(202).send(
        envelope(req.id, config.RUNTIME_MODE, { jobId: out.job.id, state: out.job.state, deduplicated: !out.created, manualFallbackAvailable: true as const, label: SAM_LABEL }),
      );
    },
  );

  r.get(
    "/api/v1/farms/:id/media",
    {
      schema: {
        tags: ["vision"],
        description: "Owner-scoped list of this farm's images, newest first (at most 20), so a reloaded page can find its photo and saved region. Other owners' farms are 404.",
        params: uuidParam,
        response: { 200: envelopeSchema(z.object({ media: z.array(mediaOut) })) },
      },
    },
    async (req) => {
      const { ownerId } = requireAuth(req);
      const farm = await pool.query("SELECT 1 FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL", [req.params.id, ownerId]);
      if (!farm.rowCount) throw notFound("Farm");
      const ids = await pool.query<{ id: string }>(
        "SELECT id FROM media_objects WHERE farm_id=$1 AND owner_id=$2 AND kind='image' AND deleted_at IS NULL ORDER BY created_at DESC, id LIMIT 20",
        [req.params.id, ownerId],
      );
      const media = (await Promise.all(ids.rows.map((r) => getMedia(pool, ownerId, r.id)))).filter((m): m is NonNullable<typeof m> => m !== null);
      return envelope(req.id, config.RUNTIME_MODE, { media });
    },
  );
}
