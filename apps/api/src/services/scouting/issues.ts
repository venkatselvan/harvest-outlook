/**
 * Issue log and field check reads (FIELD_OPERATIONS_SPEC.md 4.5, 5.2 to 5.4), plus the shared validation the writes use.
 *
 * An issue is what the farmer saw: category, severity and status are farmer-reported, never a diagnosis; nothing here
 * interprets an issue or predicts from it. Documented choices that change results:
 * - `seenBefore` (5.4): issues of any status with the same category on the same field (both farm-wide when field-less),
 *   observed earlier (same day: created earlier), newest first, at most 5. No prediction is made from it.
 * - `earliestHarvestOn`: occurredOn of the latest response carrying a label wait (by occurredOn, then creation), plus those
 *   days. Arithmetic on the farmer's own reading of a label; the app never checks a label.
 * - GET /issues without a fieldId lists every issue of the farm (the "all fields" list); with one, that field's issues plus
 *   the farm-wide ones. `counts` cover that scope before the optional status filter.
 * - GET /checks follows the year plan: on a farm with fields the field is required (400 field_required), an unknown one is
 *   404 field_not_found; the field's checks plus the farm-wide ones are listed. A farm without fields lists every check.
 */
import {pointInRing, type FarmField, type FarmWorkspace, type FieldCheck, type FieldChecks, type FieldIssue, type FieldIssues, type IssueEvent, type IssueStatus} from '@harvest/contracts';
import type {Pool} from '../../db/pool';
import {ApiError, notFound} from '../errors';
import {getFarm} from '../farms';
import {fieldOf, getWorkspace, requireField} from '../workspace';
import {addDays, checkSchedule, type CheckScope} from './schedule';
import {issueCropName, scoutingRows, toScheduleCompletion, toScheduleIssue, type EventRow, type IssueRow, type Mode, type ScoutingRows} from './repository';

export interface ScoutingDeps { pool: Pool; config: {RUNTIME_MODE: Mode}; now?: (() => Date) | undefined }
export const istToday = (now = new Date()) => new Date(now.getTime() + 19_800_000).toISOString().slice(0, 10);
export const todayOf = (deps: Pick<ScoutingDeps, 'now'>) => istToday((deps.now ?? (() => new Date()))());

export const CATEGORY_LABEL: Record<FieldIssue['category'], string> = {
  pest: 'Pest', disease: 'Disease', weed: 'Weed', water_stress: 'Water stress', nutrient: 'Nutrient', weather_damage: 'Weather damage', animal_damage: 'Animal damage', other: 'Other',
};
export const ISSUE_LIMITATIONS = [
  'Category, severity and status are what you reported; the app does not diagnose or confirm an issue.',
  '"Seen before" lists earlier issues of the same category on this field; no prediction is made from it.',
  'An earliest harvest date is arithmetic on the label wait you entered; the app does not check a label.',
];
export const CHECK_LIMITATIONS = [
  'Field checks follow relevant crop risks, weather and satellite alerts. Crop care and growth-stage guidance appear separately in Upcoming steps.',
  'Alerts indicate a reason to inspect; they do not confirm damage in the field.',
];

// ------------------------------------------------------------------ the current cycle (same rule as the Today view)

type Cycle = FarmWorkspace['cycles'][number];
/** The not-harvested cycle with the latest establishment (else sowing) date among `cycles` (services/today/view.ts currentCycle). */
export function latestOpenCycle(cycles: readonly Cycle[]): Cycle | null {
  const at = (c: Cycle) => c.establishmentDate ?? c.sowingDate;
  return [...cycles].filter((c) => c.stage !== 'harvested').sort((a, b) => at(b).localeCompare(at(a)))[0] ?? null;
}
/** The cycle an issue on this field (or the farm) defaults to: the field's own current cycle, else a farm-wide one. */
export function defaultCycle(ws: Pick<FarmWorkspace, 'cycles' | 'fields'>, fieldId: string | null): Cycle | null {
  if (fieldId === null) return latestOpenCycle(ws.fields.length ? ws.cycles.filter((c) => c.fieldId === undefined) : ws.cycles);
  return latestOpenCycle(ws.cycles.filter((c) => c.fieldId === fieldId)) ?? latestOpenCycle(ws.cycles.filter((c) => c.fieldId === undefined));
}

// ------------------------------------------------------------------ location

/** 5.1: inside the farm boundary when one is drawn, and inside the field's polygon when a field is named. */
export function assertLocationInside(location: {lat: number; lon: number} | undefined, ws: Pick<FarmWorkspace, 'boundary'>, field: FarmField | null): void {
  if (!location) return;
  if (!ws.boundary) throw new ApiError(400, 'location_outside_boundary', 'Draw the farm boundary first, then mark a location');
  const p: [number, number] = [location.lon, location.lat];
  const rings = [ws.boundary, field?.boundary].filter((b): b is NonNullable<typeof b> => !!b).map((b) => b.coordinates[0] as [number, number][]);
  if (rings.some((r) => !pointInRing(p, r))) throw new ApiError(400, 'location_outside_boundary', field ? 'The location is outside this field' : 'The location is outside the farm boundary');
}

// ------------------------------------------------------------------ mapping

const iso = (d: Date) => d.toISOString();
export function toIssueEvent(e: EventRow): IssueEvent {
  return {id: e.id, kind: e.kind, occurredOn: e.occurred_on, status: e.status, response: e.response, note: e.note, mediaIds: e.media_ids, journalEntryId: e.journal_entry_id, createdAt: iso(e.created_at)};
}
const earlier = (a: IssueRow, b: IssueRow) => a.observed_on < b.observed_on || (a.observed_on === b.observed_on && a.created_at.getTime() < b.created_at.getTime());

export function earliestHarvestOn(events: readonly EventRow[]): string | null {
  const latest = events
    .filter((e) => e.kind === 'response_recorded' && e.response && typeof e.response.labelWaitDays === 'number')
    .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || b.created_at.getTime() - a.created_at.getTime())[0];
  return latest ? addDays(latest.occurred_on, latest.response!.labelWaitDays!) : null;
}

export function toFieldIssue(r: IssueRow, events: readonly EventRow[], all: readonly IssueRow[], ws: Pick<FarmWorkspace, 'cycles'>): FieldIssue {
  const own = events.filter((e) => e.issue_id === r.id);
  const seenBefore = all
    .filter((o) => o.id !== r.id && o.category === r.category && o.field_id === r.field_id && earlier(o, r))
    .sort((a, b) => (earlier(a, b) ? 1 : earlier(b, a) ? -1 : 0))
    .slice(0, 5)
    .map((o) => ({issueId: o.id, observedOn: o.observed_on, cropName: issueCropName(o, ws), status: o.status}));
  return {
    ...(r.field_id !== null ? {fieldId: r.field_id} : {}),
    ...(r.cycle_id !== null ? {cycleId: r.cycle_id} : {}),
    observedOn: r.observed_on, category: r.category, severity: r.severity, title: r.title,
    ...(r.detail !== null ? {detail: r.detail} : {}),
    ...(r.location_lat !== null && r.location_lon !== null ? {location: {lat: r.location_lat, lon: r.location_lon}} : {}),
    mediaIds: r.media_ids, photoMarks: r.photo_marks,
    id: r.id, farmId: r.farm_id, status: r.status, cropId: r.crop_id, cropName: issueCropName(r, ws), journalEntryId: r.journal_entry_id,
    events: own.map(toIssueEvent), recheckOn: r.recheck_on, earliestHarvestOn: earliestHarvestOn(own), seenBefore,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), scope: r.field_id === null ? 'farm' : 'field',
  };
}

// ------------------------------------------------------------------ composed reads

export interface ScoutingState { checks: FieldCheck[]; issues: FieldIssue[]; rows: ScoutingRows }
/** Every check (scope all) and every issue of the farm from one set of plain reads. */
export async function scoutingState(db: Pool, ownerId: string, farmId: string, mode: Mode, ws: FarmWorkspace, today: string): Promise<ScoutingState> {
  const rows = await scoutingRows(db, ownerId, farmId, mode);
  const checks = checkSchedule({workspace: ws, completions: rows.completions.map(toScheduleCompletion), issues: rows.issues.map((i) => toScheduleIssue(i, ws)), alerts: rows.alerts, today});
  const issues = rows.issues.map((i) => toFieldIssue(i, rows.events, rows.issues, ws));
  return {checks, issues, rows};
}

const countsOf = (issues: readonly Pick<FieldIssue, 'status'>[]) => {
  const n = (s: IssueStatus) => issues.filter((i) => i.status === s).length;
  return {open: n('open'), treating: n('treating'), resolved: n('resolved'), dismissed: n('dismissed')};
};

export async function readFieldChecks(deps: ScoutingDeps, ownerId: string, farmId: string, fieldId?: string): Promise<FieldChecks> {
  const ws = await getWorkspace(deps.pool, ownerId, farmId);
  const field = requireField(ws, fieldId);
  const today = todayOf(deps);
  const scope: CheckScope = field ? {all: false, fieldId: field.id} : {all: true};
  const state = await scoutingState(deps.pool, ownerId, farmId, deps.config.RUNTIME_MODE, ws, today);
  const checks = state.checks.filter((c) => scope.all || c.fieldId === null || c.fieldId === scope.fieldId);
  const limitations = [...CHECK_LIMITATIONS];
  if (!checks.some((c) => c.status !== 'completed')) limitations.push('No condition-triggered field check is due. Continue with the crop care and growth-stage guidance in Upcoming steps.');
  return {farmId, asOf: today, checks, limitations};
}

export async function readFieldIssues(deps: ScoutingDeps, ownerId: string, farmId: string, opts: {fieldId?: string | undefined; status?: IssueStatus | undefined} = {}): Promise<FieldIssues> {
  const ws = await getWorkspace(deps.pool, ownerId, farmId);
  const field = opts.fieldId !== undefined ? fieldOf(ws, opts.fieldId) : null;
  const today = todayOf(deps);
  const state = await scoutingState(deps.pool, ownerId, farmId, deps.config.RUNTIME_MODE, ws, today);
  const scoped = state.issues.filter((i) => !field || i.fieldId === undefined || i.fieldId === field.id);
  return {farmId, asOf: today, issues: opts.status ? scoped.filter((i) => i.status === opts.status) : scoped, counts: countsOf(scoped), limitations: [...ISSUE_LIMITATIONS]};
}

export async function readFieldIssue(deps: ScoutingDeps, ownerId: string, farmId: string, issueId: string): Promise<FieldIssue> {
  if (!(await getFarm(deps.pool, ownerId, farmId))) throw notFound('Farm');
  const ws = await getWorkspace(deps.pool, ownerId, farmId);
  const state = await scoutingState(deps.pool, ownerId, farmId, deps.config.RUNTIME_MODE, ws, todayOf(deps));
  const issue = state.issues.find((i) => i.id === issueId);
  if (!issue) throw notFound('Issue');
  return issue;
}

// ------------------------------------------------------------------ Today view and briefing helpers

export interface ViewScoutingScope { fieldId: string | null; all: boolean }
/** The Today view's scope: the described field plus farm-wide records; a farm without fields: everything. */
export const viewScope = (ws: Pick<FarmWorkspace, 'fields'>, selectedFieldId: string | null): ViewScoutingScope => ({fieldId: selectedFieldId, all: ws.fields.length === 0});
const inView = (fieldId: string | null | undefined, s: ViewScoutingScope) => s.all || fieldId === null || fieldId === undefined || fieldId === s.fieldId;

/** TodayView.issues for the scope, or undefined when no issue is logged there (the view then keeps its earlier shape). */
export function todayIssuesBlock(issues: readonly FieldIssue[], s: ViewScoutingScope) {
  const scoped = issues.filter((i) => inView(i.fieldId, s));
  if (!scoped.length) return undefined;
  const active = scoped.filter((i) => i.status === 'open' || i.status === 'treating');
  return {
    open: active.filter((i) => i.status === 'open').length,
    treating: active.filter((i) => i.status === 'treating').length,
    latest: active.slice(0, 5).map((i) => ({id: i.id, category: i.category, severity: i.severity, status: i.status, title: i.title, observedOn: i.observedOn, ...(i.fieldId !== undefined ? {fieldId: i.fieldId} : {})})),
  };
}

/** The view's checks: the interval check of the described cycle, rechecks of in-scope issues, completions in scope. */
export function viewChecks(checks: readonly FieldCheck[], s: ViewScoutingScope, cycleId: string | null): FieldCheck[] {
  return checks.filter((c) => inView(c.fieldId, s) && (c.kind === 'recheck' || c.cycleId === cycleId));
}

/**
 * Briefing lines (5.3): one per field with something to say (the farm when it has no fields): open issues (open or being
 * treated) with the newest one, and the next open check's due date. Code text only; no model interprets an issue.
 */
export function briefingLines(ws: Pick<FarmWorkspace, 'fields'>, state: Pick<ScoutingState, 'checks' | 'issues'>, max = 6): string[] {
  const scopes: {fieldId: string | null; label: string}[] = ws.fields.length ? [...ws.fields.map((f) => ({fieldId: f.id as string | null, label: `Field ${f.name}`})), {fieldId: null, label: 'Whole farm'}] : [{fieldId: null, label: 'Farm'}];
  const lines: string[] = [];
  for (const sc of scopes) {
    const issues = state.issues.filter((i) => (i.fieldId ?? null) === sc.fieldId && (i.status === 'open' || i.status === 'treating'));
    const next = state.checks.filter((c) => c.fieldId === sc.fieldId && c.status !== 'completed').sort((a, b) => a.dueFrom.localeCompare(b.dueFrom))[0];
    const parts: string[] = [];
    if (issues.length) {
      const l = issues[0]!;
      parts.push(`${issues.length} open issue(s) (farmer-reported), latest: ${l.title} (${l.category}, ${l.severity}) on ${l.observedOn}`);
    }
    if (next) parts.push(`next field check due ${next.dueFrom}${next.status === 'overdue' ? ' (overdue)' : ''}`);
    if (parts.length) lines.push(`${sc.label}: ${parts.join('; ')}.`);
  }
  return lines.slice(0, max);
}
