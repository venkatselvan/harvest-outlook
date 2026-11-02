import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {FieldId, TodayView} from '@harvest/contracts';
import {z} from 'zod';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {envelope} from '../envelope';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {todayView, type TodayViewDeps} from '../services/today/view';
import {envelopeSchema, uuidParam} from './schemas/common';

export interface TodayRouteDeps extends TodayViewDeps { config: Config; pool: Pool }

/**
 * `GET /api/v1/farms/:id/today` -> TodayView (UI_BRIEF section 4). Owner-private: the farm is resolved for the session
 * owner first, so a foreign or deleted farm is 404. Registered in routes/index.ts. `?fieldId=` (2026-11-03) selects one field of
 * the farm (404 field_not_found when the farm has no such field).
 * A cold read in live mode can reach Planetary Computer (at most 12 scenes) and Open-Meteo (bounded ingest), so the
 * rate limit is low and the response is never cached by intermediaries.
 */
export async function todayRoutes(app: FastifyInstance, deps: TodayRouteDeps) {
  const {config, pool} = deps;
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/today', {
    config: {rateLimit: {max: 30, timeWindow: '1 minute'}},
    schema: {tags: ['farms'], params: uuidParam, querystring: z.object({fieldId: FieldId.optional()}).strict(), response: {200: envelopeSchema(TodayView)}},
  }, async (req, reply) => {
    const view = await todayView(deps, requireAuth(req).ownerId, req.params.id, req.query.fieldId !== undefined ? {fieldId: req.query.fieldId} : {});
    reply.header('cache-control', 'private, no-store');
    return envelope(req.id, config.RUNTIME_MODE, view);
  });
}
