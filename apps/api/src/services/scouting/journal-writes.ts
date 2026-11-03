/**
 * Scouting writes (FIELD_OPERATIONS_SPEC.md 2, 4.5, 5.1, 5.2). Every write runs in one transaction that inserts exactly one
 * immutable journal entry (the command center's `journalAction` pattern) and the scouting row that references it, so the farm
 * timeline and the assistant briefing see every check completion, issue and issue event.
 *
 * Idempotency: each write carries a client entry id. The same id with the same payload hash (and farm and mode) returns the
 * stored result (`created: false`, 200); the same id with a different payload, or an id already used by another journal
 * write, is 409 idempotency_conflict. Writes of one farm are serialised by the farm row lock; retries of one id by an advisory
 * lock on owner and id.
 *
 * Wording rules: journal texts name the farmer's own category, method, description and product name (as typed); the app adds
 * no product, dose, rate or timing of its own and never states a diagnosis. A label wait is written as "label wait <n> days
 * (farmer-entered)". Activities come from the journal's ACTIVITIES: 'observation' for a new issue, 'pest_check' for a check
 * completion and for a response, 'other' for a status change or a note.
 */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {FarmWorkspaceState, type AddIssueEvent, type CompleteCheck, type CompleteCheckResult, type CreateIssue, type FarmWorkspace, type FieldIssue, type IssueResponse} from '@harvest/contracts';
import {withTransaction} from '../../db/pool';
import {insertFact} from '../../journal/repository';
import type {ACTIVITIES} from '../../journal/types';
import {getMedia} from '../media';
import {ApiError, notFound} from '../errors';
import {payloadHash} from '../hash';
import {fieldOf} from '../workspace';
import {checkSchedule, completedCheck, cycleFieldId} from './schedule';
import {completionByCheckId, completionByClientId, eventByClientId, issueById, issueByClientId, scoutingRows, toScheduleCompletion, toScheduleIssue, type CompletionRow} from './repository';
import {CATEGORY_LABEL, assertLocationInside, defaultCycle, readFieldIssue, todayOf, type ScoutingDeps} from './issues';

type Activity = (typeof ACTIVITIES)[number];
const validation = (message: string) => new ApiError(400, 'validation_error', message);
const conflict = () => new ApiError(409, 'idempotency_conflict', 'This client entry identifier was already used for different data');

const METHOD_LABEL: Record<IssueResponse['method'], string> = {
  cultural: 'Cultural practice', mechanical: 'Mechanical (by hand or tool)', biological: 'Biological', irrigation: 'Irrigation', nutrition: 'Nutrition', product_applied: 'Product applied', other: 'Other',
};
const STATUS_LABEL: Record<FieldIssue['status'], string> = {open: 'open', treating: 'being treated', resolved: 'resolved', dismissed: 'dismissed'};

// ------------------------------------------------------------------ shared steps

/** Locks the owned farm row (404 for a foreign or deleted farm) and the client id; returns the farm's workspace state. */
async function lockFarm(c: PoolClient, ownerId: string, farmId: string, clientEntryId: string): Promise<FarmWorkspace> {
  const farm = (await c.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE', [farmId, ownerId])).rows[0];
  if (!farm) throw notFound('Farm');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ownerId}:${clientEntryId}`]);
  const row = (await c.query<{state: unknown; version: number; updated_at: Date}>('SELECT state, version, updated_at FROM farm_workspaces WHERE farm_id=$1', [farmId])).rows[0];
  const state = FarmWorkspaceState.parse(row?.state ?? {boundary: null, previousHarvest: {status: 'unknown'}, cycles: [], rotationPlans: []});
  return {...state, farmId, version: row?.version ?? 0, updatedAt: row?.updated_at.toISOString() ?? null};
}

/** A client id already taken by another kind of scouting row, or by any journal entry, is a conflict. */
async function assertUnused(c: PoolClient, ownerId: string, clientEntryId: string, skip: 'issue' | 'event' | 'check'): Promise<void> {
  if (skip !== 'issue' && (await issueByClientId(c, ownerId, clientEntryId))) throw conflict();
  if (skip !== 'event' && (await eventByClientId(c, ownerId, clientEntryId))) throw conflict();
  if (skip !== 'check' && (await completionByClientId(c, ownerId, clientEntryId))) throw conflict();
  if ((await c.query('SELECT 1 FROM journal_entries WHERE owner_id=$1 AND client_entry_id=$2', [ownerId, clientEntryId])).rowCount) throw conflict();
}

/** Owned media (farm-less uploads or this farm's), no duplicates (the journal's createEntry rule). */
async function assertMedia(c: PoolClient, ownerId: string, farmId: string, ids: readonly string[]): Promise<void> {
  if (new Set(ids).size !== ids.length) throw validation('mediaIds contains duplicates');
  for (const id of ids) {
    const m = await getMedia(c, ownerId, id);
    if (!m || (m.farmId !== null && m.farmId !== farmId)) throw notFound('Media');
  }
}

interface JournalWrite { ownerId: string; farmId: string; clientEntryId: string; date: string; text: string; activity: Activity; mode: string; hash: string; mediaIds: readonly string[]; facts: [string, string][] }
/** One immutable, final journal entry with its farmer facts (activity first). */
async function writeJournalEntry(c: PoolClient, w: JournalWrite): Promise<string> {
  const entryId = randomUUID();
  await c.query(
    `INSERT INTO journal_entries (id, owner_id, farm_id, client_entry_id, status, entry_date, observed_at, uploaded_at, text_body, language, media_ids, activity, mode, payload_hash, processing_status)
     VALUES ($1,$2,$3,$4,'final',$5::date,($5||'T12:00:00+05:30')::timestamptz,$6,$7,'en',$8::uuid[],$9,$10,$11,'submitted')`,
    [entryId, w.ownerId, w.farmId, w.clientEntryId, w.date, w.mediaIds.length ? new Date().toISOString() : null, w.text, w.mediaIds, w.activity, w.mode, w.hash]);
  for (const [field, value] of [['activity', w.activity] as [string, string], ...w.facts]) {
    await insertFact(c, {ownerId: w.ownerId, entryId, field, value, unit: null, kind: 'original', source: 'farmer', evidenceState: 'farmer_reported', requiresConfirmation: false});
  }
  return entryId;
}

const placeOf = (ws: Pick<FarmWorkspace, 'fields'>, fieldId: string | null) => (fieldId === null ? 'the farm' : ws.fields.find((f) => f.id === fieldId)?.name ?? 'the field');
const withNote = (text: string, note: string | undefined) => (note ? `${text}. ${note}` : `${text}.`);

// ------------------------------------------------------------------ issues

export async function createIssue(deps: ScoutingDeps, ownerId: string, farmId: string, body: CreateIssue): Promise<{issue: FieldIssue; created: boolean}> {
  const today = todayOf(deps), mode = deps.config.RUNTIME_MODE;
  if (body.observedOn > today) throw validation('observedOn cannot be in the future');
  const hash = payloadHash({farmId, write: 'issue', ...body});
  const out = await withTransaction(deps.pool, async (c) => {
    const ws = await lockFarm(c, ownerId, farmId, body.clientEntryId);
    const old = await issueByClientId(c, ownerId, body.clientEntryId);
    if (old) {
      if (old.farm_id !== farmId || old.payload_hash !== hash || old.mode !== mode) throw conflict();
      return {id: old.id, created: false};
    }
    await assertUnused(c, ownerId, body.clientEntryId, 'issue');
    // A farm with fields needs the field (5.1); an unknown field is 404 field_not_found.
    if (ws.fields.length && body.fieldId === undefined) throw new ApiError(400, 'field_required', 'This farm has fields; choose the field (fieldId)');
    const field = body.fieldId !== undefined ? fieldOf(ws, body.fieldId) : null;
    const fieldId = field?.id ?? null;
    let cycle = null;
    if (body.cycleId !== undefined) {
      cycle = ws.cycles.find((x) => x.id === body.cycleId) ?? null;
      if (!cycle) throw notFound('Crop cycle');
      if (cycleFieldId(ws, cycle) !== null && cycleFieldId(ws, cycle) !== fieldId) throw validation('The crop cycle grows on another field');
    } else cycle = defaultCycle(ws, fieldId);
    assertLocationInside(body.location, ws, field);
    await assertMedia(c, ownerId, farmId, body.mediaIds);
    if (body.photoMarks.some((m) => !body.mediaIds.includes(m.mediaId))) throw validation('Every photo mark must be on one of the issue photos (mediaIds)');
    if (body.fromFactId !== undefined) {
      // The suggestion the issue was made from: the farmer's accepted `observed_issue` fact on an entry of this farm and mode.
      const fact = (await c.query<{fact_key: string; status: string; farm_id: string; mode: string}>(
        'SELECT jf.fact_key, jf.status, je.farm_id, je.mode FROM journal_facts jf JOIN journal_entries je ON je.id = jf.entry_id AND je.owner_id = jf.owner_id WHERE jf.id=$1 AND jf.owner_id=$2', [body.fromFactId, ownerId])).rows[0];
      if (!fact) throw notFound('Journal fact');
      if (fact.farm_id !== farmId || fact.mode !== mode) throw validation('fromFactId must be a journal fact of this farm');
      if (fact.fact_key !== 'observed_issue') throw validation('fromFactId must be an observed_issue fact');
      if (fact.status !== 'confirmed') throw validation('fromFactId must be an observed_issue fact you accepted');
    }
    const issueId = randomUUID();
    const text = withNote(`${CATEGORY_LABEL[body.category]} on ${placeOf(ws, fieldId)}: ${body.title} (severity ${body.severity})`, body.detail);
    const facts: [string, string][] = [['field_issue_id', issueId], ['issue_category', body.category], ...(cycle ? [['cycle_id', cycle.id] as [string, string]] : []), ...(fieldId ? [['field_id', fieldId] as [string, string]] : [])];
    const entryId = await writeJournalEntry(c, {ownerId, farmId, clientEntryId: body.clientEntryId, date: body.observedOn, text, activity: 'observation', mode, hash, mediaIds: body.mediaIds, facts});
    await c.query(
      `INSERT INTO field_issues (id, owner_id, farm_id, mode, field_id, cycle_id, crop_id, observed_on, category, severity, status, title, detail, location_lat, location_lon,
         media_ids, photo_marks, from_fact_id, client_entry_id, payload_hash, journal_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11,$12,$13,$14,$15::uuid[],$16::jsonb,$17,$18,$19,$20)`,
      [issueId, ownerId, farmId, mode, fieldId, cycle?.id ?? null, cycle?.cropId ?? null, body.observedOn, body.category, body.severity, body.title, body.detail ?? null,
        body.location?.lat ?? null, body.location?.lon ?? null, body.mediaIds, JSON.stringify(body.photoMarks), body.fromFactId ?? null, body.clientEntryId, hash, entryId]);
    await c.query(
      `INSERT INTO field_issue_events (issue_id, owner_id, kind, occurred_on, status, response, note, media_ids, client_entry_id, payload_hash, journal_entry_id)
       VALUES ($1,$2,'reported',$3,'open',NULL,NULL,$4::uuid[],$5,$6,$7)`,
      [issueId, ownerId, body.observedOn, body.mediaIds, body.clientEntryId, hash, entryId]);
    return {id: issueId, created: true};
  });
  return {issue: await readFieldIssue(deps, ownerId, farmId, out.id), created: out.created};
}

function responseText(r: IssueResponse): string {
  return [
    `${METHOD_LABEL[r.method]}: ${r.description}`,
    r.productName ? `product as you named it: ${r.productName}` : null,
    r.quantity ? `quantity ${r.quantity.value} ${r.quantity.unit} (farmer-entered)` : null,
    r.labelWaitDays !== undefined ? `label wait ${r.labelWaitDays} days (farmer-entered)` : null,
    r.recheckOn ? `recheck on ${r.recheckOn}` : null,
  ].filter((x): x is string => !!x).join('; ');
}

export async function addIssueEvent(deps: ScoutingDeps, ownerId: string, farmId: string, issueId: string, body: AddIssueEvent): Promise<{issue: FieldIssue; created: boolean}> {
  const today = todayOf(deps), mode = deps.config.RUNTIME_MODE;
  if (body.occurredOn > today) throw validation('occurredOn cannot be in the future');
  const hash = payloadHash({farmId, issueId, write: 'issue_event', ...body});
  const created = await withTransaction(deps.pool, async (c) => {
    const ws = await lockFarm(c, ownerId, farmId, body.clientEntryId);
    const old = await eventByClientId(c, ownerId, body.clientEntryId);
    if (old) {
      // The stored event must belong to this issue, and the issue to this farm and mode (the issue and check paths compare both).
      if (old.issue_id !== issueId || old.payload_hash !== hash || !(await issueById(c, ownerId, farmId, mode, old.issue_id))) throw conflict();
      return false;
    }
    await assertUnused(c, ownerId, body.clientEntryId, 'event');
    const issue = await issueById(c, ownerId, farmId, mode, issueId, true);
    if (!issue) throw notFound('Issue');
    if (body.occurredOn < issue.observed_on) throw validation('An issue event cannot precede the day the issue was observed');
    // Kind rules: status_changed carries a status; response_recorded a response; note_added a note. A note may ride along.
    if (body.kind === 'status_changed') {
      if (!body.status) throw validation('status_changed needs a status');
      if (body.response) throw validation('A response is recorded with kind response_recorded');
      if (body.status === issue.status) throw validation(`The issue is already ${STATUS_LABEL[issue.status]}`);
    } else if (body.kind === 'response_recorded') {
      if (!body.response) throw validation('response_recorded needs a response');
      if (body.status) throw validation('A status change is recorded with kind status_changed');
      if (body.response.recheckOn && body.response.recheckOn < body.occurredOn) throw validation('The recheck date cannot precede the response');
      if (body.response.recheckOn && (issue.status === 'resolved' || issue.status === 'dismissed')) throw validation('Reopen the issue before scheduling a recheck');
    } else {
      if (!body.note) throw validation('note_added needs a note');
      if (body.status || body.response) throw validation('A note carries no status or response');
    }
    await assertMedia(c, ownerId, farmId, body.mediaIds);
    const where = placeOf(ws, issue.field_id);
    const text = body.kind === 'status_changed' ? withNote(`Issue on ${where}: ${issue.title} marked ${STATUS_LABEL[body.status!]}`, body.note)
      : body.kind === 'response_recorded' ? withNote(`Response on ${where} to ${issue.title}: ${responseText(body.response!)}`, body.note)
        : `Note on ${where} for ${issue.title}: ${body.note}`;
    const activity: Activity = body.kind === 'response_recorded' ? 'pest_check' : 'other';
    const facts: [string, string][] = [['field_issue_id', issue.id], ['issue_event', body.kind], ...(issue.cycle_id ? [['cycle_id', issue.cycle_id] as [string, string]] : []), ...(issue.field_id ? [['field_id', issue.field_id] as [string, string]] : [])];
    const entryId = await writeJournalEntry(c, {ownerId, farmId, clientEntryId: body.clientEntryId, date: body.occurredOn, text, activity, mode, hash, mediaIds: body.mediaIds, facts});
    await c.query(
      `INSERT INTO field_issue_events (issue_id, owner_id, kind, occurred_on, status, response, note, media_ids, client_entry_id, payload_hash, journal_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::uuid[],$9,$10,$11)`,
      [issue.id, ownerId, body.kind, body.occurredOn, body.status ?? null, body.response ? JSON.stringify(body.response) : null, body.note ?? null, body.mediaIds, body.clientEntryId, hash, entryId]);
    // A response with a recheck date sets the issue's recheck; resolving or dismissing clears it.
    if (body.kind === 'status_changed') {
      const closes = body.status === 'resolved' || body.status === 'dismissed';
      await c.query(`UPDATE field_issues SET status=$2${closes ? ', recheck_on=NULL' : ''} WHERE id=$1`, [issue.id, body.status]);
    } else if (body.kind === 'response_recorded' && body.response!.recheckOn) {
      await c.query('UPDATE field_issues SET recheck_on=$2 WHERE id=$1', [issue.id, body.response!.recheckOn]);
    } else {
      await c.query('UPDATE field_issues SET updated_at=now() WHERE id=$1', [issue.id]);
    }
    return true;
  });
  return {issue: await readFieldIssue(deps, ownerId, farmId, issueId), created};
}

// ------------------------------------------------------------------ check completions

async function asResult(c: PoolClient, ws: FarmWorkspace, ownerId: string, farmId: string, mode: ScoutingDeps['config']['RUNTIME_MODE'], row: CompletionRow, alreadyCompleted: boolean): Promise<CompleteCheckResult> {
  const rows = await scoutingRows(c, ownerId, farmId, mode);
  const check = completedCheck({workspace: ws, issues: rows.issues.map((i) => toScheduleIssue(i, ws)), alerts: rows.alerts}, toScheduleCompletion(row));
  return {check, journalEntryId: row.journal_entry_id, alreadyCompleted};
}

export async function completeCheck(deps: ScoutingDeps, ownerId: string, farmId: string, body: CompleteCheck): Promise<CompleteCheckResult> {
  const today = todayOf(deps), mode = deps.config.RUNTIME_MODE;
  if (body.completedOn > today) throw validation('Completion cannot be in the future');
  const hash = payloadHash({farmId, write: 'check', ...body});
  return withTransaction(deps.pool, async (c) => {
    const ws = await lockFarm(c, ownerId, farmId, body.clientEntryId);
    const replay = await completionByClientId(c, ownerId, body.clientEntryId);
    if (replay) {
      if (replay.farm_id !== farmId || replay.payload_hash !== hash || replay.mode !== mode) throw conflict();
      return asResult(c, ws, ownerId, farmId, mode, replay, true);
    }
    await assertUnused(c, ownerId, body.clientEntryId, 'check');
    // Already completed under another client id (a double tap on two devices): the first completion stands.
    const done = await completionByCheckId(c, farmId, mode, body.checkId);
    if (done) return asResult(c, ws, ownerId, farmId, mode, done, true);
    const rows = await scoutingRows(c, ownerId, farmId, mode);
    const schedule = checkSchedule({workspace: ws, completions: rows.completions.map(toScheduleCompletion), issues: rows.issues.map((i) => toScheduleIssue(i, ws)), alerts: rows.alerts, today});
    const check = schedule.find((x) => x.id === body.checkId && x.status !== 'completed');
    if (!check) throw notFound('Field check');
    const cycle = check.cycleId ? ws.cycles.find((x) => x.id === check.cycleId) : undefined;
    if (check.kind === 'interval' && cycle && body.completedOn < (cycle.establishmentDate ?? cycle.sowingDate)) throw validation('A field check cannot precede crop establishment');
    const issue = check.issueId ? rows.issues.find((i) => i.id === check.issueId) : undefined;
    if (issue && body.completedOn < issue.observed_on) throw validation('A recheck cannot precede the day the issue was observed');
    if (body.result === 'nothing_found' && body.issueIds.length) throw validation('Issues are listed only when the result is issues_found');
    if (new Set(body.issueIds).size !== body.issueIds.length) throw validation('issueIds contains duplicates');
    for (const id of body.issueIds) {
      const listed = rows.issues.find((i) => i.id === id);
      if (!listed) throw notFound('Issue');
      if (check.fieldId !== null && listed.field_id !== null && listed.field_id !== check.fieldId) throw validation('A listed issue belongs to another field than this check');
    }
    const where = placeOf(ws, check.fieldId);
    const outcome = body.result === 'nothing_found' ? 'nothing found' : body.issueIds.length ? `${body.issueIds.length} issue(s) logged` : 'issues found';
    const lead = check.kind === 'recheck' ? `Recheck on ${where} of ${issue?.title ?? 'an issue'}` : `Field check on ${where}`;
    const facts: [string, string][] = [['field_check_id', check.id], ...(check.cycleId ? [['cycle_id', check.cycleId] as [string, string]] : []), ...(check.fieldId ? [['field_id', check.fieldId] as [string, string]] : []), ...(check.issueId ? [['field_issue_id', check.issueId] as [string, string]] : [])];
    const entryId = await writeJournalEntry(c, {ownerId, farmId, clientEntryId: body.clientEntryId, date: body.completedOn, text: withNote(`${lead}: ${outcome}`, body.note), activity: 'pest_check', mode, hash, mediaIds: [], facts});
    const row = (await c.query<CompletionRow>(
      `INSERT INTO field_check_completions (owner_id, farm_id, mode, check_id, check_kind, field_id, cycle_id, issue_id, due_on, completed_on, result, issue_ids, client_entry_id, payload_hash, journal_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid[],$13,$14,$15)
       RETURNING id, owner_id, farm_id, mode, check_id, check_kind, field_id, cycle_id, issue_id, to_char(due_on,'YYYY-MM-DD') AS due_on, to_char(completed_on,'YYYY-MM-DD') AS completed_on,
         result, issue_ids, client_entry_id, payload_hash, journal_entry_id, created_at`,
      [ownerId, farmId, mode, check.id, check.kind, check.fieldId, check.cycleId, check.issueId, check.dueFrom, body.completedOn, body.result, body.issueIds, body.clientEntryId, hash, entryId])).rows[0]!;
    return {check: {...check, status: 'completed', completedOn: row.completed_on, journalEntryId: entryId}, journalEntryId: entryId, alreadyCompleted: false};
  });
}
