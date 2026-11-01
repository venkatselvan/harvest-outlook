import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {SeasonPreview, SeasonPreviewQuery} from '@harvest/contracts';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {envelope} from '../envelope';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {seasonPreview, type SeasonPreviewDeps} from '../services/season-preview';
import {envelopeSchema, uuidParam} from './schemas/common';

export interface SeasonPreviewRouteDeps extends Omit<SeasonPreviewDeps, 'config' | 'pool'> { config: Config; pool: Pool }

/**
 * `GET /api/v1/farms/:id/season-preview?planId=` or `?cropId=&productId=&sowing=&harvestLatest=&establishmentMethod=&systemId=`
 * -> SeasonPreview (ROUND3_SPEC.md section 7). Synchronous: no job and no model call; every number is computed by code
 * (stage calendar, climatology normals, historical seasonal prices, the year-plan slot scoring on the stored inputs).
 * Owner-private: the farm is resolved for the session owner first, so a foreign or deleted farm is 404. A cold read in
 * live mode can reach Open-Meteo through the weather source's bounded climatology ingest, so the rate limit is low and
 * the response is not cached by intermediaries. Registered in routes/index.ts by the orchestrator.
 */
export async function seasonPreviewRoutes(app: FastifyInstance, deps: SeasonPreviewRouteDeps): Promise<void> {
  const {config, pool} = deps;
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/season-preview', {
    config: {rateLimit: {max: 30, timeWindow: '1 minute'}},
    schema: {tags: ['plans'], params: uuidParam, querystring: SeasonPreviewQuery, response: {200: envelopeSchema(SeasonPreview)}},
  }, async (req, reply) => {
    const data = SeasonPreview.parse(await seasonPreview(deps, requireAuth(req).ownerId, req.params.id, req.query));
    reply.header('cache-control', 'private, no-store');
    return envelope(req.id, config.RUNTIME_MODE, data);
  });
}
