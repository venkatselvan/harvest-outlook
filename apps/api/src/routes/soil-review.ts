import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { FieldId, SoilReview } from '@harvest/contracts';
import { privateRouteGuard } from '../security/guards';
import { requireAuth } from '../security/session';
import { envelope } from '../envelope';
import { envelopeSchema, uuidParam } from './schemas/common';
import { ensureSoilReview, type SoilReviewDeps } from '../services/soil-review';

/**
 * Soil review (ROUND2_SPEC.md 5.2). Owner-private; not registered here (routes/index.ts owns registration).
 * GET returns the review for the current soil values and seasons: a ready review, or a pending one with the code-rated
 * readings already filled in (the job farm.soil-review writes the narrative), or status 'no_report' without confirmed values.
 */
/** 2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 12.3): `fieldId` takes the current and next crop from that field; the soil values stay farm-level. */
const FieldQuery = z.object({ fieldId: FieldId.optional() }).strict();

export async function soilReviewRoutes(app: FastifyInstance, deps: SoilReviewDeps) {
  app.addHook('onRequest', privateRouteGuard(deps.config, deps.pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/soil-review', { schema: { tags: ['farms'], description: 'The soil review for this field\'s confirmed soil values: readings rated against cited bands, code facts and the narrative. Creates a pending review and enqueues one job when none exists for the current values.', params: uuidParam, querystring: FieldQuery, response: { 200: envelopeSchema(SoilReview) } } }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return envelope(req.id, deps.config.RUNTIME_MODE, await ensureSoilReview(deps, requireAuth(req), req.params.id, { fieldId: req.query.fieldId }));
  });
  r.post('/api/v1/farms/:id/soil-review', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } }, schema: { tags: ['farms'], description: 'Refresh: a finished review is archived and rebuilt; a review still being built is returned. Body {}.', params: uuidParam, querystring: FieldQuery, body: z.object({}).strict().optional(), response: { 200: envelopeSchema(SoilReview) } } },
    async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      return envelope(req.id, deps.config.RUNTIME_MODE, await ensureSoilReview(deps, requireAuth(req), req.params.id, { force: true, fieldId: req.query.fieldId }));
    });
}
