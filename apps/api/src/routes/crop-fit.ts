import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CropFitMode, CropFitReview, CropSeason } from '@harvest/contracts';
import { privateRouteGuard } from '../security/guards';
import { requireAuth } from '../security/session';
import { envelope } from '../envelope';
import { envelopeSchema, uuidParam } from './schemas/common';
import { ensureCropFit, type CropFitDeps } from '../services/crop-fit/service';
import { ApiError } from '../services/errors';

/**
 * Query of GET/POST /api/v1/farms/:id/crop-fit. `season` is required with mode=season; `sowing` (YYYY-MM-DD, today or
 * later, at most 400 days ahead) applies to mode=date and defaults to today. Parameters that do not apply to the mode are
 * ignored, so the cached review depends only on the effective request. No mode: `next` when a crop is growing, else `date`.
 */
export const CropFitQuery = z.object({
  mode: CropFitMode.optional(),
  season: CropSeason.optional(),
  sowing: z.iso.date().optional(),
}).strict().superRefine((q, ctx) => {
  if (q.mode === 'season' && !q.season) ctx.addIssue({ code: 'custom', path: ['season'], message: 'season is required when mode is season' });
});

const DESCRIPTION = 'Crop fit v2 (ROUND2_SPEC 4.1): every pool crop scored by code for one sowing date, compared with the confirmed soil markers, and three picks (Meta, or calculated when Meta is unavailable). GET returns the ready review for the current inputs or starts one (status pending) and enqueues farm.crop-fit once; poll GET while pending or running.';

/** Owner-private; not registered here (routes/index.ts owns registration). */
export async function cropFitRoutes(app: FastifyInstance, deps: CropFitDeps) {
  app.addHook('onRequest', privateRouteGuard(deps.config, deps.pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  const today = () => new Date((deps.now ?? (() => new Date()))().getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const checkSowing = (sowing: string | undefined, mode: string | undefined) => {
    if (!sowing || (mode !== undefined && mode !== 'date')) return;
    const t = today();
    const limit = new Date(Date.parse(`${t}T00:00:00Z`) + 400 * 86_400_000).toISOString().slice(0, 10);
    if (sowing < t || sowing > limit) throw new ApiError(400, 'validation_error', 'sowing must be today or later and at most 400 days ahead');
  };
  r.get('/api/v1/farms/:id/crop-fit', { schema: { tags: ['farms'], description: DESCRIPTION, params: uuidParam, querystring: CropFitQuery, response: { 200: envelopeSchema(CropFitReview) } } }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    checkSowing(req.query.sowing, req.query.mode);
    return envelope(req.id, deps.config.RUNTIME_MODE, await ensureCropFit(deps, requireAuth(req), req.params.id, req.query));
  });
  r.post('/api/v1/farms/:id/crop-fit', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } }, schema: { tags: ['farms'], description: `${DESCRIPTION} POST with the same query replaces a finished review at once (never one still being built). Body {} or none.`, params: uuidParam, querystring: CropFitQuery, body: z.object({}).strict().optional(), response: { 200: envelopeSchema(CropFitReview) } } }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    checkSowing(req.query.sowing, req.query.mode);
    return envelope(req.id, deps.config.RUNTIME_MODE, await ensureCropFit(deps, requireAuth(req), req.params.id, req.query, { force: true }));
  });
}
