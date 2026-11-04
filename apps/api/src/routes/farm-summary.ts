import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { FarmSummary } from '@harvest/contracts';
import { z } from 'zod';
import { privateRouteGuard } from '../security/guards';
import { requireAuth } from '../security/session';
import { envelope } from '../envelope';
import { envelopeSchema, uuidParam } from './schemas/common';
import { readFarmSummary, requestFarmSummary, type SummaryDeps } from '../services/farm-summary';
export async function farmSummaryRoutes(app: FastifyInstance, deps: SummaryDeps) {
  app.addHook('onRequest', privateRouteGuard(deps.config, deps.pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/summary', {
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute'
      }
    },
    schema: {
      tags: ['farms'],
      params: uuidParam,
      response: {
        200: envelopeSchema(FarmSummary)
      }
    }
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return envelope(req.id, deps.config.RUNTIME_MODE, await readFarmSummary(deps, requireAuth(req).ownerId, req.params.id));
  });
  r.post('/api/v1/farms/:id/summary', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute'
      }
    },
    schema: {
      tags: ['farms'],
      params: uuidParam,
      body: z.object({}).strict().nullish(),
      response: {
        200: envelopeSchema(FarmSummary)
      }
    }
  }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return envelope(req.id, deps.config.RUNTIME_MODE, await requestFarmSummary(deps, requireAuth(req).ownerId, req.params.id));
  });
}
