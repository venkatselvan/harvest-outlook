import { describe, expect, it } from 'vitest';
import { AddIssueEvent, CompleteCheck, CompleteCheckResult, CreateIssue, FieldCheck, FieldChecks, FieldIssue, FieldIssues, IssueResponse, TodayView, UpcomingStep } from './index';
import { FarmField, FarmWorkspaceState, PutFarmWorkspace } from './workspace';

// SYNTHETIC examples only: ids, dates and texts are invented for schema checks.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const issue = { clientEntryId: 'issue-0001', observedOn: '2026-11-02', category: 'pest', severity: 'medium', title: 'Holes in leaves' };
const check: FieldCheck = {
  id: 'check:cycle-1:2026-11-05', kind: 'interval', fieldId: 'strip-2', cycleId: 'cycle-1', issueId: null, cropName: 'Maize', dueFrom: '2026-11-05', dueTo: '2026-11-07',
  status: 'upcoming', intervalDays: 7, checklist: [{ text: 'New leaf damage or holes', kind: 'general', sourceName: null, sourceUrl: null, sourceDate: null, alertId: null }],
  completedOn: null, journalEntryId: null, scope: 'field',
};
const { clientEntryId: _client, ...issueBody } = issue;
const fieldIssue = {
  ...issueBody, id: U1, farmId: U2, fieldId: 'strip-2', cycleId: 'cycle-1', status: 'open', cropId: 'maize', cropName: 'Maize', journalEntryId: U3, mediaIds: [], photoMarks: [],
  events: [{ id: U2, kind: 'reported', occurredOn: '2026-11-02', status: 'open', response: null, note: null, mediaIds: [], journalEntryId: U3, createdAt: '2026-11-02T06:00:00.000Z' }],
  recheckOn: null, earliestHarvestOn: null, seenBefore: [], createdAt: '2026-11-02T06:00:00.000Z', updatedAt: '2026-11-02T06:00:00.000Z', scope: 'field',
};

describe('scouting contracts: issues', () => {
  it('accepts a minimal issue and fills the array defaults', () => {
    const parsed = CreateIssue.parse(issue);
    expect(parsed.mediaIds).toEqual([]);
    expect(parsed.photoMarks).toEqual([]);
    expect(CreateIssue.safeParse({ ...issue, fieldId: 'strip-2', cycleId: 'c', location: { lat: 13.1, lon: 76.2 }, mediaIds: [U1], photoMarks: [{ mediaId: U1, x: 0.2, y: 0.9, label: 'here' }], fromFactId: U2, detail: 'Seen on the north edge' }).success).toBe(true);
  });
  it.each([
    ['short client id', { clientEntryId: 'short' }],
    ['unknown category', { category: 'fungus' }],
    ['unknown severity', { severity: 'severe' }],
    ['empty title', { title: '   ' }],
    ['title too long', { title: 'x'.repeat(121) }],
    ['bad date', { observedOn: '2026-02-30' }],
    ['latitude out of range', { location: { lat: 91, lon: 0 } }],
    ['mark outside the photo', { photoMarks: [{ mediaId: U1, x: 1.2, y: 0 }] }],
    ['five photos', { mediaIds: [U1, U1, U1, U1, U1] }],
    ['field id with a slash', { fieldId: 'a/b' }],
    ['unknown key', { diagnosis: 'x' }],
  ])('rejects %s', (_label, patch) => expect(CreateIssue.safeParse({ ...issue, ...patch }).success).toBe(false));

  it('responses are farmer-reported: no recommendation fields, label wait is an integer of days', () => {
    expect(IssueResponse.safeParse({ method: 'product_applied', description: 'Sprayed what the shop gave', labelWaitDays: 14, recheckOn: '2026-11-09', quantity: { value: 2, unit: 'L' } }).success).toBe(true);
    expect(IssueResponse.safeParse({ method: 'product_applied', description: 'x', labelWaitDays: 1.5 }).success).toBe(false);
    expect(IssueResponse.safeParse({ method: 'product_applied', description: 'x', recommendedDose: '2 L/ha' }).success).toBe(false);
    expect(IssueResponse.safeParse({ method: 'spraying', description: 'x' }).success).toBe(false);
    expect(AddIssueEvent.safeParse({ clientEntryId: 'event-0001', occurredOn: '2026-11-03', kind: 'status_changed', status: 'treating' }).success).toBe(true);
    expect(AddIssueEvent.safeParse({ clientEntryId: 'event-0001', occurredOn: '2026-11-03', kind: 'reported' }).success).toBe(false); // written with the issue only
  });

  it('FieldIssue and FieldIssues round-trip; seenBefore holds at most 5', () => {
    expect(FieldIssue.safeParse(fieldIssue).success).toBe(true);
    expect(FieldIssue.safeParse({ ...fieldIssue, clientEntryId: 'issue-0001' }).success).toBe(false);
    const seen = { issueId: U3, observedOn: '2026-10-01', cropName: null, status: 'resolved' };
    expect(FieldIssue.safeParse({ ...fieldIssue, seenBefore: Array(6).fill(seen) }).success).toBe(false);
    expect(FieldIssues.safeParse({ farmId: U2, asOf: '2026-11-03', issues: [fieldIssue], counts: { open: 1, treating: 0, resolved: 0, dismissed: 0 }, limitations: [] }).success).toBe(true);
  });
});

describe('scouting contracts: checks', () => {
  it('accepts a check and a completion; rejects an unknown status or result', () => {
    expect(FieldChecks.safeParse({ farmId: U2, asOf: '2026-11-03', checks: [check], limitations: [] }).success).toBe(true);
    expect(FieldCheck.safeParse({ ...check, status: 'skipped' }).success).toBe(false);
    expect(FieldCheck.safeParse({ ...check, checklist: Array(21).fill(check.checklist[0]) }).success).toBe(false);
    expect(CompleteCheck.parse({ clientEntryId: 'check-done-01', checkId: check.id, completedOn: '2026-11-05', result: 'nothing_found' }).issueIds).toEqual([]);
    expect(CompleteCheck.safeParse({ clientEntryId: 'check-done-01', checkId: check.id, completedOn: '2026-11-05', result: 'maybe' }).success).toBe(false);
    expect(CompleteCheckResult.safeParse({ check: { ...check, status: 'completed', completedOn: '2026-11-05', journalEntryId: U3 }, journalEntryId: U3, alreadyCompleted: false }).success).toBe(true);
  });
  it('the field_check step kind carries the check; the Today issues block is optional and capped', () => {
    const step = { id: check.id, kind: 'field_check', title: 'Walk the field: Maize on Strip 2', detail: null, dueFrom: check.dueFrom, dueTo: check.dueTo, status: 'upcoming', careTask: null, alertId: null, fieldCheck: check, issueId: null };
    expect(UpcomingStep.safeParse(step).success).toBe(true);
    expect(UpcomingStep.safeParse({ ...step, kind: 'scouting' }).success).toBe(false);
    const issues = { open: 1, treating: 0, latest: [{ id: U1, category: 'pest', severity: 'medium', status: 'open', title: 'Holes', observedOn: '2026-11-02', fieldId: 'strip-2' }] };
    const shape = TodayView.shape.issues;
    expect(shape.safeParse(undefined).success).toBe(true);
    expect(shape.safeParse(issues).success).toBe(true);
    expect(shape.safeParse({ ...issues, latest: Array(6).fill(issues.latest[0]) }).success).toBe(false);
    expect(shape.safeParse({ ...issues, latest: [{ ...issues.latest[0], detail: 'not in the pick' }] }).success).toBe(false);
  });
});

describe('check interval on the workspace', () => {
  const ring = [[76, 13], [76.01, 13], [76.01, 13.01], [76, 13.01], [76, 13]];
  const field = { id: 'strip-2', name: 'Strip 2', boundary: { type: 'Polygon', coordinates: [ring] } };
  const state = { boundary: null, previousHarvest: { status: 'unknown' }, cycles: [], rotationPlans: [] };
  it('accepts whole days from 3 to 30 on a field and on the farm; PUT accepts them', () => {
    expect(FarmField.safeParse({ ...field, checkIntervalDays: 3 }).success).toBe(true);
    expect(FarmField.safeParse({ ...field, checkIntervalDays: 30 }).success).toBe(true);
    expect(FarmWorkspaceState.parse({ ...state, checkIntervalDays: 10 }).checkIntervalDays).toBe(10);
    expect(PutFarmWorkspace.safeParse({ ...state, expectedVersion: 0, checkIntervalDays: 14, fields: [{ ...field, checkIntervalDays: 5 }] }).success).toBe(true);
    expect(FarmWorkspaceState.parse(state).checkIntervalDays).toBeUndefined();
  });
  it.each([2, 31, 7.5])('rejects %s days', (n) => {
    expect(FarmField.safeParse({ ...field, checkIntervalDays: n }).success).toBe(false);
    expect(PutFarmWorkspace.safeParse({ ...state, expectedVersion: 0, checkIntervalDays: n }).success).toBe(false);
  });
});
