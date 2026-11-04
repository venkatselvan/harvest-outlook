import type { CareTask, FarmAlert } from '@harvest/contracts';
import type { GeoFarm } from '../state';
import type { FarmLoad, FarmLoads } from './model';
import type { Priority } from './priorities';

/**
 * All farms status rules (docs/research/ALL_FARMS_LAYOUT_SPEC.md items 2, 3 and 5). Everything here is derived in code
 * from the reads this page already makes: the farm workspace (fields, cycles) and each farm's stored alerts and
 * source-scheduled care tasks (`/alerts` and `/command-center`). Field checks and issues recorded in the field-operations
 * log are not read on this page, so "checks" here means the source-scheduled care tasks the command center returns
 * (status `due` / `overdue` / `upcoming`, computed by the server for its as-of date).
 */

export type FarmStatusKind = 'attention' | 'review' | 'healthy' | 'unavailable' | 'checking';
export interface FarmStatus {
  kind: FarmStatusKind;
  label: string;
  /** One sentence saying why, for a tooltip and screen readers. */
  reason: string;
}

/** Alerts still to review (every active stored alert) plus care tasks that are due or overdue. */
export function openReviewCount(priority: Pick<Priority, 'alerts' | 'tasks'>): number {
  return priority.alerts.length + priority.tasks.filter(({ task }) => task.status === 'due' || task.status === 'overdue').length;
}

/**
 * One status per farm:
 * - Unavailable: the farm workspace failed to load, or neither its alerts nor its care tasks could be read, or one of
 *   the two failed and the part that loaded shows nothing open (so "healthy" cannot be claimed).
 * - Needs attention: any warning-level alert or any overdue care task (even when the other read failed).
 * - Review due: any due care task or any info / watch alert to review.
 * - Healthy: workspace loaded, both reads loaded, nothing open.
 * - Checking: still loading.
 */
export function farmStatus(load: FarmLoad | undefined, priority: Priority | undefined): FarmStatus {
  if (load?.status === 'error') return { kind: 'unavailable', label: 'Unavailable', reason: 'This farm’s records could not load.' };
  if (!priority || priority.status === 'loading') return { kind: 'checking', label: 'Checking…', reason: 'Reading stored alerts and care schedules.' };
  if (priority.status === 'error') return { kind: 'unavailable', label: 'Unavailable', reason: 'Stored alerts and care schedules could not load.' };
  const warning = priority.alerts.some((alert) => alert.severity === 'warning');
  const overdue = priority.tasks.some(({ task }) => task.status === 'overdue');
  if (warning || overdue) return { kind: 'attention', label: 'Needs attention', reason: warning ? 'A warning-level alert is active.' : 'A scheduled care task is overdue.' };
  const due = priority.tasks.some(({ task }) => task.status === 'due');
  if (due || priority.alerts.length) return { kind: 'review', label: 'Review due', reason: due ? 'A scheduled care task is due.' : 'An alert is ready to review.' };
  if (priority.alertsError || priority.tasksError) return { kind: 'unavailable', label: 'Unavailable', reason: priority.alertsError ? 'Stored alerts could not load.' : 'Care schedules could not load.' };
  if (!load || load.status === 'loading') return { kind: 'checking', label: 'Checking…', reason: 'Reading this farm’s records.' };
  return { kind: 'healthy', label: 'Healthy', reason: 'No open alerts or due care tasks in the stored records.' };
}

export interface OpenReviewsTotal {
  /** Sum over farms whose alerts or care tasks loaded. */
  count: number;
  /** Farms that contributed (at least one of the two reads loaded). */
  counted: number;
  /** Still reading at least one farm. */
  loading: boolean;
  /** Some workspace or some alerts / care-task read failed: the count may be low. */
  partial: boolean;
}
export function openReviewsTotal(farms: readonly GeoFarm[], loads: FarmLoads, priorities: Readonly<Record<string, Priority>>): OpenReviewsTotal {
  let count = 0,
    counted = 0,
    loading = false,
    partial = false;
  for (const farm of farms) {
    if (loads[farm.id]?.status === 'error') partial = true;
    const priority = priorities[farm.id];
    if (!priority || priority.status === 'loading') {
      loading = true;
      continue;
    }
    if (priority.alertsError || priority.tasksError) partial = true;
    if (priority.status === 'error') continue;
    count += openReviewCount(priority);
    counted++;
  }
  return { count, counted, loading, partial };
}

/** Care tasks due or overdue as of the server's date, overdue first, then by due date. */
export function todaysTasks(priority: Pick<Priority, 'tasks'>): Priority['tasks'] {
  return priority.tasks
    .filter(({ task }) => task.status === 'due' || task.status === 'overdue')
    .sort((a, b) => (a.task.status === b.task.status ? a.task.dueFrom.localeCompare(b.task.dueFrom) : a.task.status === 'overdue' ? -1 : 1));
}

/** The earliest upcoming (not yet due) care task, or null. */
export function nextPlannedTask(priority: Pick<Priority, 'tasks'>): Priority['tasks'][number] | null {
  return [...priority.tasks].filter(({ task }) => task.status === 'upcoming').sort((a, b) => a.task.dueFrom.localeCompare(b.task.dueFrom))[0] ?? null;
}

/** Saved fields with a growing (not harvested) crop cycle recorded on them. */
export function activeFieldCount(load: FarmLoad | undefined): number | null {
  if (load?.status !== 'ready') return null;
  const growing = new Set(load.workspace.cycles.filter((c) => c.stage !== 'harvested' && c.fieldId).map((c) => c.fieldId));
  return (load.workspace.fields ?? []).filter((field) => growing.has(field.id)).length;
}

/** "01", "02" … in list order. */
export const pinNumber = (index: number) => String(index + 1).padStart(2, '0');

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekdayFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
/** A calendar date (YYYY-MM-DD) without a time-zone shift; the raw text when it does not parse. */
export function shortDate(value: string, weekday = false): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? (weekday ? weekdayFormat : dateFormat).format(date) : value;
}

export function taskWhen(task: CareTask): string {
  const range = task.dueFrom === task.dueTo ? shortDate(task.dueFrom) : `${shortDate(task.dueFrom)} – ${shortDate(task.dueTo)}`;
  if (task.status === 'overdue') return `Overdue · was due ${range}`;
  if (task.status === 'due') return `Due ${range}`;
  return `From ${range}`;
}

export const severityLabel = (severity: FarmAlert['severity']) => (severity === 'warning' ? 'Warning' : severity === 'watch' ? 'Watch' : 'Info');
