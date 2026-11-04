import {describe, expect, it} from 'vitest';
import {FieldCheck} from '@harvest/contracts';
import {checkSchedule, conditionCheckId, type RiskAlert, type ScheduleCompletion, type ScheduleInput} from '../src/services/scouting/schedule';

// Synthetic crops, alerts and dates. No external providers or agronomic assumptions.
const cycle = (id = 'c1', cropId = 'maize', fieldId?: string) => ({id, cropId, sowingDate: '2026-10-01', stage: 'growing' as const, ...(fieldId ? {fieldId} : {})});
const field = (id: string) => ({id, name: id, boundary: {type: 'Polygon' as const, coordinates: [[[76, 13], [76.001, 13], [76.001, 13.001], [76, 13]]] as [number, number][][]}});
const alert = (over: Partial<RiskAlert> = {}): RiskAlert => ({id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Maize leaf damage risk', detail: 'Synthetic sourced risk.', sourceName: 'Test source', sourceUrl: 'https://example.test/risk', sourceDate: '2026-11-01', validFrom: '2026-11-03', validTo: '2026-11-09', fieldId: null, type: 'crop_threat', cycleId: 'c1', suggestedStep: 'Inspect maize leaves for the damage described in the bulletin.', ...over});
const run = (over: Partial<ScheduleInput> = {}) => checkSchedule({workspace: {cycles: [cycle()], fields: []}, alerts: [alert()], completions: [], issues: [], today: '2026-11-04', ...over}).map(c => FieldCheck.parse(c));
const done = (check: FieldCheck, over: Partial<ScheduleCompletion> = {}): ScheduleCompletion => ({checkId: check.id, checkKind: check.kind, fieldId: check.fieldId, cycleId: check.cycleId, issueId: check.issueId, dueOn: check.dueFrom, completedOn: '2026-11-04', journalEntryId: '44444444-4444-4444-8444-444444444444', snapshot: check, ...over});

describe('condition-based field checks', () => {
  it('does not create a periodic checklist even when a legacy interval is configured', () => {
    expect(run({alerts: [], workspace: {cycles: [cycle()], fields: [], checkIntervalDays: 7}})).toEqual([]);
    expect(run({alerts: [], today: '2027-01-01'})).toEqual([]);
  });
  it('uses the condition window and specific inspection action without general prompts', () => {
    const [c] = run();
    expect(c).toMatchObject({id: conditionCheckId('c1', alert().id), kind: 'condition', status: 'due', dueFrom: '2026-11-03', dueTo: '2026-11-09', reason: alert().title, intervalDays: null});
    expect(c!.checklist).toEqual([expect.objectContaining({text: alert().suggestedStep, alertId: alert().id, sourceUrl: alert().sourceUrl})]);
    expect(run({today: '2026-11-02'})[0]!.status).toBe('upcoming');
  });
  it('drops expired, distant, ungrounded and non-actionable conditions', () => {
    for (const a of [alert({validTo: '2026-11-03'}), alert({validFrom: '2026-12-01', validTo: '2026-12-10'}), alert({sourceUrl: ''}), alert({suggestedStep: null})]) expect(run({alerts: [a]})).toEqual([]);
  });
  it('does not schedule a field visit for a future or harvested crop', () => {
    for (const c of [{...cycle(), sowingDate: '2026-12-01'}, {...cycle(), stage: 'harvested' as const, harvestDate: '2026-11-01'}]) expect(run({workspace: {cycles: [c], fields: []}})).toEqual([]);
  });
  it('matches the crop cycle, not every crop on a farm', () => {
    const workspace = {cycles: [cycle(), cycle('c2', 'chickpea')], fields: []};
    expect(run({workspace}).map(c => c.cycleId)).toEqual(['c1']);
    expect(run({workspace, alerts: [alert({cycleId: null, title: 'Chickpea pod risk', detail: 'Only chickpea.'})]}).map(c => c.cycleId)).toEqual(['c2']);
    expect(run({workspace, alerts: [alert({cycleId: null, title: 'Unspecified risk', detail: 'Unknown crop.'})]})).toEqual([]);
  });
  it('keeps satellite conditions on their field; farm-wide weather affects growing crops', () => {
    const workspace = {cycles: [cycle('c1', 'maize', 'north'), cycle('c2', 'chickpea', 'south')], fields: [field('north'), field('south')]};
    expect(run({workspace, alerts: [alert({type: 'satellite', fieldId: 'north', cycleId: null})]}).map(c => c.fieldId)).toEqual(['north']);
    expect(run({workspace, alerts: [alert({type: 'weather', cycleId: null})]}).map(c => c.fieldId).sort()).toEqual(['north', 'south']);
    const scoped = checkSchedule({workspace, alerts: [alert({type: 'weather', cycleId: null})], issues: [], completions: [], today: '2026-11-04'}, {all: false, fieldId: 'south'});
    expect(scoped.map(c => c.fieldId)).toEqual(['south']);
  });
  it('completion suppresses the event across refreshes and validity extensions, with no next weekly slot', () => {
    const c = run()[0]!;
    const completions = [done(c)];
    const next = run({completions, today: '2026-11-05', alerts: [alert({validTo: '2026-11-15'})]});
    expect(next.map(c => c.status)).toEqual(['completed']);
    expect(next[0]!.checklist).toEqual(c.checklist);
    expect(run({completions, alerts: []})[0]!.reason).toBe(c.reason);
    expect(run({completions, today: '2026-12-10', alerts: [alert({validTo: '2026-12-20'})]})).toEqual([]);
    expect(run({completions, alerts: [alert({id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})]}).filter(c => c.status !== 'completed')).toHaveLength(1);
  });
  it('uses only the logged issue for a recheck and clears it on resolution or completion', () => {
    const issue = {id: '55555555-5555-4555-8555-555555555555', fieldId: null, cycleId: 'c1', cropName: 'Maize', title: 'Yellow patch', status: 'open' as const, recheckOn: '2026-11-05'};
    const c = run({alerts: [], issues: [issue]})[0]!;
    expect(c).toMatchObject({kind: 'recheck', dueFrom: issue.recheckOn, dueTo: issue.recheckOn});
    expect(c.checklist).toHaveLength(1);
    expect(c.checklist[0]!.text).toContain('Yellow patch');
    expect(run({alerts: [], issues: [{...issue, status: 'resolved'}]})).toEqual([]);
    expect(run({alerts: [], issues: [issue], completions: [done(c)]}).map(c => c.status)).toEqual(['completed']);
  });
});
