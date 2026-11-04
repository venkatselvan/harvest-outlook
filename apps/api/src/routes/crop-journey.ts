import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {CropJourney, CropJourneyRequest} from '@harvest/contracts';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {envelope} from '../envelope';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {cropJourneyStatus, requestCropJourney, type CropJourneyDeps} from '../services/today/crop-journey';
import {envelopeSchema} from './schemas/common';

export interface CropJourneyRouteDeps extends Omit<CropJourneyDeps, 'config' | 'pool'> { config: Config; pool: Pool }

/**
 * Crop journey (docs/research/EVARA_ACTIONS_SPEC.md section 3.2, 2026-11-04): an arbitrary crop's growth cycle on one field as
 * up to five generated stage illustrations (services/today/crop-journey.ts has the rules). Owner-private: the farm is
 * resolved for the session owner first, so a foreign or deleted farm is 404. Images are served by the existing
 * GET /api/v1/farms/:id/future-look/:assetId/image route. Registered in routes/index.ts; the job type today.crop-journey is
 * registered in worker/handlers/index.ts.
 */
export async function cropJourneyRoutes(app: FastifyInstance, deps: CropJourneyRouteDeps): Promise<void> {
  const {config, pool} = deps;
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/api/v1/farms/:id/crop-journey', {
    config: {rateLimit: {max: 6, timeWindow: '1 minute'}},
    schema: {
      tags: ['farms'],
      description:
        'Requests generated stage illustrations of a crop\'s growth cycle on this field (Meta image edits of the latest usable satellite scene, else the latest ' +
        'field photo with a confirmed region, inside the field outline; QA-checked). Live mode with a model key only. Up to 5 illustrated stages (first, last and ' +
        'up to three evenly spaced), the rest schematic. One journey per crop, field and IST day (a repeat returns it, deduplicated), at most 3 per farm per day. ' +
        '202 while queued or running, 200 otherwise (ready, partial, failed, unavailable: runtime_mode, no_source_image, field_required, daily_cap, budget).',
      params: z.object({id: z.uuid()}),
      body: CropJourneyRequest,
      response: {200: envelopeSchema(CropJourney), 202: envelopeSchema(CropJourney)},
    },
  }, async (req, reply) => {
    const {ownerId, sessionId} = requireAuth(req);
    const out = await requestCropJourney(deps, {ownerId, sessionId}, req.params.id, req.body);
    reply.header('cache-control', 'private, no-store');
    return reply.code(out.status === 'queued' || out.status === 'running' ? 202 : 200).send(envelope(req.id, config.RUNTIME_MODE, out));
  });

  r.get('/api/v1/farms/:id/crop-journey/:journeyId', {
    config: {rateLimit: {max: 120, timeWindow: '1 minute'}},
    schema: {tags: ['farms'], params: z.object({id: z.uuid(), journeyId: z.uuid()}), response: {200: envelopeSchema(CropJourney)}},
  }, async (req, reply) => {
    const out = await cropJourneyStatus(deps, requireAuth(req).ownerId, req.params.id, req.params.journeyId);
    reply.header('cache-control', 'private, no-store');
    return envelope(req.id, config.RUNTIME_MODE, out);
  });
}
