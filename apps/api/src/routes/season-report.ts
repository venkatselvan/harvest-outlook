import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {SeasonReport, SeasonReportQuery} from '@harvest/contracts';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema, uuidParam} from './schemas/common';
import {buildSeasonReport, seasonReportCsv} from '../services/season-report';

const SELECT = 'Select the crop with `cycleId`, or with `fieldId` (that field\'s current cycle). A farm with fields needs one of them (400 field_required); an unknown field is 404 field_not_found, an unknown cycle 404 cycle_not_found. A farm without fields defaults to its current crop.';

/**
 * Season report and its CSV (docs/research/FIELD_OPERATIONS_SPEC.md section 8.1). Owner-private, read-only; registered once in
 * routes/index.ts. The report holds what the farmer recorded plus stored, dated records; totals are added by the web.
 */
export async function seasonReportRoutes(app: FastifyInstance, deps: {config: Config; pool: Pool; now?: (() => Date) | undefined}) {
  app.addHook('onRequest', privateRouteGuard(deps.config, deps.pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/farms/:id/season-report', {schema: {tags: ['farms'], description: `One crop cycle's journal entries, completed field checks, issues, care completions, alerts and stored satellite readings for printing. ${SELECT}`, params: uuidParam, querystring: SeasonReportQuery, response: {200: envelopeSchema(SeasonReport)}}},
    async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      return envelope(req.id, deps.config.RUNTIME_MODE, await buildSeasonReport(deps, requireAuth(req).ownerId, req.params.id, req.query));
    });
  r.get('/api/v1/farms/:id/season-report.csv', {schema: {tags: ['farms'], description: `The same report as UTF-8 CSV (header row; one row per dated record; every cell quoted; a cell starting with = + - or @ is prefixed with a quote; details are capped at 500 characters). ${SELECT}`, params: uuidParam, querystring: SeasonReportQuery}},
    async (req, reply) => {
      const csv = seasonReportCsv(await buildSeasonReport(deps, requireAuth(req).ownerId, req.params.id, req.query));
      return reply
        .header('cache-control', 'private, no-store')
        .header('content-disposition', `attachment; filename="${csv.filename}"`)
        .type('text/csv; charset=utf-8')
        .send(csv.body);
    });
}
