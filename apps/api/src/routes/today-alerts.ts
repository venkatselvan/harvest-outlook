import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { FarmAlert, FarmAlerts, FieldId } from '@harvest/contracts';
import type { Config } from '../config';
import type { Pool } from '../db/pool';
import { envelope } from '../envelope';
import { privateRouteGuard } from '../security/guards';
import { requireAuth } from '../security/session';
import { dismissAlert, listAlerts } from '../services/today/alerts';
import { envelopeSchema, uuidParam } from './schemas/common';

export interface TodayAlertRouteDeps { config: Config; pool: Pool; now?: () => Date }

/**
 * Today view alerts (registered in routes/index.ts). Owner isolation: every query is scoped by the session owner and the parent farm; foreign farms
 * and alerts are 404. `?fieldId=` (2026-11-03, FIELDS_MULTICROP_SOIL_SPEC.md 12.4): that field's alerts plus the farm-wide ones;
 * 404 field_not_found when the farm has no such field. Each alert carries `scope` ('field' | 'farm').
 */
export async function todayAlertRoutes(app: FastifyInstance, deps: TodayAlertRouteDeps) {
  const { config, pool } = deps;
  const now = deps.now ?? (() => new Date());
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/v1/farms/:id/alerts', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags: ['farms'], params: uuidParam, querystring: z.object({ fieldId: FieldId.optional() }).strict(), response: { 200: envelopeSchema(FarmAlerts) } },
  }, async (req) => envelope(req.id, config.RUNTIME_MODE, await listAlerts(pool, requireAuth(req).ownerId, req.params.id, config.RUNTIME_MODE, now().toISOString(), { fieldId: req.query.fieldId })));

  r.post('/api/v1/farms/:id/alerts/:alertId/dismiss', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['farms'], params: z.object({ id: z.uuid(), alertId: z.uuid() }), response: { 200: envelopeSchema(FarmAlert) } },
  }, async (req) => envelope(req.id, config.RUNTIME_MODE, await dismissAlert(pool, requireAuth(req).ownerId, req.params.id, config.RUNTIME_MODE, req.params.alertId)));
}
