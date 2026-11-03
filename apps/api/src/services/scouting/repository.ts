/**
 * Scouting storage reads (FIELD_OPERATIONS_SPEC.md 4.4 and 5.1). Every read is scoped by owner, farm and runtime mode and
 * joins the parent farm (a deleted farm reads as nothing). Reads are plain SELECTs, so the read-only farm briefing can use
 * them. Writes live in journal-writes.ts.
 */
import type {PoolClient} from 'pg';
import type {FarmWorkspace, IssueCategory, IssueResponse, IssueSeverity, IssueStatus, PhotoMark} from '@harvest/contracts';
import type {Config} from '../../config';
import type {Pool} from '../../db/pool';
import type {RiskAlert, ScheduleCompletion, ScheduleIssue} from './schedule';

type Db = Pool | PoolClient;
export type Mode = Config['RUNTIME_MODE'];

export interface CompletionRow {
  id: string; owner_id: string; farm_id: string; mode: Mode; check_id: string; check_kind: 'interval' | 'recheck'; field_id: string | null; cycle_id: string | null;
  issue_id: string | null; due_on: string; completed_on: string; result: 'nothing_found' | 'issues_found'; issue_ids: string[]; client_entry_id: string;
  payload_hash: string; journal_entry_id: string; created_at: Date;
}
const COMPLETION_COLS = `c.id, c.owner_id, c.farm_id, c.mode, c.check_id, c.check_kind, c.field_id, c.cycle_id, c.issue_id, to_char(c.due_on,'YYYY-MM-DD') AS due_on,
  to_char(c.completed_on,'YYYY-MM-DD') AS completed_on, c.result, c.issue_ids, c.client_entry_id, c.payload_hash, c.journal_entry_id, c.created_at`;

export interface IssueRow {
  id: string; owner_id: string; farm_id: string; mode: Mode; field_id: string | null; cycle_id: string | null; crop_id: string | null; observed_on: string;
  category: IssueCategory; severity: IssueSeverity; status: IssueStatus; title: string; detail: string | null; location_lat: number | null; location_lon: number | null;
  media_ids: string[]; photo_marks: PhotoMark[]; from_fact_id: string | null; client_entry_id: string; payload_hash: string; journal_entry_id: string;
  recheck_on: string | null; created_at: Date; updated_at: Date;
}
const ISSUE_COLS = `i.id, i.owner_id, i.farm_id, i.mode, i.field_id, i.cycle_id, i.crop_id, to_char(i.observed_on,'YYYY-MM-DD') AS observed_on, i.category, i.severity, i.status,
  i.title, i.detail, i.location_lat, i.location_lon, i.media_ids, i.photo_marks, i.from_fact_id, i.client_entry_id, i.payload_hash, i.journal_entry_id,
  to_char(i.recheck_on,'YYYY-MM-DD') AS recheck_on, i.created_at, i.updated_at`;

export interface EventRow {
  id: string; issue_id: string; owner_id: string; kind: 'reported' | 'status_changed' | 'response_recorded' | 'recheck_scheduled' | 'note_added'; occurred_on: string;
  status: IssueStatus | null; response: IssueResponse | null; note: string | null; media_ids: string[]; client_entry_id: string; payload_hash: string;
  journal_entry_id: string | null; created_at: Date;
}
const EVENT_COLS = `e.id, e.issue_id, e.owner_id, e.kind, to_char(e.occurred_on,'YYYY-MM-DD') AS occurred_on, e.status, e.response, e.note, e.media_ids, e.client_entry_id,
  e.payload_hash, e.journal_entry_id, e.created_at`;

const FARM_JOIN = 'JOIN farms f ON f.id = %.farm_id AND f.owner_id = %.owner_id AND f.deleted_at IS NULL';
const farmJoin = (alias: string) => FARM_JOIN.replace(/%/g, alias);

export async function completionsOf(db: Db, ownerId: string, farmId: string, mode: Mode): Promise<CompletionRow[]> {
  return (await db.query<CompletionRow>(`SELECT ${COMPLETION_COLS} FROM field_check_completions c ${farmJoin('c')} WHERE c.owner_id=$1 AND c.farm_id=$2 AND c.mode=$3 ORDER BY c.completed_on DESC, c.created_at DESC, c.id`, [ownerId, farmId, mode])).rows;
}
export async function completionByClientId(db: Db, ownerId: string, clientEntryId: string): Promise<CompletionRow | null> {
  return (await db.query<CompletionRow>(`SELECT ${COMPLETION_COLS} FROM field_check_completions c WHERE c.owner_id=$1 AND c.client_entry_id=$2`, [ownerId, clientEntryId])).rows[0] ?? null;
}
export async function completionByCheckId(db: Db, farmId: string, mode: Mode, checkId: string): Promise<CompletionRow | null> {
  return (await db.query<CompletionRow>(`SELECT ${COMPLETION_COLS} FROM field_check_completions c WHERE c.farm_id=$1 AND c.mode=$2 AND c.check_id=$3`, [farmId, mode, checkId])).rows[0] ?? null;
}

export async function issuesOf(db: Db, ownerId: string, farmId: string, mode: Mode): Promise<IssueRow[]> {
  return (await db.query<IssueRow>(`SELECT ${ISSUE_COLS} FROM field_issues i ${farmJoin('i')} WHERE i.owner_id=$1 AND i.farm_id=$2 AND i.mode=$3 ORDER BY i.observed_on DESC, i.created_at DESC, i.id`, [ownerId, farmId, mode])).rows;
}
export async function issueById(db: Db, ownerId: string, farmId: string, mode: Mode, issueId: string, forUpdate = false): Promise<IssueRow | null> {
  return (await db.query<IssueRow>(`SELECT ${ISSUE_COLS} FROM field_issues i WHERE i.id=$1 AND i.owner_id=$2 AND i.farm_id=$3 AND i.mode=$4${forUpdate ? ' FOR UPDATE' : ''}`, [issueId, ownerId, farmId, mode])).rows[0] ?? null;
}
export async function issueByClientId(db: Db, ownerId: string, clientEntryId: string): Promise<IssueRow | null> {
  return (await db.query<IssueRow>(`SELECT ${ISSUE_COLS} FROM field_issues i WHERE i.owner_id=$1 AND i.client_entry_id=$2`, [ownerId, clientEntryId])).rows[0] ?? null;
}
export async function eventsOf(db: Db, ownerId: string, issueIds: readonly string[]): Promise<EventRow[]> {
  if (!issueIds.length) return [];
  return (await db.query<EventRow>(`SELECT ${EVENT_COLS} FROM field_issue_events e WHERE e.owner_id=$1 AND e.issue_id = ANY($2::uuid[]) ORDER BY e.occurred_on, e.created_at, e.id`, [ownerId, issueIds])).rows;
}
export async function eventByClientId(db: Db, ownerId: string, clientEntryId: string): Promise<EventRow | null> {
  return (await db.query<EventRow>(`SELECT ${EVENT_COLS} FROM field_issue_events e WHERE e.owner_id=$1 AND e.client_entry_id=$2`, [ownerId, clientEntryId])).rows[0] ?? null;
}

/** Stored crop-threat RULE alerts of the farm in this mode (dismissed ones excluded); the checklist's risk-window items. */
export async function riskAlertsOf(db: Db, ownerId: string, farmId: string, mode: Mode): Promise<RiskAlert[]> {
  const rows = (await db.query<{id: string; title: string; detail: string; source: {name: string; url: string; date: string}; valid_from: string; valid_to: string; field_id: string | null}>(
    `SELECT a.id, a.title, a.detail, a.source, to_char(a.valid_from,'YYYY-MM-DD') AS valid_from, to_char(a.valid_to,'YYYY-MM-DD') AS valid_to, a.field_id
       FROM farm_alerts a ${farmJoin('a')}
      WHERE a.owner_id=$1 AND a.farm_id=$2 AND a.mode=$3 AND a.type='crop_threat' AND a.origin='rule' AND a.dismissed_at IS NULL
      ORDER BY a.valid_from, a.id`, [ownerId, farmId, mode])).rows;
  return rows.map((r) => ({id: r.id, title: r.title, detail: r.detail, sourceName: r.source.name, sourceUrl: r.source.url, sourceDate: r.source.date, validFrom: r.valid_from, validTo: r.valid_to, fieldId: r.field_id}));
}

// ------------------------------------------------------------------ schedule inputs

export const toScheduleCompletion = (r: CompletionRow): ScheduleCompletion => ({
  checkId: r.check_id, checkKind: r.check_kind, fieldId: r.field_id, cycleId: r.cycle_id, issueId: r.issue_id, dueOn: r.due_on, completedOn: r.completed_on, journalEntryId: r.journal_entry_id,
});
export function toScheduleIssue(r: IssueRow, ws: Pick<FarmWorkspace, 'cycles'>): ScheduleIssue {
  return {id: r.id, fieldId: r.field_id, cycleId: r.cycle_id, cropName: issueCropName(r, ws), title: r.title, status: r.status, recheckOn: r.recheck_on};
}
/** The issue's crop name: its cycle's, else the crop id in words; null without a crop. */
export function issueCropName(r: Pick<IssueRow, 'cycle_id' | 'crop_id'>, ws: Pick<FarmWorkspace, 'cycles'>): string | null {
  const cycle = r.cycle_id ? ws.cycles.find((c) => c.id === r.cycle_id) : undefined;
  if (cycle?.cropName) return cycle.cropName;
  const id = cycle?.cropId ?? r.crop_id;
  return id ? id.replace(/[-_]+/g, ' ').replace(/^./, (x) => x.toUpperCase()) : null;
}

/** Everything the schedule and the issue log need for one farm, in one place (plain reads). */
export async function scoutingRows(db: Db, ownerId: string, farmId: string, mode: Mode) {
  // Sequential: inside a transaction the reads share one client.
  const completions = await completionsOf(db, ownerId, farmId, mode);
  const issues = await issuesOf(db, ownerId, farmId, mode);
  const alerts = await riskAlertsOf(db, ownerId, farmId, mode);
  const events = await eventsOf(db, ownerId, issues.map((i) => i.id));
  return {completions, issues, events, alerts};
}
export type ScoutingRows = Awaited<ReturnType<typeof scoutingRows>>;
