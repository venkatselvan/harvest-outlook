import { describe, it, expect } from 'vitest';
import type { FarmWorkspace, CareTask, FarmAlert } from '@harvest/contracts';
import type { GeoFarm } from '../state';
import type { FarmLoad } from './model';
import { emptyPriorities, loadPriorityCohort, type Priority } from './priorities';
import { activeFieldCount, farmStatus, nextPlannedTask, openReviewCount, openReviewsTotal, pinNumber, shortDate, taskWhen, todaysTasks } from './status';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const alert = (severity: FarmAlert['severity'], farmId = A): FarmAlert => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', farmId, type: 'weather', severity, origin: 'rule', title: 'Rain alert', detail: 'Fixture', source: { name: 'Fixture forecast', url: 'https://example.org', date: '2026-11-03' }, validFrom: '2026-11-03', validTo: '2026-11-05', suggestedStep: null, createdAt: '2026-11-03T04:30:00Z' });
const task = (status: CareTask['status'], dueFrom = '2026-11-03', id = `t-${status}-${dueFrom}`): { task: CareTask; fieldId: string | undefined } => ({ fieldId: 'field-a', task: { id, actionId: 'check', cycleId: 'c', cropId: 'maize', title: `Task ${status}`, action: 'Inspect', anchor: 'direct_sowing', dueFrom, dueTo: dueFrom, conditions: [], sourceRefs: [], status, completedOn: null, journalEntryId: null, evidenceState: 'source_schedule' } });
const ready = (over: Partial<Priority> = {}, farmId = A): Priority => ({ ...emptyPriorities(farmId, 1), status: 'ready', ...over });
// Only fields and cycles matter to the active-field rule; the shape is not schema-validated (field geometry is irrelevant here).
const workspace = (farmId = A) => ({ farmId, version: 1, updatedAt: '2026-11-03T04:30:00Z', boundary: null, previousHarvest: { status: 'unknown' }, rotationPlans: [],
  fields: [{ id: 'f1', name: 'North', boundary: null }, { id: 'f2', name: 'South', boundary: null }, { id: 'f3', name: 'East', boundary: null }],
  cycles: [{ id: 'c1', cropId: 'maize', fieldId: 'f1', sowingDate: '2026-09-01', establishmentMethod: 'direct_sowing', stage: 'growing' }, { id: 'c2', cropId: 'ragi', fieldId: 'f2', sowingDate: '2026-03-01', establishmentMethod: 'direct_sowing', stage: 'harvested' }, { id: 'c3', cropId: 'ginger', sowingDate: '2026-05-01', establishmentMethod: 'direct_sowing', stage: 'growing' }] }) as unknown as FarmWorkspace;
const loaded: FarmLoad = { status: 'ready', workspace: workspace() };
const farm = (id: string) => ({ id, name: id, location: {}, facts: {} }) as unknown as GeoFarm;

describe('All farms status chip', () => {
  it('says Unavailable when the workspace failed, whatever the alerts say', () => {
    expect(farmStatus({ status: 'error' }, ready({ alerts: [alert('warning')] })).kind).toBe('unavailable');
  });
  it('says Checking while reads are in flight, never Healthy', () => {
    expect(farmStatus(undefined, undefined).kind).toBe('checking');
    expect(farmStatus(loaded, emptyPriorities(A, 1)).kind).toBe('checking');
    expect(farmStatus({ status: 'loading' }, ready()).kind).toBe('checking');
  });
  it('needs attention for a warning-level alert or an overdue task', () => {
    expect(farmStatus(loaded, ready({ alerts: [alert('warning')] }))).toMatchObject({ kind: 'attention', label: 'Needs attention' });
    expect(farmStatus(loaded, ready({ tasks: [task('overdue')] })).kind).toBe('attention');
    // A failed care read does not hide a warning that did load.
    expect(farmStatus(loaded, ready({ alerts: [alert('warning')], tasksError: true })).kind).toBe('attention');
  });
  it('says Review due for due tasks or info and watch alerts', () => {
    expect(farmStatus(loaded, ready({ tasks: [task('due')] }))).toMatchObject({ kind: 'review', label: 'Review due' });
    expect(farmStatus(loaded, ready({ alerts: [alert('info')] })).kind).toBe('review');
    expect(farmStatus(loaded, ready({ alerts: [alert('watch')] })).kind).toBe('review');
  });
  it('is Healthy only with the workspace and both reads loaded and nothing open; upcoming tasks are not open', () => {
    expect(farmStatus(loaded, ready({ tasks: [task('upcoming', '2026-11-20')] }))).toMatchObject({ kind: 'healthy', label: 'Healthy' });
    expect(farmStatus(loaded, ready({ alertsError: true })).kind).toBe('unavailable');
    expect(farmStatus(loaded, ready({ tasksError: true })).kind).toBe('unavailable');
    expect(farmStatus(loaded, { ...ready(), status: 'error', alertsError: true, tasksError: true }).kind).toBe('unavailable');
  });
});

describe('open reviews total', () => {
  it('counts every stored alert plus due and overdue tasks, not upcoming or completed-out tasks', () => {
    expect(openReviewCount(ready({ alerts: [alert('watch'), alert('info')], tasks: [task('due'), task('overdue'), task('upcoming')] }))).toBe(4);
  });
  it('sums loaded farms and flags partial when a workspace or a read failed', () => {
    const farms = [farm(A), farm(B), farm(C)];
    const all = openReviewsTotal(farms, { [A]: loaded, [B]: loaded, [C]: loaded }, { [A]: ready({ alerts: [alert('watch')] }), [B]: ready({ tasks: [task('due')] }, B), [C]: ready({}, C) });
    expect(all).toEqual({ count: 2, counted: 3, loading: false, partial: false });
    const failedWorkspace = openReviewsTotal(farms, { [A]: loaded, [B]: { status: 'error' }, [C]: loaded }, { [A]: ready({ alerts: [alert('watch')] }), [B]: ready({}, B), [C]: ready({}, C) });
    expect(failedWorkspace).toMatchObject({ count: 1, partial: true });
    const failedRead = openReviewsTotal(farms, { [A]: loaded, [B]: loaded, [C]: loaded }, { [A]: ready({ alerts: [alert('watch')] }), [B]: { ...ready({}, B), status: 'error', alertsError: true, tasksError: true }, [C]: ready({ tasksError: true }, C) });
    expect(failedRead).toEqual({ count: 1, counted: 2, loading: false, partial: true });
    const pending = openReviewsTotal(farms, {}, { [A]: ready({ alerts: [alert('watch')] }) });
    expect(pending).toEqual({ count: 1, counted: 1, loading: true, partial: false });
  });
});

describe('tasks, fields and labels', () => {
  it('lists overdue then due tasks as today’s tasks and picks the earliest upcoming task as next planned', () => {
    const p = ready({ tasks: [task('due', '2026-11-03'), task('upcoming', '2026-11-12'), task('overdue', '2026-11-01'), task('upcoming', '2026-11-08')] });
    expect(todaysTasks(p).map(t => t.task.status)).toEqual(['overdue', 'due']);
    expect(nextPlannedTask(p)?.task.dueFrom).toBe('2026-11-08');
    expect(nextPlannedTask(ready({ tasks: [task('due')] }))).toBeNull();
  });
  it('counts active fields as saved fields with a growing cycle', () => {
    expect(activeFieldCount(loaded)).toBe(1);
    expect(activeFieldCount({ status: 'error' })).toBeNull();
  });
  it('numbers pins in list order and formats calendar dates without a time-zone shift', () => {
    expect([0, 1, 9].map(pinNumber)).toEqual(['01', '02', '10']);
    expect(shortDate('2026-11-03')).toBe('3 Nov');
    expect(taskWhen(task('overdue', '2026-11-01').task)).toBe('Overdue · was due 1 Nov');
  });
});

describe('priority cohort', () => {
  it('reads the selected farm first, two farms at a time, and stops dispatching when the cohort ends', async () => {
    const started: string[] = [], release = new Map<string, () => void>();
    let current = true, active = 0, max = 0;
    const published: string[] = [];
    const done = loadPriorityCohort([A, B, C], 1, () => current, v => published.push(v.farmId), C, async (id, epoch, isCurrent, publish) => {
      started.push(id); active++; max = Math.max(max, active);
      await new Promise<void>(resolve => release.set(id, resolve));
      active--;
      if (isCurrent()) publish(ready({}, id));
      void epoch;
    });
    expect(started).toEqual([C, A]);
    release.get(C)!(); await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([C, A, B]);
    current = false; release.get(A)!(); release.get(B)!(); await done;
    expect(published).toEqual([C]); expect(max).toBe(2);
  });
});
