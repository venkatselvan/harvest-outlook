import { FarmAlerts, FarmCommandCenter, type FarmAlert, type CareTask } from '@harvest/contracts';
import { apiRequest } from '../../features/photo-region/http';
export type Priority = {
  farmId: string;
  epoch: number;
  status: 'loading' | 'ready' | 'error';
  alerts: FarmAlert[];
  tasks: {
    task: CareTask;
    fieldId: string | undefined;
  }[];
  alertsError: boolean;
  tasksError: boolean;
  mode: string | null;
  asOf: string | null;
};
type ReadResult = {
  data: unknown;
  mode: string;
};
export const emptyPriorities = (farmId: string, epoch: number): Priority => ({
  farmId,
  epoch,
  status: 'loading',
  alerts: [],
  tasks: [],
  alertsError: false,
  tasksError: false,
  mode: null,
  asOf: null
});
/** These endpoints read stored alerts and compute source schedules. /today is deliberately avoided: its GET can queue AI jobs. */
export async function loadPriorities(farmId: string, epoch: number, current: () => boolean, publish: (value: Priority) => void, read: (part: 'alerts' | 'command-center') => Promise<ReadResult> = part => apiRequest<unknown>(`/api/v1/farms/${encodeURIComponent(farmId)}/${part}`)) {
  const [alertsResult, tasksResult] = await Promise.allSettled([read('alerts'), read('command-center')]);
  if (!current()) return;
  const next: Priority = {
    ...emptyPriorities(farmId, epoch),
    status: 'ready',
    alertsError: true,
    tasksError: true
  };
  if (alertsResult.status === 'fulfilled') {
    const p = FarmAlerts.safeParse(alertsResult.value.data);
    if (p.success && p.data.farmId === farmId) {
      next.alerts = p.data.alerts;
      next.alertsError = false;
      next.mode = alertsResult.value.mode;
      next.asOf = p.data.asOf;
    }
  }
  if (tasksResult.status === 'fulfilled') {
    const p = FarmCommandCenter.safeParse(tasksResult.value.data);
    if (p.success && p.data.farmId === farmId) {
      next.tasks = p.data.currentCycles.flatMap(c => c.careTasks.filter(t => t.status !== 'completed').map(task => ({
        task,
        fieldId: c.cycle.fieldId
      }))).sort((a, b) => a.task.dueFrom.localeCompare(b.task.dueFrom));
      next.tasksError = false;
      next.mode ??= tasksResult.value.mode;
      next.asOf ??= p.data.asOf;
    }
  }
  next.status = next.alertsError && next.tasksError ? 'error' : 'ready';
  if (current()) publish(next);
}
