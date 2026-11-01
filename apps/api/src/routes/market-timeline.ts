import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {Id, MarketTimeline} from '@harvest/contracts';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {envelope} from '../envelope';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {marketTimeline, type MarketTimelineDeps} from '../services/market-timeline';
import {envelopeSchema, uuidParam} from './schemas/common';

export interface MarketTimelineRouteDeps extends MarketTimelineDeps { config: Config; pool: Pool }

const query = z.object({
  /** Product slug or id; default the current cycle's product. */
  productId: Id.optional(),
  monthsBack: z.coerce.number().int().min(1).max(60).default(36),
  monthsAhead: z.coerce.number().int().min(0).max(18).default(12),
});

/**
 * `GET /api/v1/farms/:id/market-timeline?productId=&monthsBack=36&monthsAhead=12` -> MarketTimeline (ROUND2_SPEC 3.1).
 * Owner-private: the farm is resolved for the session owner first, so a foreign or deleted farm is 404. The runtime mode
 * comes from server config. The payload is parsed with the MarketTimeline contract before it is sent (the service
 * parses it and the response schema serialises through it), so a drifting payload is a 500, not a silent change.
 * A cold read in live mode can reach Open-Meteo (the weather source's bounded ingest), so the rate limit is low and the
 * response is not cached by intermediaries. Registered in routes/index.ts by the orchestrator.
 */
export async function marketTimelineRoutes(app: FastifyInstance, deps: MarketTimelineRouteDeps): Promise<void> {
  const {config, pool} = deps;
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/market-timeline', {
    config: {rateLimit: {max: 30, timeWindow: '1 minute'}},
    schema: {tags: ['market'], params: uuidParam, querystring: query, response: {200: envelopeSchema(MarketTimeline)}},
  }, async (req, reply) => {
    const q = req.query;
    const data = MarketTimeline.parse(await marketTimeline(deps, requireAuth(req).ownerId, req.params.id, {productId: q.productId, monthsBack: q.monthsBack, monthsAhead: q.monthsAhead}));
    reply.header('cache-control', 'private, no-store');
    return envelope(req.id, config.RUNTIME_MODE, data);
  });
}
