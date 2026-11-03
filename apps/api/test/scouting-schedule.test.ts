import {describe, expect, it} from 'vitest';
import {FieldCheck} from '@harvest/contracts';
import {GENERAL_CHECK_ITEMS, checkSchedule, type RiskAlert, type ScheduleCompletion, type ScheduleInput} from '../src/services/scouting/schedule';

// SYNTHETIC: cycles, fields, completions, issues and alerts below are invented test data; no source or field is described.
const ring = (x0: number) => [[[x0, 13], [x0 + 0.001, 13], [x0 + 0.001, 13.001], [x0, 13.001], [x0, 13]]] as [number, number][][];
const field = (id: string, x0: number, checkIntervalDays?: number) => ({id, name: id.toUpperCase(), boundary: {type: 'Polygon' as const, coordinates: ring(x0)}, ...(checkIntervalDays ? {checkIntervalDays} : {})});
const cycle = (id: string, est: string, extra: Record<string, unknown> = {}) => ({id, cropId: 'maize', cropName: 'Maize', sowingDate: est, establishmentDate: est, establishmentMethod: 'direct_sowing', stage: 'growing' as const, ...extra});
const ws = (over: Partial<ScheduleInput['workspace']> = {}): ScheduleInput['workspace'] => ({cycles: [], fields: [], ...over} as ScheduleInput['workspace']);
const run = (over: Partial<ScheduleInput>, today: string) => checkSchedule({workspace: ws(), completions: [], issues: [], alerts: [], today, ...over}).map((c) => FieldCheck.parse(c));
const done = (c: Partial<ScheduleCompletion> & Pick<ScheduleCompletion, 'checkId' | 'dueOn' | 'completedOn'>): ScheduleCompletion => ({checkKind: 'interval', fieldId: null, cycleId: 'c1', issueId: null, journalEntryId: '44444444-4444-4444-8444-444444444444', ...c});
const ISSUE = '55555555-5555-4555-8555-555555555555';

describe('field check schedule (pure)', () => {
  it('anchors on the establishment date at the default 7 days; a cycle established today has nothing due before 7 days', () => {
    const [c] = run({workspace: ws({cycles: [cycle('c1', '2026-11-03')]})}, '2026-11-03');
    expect(c).toMatchObject({id: 'check:c1:2026-11-10', kind: 'interval', dueFrom: '2026-11-10', dueTo: '2026-11-12', status: 'upcoming', intervalDays: 7, scope: 'farm', fieldId: null, cropName: 'Maize'});
    expect(c!.checklist.map((i) => i.text)).toEqual([...GENERAL_CHECK_ITEMS]);
  });

  it('due inside the two-day window, overdue after it (and stays overdue within one interval of dueFrom)', () => {
    const w = ws({cycles: [cycle('c1', '2026-10-01')]});
    expect(run({workspace: w}, '2026-10-08')[0]).toMatchObject({status: 'due', dueFrom: '2026-10-08', dueTo: '2026-10-10'});
    expect(run({workspace: w}, '2026-10-10')[0]!.status).toBe('due');
    expect(run({workspace: w}, '2026-10-11')[0]!.status).toBe('overdue');
    expect(run({workspace: w}, '2026-10-15')[0]).toMatchObject({id: 'check:c1:2026-10-08', status: 'overdue'});
  });

  it('rolls an interval check overdue by more than one interval to the latest slot on or before today and counts the skipped slots', () => {
    const w = ws({cycles: [cycle('c1', '2026-10-01')]});
    // 33 days after establishment, interval 7: slots at day 7, 14, 21, 28; the latest on or before today is day 28 (2026-10-29).
    const [c] = run({workspace: w}, '2026-11-03');
    expect(c).toMatchObject({id: 'check:c1:2026-10-29', dueFrom: '2026-10-29', dueTo: '2026-10-31', missedCount: 3, status: 'overdue'});
    // The day a slot starts it is due, not overdue.
    expect(run({workspace: w}, '2026-11-05')[0]).toMatchObject({id: 'check:c1:2026-11-05', dueFrom: '2026-11-05', missedCount: 4, status: 'due'});
    // One slot behind: exactly one interval after dueFrom the check has not rolled; one day later it moves to the next slot.
    expect(run({workspace: w}, '2026-10-15')[0]).toMatchObject({id: 'check:c1:2026-10-08'});
    expect(run({workspace: w}, '2026-10-15')[0]!.missedCount).toBeUndefined();
    expect(run({workspace: w}, '2026-10-16')[0]).toMatchObject({id: 'check:c1:2026-10-15', missedCount: 1});
    // Never rolled while on time: no missedCount key at all.
    expect('missedCount' in run({workspace: w}, '2026-10-09')[0]!).toBe(false);
  });

  it('completion anchors are unchanged by the roll: the next check follows the completed (rolled) slot, and a recheck never rolls', () => {
    const w = ws({cycles: [cycle('c1', '2026-10-01')]});
    const rolled = run({workspace: w}, '2026-11-03')[0]!;
    // Completing the rolled check on 3 Nov anchors on the later of completion and due date: next slot is 10 Nov, not rolled.
    const after = run({workspace: w, completions: [done({checkId: rolled.id, dueOn: rolled.dueFrom, completedOn: '2026-11-03'})]}, '2026-11-03');
    expect(after.find((c) => c.status !== 'completed')).toMatchObject({id: 'check:c1:2026-11-10', status: 'upcoming'});
    expect(after.find((c) => c.status !== 'completed')!.missedCount).toBeUndefined();
    // A completed slot in the past anchors as before: completed on day 7 (8 Oct), now 33 days in -> rolls from that anchor.
    const early = run({workspace: w, completions: [done({checkId: 'check:c1:2026-10-08', dueOn: '2026-10-08', completedOn: '2026-10-08'})]}, '2026-11-03').find((c) => c.status !== 'completed')!;
    expect(early).toMatchObject({id: 'check:c1:2026-10-29', missedCount: 2});
    // A recheck three intervals overdue stays on its own date.
    const issue = {id: ISSUE, fieldId: null, cycleId: 'c1', cropName: 'Maize', title: 'Holes in leaves', status: 'open' as const, recheckOn: '2026-10-05'};
    expect(run({workspace: w, issues: [issue]}, '2026-11-03').find((c) => c.kind === 'recheck')).toMatchObject({id: `recheck:${ISSUE}:2026-10-05`, dueFrom: '2026-10-05', status: 'overdue'});
    expect(run({workspace: w, issues: [issue]}, '2026-11-03').find((c) => c.kind === 'recheck')!.missedCount).toBeUndefined();
  });

  it('uses the field interval, else the farm interval; the latest interval completion re-anchors and is listed for 30 days', () => {
    const w = ws({fields: [field('north', 76, 5), field('south', 76.002)], checkIntervalDays: 10, cycles: [cycle('c1', '2026-10-01', {fieldId: 'north'}), cycle('c2', '2026-10-01', {fieldId: 'south'})]});
    const checks = run({workspace: w, completions: [done({checkId: 'check:c1:2026-10-06', dueOn: '2026-10-06', completedOn: '2026-10-07', fieldId: 'north'})]}, '2026-10-12');
    expect(checks.find((c) => c.cycleId === 'c1' && c.status !== 'completed')).toMatchObject({id: 'check:c1:2026-10-12', intervalDays: 5, fieldId: 'north', scope: 'field', status: 'due'});
    expect(checks.find((c) => c.cycleId === 'c2')).toMatchObject({id: 'check:c2:2026-10-11', intervalDays: 10, status: 'due'});
    expect(checks.find((c) => c.status === 'completed')).toMatchObject({id: 'check:c1:2026-10-06', completedOn: '2026-10-07', dueTo: '2026-10-08'});
    // 31 days later the completion is no longer listed.
    expect(run({workspace: w, completions: [done({checkId: 'check:c1:2026-10-06', dueOn: '2026-10-06', completedOn: '2026-10-07', fieldId: 'north'})]}, '2026-11-07').some((c) => c.status === 'completed')).toBe(false);
  });

  it('an early completion satisfies its own slot: the next check is the due date plus the interval', () => {
    const w = ws({cycles: [cycle('c1', '2026-10-01')]});
    const checks = run({workspace: w, completions: [done({checkId: 'check:c1:2026-10-08', dueOn: '2026-10-08', completedOn: '2026-10-06'})]}, '2026-10-07');
    expect(checks.find((c) => c.status !== 'completed')!.id).toBe('check:c1:2026-10-15');
  });

  it('rechecks come from open or treating issues with a recheck date until a completion names them', () => {
    const issue = {id: ISSUE, fieldId: null, cycleId: 'c1', cropName: 'Maize', title: 'Holes in leaves', status: 'treating' as const, recheckOn: '2026-11-05'};
    const w = ws({cycles: [cycle('c1', '2026-11-01')]});
    expect(run({workspace: w, issues: [issue]}, '2026-11-03').find((c) => c.kind === 'recheck')).toMatchObject({id: `recheck:${ISSUE}:2026-11-05`, dueFrom: '2026-11-05', dueTo: '2026-11-05', status: 'upcoming', issueId: ISSUE, intervalDays: null});
    expect(run({workspace: w, issues: [issue]}, '2026-11-06').find((c) => c.kind === 'recheck')!.status).toBe('overdue');
    expect(run({workspace: w, issues: [{...issue, status: 'resolved'}]}, '2026-11-03').some((c) => c.kind === 'recheck')).toBe(false);
    const completed = run({workspace: w, issues: [issue], completions: [done({checkId: `recheck:${ISSUE}:2026-11-05`, checkKind: 'recheck', issueId: ISSUE, dueOn: '2026-11-05', completedOn: '2026-11-05'})]}, '2026-11-06');
    expect(completed.filter((c) => c.kind === 'recheck').map((c) => c.status)).toEqual(['completed']);
    // A recheck completion does not move the interval walk.
    expect(completed.find((c) => c.kind === 'interval')!.id).toBe('check:c1:2026-11-08');
  });

  it('a cycle without a field on a farm with fields is farm-wide; scopes filter field and farm-wide checks', () => {
    const w = ws({fields: [field('north', 76)], cycles: [cycle('legacy', '2026-10-30'), cycle('c1', '2026-10-30', {fieldId: 'north'}), cycle('old', '2026-06-01', {stage: 'harvested', harvestDate: '2026-09-01'})]});
    const all = run({workspace: w}, '2026-11-03');
    expect(all.map((c) => [c.cycleId, c.fieldId, c.scope])).toEqual([['c1', 'north', 'field'], ['legacy', null, 'farm']]);
    expect(checkSchedule({workspace: w, completions: [], issues: [], alerts: [], today: '2026-11-03'}, {all: false, fieldId: 'other'}).map((c) => c.cycleId)).toEqual(['legacy']);
  });

  it('lists the overlapping crop-threat windows of the same scope (at most 6) before the general prompts', () => {
    const alert = (id: string, fieldId: string | null, from: string, to: string): RiskAlert => ({id, title: `Window ${id.slice(0, 1)}`, detail: 'Synthetic window.', sourceName: 'Synthetic source', sourceUrl: 'https://example.test/s', sourceDate: '2026-10-01', validFrom: from, validTo: to, fieldId});
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', '1'].map((p) => `${p.repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    const alerts = [...ids.map((id) => alert(id, 'north', '2026-11-01', '2026-11-20')), alert('99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, '2026-11-01', '2026-11-20'), alert('88888888-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'north', '2026-12-01', '2026-12-20')];
    const w = ws({fields: [field('north', 76)], cycles: [cycle('c1', '2026-11-01', {fieldId: 'north'})]});
    const [c] = run({workspace: w, alerts}, '2026-11-03');
    const risks = c!.checklist.filter((i) => i.kind === 'risk_window');
    expect(risks).toHaveLength(6);
    expect(risks.every((i) => i.sourceUrl === 'https://example.test/s' && i.sourceDate === '2026-10-01' && i.alertId !== null)).toBe(true);
    expect(c!.checklist).toHaveLength(14);
  });
});
