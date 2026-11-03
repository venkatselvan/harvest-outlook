import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {AddIssueEvent, CompleteCheck, CompleteCheckResult, CreateIssue, FieldChecks, FieldChecksQuery, FieldIssue, FieldIssues, FieldIssuesQuery} from '@harvest/contracts';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema, uuidParam} from './schemas/common';
import {readFieldChecks, readFieldIssue, readFieldIssues} from '../services/scouting/issues';
import {addIssueEvent, completeCheck, createIssue} from '../services/scouting/journal-writes';

const FIELDS = 'On a farm with fields the check list names the field (`?fieldId=`): without it 400 field_required, an unknown field 404 field_not_found (as the year plan). A farm without fields lists every check.';
const REPLAY = 'Idempotent per clientEntryId: the same id and payload returns the stored result with 200; the same id with a different payload is 409 idempotency_conflict. Every write adds one immutable journal entry.';
const issueParams = z.object({id: z.uuid(), issueId: z.uuid()});

/**
 * Field checks and the issue log (docs/research/FIELD_OPERATIONS_SPEC.md 4.5 and 5.2). Owner-private; registered once in
 * routes/index.ts. Category, severity, status and responses are farmer-reported; nothing here diagnoses or recommends.
 */
export async function scoutingRoutes(app: FastifyInstance, deps: {config: Config; pool: Pool; now?: (() => Date) | undefined}) {
  app.addHook('onRequest', privateRouteGuard(deps.config, deps.pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  const mode = deps.config.RUNTIME_MODE;
  const noStore = (reply: {header: (k: string, v: string) => unknown}) => reply.header('cache-control', 'private, no-store');

  r.get('/api/v1/farms/:id/checks', {schema: {tags: ['farms'], description: `Field checks computed on read (the next one per growing crop at your own interval, rechecks of open issues, completions of the last 30 days). ${FIELDS}`, params: uuidParam, querystring: FieldChecksQuery, response: {200: envelopeSchema(FieldChecks)}}},
    async (req, reply) => { noStore(reply); return envelope(req.id, mode, await readFieldChecks(deps, requireAuth(req).ownerId, req.params.id, req.query.fieldId)); });
  r.post('/api/v1/farms/:id/checks/complete', {schema: {tags: ['farms'], description: `Complete a scheduled check: 201 when recorded, 200 with alreadyCompleted on a replay or when the check was already completed. 400 when completedOn is in the future or before establishment; 404 when the check id is not in the schedule. ${REPLAY}`, params: uuidParam, body: CompleteCheck, response: {200: envelopeSchema(CompleteCheckResult), 201: envelopeSchema(CompleteCheckResult)}}},
    async (req, reply) => {
      const out = await completeCheck(deps, requireAuth(req).ownerId, req.params.id, req.body);
      return reply.code(out.alreadyCompleted ? 200 : 201).send(envelope(req.id, mode, out));
    });
  r.get('/api/v1/farms/:id/issues', {schema: {tags: ['farms'], description: 'The farmer-reported issue log: with `fieldId`, that field\'s issues plus the farm-wide ones; `status` filters the list (counts cover the field or farm before the filter).', params: uuidParam, querystring: FieldIssuesQuery, response: {200: envelopeSchema(FieldIssues)}}},
    async (req, reply) => { noStore(reply); return envelope(req.id, mode, await readFieldIssues(deps, requireAuth(req).ownerId, req.params.id, {fieldId: req.query.fieldId, status: req.query.status})); });
  r.post('/api/v1/farms/:id/issues', {schema: {tags: ['farms'], description: `Log an issue you saw (201). The field is required on a farm with fields; a location must be inside the farm (and the field). ${REPLAY}`, params: uuidParam, body: CreateIssue, response: {200: envelopeSchema(FieldIssue), 201: envelopeSchema(FieldIssue)}}},
    async (req, reply) => {
      const out = await createIssue(deps, requireAuth(req).ownerId, req.params.id, req.body);
      return reply.code(out.created ? 201 : 200).send(envelope(req.id, mode, out.issue));
    });
  r.get('/api/v1/farms/:id/issues/:issueId', {schema: {tags: ['farms'], params: issueParams, response: {200: envelopeSchema(FieldIssue)}}},
    async (req, reply) => { noStore(reply); return envelope(req.id, mode, await readFieldIssue(deps, requireAuth(req).ownerId, req.params.id, req.params.issueId)); });
  r.post('/api/v1/farms/:id/issues/:issueId/events', {schema: {tags: ['farms'], description: `Add a status change, a response (what you did) or a note (201 with the updated issue). A response with recheckOn schedules a recheck; resolving or dismissing clears it. ${REPLAY}`, params: issueParams, body: AddIssueEvent, response: {200: envelopeSchema(FieldIssue), 201: envelopeSchema(FieldIssue)}}},
    async (req, reply) => {
      const out = await addIssueEvent(deps, requireAuth(req).ownerId, req.params.id, req.params.issueId, req.body);
      return reply.code(out.created ? 201 : 200).send(envelope(req.id, mode, out.issue));
    });
}
