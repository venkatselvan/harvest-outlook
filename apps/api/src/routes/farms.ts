import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../config";
import type { Pool } from "../db/pool";
import { envelope } from "../envelope";
import { privateRouteGuard } from "../security/guards";
import { requireAuth } from "../security/session";
import { notFound } from "../services/errors";
import { createFarm, deleteFarm, getFarm, listFarms, patchFarm } from "../services/farms";
import { parseIdempotencyKey, runIdempotent } from "../services/idempotency";
import type { StorageAdapter } from "../storage/types";
import { envelopeSchema, uuidParam } from "./schemas/common";
import { createFarmBody, deleteFarmOut, farmListOut, farmOut, patchFarmBody } from "./schemas/farms";

export async function farmRoutes(app: FastifyInstance, opts: { config: Config; pool: Pool; storage: StorageAdapter }) {
  const { config, pool, storage } = opts;
  app.addHook("onRequest", privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/v1/farms",
    {
      schema: {
        tags: ["farms"],
        description:
          "Creates a farm. Location needs a district; coordinates are optional with a precision label (approximate coordinates are rounded to ~1 km). Each fact carries its own provenance. Supports Idempotency-Key.",
        body: createFarmBody,
        response: { 201: envelopeSchema(farmOut) },
      },
    },
    async (req, reply) => {
      const { ownerId } = requireAuth(req);
      const key = parseIdempotencyKey(req.headers["idempotency-key"]);
      const out = await runIdempotent(pool, { ownerId, key, route: "POST /api/v1/farms", hashInput: req.body }, async () => {
        const farm = await createFarm(pool, ownerId, req.body);
        return { status: 201, body: envelope(req.id, config.RUNTIME_MODE, farm) };
      });
      if (out.replay) reply.header("idempotent-replay", "true");
      return reply.code(out.status as 201).send(out.body as never);
    },
  );

  r.get(
    "/api/v1/farms",
    { schema: { tags: ["farms"], description: "Lists the current owner's farms.", response: { 200: envelopeSchema(farmListOut) } } },
    async (req) => envelope(req.id, config.RUNTIME_MODE, { farms: await listFarms(pool, requireAuth(req).ownerId) }),
  );

  r.get(
    "/api/v1/farms/:id",
    {
      schema: {
        tags: ["farms"],
        description: "Owner-scoped farm; other owners' farms are 404 (no existence leak). history=true includes superseded facts.",
        params: uuidParam,
        querystring: z.object({ history: z.enum(["true", "false"]).default("false") }),
        response: { 200: envelopeSchema(farmOut) },
      },
    },
    async (req) => {
      const farm = await getFarm(pool, requireAuth(req).ownerId, req.params.id, req.query.history === "true");
      if (!farm) throw notFound("Farm");
      return envelope(req.id, config.RUNTIME_MODE, farm);
    },
  );

  r.patch(
    "/api/v1/farms/:id",
    {
      schema: {
        tags: ["farms"],
        description: "Updates a farm. Fact changes append superseding facts (history is kept). expectedVersion enables optimistic concurrency (409 version_conflict).",
        params: uuidParam,
        body: patchFarmBody,
        response: { 200: envelopeSchema(farmOut) },
      },
    },
    async (req) => envelope(req.id, config.RUNTIME_MODE, await patchFarm(pool, requireAuth(req).ownerId, req.params.id, req.body)),
  );

  r.delete(
    "/api/v1/farms/:id",
    {
      schema: {
        tags: ["farms"],
        description:
          "Permanently deletes the farm and all dependent data in one transaction: plans (immutability trigger bypassed for this procedure only), plan outputs, journal, actions, visual assets, facts and media rows. " +
          "Private image files are removed after commit; a failed file removal is logged, reported in storageObjectsFailed and the file is unreachable through the API. Nothing is retained for recovery. Usage ledger rows (cost accounting, no farm data) are retained.",
        params: uuidParam,
        response: { 200: envelopeSchema(deleteFarmOut) },
      },
    },
    async (req) => {
      const res = await deleteFarm(pool, storage, requireAuth(req).ownerId, req.params.id, req.log);
      return envelope(req.id, config.RUNTIME_MODE, { deleted: true as const, ...res });
    },
  );
}
