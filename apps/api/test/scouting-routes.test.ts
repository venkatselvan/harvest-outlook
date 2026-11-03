import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {CompleteCheckResult, FieldChecks, FieldIssue, FieldIssues, TodayView} from '@harvest/contracts';
import {farmBody, login, makeJpeg, setupHarness, upload, type Client, type Harness} from './helpers';
import {istToday} from '../src/services/scouting/issues';
import {addDays} from '../src/services/scouting/schedule';

/**
 * SYNTHETIC: farms, fields, cycles, photos and issues are invented test data; runtime mode is synthetic and no provider is
 * called. Dates are relative to the real IST date because the routes use the server clock.
 */
const TODAY = istToday();
const EST = addDays(TODAY, -7); // the first check (7-day default) is due today
const rect = (x0: number, y0: number, x1: number, y1: number) => ({type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]});
const BOUNDARY = rect(76.25, 13.25, 76.252, 13.251);
const FIELDS = [
  {id: 'north', name: 'North strip', boundary: rect(76.25, 13.25, 76.251, 13.251)},
  {id: 'south', name: 'South strip', boundary: rect(76.251, 13.25, 76.252, 13.251), checkIntervalDays: 10},
];
const CYCLE = {id: 'cycle-north', cropId: 'maize', cropName: 'Maize', sowingDate: EST, establishmentDate: EST, establishmentMethod: 'direct_sowing', stage: 'growing', fieldId: 'north'};

let h: Harness, a: Client, b: Client, farmId: string, plainFarmId: string, mediaId: string, issue: FieldIssue;
const base = () => `/api/v1/farms/${farmId}`;

beforeAll(async () => {
  h = await setupHarness();
  a = await login(h.app);
  b = await login(h.app);
  farmId = (await a.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id;
  const put = await a.call('PUT', `${base()}/workspace`, {payload: {expectedVersion: 0, boundary: BOUNDARY, previousHarvest: {status: 'unknown'}, cycles: [CYCLE], rotationPlans: [], fields: FIELDS, checkIntervalDays: 7}});
  expect(put.statusCode, put.body).toBe(200);
  expect(put.json().data.fields[1].checkIntervalDays).toBe(10);
  plainFarmId = (await a.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id;
  const up = await upload(a, await makeJpeg(), {farmId});
  expect(up.statusCode, up.body).toBe(201);
  mediaId = up.json().data.id;
}, 60_000);
afterAll(async () => h?.close());

const newIssue = (over: Record<string, unknown> = {}) => ({clientEntryId: 'issue-north-1', fieldId: 'north', observedOn: TODAY, category: 'pest', severity: 'medium', title: 'Holes in young leaves', detail: 'Seen along the east edge', location: {lat: 13.2505, lon: 76.2505}, mediaIds: [mediaId], photoMarks: [{mediaId, x: 0.4, y: 0.6, label: 'holes'}], ...over});

describe('scouting routes: issues', () => {
  it('validates field, location and media before writing anything', async () => {
    const count = async () => Number((await h.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count);
    const before = await count();
    const noField = await a.call('POST', `${base()}/issues`, {payload: newIssue({fieldId: undefined})});
    expect([noField.statusCode, noField.json().error.code]).toEqual([400, 'field_required']);
    const unknown = await a.call('POST', `${base()}/issues`, {payload: newIssue({fieldId: 'west'})});
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'field_not_found']);
    // Inside the farm but in the south strip, while the issue names the north strip.
    const outside = await a.call('POST', `${base()}/issues`, {payload: newIssue({location: {lat: 13.2505, lon: 76.2515}})});
    expect([outside.statusCode, outside.json().error.code]).toEqual([400, 'location_outside_boundary']);
    const offFarm = await a.call('POST', `${base()}/issues`, {payload: newIssue({location: {lat: 13.3, lon: 76.3}})});
    expect(offFarm.json().error.code).toBe('location_outside_boundary');
    const badMark = await a.call('POST', `${base()}/issues`, {payload: newIssue({photoMarks: [{mediaId: '11111111-1111-4111-8111-111111111111', x: 0, y: 0}]})});
    expect(badMark.statusCode).toBe(400);
    const future = await a.call('POST', `${base()}/issues`, {payload: newIssue({observedOn: addDays(TODAY, 2)})});
    expect(future.statusCode).toBe(400);
    // Another owner's media and another owner's farm are 404.
    const theirs = (await upload(b, await makeJpeg())).json().data.id;
    expect((await a.call('POST', `${base()}/issues`, {payload: newIssue({mediaIds: [theirs], photoMarks: []})})).statusCode).toBe(404);
    expect((await b.call('POST', `${base()}/issues`, {payload: newIssue()})).statusCode).toBe(404);
    expect(await count()).toBe(before);
  });

  it('creates the issue with its journal entry, replays the same payload and refuses a different one', async () => {
    const res = await a.call('POST', `${base()}/issues`, {payload: newIssue()});
    expect(res.statusCode, res.body).toBe(201);
    issue = FieldIssue.parse(res.json().data);
    expect(issue).toMatchObject({fieldId: 'north', cycleId: 'cycle-north', cropId: 'maize', cropName: 'Maize', status: 'open', scope: 'field', recheckOn: null, earliestHarvestOn: null, seenBefore: [], location: {lat: 13.2505, lon: 76.2505}});
    expect(issue.events.map((e) => e.kind)).toEqual(['reported']);
    const replay = await a.call('POST', `${base()}/issues`, {payload: newIssue()});
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(issue.id);
    const conflict = await a.call('POST', `${base()}/issues`, {payload: newIssue({title: 'Something else'})});
    expect([conflict.statusCode, conflict.json().error.code]).toEqual([409, 'idempotency_conflict']);
    const entry = (await h.pool.query('SELECT activity, text_body, media_ids FROM journal_entries WHERE id=$1', [issue.journalEntryId])).rows[0];
    expect(entry).toMatchObject({activity: 'observation', text_body: 'Pest on North strip: Holes in young leaves (severity medium). Seen along the east edge', media_ids: [mediaId]});
  });

  it('records a response with a label wait and a recheck date; the recheck appears in GET /checks', async () => {
    const ev = {clientEntryId: 'issue-north-1-resp', occurredOn: TODAY, kind: 'response_recorded', response: {method: 'product_applied', description: 'Sprayed what the shop gave', productName: 'Shop spray', labelWaitDays: 14, recheckOn: addDays(TODAY, 3)}};
    const res = await a.call('POST', `${base()}/issues/${issue.id}/events`, {payload: ev});
    expect(res.statusCode, res.body).toBe(201);
    const updated = FieldIssue.parse(res.json().data);
    expect(updated).toMatchObject({recheckOn: addDays(TODAY, 3), earliestHarvestOn: addDays(TODAY, 14), status: 'open'});
    expect(updated.events.map((e) => e.kind)).toEqual(['reported', 'response_recorded']);
    const text = (await h.pool.query('SELECT activity, text_body FROM journal_entries WHERE id=$1', [updated.events[1]!.journalEntryId])).rows[0];
    expect(text.activity).toBe('pest_check');
    expect(text.text_body).toMatch(/Product applied: Sprayed what the shop gave; product as you named it: Shop spray; label wait 14 days \(farmer-entered\)/);
    expect((await a.call('POST', `${base()}/issues/${issue.id}/events`, {payload: ev})).statusCode).toBe(200);
    expect((await a.call('POST', `${base()}/issues/${issue.id}/events`, {payload: {...ev, response: {...ev.response, description: 'Other'}}})).statusCode).toBe(409);
    expect((await a.call('POST', `${base()}/issues/${issue.id}/events`, {payload: {clientEntryId: 'issue-north-1-bad', occurredOn: TODAY, kind: 'status_changed'}})).statusCode).toBe(400);

    const checks = await a.call('GET', `${base()}/checks?fieldId=north`);
    expect(checks.statusCode, checks.body).toBe(200);
    const list = FieldChecks.parse(checks.json().data).checks;
    expect(list.find((c) => c.kind === 'recheck')).toMatchObject({id: `recheck:${issue.id}:${addDays(TODAY, 3)}`, issueId: issue.id, status: 'upcoming', fieldId: 'north'});
    expect(list.find((c) => c.kind === 'interval')).toMatchObject({id: `check:cycle-north:${TODAY}`, status: 'due', intervalDays: 7, cropName: 'Maize'});
    // Field required on a farm with fields; unknown field 404; another owner 404.
    expect((await a.call('GET', `${base()}/checks`)).json().error.code).toBe('field_required');
    expect((await a.call('GET', `${base()}/checks?fieldId=west`)).statusCode).toBe(404);
    expect((await b.call('GET', `${base()}/checks?fieldId=north`)).statusCode).toBe(404);
    expect((await b.call('GET', `${base()}/issues`)).statusCode).toBe(404);
    expect((await b.call('GET', `${base()}/issues/${issue.id}`)).statusCode).toBe(404);
  });

  it('completes the field check with issues found, replays it, refuses a conflicting replay and an unknown check', async () => {
    const body = {clientEntryId: 'check-north-1', checkId: `check:cycle-north:${TODAY}`, completedOn: TODAY, result: 'issues_found', issueIds: [issue.id], note: 'North edge only'};
    const res = await a.call('POST', `${base()}/checks/complete`, {payload: body});
    expect(res.statusCode, res.body).toBe(201);
    const out = CompleteCheckResult.parse(res.json().data);
    expect(out).toMatchObject({alreadyCompleted: false, check: {status: 'completed', completedOn: TODAY}});
    expect((await h.pool.query('SELECT activity, text_body FROM journal_entries WHERE id=$1', [out.journalEntryId])).rows[0]).toEqual({activity: 'pest_check', text_body: 'Field check on North strip: 1 issue(s) logged. North edge only'});
    const replay = await a.call('POST', `${base()}/checks/complete`, {payload: body});
    expect([replay.statusCode, replay.json().data.alreadyCompleted, replay.json().data.journalEntryId]).toEqual([200, true, out.journalEntryId]);
    expect((await a.call('POST', `${base()}/checks/complete`, {payload: {...body, note: 'changed'}})).json().error.code).toBe('idempotency_conflict');
    expect((await a.call('POST', `${base()}/checks/complete`, {payload: {...body, clientEntryId: 'check-north-x', checkId: 'check:cycle-north:2001-01-01'}})).statusCode).toBe(404);
    expect((await a.call('POST', `${base()}/checks/complete`, {payload: {...body, clientEntryId: 'check-north-f', completedOn: addDays(TODAY, 1)}})).statusCode).toBe(400);
    // The next interval check is anchored on the completion.
    const list = FieldChecks.parse((await a.call('GET', `${base()}/checks?fieldId=north`)).json().data).checks;
    expect(list.find((c) => c.kind === 'interval' && c.status !== 'completed')!.id).toBe(`check:cycle-north:${addDays(TODAY, 7)}`);
    expect(list.filter((c) => c.status === 'completed').map((c) => c.id)).toEqual([`check:cycle-north:${TODAY}`]);
  });

  it('lists issues with counts and seenBefore; the journal timeline shows the three entries', async () => {
    const second = await a.call('POST', `${base()}/issues`, {payload: newIssue({clientEntryId: 'issue-north-2', title: 'More holes', location: undefined, mediaIds: [], photoMarks: []})});
    expect(second.statusCode, second.body).toBe(201);
    expect(FieldIssue.parse(second.json().data).seenBefore.map((s) => s.issueId)).toEqual([issue.id]);
    const listed = FieldIssues.parse((await a.call('GET', `${base()}/issues?fieldId=north`)).json().data);
    expect(listed.counts).toEqual({open: 2, treating: 0, resolved: 0, dismissed: 0});
    const closed = await a.call('POST', `${base()}/issues/${issue.id}/events`, {payload: {clientEntryId: 'issue-north-1-done', occurredOn: TODAY, kind: 'status_changed', status: 'resolved'}});
    expect(closed.statusCode, closed.body).toBe(201);
    expect(closed.json().data).toMatchObject({status: 'resolved', recheckOn: null});
    const resolved = FieldIssues.parse((await a.call('GET', `${base()}/issues?status=resolved`)).json().data);
    expect(resolved.issues.map((i) => i.id)).toEqual([issue.id]);
    expect(resolved.counts).toMatchObject({open: 1, resolved: 1});
    // The recheck disappears once the issue is resolved.
    expect(FieldChecks.parse((await a.call('GET', `${base()}/checks?fieldId=north`)).json().data).checks.some((c) => c.kind === 'recheck')).toBe(false);
    const timeline = await a.call('GET', `${base()}/journal`);
    expect(timeline.statusCode, timeline.body).toBe(200);
    const texts = (timeline.json().data.entries as {textBody?: string | null; text?: string | null; activity: string | null}[]).map((e) => e.activity);
    expect(texts.filter((x) => x === 'observation')).toHaveLength(2);
    expect(texts.filter((x) => x === 'pest_check')).toHaveLength(2); // the response and the check completion
    expect(texts.filter((x) => x === 'other')).toHaveLength(1); // the status change
  });

  it('a farm without fields: farm-wide checks without a fieldId, issues without a field', async () => {
    const put = await a.call('PUT', `/api/v1/farms/${plainFarmId}/workspace`, {payload: {expectedVersion: 0, boundary: null, previousHarvest: {status: 'unknown'}, cycles: [{...CYCLE, id: 'plain', fieldId: undefined}], rotationPlans: []}});
    expect(put.statusCode, put.body).toBe(200);
    const checks = FieldChecks.parse((await a.call('GET', `/api/v1/farms/${plainFarmId}/checks`)).json().data).checks;
    expect(checks.map((c) => [c.id, c.scope, c.fieldId])).toEqual([[`check:plain:${TODAY}`, 'farm', null]]);
    const res = await a.call('POST', `/api/v1/farms/${plainFarmId}/issues`, {payload: newIssue({clientEntryId: 'issue-plain-1', fieldId: undefined, location: undefined, mediaIds: [], photoMarks: [], category: 'weed', title: 'Weeds between rows'})});
    expect(res.statusCode, res.body).toBe(201);
    expect(FieldIssue.parse(res.json().data)).toMatchObject({scope: 'farm', cycleId: 'plain'});
    expect('fieldId' in res.json().data).toBe(false);
  });
});

describe('Today view: field_check steps and the issues block', () => {
  it('lists the due field check of the described field and counts its open issues', async () => {
    const res = await a.call('GET', `${base()}/today?fieldId=north`);
    expect(res.statusCode, res.body).toBe(200);
    const view = TodayView.parse(res.json().data);
    const steps = view.upcoming.filter((s) => s.kind === 'field_check');
    // The check due today was completed today (listed as done); the next one is 7 days out.
    expect(steps.map((s) => [s.id, s.status])).toEqual([[`check:cycle-north:${addDays(TODAY, 7)}`, 'upcoming'], [`check:cycle-north:${TODAY}`, 'completed']]);
    expect(steps[0]).toMatchObject({title: 'Walk the field: Maize on North strip', careTask: null, alertId: null});
    expect(steps[0]!.fieldCheck!.checklist.filter((i) => i.kind === 'general')).toHaveLength(8);
    expect(view.issues).toMatchObject({open: 1, treating: 0});
    expect(view.issues!.latest.map((i) => i.title)).toEqual(['More holes']);
    // A field without issues and a farm-wide view without any keep the earlier shape (no issues key).
    const south = TodayView.parse((await a.call('GET', `${base()}/today?fieldId=south`)).json().data);
    expect(south.issues).toBeUndefined();
    expect(south.upcoming.some((s) => s.kind === 'field_check')).toBe(false); // no crop on the south strip
  });

  it('a recheck becomes a step titled with the issue', async () => {
    const res = await a.call('POST', `${base()}/issues`, {payload: newIssue({clientEntryId: 'issue-north-3', title: 'Yellow patch', category: 'nutrient', location: undefined, mediaIds: [], photoMarks: []})});
    const id = res.json().data.id as string;
    expect((await a.call('POST', `${base()}/issues/${id}/events`, {payload: {clientEntryId: 'issue-north-3-r', occurredOn: TODAY, kind: 'response_recorded', response: {method: 'nutrition', description: 'Added compost', recheckOn: addDays(TODAY, 2)}}})).statusCode).toBe(201);
    const view = TodayView.parse((await a.call('GET', `${base()}/today?fieldId=north`)).json().data);
    expect(view.upcoming.find((s) => s.issueId === id)).toMatchObject({kind: 'field_check', title: 'Recheck: Yellow patch', status: 'upcoming', dueFrom: addDays(TODAY, 2)});
    expect(view.issues).toMatchObject({open: 2});
  });
});
