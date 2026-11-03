/**
 * Field check schedule (FIELD_OPERATIONS_SPEC.md 4.1 and 4.3), pure: computed on read from the workspace cycles, the stored
 * check completions, the issue log, the stored crop-threat rule alerts and today's date. Nothing is created by computing it.
 *
 * A field check is a recurring app action at the farmer's own interval ("Your check interval"), not an agronomic claim.
 *
 * Rules (each a documented choice that changes results):
 * - Scope: on a farm with fields, an unharvested cycle naming a field gets a field check (scope 'field'); a cycle recorded
 *   without a field (before the fields were drawn) gets a farm-wide check (fieldId null, scope 'farm'). On a farm without
 *   fields every check is farm-wide.
 * - Interval: the field's checkIntervalDays, else the farm's, else DEFAULT_CHECK_INTERVAL_DAYS (7). Farm-wide checks use the
 *   farm's, else 7.
 * - Anchor: the latest INTERVAL completion of the cycle, else the establishment date (else the sowing date). A recheck
 *   completion looks at one issue and does not move the walk. Refinement (not in the spec text): the anchor of a completion
 *   is the later of its completion date and its due date, so a check completed early satisfies its own slot and the next
 *   slot is the due date plus the interval (this also keeps every deterministic check id unique per cycle).
 * - Window: dueFrom = anchor + interval, dueTo = dueFrom + CHECK_WINDOW_DAYS (2). 'upcoming' before dueFrom, 'due' inside,
 *   'overdue' after dueTo. Only the next open check per cycle is listed; a cycle established today has no check due before
 *   `interval` days. Roll-forward (2026-11-03): an interval check overdue by more than one interval (today - dueFrom >
 *   interval) moves to the latest slot on or before today, dueFrom = anchor + k x interval with the largest k such that
 *   dueFrom <= today (dueTo = dueFrom + 2), and `missedCount` = k - 1 names the slots skipped; the id uses the rolled dueOn.
 *   Within one interval of dueFrom a check stays where it is (overdue until completed). Rechecks never roll.
 * - Rechecks: every open or treating issue with a recheck date yields `recheck:<issueId>:<recheckOn>` (dueFrom = dueTo =
 *   recheckOn) until a completion names that check id, or the issue is resolved or dismissed (which clears the date).
 * - Completed checks (interval and recheck) completed within the last COMPLETED_LOOKBACK_DAYS (30) days are listed with
 *   status 'completed'.
 * - Checklist: the crop-threat rule alerts of the check's scope (the field's own for a field check, the farm-wide ones for a
 *   farm-wide check) whose validity overlaps the check window, at most 6, then the 8 fixed general prompts. Alerts carry no
 *   cycle id: on a farm without fields with two growing crops, both crops' windows are listed on each check.
 */
import type {CheckItem, FarmWorkspace, FieldCheck, IssueStatus} from '@harvest/contracts';

export const DEFAULT_CHECK_INTERVAL_DAYS = 7;
export const CHECK_WINDOW_DAYS = 2;
export const COMPLETED_LOOKBACK_DAYS = 30;
export const MAX_RISK_ITEMS = 6;
/** Fixed general prompts (4.3), shown under "General prompts (not crop-specific advice)". */
export const GENERAL_CHECK_ITEMS: readonly string[] = [
  'New leaf damage or holes',
  'Discoloured or wilting plants',
  'Insects on leaves, stems or the soil surface',
  'Weeds taller than the crop between rows',
  'Standing water or dry cracked soil',
  'Animal tracks or grazing damage',
  'Anything different from last week',
  'Take a photo of anything unusual',
];
export const GENERAL_PROMPTS_LABEL = 'General prompts (not crop-specific advice)';

type Cycle = FarmWorkspace['cycles'][number];
const DAY_MS = 86_400_000;
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export interface ScheduleCompletion {
  checkId: string; checkKind: 'interval' | 'recheck'; fieldId: string | null; cycleId: string | null; issueId: string | null;
  dueOn: string; completedOn: string; journalEntryId: string;
}
export interface ScheduleIssue { id: string; fieldId: string | null; cycleId: string | null; cropName: string | null; title: string; status: IssueStatus; recheckOn: string | null }
/** A stored crop-threat rule alert (farm_alerts, type crop_threat, origin rule, not dismissed). */
export interface RiskAlert { id: string; title: string; detail: string; sourceName: string; sourceUrl: string; sourceDate: string; validFrom: string; validTo: string; fieldId: string | null }
export interface ScheduleInput {
  workspace: Pick<FarmWorkspace, 'cycles' | 'fields'> & {checkIntervalDays?: number | undefined};
  completions: readonly ScheduleCompletion[];
  issues: readonly ScheduleIssue[];
  alerts: readonly RiskAlert[];
  today: string;
}
/** Which checks a reader sees: a field's own plus the farm-wide ones; `all` = every check of the farm. */
export type CheckScope = {all: true} | {all: false; fieldId: string | null};

export const checkStatus = (dueFrom: string, dueTo: string, today: string): FieldCheck['status'] => (dueTo < today ? 'overdue' : dueFrom > today ? 'upcoming' : 'due');
export const intervalCheckId = (cycleId: string, dueOn: string) => `check:${cycleId}:${dueOn}`;
export const recheckId = (issueId: string, dueOn: string) => `recheck:${issueId}:${dueOn}`;
export const cycleCropName = (c: Pick<Cycle, 'cropId' | 'cropName'>) => c.cropName ?? c.cropId.replace(/[-_]+/g, ' ').replace(/^./, (x) => x.toUpperCase());

/** The field a cycle's checks belong to: its fieldId on a farm with fields, else null (farm-wide). */
export const cycleFieldId = (ws: Pick<FarmWorkspace, 'fields'>, c: Pick<Cycle, 'fieldId'>): string | null => (ws.fields.length && c.fieldId !== undefined ? c.fieldId : null);

/** The farmer's interval for a field (null = farm-wide): the field's, else the farm's, else 7. */
export function intervalFor(ws: ScheduleInput['workspace'], fieldId: string | null): number {
  const own = fieldId === null ? undefined : ws.fields.find((f) => f.id === fieldId)?.checkIntervalDays;
  return own ?? ws.checkIntervalDays ?? DEFAULT_CHECK_INTERVAL_DAYS;
}

export function inScope(fieldId: string | null, scope: CheckScope): boolean {
  return scope.all || fieldId === null || fieldId === scope.fieldId;
}

/** Risk-window items (at most 6, by start date then id) and the 8 general prompts. */
export function checklistFor(alerts: readonly RiskAlert[], fieldId: string | null, dueFrom: string, dueTo: string): CheckItem[] {
  const risks = alerts
    .filter((a) => a.fieldId === fieldId && a.validFrom <= dueTo && a.validTo >= dueFrom)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id))
    .slice(0, MAX_RISK_ITEMS)
    .map((a): CheckItem => ({text: cap(`${a.title}: ${a.detail}`, 300), kind: 'risk_window', sourceName: cap(a.sourceName, 200), sourceUrl: a.sourceUrl, sourceDate: a.sourceDate, alertId: a.id}));
  return [...risks, ...GENERAL_CHECK_ITEMS.map((text): CheckItem => ({text, kind: 'general', sourceName: null, sourceUrl: null, sourceDate: null, alertId: null}))];
}

const STATUS_RANK: Record<FieldCheck['status'], number> = {overdue: 0, due: 1, upcoming: 2, completed: 3};
export const orderChecks = (checks: readonly FieldCheck[]) => [...checks].sort((a, b) =>
  STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.status === 'completed' ? (b.completedOn ?? '').localeCompare(a.completedOn ?? '') : 0) || a.dueFrom.localeCompare(b.dueFrom) || a.id.localeCompare(b.id));

/** Every check of the farm (open and recently completed), ordered overdue, due, upcoming (by dueFrom), completed (newest first). */
export function checkSchedule(input: ScheduleInput, scope: CheckScope = {all: true}): FieldCheck[] {
  const {workspace: ws, completions, issues, alerts, today} = input;
  const out: FieldCheck[] = [];
  const cycles = new Map(ws.cycles.map((c) => [c.id, c]));
  const completedIds = new Set(completions.map((c) => c.checkId));

  // Interval checks: the next one per unharvested cycle.
  for (const cycle of ws.cycles) {
    if (cycle.stage === 'harvested') continue;
    const fieldId = cycleFieldId(ws, cycle);
    if (!inScope(fieldId, scope)) continue;
    const interval = intervalFor(ws, fieldId);
    let anchor = cycle.establishmentDate ?? cycle.sowingDate;
    for (const c of completions) {
      if (c.checkKind !== 'interval' || c.cycleId !== cycle.id) continue;
      const at = c.completedOn > c.dueOn ? c.completedOn : c.dueOn;
      if (at > anchor) anchor = at;
    }
    let dueFrom = addDays(anchor, interval), missedCount = 0;
    const daysLate = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueFrom}T00:00:00Z`)) / DAY_MS);
    if (daysLate > interval) {
      const k = Math.floor((daysLate + interval) / interval); // largest k with anchor + k x interval <= today
      dueFrom = addDays(anchor, k * interval);
      missedCount = k - 1;
    }
    const dueTo = addDays(dueFrom, CHECK_WINDOW_DAYS);
    const id = intervalCheckId(cycle.id, dueFrom);
    if (completedIds.has(id)) continue; // unreachable with the anchor rule above; kept as a guard
    out.push({
      id, kind: 'interval', fieldId, cycleId: cycle.id, issueId: null, cropName: cycleCropName(cycle), dueFrom, dueTo,
      status: checkStatus(dueFrom, dueTo, today), intervalDays: interval, checklist: checklistFor(alerts, fieldId, dueFrom, dueTo),
      completedOn: null, journalEntryId: null, scope: fieldId === null ? 'farm' : 'field', ...(missedCount ? {missedCount} : {}),
    });
  }

  // Rechecks: open or treating issues with a recheck date, until a completion names the check.
  for (const issue of issues) {
    if ((issue.status !== 'open' && issue.status !== 'treating') || !issue.recheckOn) continue;
    if (!inScope(issue.fieldId, scope)) continue;
    const id = recheckId(issue.id, issue.recheckOn);
    if (completedIds.has(id)) continue;
    out.push({
      id, kind: 'recheck', fieldId: issue.fieldId, cycleId: issue.cycleId, issueId: issue.id, cropName: issue.cropName, dueFrom: issue.recheckOn, dueTo: issue.recheckOn,
      status: checkStatus(issue.recheckOn, issue.recheckOn, today), intervalDays: null, checklist: checklistFor(alerts, issue.fieldId, issue.recheckOn, issue.recheckOn),
      completedOn: null, journalEntryId: null, scope: issue.fieldId === null ? 'farm' : 'field',
    });
  }

  // Completed within the last 30 days.
  const since = addDays(today, -COMPLETED_LOOKBACK_DAYS);
  for (const c of completions) {
    if (c.completedOn < since || !inScope(c.fieldId, scope)) continue;
    out.push(completedCheck(input, c, cycles));
  }
  return orderChecks(out);
}

/** A completion row as a completed FieldCheck (crop name from the cycle, else the issue; interval = the current one). */
export function completedCheck(input: Pick<ScheduleInput, 'workspace' | 'issues' | 'alerts'>, c: ScheduleCompletion, cycles = new Map(input.workspace.cycles.map((x) => [x.id, x]))): FieldCheck {
  const cycle = c.cycleId ? cycles.get(c.cycleId) : undefined;
  const issue = c.issueId ? input.issues.find((i) => i.id === c.issueId) : undefined;
  const dueTo = c.checkKind === 'interval' ? addDays(c.dueOn, CHECK_WINDOW_DAYS) : c.dueOn;
  return {
    id: c.checkId, kind: c.checkKind, fieldId: c.fieldId, cycleId: c.cycleId, issueId: c.issueId,
    cropName: cycle ? cycleCropName(cycle) : issue?.cropName ?? null, dueFrom: c.dueOn, dueTo, status: 'completed',
    intervalDays: c.checkKind === 'interval' ? intervalFor(input.workspace, c.fieldId) : null,
    checklist: checklistFor(input.alerts, c.fieldId, c.dueOn, dueTo), completedOn: c.completedOn, journalEntryId: c.journalEntryId,
    scope: c.fieldId === null ? 'farm' : 'field',
  };
}
