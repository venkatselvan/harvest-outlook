import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import type {StorageAdapter} from '../storage/types';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {ApiError} from '../services/errors';
import {envelopeSchema} from './schemas/common';
import {ITEM_ID_RE} from '../providers/sentinel2';
import {FieldId, FutureLookAsset, FutureLookRequestBody, FutureLookRequestResult} from '@harvest/contracts';
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
        'Requests a generated look made by editing the latest usable satellite scene (only inside the field outline), live mode only. ' +
        'kind=stage (default; stageId query required): a typical look of a current or future stage, at most once per stage per crop cycle. ' +
        'kind=gap (2026-11-03; targetDate body field required): the AI-predicted look of the field on a date after the latest real scene and at most 120 days after today, ' +
        'at most one per crop cycle per calendar week (stored on the week start). Both are code-guided (calendar stage, satellite curve, conditions) and never observations; ' +
        'FUTURE_LOOK_DAILY_LIMIT per crop cycle in a rolling 24 hours (default 24; 0 disables the cap). regenerate=true (gap only, 2026-11-04) replaces the existing ready look of that week with a new one from the latest scene (the per-cycle daily cap still applies; a look already queued or running is returned as deduplicated). 202 while queued or running, 200 when the existing look is ready, failed or unavailable (synthetic/replay mode, no model key, cycle limit).',
      params: z.object({id: z.uuid(), itemId: z.string().regex(ITEM_ID_RE)}),
      querystring: z.object({stageId: z.string().min(1).max(80).optional(), cycleId: z.string().min(1).max(120).optional()}).strict(),
      // No body (or an empty one) is a stage request, as before 2026-11-03.
      body: FutureLookRequestBody.nullish(),
      response: {200: envelopeSchema(FutureLookRequestResult), 202: envelopeSchema(FutureLookRequestResult)},
    },
  }, async (req, reply) => {
    const {ownerId, sessionId} = requireAuth(req);
    const body = req.body ?? {kind: 'stage' as const};
    const kind = body.kind ?? 'stage';
    if (kind === 'stage' && !req.query.stageId) throw new ApiError(400, 'validation_error', 'stageId is required for a stage look', {reason: 'stage_id_required'});
    const out = await requestFutureLook(deps, ownerId, req.params.id, {
      itemId: req.params.itemId, kind, stageId: req.query.stageId, targetDate: body.targetDate, cycleId: req.query.cycleId, sessionId, regenerate: body.regenerate === true,
    });
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
    // fieldId (2026-11-03): the field view's predicted-scene paths carry it; it must be the asset cycle's field.
    schema: {tags: ['farms'], params: farmAsset, querystring: z.object({fieldId: FieldId.optional(), v: z.coerce.number().int().positive().optional()}).strict()},
  }, async (req, reply) => {
    const image = await futureLookImage(deps, requireAuth(req).ownerId, req.params.id, req.params.assetId, req.query.fieldId);
    reply.header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff').header('content-disposition', 'inline')
      .header('x-illustration', image.kind === 'gap' ? 'predicted' : 'generated');
    if (image.sourceAcquiredAt) reply.header('x-derived-from-acquired-at', image.sourceAcquiredAt);
    return reply.type(image.contentType).send(image.bytes);
  });
}
