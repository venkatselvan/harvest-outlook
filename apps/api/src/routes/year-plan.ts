import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApplyYearPlan, ApplyYearPlanResult, RescoreYearPlan, YearPlanFieldQuery, YearPlanHorizonQuery, YearPlanOption, YearPlanReview } from '@harvest/contracts';
import { privateRouteGuard } from '../security/guards';
import { requireAuth } from '../security/session';
import { envelope } from '../envelope';
import { envelopeSchema, uuidParam } from './schemas/common';
import { applyYearPlan, ensureYearPlan, readYearPlan, rescoreYearPlan, type YearPlanDeps } from '../services/year-plan/service';

const HORIZONS = 'Round 3: `from` (YYYY-MM-DD) selects a later 12-month plan year; it must be the start of the current year (navigation.from of year 0) or of years 1 to 3 (navigation.nextFrom chain), else 400 validation_error naming the allowed dates. Without `from`: the current horizon.';
const FIELDS = '2026-11-03 (FIELDS_MULTICROP_SOIL_SPEC.md 12.2): on a farm with fields every year-plan call names the field (`?fieldId=` on GET and POST, `fieldId` in the rescore and apply bodies); without it 400 field_required, an unknown field 404 field_not_found. Each field has its own review, horizon chain and area; apply writes saved seasons with that fieldId and keeps the other fields\' seasons. A farm without fields is unchanged.';
const EDIT_CONVENTION = 'A re-scored (farmer-edited) option is returned with optionId "<base optionId>:edit" and kept on the server with the review (the latest edit per base option). ApplyYearPlan carries no slots: to apply "Your version", send optionId "<base optionId>:edit" (and optionally its slotIds); the server applies the stored edited slots.';

/** Year plan (UI_BRIEF section 4). Owner-private; not registered here (routes/index.ts owns registration). */
export async function yearPlanRoutes(app: FastifyInstance, deps: YearPlanDeps) {
  app.addHook('onRequest', privateRouteGuard(deps.config, deps.pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/year-plan', { schema: { tags: ['farms'], description: `${HORIZONS} ${FIELDS}`, params: uuidParam, querystring: YearPlanHorizonQuery, response: { 200: envelopeSchema(YearPlanReview) } } }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return envelope(req.id, deps.config.RUNTIME_MODE, await readYearPlan(deps, requireAuth(req).ownerId, req.params.id, { from: req.query.from, fieldId: req.query.fieldId }));
  });
  r.post('/api/v1/farms/:id/year-plan', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } }, schema: { tags: ['farms'], params: uuidParam, description: `Start (or return) the year plan for the current inputs. Body {} keeps the 15-minute provider-error cooldown; {"force":true} replaces a finished plan at once (never one still being built). ${HORIZONS} ${FIELDS}`, querystring: YearPlanFieldQuery, body: z.object({ force: z.boolean().optional(), from: YearPlanHorizonQuery.shape.from }).strict(), response: { 200: envelopeSchema(YearPlanReview) } } },
    async (req) => envelope(req.id, deps.config.RUNTIME_MODE, await ensureYearPlan(deps, requireAuth(req), req.params.id, { force: req.body.force === true, from: req.body.from, fieldId: req.query.fieldId })));
  r.post('/api/v1/farms/:id/year-plan/rescore', { schema: { tags: ['farms'], description: `Re-score a farmer edit by code (no model call). ${EDIT_CONVENTION} ${FIELDS}`, params: uuidParam, body: RescoreYearPlan, response: { 200: envelopeSchema(YearPlanOption) } } },
    async (req) => envelope(req.id, deps.config.RUNTIME_MODE, await rescoreYearPlan(deps, requireAuth(req).ownerId, req.params.id, req.body)));
  r.post('/api/v1/farms/:id/year-plan/apply', { schema: { tags: ['farms'], description: `Append the option's seasons (the growing crop is skipped) with ids yearplan:{reviewId}:{optionId}:{slotId}; a repeated apply is a no-op. ${EDIT_CONVENTION} ${FIELDS}`, params: uuidParam, body: ApplyYearPlan, response: { 200: envelopeSchema(ApplyYearPlanResult) } } },
    async (req) => envelope(req.id, deps.config.RUNTIME_MODE, await applyYearPlan(deps, requireAuth(req).ownerId, req.params.id, req.body)));
}
