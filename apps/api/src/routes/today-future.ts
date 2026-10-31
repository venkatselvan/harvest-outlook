import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import type {StorageAdapter} from '../storage/types';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema} from './schemas/common';
import {ITEM_ID_RE} from '../providers/sentinel2';
import {FutureLookAsset, FutureLookRequestResult} from '@harvest/contracts';
import {futureLookImage, futureLookStatus, requestFutureLook, type FutureLookImageDeps} from '../services/today/future-look';

export interface TodayFutureDeps extends FutureLookImageDeps { config: Config; pool: Pool; storage: StorageAdapter }

/**
 * Owner-private "future look" illustrations for the Today satellite view. Registered in routes/index.ts.
 */
export async function todayFutureRoutes(app: FastifyInstance, deps: TodayFutureDeps) {
  const {config, pool} = deps;
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  const farmAsset = z.object({id: z.uuid(), assetId: z.uuid()});

  r.post('/api/v1/farms/:id/ndvi/:itemId/future', {
    config: {rateLimit: {max: 6, timeWindow: '1 minute'}},
    schema: {
      tags: ['farms'],
      description:
        'Requests a generated illustration of a typical look of a current or future stage, made by editing the latest usable satellite scene ' +
        '(only inside the field outline). Live mode only; generated only on this explicit request and at most once per stage per crop cycle. ' +
        '202 while queued or running, 200 when the existing illustration is ready, failed or unavailable (synthetic/replay mode, no model key, cycle limit).',
      params: z.object({id: z.uuid(), itemId: z.string().regex(ITEM_ID_RE)}),
      querystring: z.object({stageId: z.string().min(1).max(80), cycleId: z.string().min(1).max(120).optional()}).strict(),
      response: {200: envelopeSchema(FutureLookRequestResult), 202: envelopeSchema(FutureLookRequestResult)},
    },
  }, async (req, reply) => {
    const {ownerId, sessionId} = requireAuth(req);
    const out = await requestFutureLook(deps, ownerId, req.params.id, {itemId: req.params.itemId, stageId: req.query.stageId, cycleId: req.query.cycleId, sessionId});
    return reply.code(out.status === 'queued' || out.status === 'running' ? 202 : 200).send(envelope(req.id, config.RUNTIME_MODE, out));
  });

  r.get('/api/v1/farms/:id/future-look/:assetId', {
    config: {rateLimit: {max: 120, timeWindow: '1 minute'}},
    schema: {tags: ['farms'], params: farmAsset, response: {200: envelopeSchema(FutureLookAsset)}},
  }, async (req) => {
    const asset = await futureLookStatus(deps, requireAuth(req).ownerId, req.params.id, req.params.assetId);
    return envelope(req.id, config.RUNTIME_MODE, asset);
  });

  r.get('/api/v1/farms/:id/future-look/:assetId/image', {
    config: {rateLimit: {max: 60, timeWindow: '1 minute'}},
    schema: {tags: ['farms'], params: farmAsset},
  }, async (req, reply) => {
    const image = await futureLookImage(deps, requireAuth(req).ownerId, req.params.id, req.params.assetId);
    reply.header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff').header('content-disposition', 'inline').header('x-illustration', 'generated');
    if (image.sourceAcquiredAt) reply.header('x-derived-from-acquired-at', image.sourceAcquiredAt);
    return reply.type(image.contentType).send(image.bytes);
  });
}
