import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { FarmWorkspace, PutFarmWorkspace,CurrentMandiQuotes } from '@harvest/contracts';
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
import { getWorkspace, putWorkspace } from '../services/workspace';
import { monitoringSnapshot } from '../services/monitoring';
import type { PriceDeps } from '../plans/adapters/market-outlook';
import type { FetchLike } from '../ingest/http';
import {currentMandiQuotes} from '../services/market-quotes';
import {ensurePlanningReview,type PlanningDeps} from '../services/planning-review';
import { MonitorSettings, readMonitorSettings, saveMonitorSnapshot, updateMonitorSettings } from '../services/monitor-schedule';

export async function farmRoutes(app: FastifyInstance, opts: { config: Config; pool: Pool; storage: StorageAdapter; prices?: PriceDeps | undefined; weatherFetch?: FetchLike | undefined; planning?:PlanningDeps|undefined }) {
  const { config, pool, storage } = opts;
  app.addHook("onRequest", privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/v1/farms/:id/market-quotes',{schema:{tags:['farms'],params:uuidParam,response:{200:envelopeSchema(CurrentMandiQuotes)}}},async req=>envelope(req.id,config.RUNTIME_MODE,await currentMandiQuotes({config,pool,fetchImpl:opts.weatherFetch as unknown as typeof fetch},requireAuth(req).ownerId,req.params.id)));
  r.post('/api/v1/farms/:id/market-quotes',{config:{rateLimit:{max:6,timeWindow:'1 minute'}},schema:{tags:['farms'],params:uuidParam,body:z.object({productIds:z.array(z.string().min(1).max(200)).max(8).optional()}).strict(),response:{200:envelopeSchema(CurrentMandiQuotes)}}},async req=>envelope(req.id,config.RUNTIME_MODE,await currentMandiQuotes({config,pool,fetchImpl:opts.weatherFetch as unknown as typeof fetch},requireAuth(req).ownerId,req.params.id,{refresh:true,...(req.body.productIds?{productIds:req.body.productIds}:{})})));

  r.get('/api/v1/farms/:id/workspace', {
    schema: { tags: ['farms'], params: uuidParam, response: { 200: envelopeSchema(FarmWorkspace) } },
  }, async (req) => envelope(req.id, config.RUNTIME_MODE, await getWorkspace(pool, requireAuth(req).ownerId, req.params.id)));

  r.put('/api/v1/farms/:id/workspace', {
    schema: { tags: ['farms'], params: uuidParam, body: PutFarmWorkspace, response: { 200: envelopeSchema(FarmWorkspace) } },
  }, async (req) => {
    const auth=requireAuth(req);const saved=await putWorkspace(pool,auth.ownerId,req.params.id,req.body);
    // Initial unknown history is collected in a follow-up form. Explicitly submitted unknown uses POST ensure.
    if(opts.planning&&saved.previousHarvest.status!=='unknown')await ensurePlanningReview(opts.planning,auth,req.params.id).catch(()=>req.log.warn({code:'planning_enqueue_unavailable'},'Workspace saved; automatic planning enqueue unavailable'));
    return envelope(req.id,config.RUNTIME_MODE,saved);
  });

  r.get('/api/v1/farms/:id/monitoring', {
    schema: { tags: ['farms'], params: uuidParam, response: { 200: envelopeSchema(z.unknown()) } },
  }, async (req) => {
    const ownerId = requireAuth(req).ownerId;
    const snapshot = await monitoringSnapshot({ config, pool, prices: opts.prices, fetchImpl: opts.weatherFetch }, ownerId, req.params.id);
    await saveMonitorSnapshot(pool, ownerId, snapshot);
    return envelope(req.id, config.RUNTIME_MODE, { ...snapshot, schedule: await readMonitorSettings(pool, ownerId, req.params.id, config.RUNTIME_MODE) });
  });

  r.put('/api/v1/farms/:id/monitoring', {
    schema: { tags: ['farms'], params: uuidParam, body: MonitorSettings, response: { 200: envelopeSchema(z.unknown()) } },
  }, async (req) => {
    const auth = requireAuth(req);
    return envelope(req.id, config.RUNTIME_MODE, await updateMonitorSettings(pool, auth.ownerId, req.params.id, auth.sessionId, req.body, config.RUNTIME_MODE));
  });

  r.get('/api/v1/farms/:id/plans', {
    schema: { tags: ['farms'], params: uuidParam, querystring:z.object({includeArchived:z.enum(['true','false']).default('false')}),response: { 200: envelopeSchema(z.unknown()) } },
  }, async (req) => {
    const ownerId = requireAuth(req).ownerId;
    if (!await getFarm(pool, ownerId, req.params.id)) throw notFound('Farm');
    const plans = await pool.query<{ id: string; parent_plan_id: string | null; snapshot: Record<string, unknown>; created_at: Date }>(
      'SELECT id,parent_plan_id,snapshot,created_at FROM plans p WHERE farm_id=$1 AND owner_id=$2 AND ($3 OR NOT EXISTS(SELECT 1 FROM archived_plans a WHERE a.plan_id=p.id AND a.owner_id=$2)) ORDER BY created_at DESC,id DESC LIMIT 100', [req.params.id, ownerId,req.query.includeArchived==='true']);
    return envelope(req.id, config.RUNTIME_MODE, { plans: plans.rows.map((p) => ({ id: p.id, parentId: p.parent_plan_id, cropId: p.snapshot.cropId, productId: p.snapshot.productId, createdAt: p.created_at.toISOString() })) });
  });

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
