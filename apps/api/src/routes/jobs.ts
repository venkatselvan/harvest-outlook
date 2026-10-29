import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { envelope } from "../envelope";
import { privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import { notFound } from "../services/errors";
import { getJob, requestCancel } from "../services/jobs";
import { envelopeSchema, uuidParam } from "./schemas/common";
import { jobOut } from "./schemas/session";

export async function jobRoutes(app: FastifyInstance, opts: { config: Config; pool: Pool }) {
  const { config, pool } = opts;
  app.addHook("onRequest", privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/v1/jobs/:id",
    { schema: { tags: ["jobs"], description: "Owner-scoped job status. Other owners' jobs are 404.", params: uuidParam, response: { 200: envelopeSchema(jobOut) } } },
    async (req) => {
      const job = await getJob(pool, requireAuth(req).ownerId, req.params.id);
      if (!job) throw notFound("Job");
      return envelope(req.id, config.RUNTIME_MODE, job);
    },
  );

  r.post(
    "/api/v1/jobs/:id/cancel",
    { schema: { tags: ["jobs"], description: "Requests cancellation. The worker honours the flag; a provider call already in flight may still complete and be billed.", params: uuidParam, response: { 200: envelopeSchema(jobOut) } } },
    async (req) => {
      const job = await requestCancel(pool, requireAuth(req).ownerId, req.params.id);
      if (!job) throw notFound("Job");
      return envelope(req.id, config.RUNTIME_MODE, job);
    },
  );
}
