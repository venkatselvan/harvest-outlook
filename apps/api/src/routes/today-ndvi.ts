import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import type {StorageAdapter} from '../storage/types';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema, uuidParam} from './schemas/common';
import {NdviSeries} from '@harvest/contracts';
import {ITEM_ID_RE, type Sentinel2Fetch} from '../providers/sentinel2';
import {ndviSeries, sceneImage} from '../services/today/ndvi';

export interface TodayNdviDeps { config: Config; pool: Pool; storage: StorageAdapter; fetchImpl?: Sentinel2Fetch | undefined }

/** Owner-private Sentinel-2 NDVI series and scene images for one farm. */
export async function todayNdviRoutes(app: FastifyInstance, deps: TodayNdviDeps) {
  const {config, pool} = deps;
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/ndvi', {
    config: {rateLimit: {max: 20, timeWindow: '1 minute'}},
    schema: {tags: ['farms'], params: uuidParam, querystring: z.object({from: z.iso.date().optional(), to: z.iso.date().optional()}).strict(), response: {200: envelopeSchema(NdviSeries)}},
  }, async (req) => {
    const series = await ndviSeries(deps, requireAuth(req).ownerId, req.params.id, {from: req.query.from, to: req.query.to});
    return envelope(req.id, config.RUNTIME_MODE, series);
  });
  r.get('/api/v1/farms/:id/ndvi/:itemId/image', {
    config: {rateLimit: {max: 60, timeWindow: '1 minute'}},
    schema: {tags: ['farms'], params: z.object({id: z.uuid(), itemId: z.string().regex(ITEM_ID_RE)}), querystring: z.object({kind: z.enum(['visual', 'ndvi']).default('visual'), zoom: z.enum(['wide', 'field']).default('wide')}).strict()},
  }, async (req, reply) => {
    const image = await sceneImage(deps, requireAuth(req).ownerId, req.params.id, req.params.itemId, req.query.kind, req.query.zoom);
    reply.header('cache-control', 'private, max-age=3600').header('x-scene-acquired-at', image.acquiredAt);
    return reply.type(image.contentType).send(image.bytes);
  });
}
