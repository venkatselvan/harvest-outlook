import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {TodayView} from '@harvest/contracts';
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
 * owner first, so a foreign or deleted farm is 404. Registered in routes/index.ts.
 * A cold read in live mode can reach Planetary Computer (at most 12 scenes) and Open-Meteo (bounded ingest), so the
 * rate limit is low and the response is never cached by intermediaries.
 */
export async function todayRoutes(app: FastifyInstance, deps: TodayRouteDeps) {
  const {config, pool} = deps;
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/today', {
    config: {rateLimit: {max: 30, timeWindow: '1 minute'}},
    schema: {tags: ['farms'], params: uuidParam, response: {200: envelopeSchema(TodayView)}},
  }, async (req, reply) => {
    const view = await todayView(deps, requireAuth(req).ownerId, req.params.id);
    reply.header('cache-control', 'private, no-store');
    return envelope(req.id, config.RUNTIME_MODE, view);
  });
}
