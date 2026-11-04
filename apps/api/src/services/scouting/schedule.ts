/** Checks follow actionable crop/condition events, never a configured cadence.
 * Crop care and stage checks remain in Today’s sourced care schedule. An alert produces
 * one check per affected growing cycle, retained as completed for its entire event.
 * Expired alerts disappear; issue rechecks retain the farmer’s explicit date.
 */
import {createHash} from 'node:crypto';
import type {CheckItem, FarmWorkspace, FieldCheck, IssueStatus} from '@harvest/contracts';

export const COMPLETED_LOOKBACK_DAYS = 30;
type Cycle = FarmWorkspace['cycles'][number];
const DAY_MS = 86_400_000;
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export interface ScheduleCompletion {
  checkId: string; checkKind: FieldCheck['kind']; fieldId: string | null; cycleId: string | null; issueId: string | null;
  dueOn: string; completedOn: string; journalEntryId: string; snapshot?: FieldCheck | null;
}
export interface ScheduleIssue { id: string; fieldId: string | null; cycleId: string | null; cropName: string | null; title: string; status: IssueStatus; recheckOn: string | null }
/** Only actionable, sourced alerts are eligible. Cycle identity is recorded for crop rules. */
export interface RiskAlert {
  id: string; title: string; detail: string; sourceName: string; sourceUrl: string; sourceDate: string;
  validFrom: string; validTo: string; fieldId: string | null;
  type: 'crop_threat' | 'weather' | 'satellite'; suggestedStep: string | null; cycleId: string | null;
}
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

export function inScope(fieldId: string | null, scope: CheckScope): boolean {
  return scope.all || fieldId === null || fieldId === scope.fieldId;
}

export const conditionCheckId = (cycleId: string, alertId: string) =>
  `condition:${createHash('sha256').update(JSON.stringify([cycleId, alertId])).digest('hex').slice(0, 40)}`;

function alertItem(a: RiskAlert): CheckItem {
  return {text: cap(a.suggestedStep!, 300), kind: 'risk_window', sourceName: cap(a.sourceName, 200),
    sourceUrl: a.sourceUrl, sourceDate: a.sourceDate, alertId: a.id};
}
function affectsCycle(a: RiskAlert, cycle: Cycle, fieldId: string | null): boolean {
  if (a.fieldId !== null && a.fieldId !== fieldId) return false;
  if (a.cycleId) return a.cycleId === cycle.id;
  if (a.type !== 'crop_threat') return true;
  // Older and news alerts have no cycle identity. Do not assign an unspecified
  // crop threat to every crop on a multi-crop farm: require a named crop.
  const text = ` ${a.title} ${a.detail} `.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return [cycle.cropId, cycle.cropName].filter(Boolean).some(name => {
    const crop = name!.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return crop && text.includes(` ${crop} `);
  });
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

  for (const cycle of ws.cycles) {
    const anchor = cycle.establishmentDate ?? cycle.sowingDate;
    if (cycle.stage === 'harvested' || anchor > today) continue;
    const fieldId = cycleFieldId(ws, cycle);
    if (!inScope(fieldId, scope)) continue;
    for (const alert of alerts) {
      if (!alert.suggestedStep?.trim() || !/^https?:\/\//.test(alert.sourceUrl) || !alert.sourceDate) continue;
      if (alert.validTo < today || alert.validFrom > addDays(today, 14) || alert.validTo < anchor) continue;
      if (!affectsCycle(alert, cycle, fieldId)) continue;
      const id = conditionCheckId(cycle.id, alert.id);
      if (completedIds.has(id)) continue;
      const dueFrom = alert.validFrom < anchor ? anchor : alert.validFrom;
      out.push({id, kind: 'condition', fieldId, cycleId: cycle.id, issueId: null,
        cropName: cycleCropName(cycle), dueFrom, dueTo: alert.validTo,
        status: checkStatus(dueFrom, alert.validTo, today), intervalDays: null,
        reason: cap(alert.title, 300), checklist: [alertItem(alert)],
        completedOn: null, journalEntryId: null, scope: fieldId === null ? 'farm' : 'field'});
    }
  }

  // Rechecks: open or treating issues with a recheck date, until a completion names the check.
  for (const issue of issues) {
    if ((issue.status !== 'open' && issue.status !== 'treating') || !issue.recheckOn) continue;
    if (!inScope(issue.fieldId, scope)) continue;
    const id = recheckId(issue.id, issue.recheckOn);
    if (completedIds.has(id)) continue;
    out.push({
      id, kind: 'recheck', fieldId: issue.fieldId, cycleId: issue.cycleId, issueId: issue.id, cropName: issue.cropName, dueFrom: issue.recheckOn, dueTo: issue.recheckOn,
      status: checkStatus(issue.recheckOn, issue.recheckOn, today), intervalDays: null, reason: cap(issue.title, 300), checklist: [{text: cap(`Revisit ${issue.title}. Record what has changed since the last observation.`, 300), kind: 'general', sourceName: null, sourceUrl: null, sourceDate: null, alertId: null}],
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

/** Preserve the reason and evidence at completion, even after its alert expires or is dismissed. */
export function completedCheck(input: Pick<ScheduleInput, 'workspace' | 'issues' | 'alerts'>, c: ScheduleCompletion, cycles = new Map(input.workspace.cycles.map((x) => [x.id, x]))): FieldCheck {
  if (c.snapshot) return {...c.snapshot, status: 'completed', completedOn: c.completedOn, journalEntryId: c.journalEntryId};
  const cycle = c.cycleId ? cycles.get(c.cycleId) : undefined;
  const issue = c.issueId ? input.issues.find((i) => i.id === c.issueId) : undefined;
  const dueTo = c.checkKind === 'interval' ? addDays(c.dueOn, 2) : c.dueOn;
  return {
    id: c.checkId, kind: c.checkKind, fieldId: c.fieldId, cycleId: c.cycleId, issueId: c.issueId,
    cropName: cycle ? cycleCropName(cycle) : issue?.cropName ?? null, dueFrom: c.dueOn, dueTo, status: 'completed',
    intervalDays: null,
    checklist: [], completedOn: c.completedOn, journalEntryId: c.journalEntryId,
    scope: c.fieldId === null ? 'farm' : 'field',
  };
}
