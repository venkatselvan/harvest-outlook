import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {SeasonReport, TodayView} from '@harvest/contracts';
import {farmBody, login, setupHarness, type Client, type Harness} from './helpers';
import {istToday} from '../src/services/scouting/issues';
import {addDays} from '../src/services/scouting/schedule';
import {insertFact} from '../src/journal/repository';
import {deterministicOverview, overviewFacts} from '../src/services/today/overview';

/**
 * Review fixes of the field operations round (privacy of the overview facts, fromFactId, recheck on a closed issue, location
 * without a boundary, check issue ids, replay mode, cycle attribution of report entries). SYNTHETIC: farms, fields, cycles,
 * issues and journal facts are invented test data; runtime mode is synthetic and no provider is called.
 */
const TODAY = istToday();
const d = (n: number) => addDays(TODAY, n);
const rect = (x0: number, y0: number, x1: number, y1: number) => ({type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]});
const BOUNDARY = rect(76.25, 13.25, 76.252, 13.251);
const FIELDS = [
  {id: 'north', name: 'North strip', boundary: rect(76.25, 13.25, 76.251, 13.251)},
  {id: 'south', name: 'South strip', boundary: rect(76.251, 13.25, 76.252, 13.251)},
];
const CYCLES = [
  {id: 'cycle-north', cropId: 'maize', cropName: 'Maize', sowingDate: d(-20), establishmentDate: d(-20), establishmentMethod: 'direct_sowing', stage: 'growing', fieldId: 'north'},
  {id: 'cycle-south', cropId: 'maize', cropName: 'Maize', sowingDate: d(-5), establishmentDate: d(-5), establishmentMethod: 'direct_sowing', stage: 'growing', fieldId: 'south'},
];
const NO_CARE = {cropId: 'unlisted-test-crop', cropName: 'Test millet'};
const SECRET = 'Zebra-stripe mould near the well';

let h: Harness, a: Client, b: Client, farmId: string, ownerId: string;
const base = (id = farmId) => `/api/v1/farms/${id}`;
const issue = (clientEntryId: string, over: Record<string, unknown> = {}) => ({clientEntryId, fieldId: 'north', observedOn: d(-2), category: 'pest', severity: 'low', title: 'Holes in leaves', ...over});
const post = (path: string, payload: unknown, c: Client = a) => c.call('POST', `${base()}${path}`, {payload});
const err = (res: {statusCode: number; json: () => {error?: {code: string; message: string}}}) => [res.statusCode, res.json().error?.code] as const;

async function newFarm(workspace: Record<string, unknown>): Promise<string> {
  const id = (await a.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id as string;
  const put = await a.call('PUT', `${base(id)}/workspace`, {payload: {expectedVersion: 0, previousHarvest: {status: 'unknown'}, rotationPlans: [], checkIntervalDays: 7, ...workspace}});
  expect(put.statusCode, put.body).toBe(200);
  return id;
}

beforeAll(async () => {
  h = await setupHarness();
  a = await login(h.app);
  b = await login(h.app);
  farmId = await newFarm({boundary: BOUNDARY, cycles: CYCLES, fields: FIELDS});
  ownerId = (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
}, 60_000);
afterAll(async () => h?.close());

describe('S1: farmer-written issue titles stay out of the overview facts and points', () => {
  it('a recheck due today is the next step in the view, yet the overview says only "an issue you logged"', async () => {
    const id = await newFarm({boundary: BOUNDARY, cycles: [{...CYCLES[0]!, ...NO_CARE, id: 'fresh', sowingDate: TODAY, establishmentDate: TODAY}], fields: FIELDS});
    const made = await a.call('POST', `${base(id)}/issues`, {payload: issue('rvw-s1-issue', {title: SECRET, detail: SECRET, observedOn: TODAY})});
    expect(made.statusCode, made.body).toBe(201);
    const resp = await a.call('POST', `${base(id)}/issues/${made.json().data.id}/events`, {payload: {clientEntryId: 'rvw-s1-resp', occurredOn: TODAY, kind: 'response_recorded', response: {method: 'cultural', description: 'Cleared the bed', recheckOn: TODAY}}});
    expect(resp.statusCode, resp.body).toBe(201);
    const view = TodayView.parse((await a.call('GET', `${base(id)}/today?fieldId=north`)).json().data);
    // The view (shown in the web) may keep the issue title; the model-bound text may not.
    expect(view.nextAction).toMatchObject({kind: 'field_check', title: `Recheck: ${SECRET}`, status: 'due'});
    expect(view.nextAction!.detail ?? '').not.toContain(SECRET);
    const set = overviewFacts(view, {overdueChecks: []});
    expect(set).not.toBeNull();
    const next = set!.facts.find((f) => f.id === 'next')!;
    expect(next.text).toMatch(/^Next step: Recheck an issue you logged, due /);
    const everything = JSON.stringify([set, deterministicOverview(set!)]);
    expect(everything).not.toMatch(/zebra/i);
    expect(everything).not.toMatch(/mould/i);
    expect(deterministicOverview(set!).points.find((p) => p.kind === 'do_now')!.text).toMatch(/^Do next: Recheck an issue you logged, due /);
  });

  it('an interval check is "Walk the field: <crop>" without the field name', async () => {
    const id = await newFarm({boundary: BOUNDARY, cycles: [{...CYCLES[0]!, ...NO_CARE, id: 'walk', sowingDate: d(-7), establishmentDate: d(-7)}], fields: FIELDS});
    const view = TodayView.parse((await a.call('GET', `${base(id)}/today?fieldId=north`)).json().data);
    expect(view.nextAction).toMatchObject({kind: 'field_check', title: 'Walk the field: Test millet on North strip'});
    const set = overviewFacts(view, {overdueChecks: []})!;
    expect(set.facts.find((f) => f.id === 'next')!.text).toMatch(/^Next step: Walk the field: Test millet, due /);
    expect(JSON.stringify(set)).not.toContain('North strip');
  });
});

describe('S2: fromFactId must be an accepted observed_issue fact of this farm and mode', () => {
  const entryWithFacts = async (c: Client, onFarm: string, clientEntryId: string, facts: {field: string; accepted: boolean}[]) => {
    const r = await c.call('POST', '/api/v1/journal', {payload: {clientEntryId, farmId: onFarm, observedOn: d(-1), note: 'Holes near the gate', activity: 'observation'}});
    expect(r.statusCode, r.body).toBe(201);
    const entryId = r.json().data.entry.id as string;
    const owner = (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [onFarm])).rows[0]!.owner_id;
    const ids: string[] = [];
    for (const f of facts) {
      ids.push(await insertFact(h.pool, f.accepted
        ? {ownerId: owner, entryId, field: f.field, value: 'pest', unit: null, kind: 'confirmed', source: 'farmer', evidenceState: 'farmer_reported', requiresConfirmation: false, confirmedAt: new Date()}
        : {ownerId: owner, entryId, field: f.field, value: 'pest', unit: null, kind: 'proposed', source: 'ai', evidenceState: 'derived', requiresConfirmation: true}));
    }
    return {entryId, ids};
  };

  it('accepts an accepted observed_issue fact and stores it', async () => {
    const {ids} = await entryWithFacts(a, farmId, 'rvw-s2-entry-ok', [{field: 'observed_issue', accepted: true}]);
    const res = await post('/issues', issue('rvw-s2-issue-ok', {fromFactId: ids[0]}));
    expect(res.statusCode, res.body).toBe(201);
    expect((await h.pool.query('SELECT from_fact_id FROM field_issues WHERE client_entry_id=$1', ['rvw-s2-issue-ok'])).rows[0].from_fact_id).toBe(ids[0]);
  });

  it('refuses another fact key, an unaccepted suggestion, another farm\'s fact and a fact of another mode (400); another owner\'s is 404', async () => {
    const before = Number((await h.pool.query('SELECT count(*) FROM field_issues')).rows[0].count);
    const mine = await entryWithFacts(a, farmId, 'rvw-s2-entry-bad', [{field: 'observed_issue', accepted: false}, {field: 'observed_issue_note', accepted: true}]);
    const activity = (await h.pool.query<{id: string}>(`SELECT id FROM journal_facts WHERE entry_id=$1 AND fact_key='activity'`, [mine.entryId])).rows[0]!.id;
    for (const [n, fromFactId, text] of [[1, activity, /observed_issue fact/], [2, mine.ids[1]!, /observed_issue fact/], [3, mine.ids[0]!, /accepted/]] as const) {
      const res = await post('/issues', issue(`rvw-s2-issue-bad-${n}`, {fromFactId}));
      expect(err(res), res.body).toEqual([400, 'validation_error']);
      expect(res.json().error.message).toMatch(text);
    }
    const other = await newFarm({boundary: null, cycles: []});
    const elsewhere = await entryWithFacts(a, other, 'rvw-s2-entry-other-farm', [{field: 'observed_issue', accepted: true}]);
    const wrongFarm = await post('/issues', issue('rvw-s2-issue-farm', {fromFactId: elsewhere.ids[0]}));
    expect(err(wrongFarm)).toEqual([400, 'validation_error']);
    // An entry of another runtime mode (rows are immutable, so it is inserted that way).
    const liveEntry = (await h.pool.query<{id: string}>(
      `INSERT INTO journal_entries (owner_id, farm_id, client_entry_id, status, entry_date, text_body, language, activity, mode, payload_hash, processing_status)
       VALUES ($1,$2,'rvw-s2-entry-live','final',$3::date,'Live-mode entry','en','observation','live','h','submitted') RETURNING id`, [ownerId, farmId, d(-1)])).rows[0]!.id;
    const live = {ids: [await insertFact(h.pool, {ownerId, entryId: liveEntry, field: 'observed_issue', value: 'pest', unit: null, kind: 'confirmed', source: 'farmer', evidenceState: 'farmer_reported', requiresConfirmation: false, confirmedAt: new Date()})]};
    expect(err(await post('/issues', issue('rvw-s2-issue-mode', {fromFactId: live.ids[0]})))).toEqual([400, 'validation_error']);
    const bFarm = (await b.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id as string;
    const theirs = await entryWithFacts(b, bFarm, 'rvw-s2-entry-b', [{field: 'observed_issue', accepted: true}]);
    expect(err(await post('/issues', issue('rvw-s2-issue-b', {fromFactId: theirs.ids[0]})))).toEqual([404, 'not_found']);
    expect(Number((await h.pool.query('SELECT count(*) FROM field_issues')).rows[0].count)).toBe(before);
  });
});

describe('S3 and N3 and N4: events and check completions', () => {
  it('S3: a recheck date on a resolved or dismissed issue is refused until the issue is reopened', async () => {
    const made = await post('/issues', issue('rvw-s3-issue'));
    const id = made.json().data.id as string;
    const withRecheck = (clientEntryId: string) => ({clientEntryId, occurredOn: TODAY, kind: 'response_recorded', response: {method: 'cultural', description: 'Cleared the bed', recheckOn: d(2)}});
    expect((await post(`/issues/${id}/events`, {clientEntryId: 'rvw-s3-res', occurredOn: TODAY, kind: 'status_changed', status: 'resolved'})).statusCode).toBe(201);
    const refused = await post(`/issues/${id}/events`, withRecheck('rvw-s3-r1'));
    expect(err(refused)).toEqual([400, 'validation_error']);
    expect(refused.json().error.message).toBe('Reopen the issue before scheduling a recheck');
    // A response without a recheck date stays allowed on a closed issue; nothing was written by the refusal.
    const plain = await post(`/issues/${id}/events`, {clientEntryId: 'rvw-s3-r2', occurredOn: TODAY, kind: 'response_recorded', response: {method: 'cultural', description: 'Noted what worked'}});
    expect(plain.statusCode, plain.body).toBe(201);
    expect(plain.json().data).toMatchObject({status: 'resolved', recheckOn: null});
    expect((await h.pool.query(`SELECT count(*) FROM field_issue_events WHERE client_entry_id='rvw-s3-r1'`)).rows[0].count).toBe('0');
    expect((await post(`/issues/${id}/events`, {clientEntryId: 'rvw-s3-open', occurredOn: TODAY, kind: 'status_changed', status: 'open'})).statusCode).toBe(201);
    const ok = await post(`/issues/${id}/events`, withRecheck('rvw-s3-r3'));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().data).toMatchObject({status: 'open', recheckOn: d(2)});
    // Dismissed behaves like resolved.
    expect((await post(`/issues/${id}/events`, {clientEntryId: 'rvw-s3-dis', occurredOn: TODAY, kind: 'status_changed', status: 'dismissed'})).statusCode).toBe(201);
    expect(err(await post(`/issues/${id}/events`, withRecheck('rvw-s3-r4')))).toEqual([400, 'validation_error']);
  });

  it('N3: a completed check may list only issues of its own field or farm-wide ones that exist on the farm', async () => {
    const southIssue = (await post('/issues', issue('rvw-n3-south', {fieldId: 'south', title: 'South holes'}))).json().data.id as string;
    const northIssue = (await post('/issues', issue('rvw-n3-north', {title: 'North holes'}))).json().data.id as string;
    const listed = await a.call('GET', `${base()}/checks?fieldId=north`);
    const checkId = (listed.json().data.checks as {id: string; kind: string; status: string}[]).find((c) => c.kind === 'interval' && c.status !== 'completed')!.id;
    const complete = (clientEntryId: string, issueIds: string[]) => post('/checks/complete', {clientEntryId, checkId, completedOn: TODAY, result: 'issues_found', issueIds});
    const wrongField = await complete('rvw-n3-c1', [southIssue]);
    expect(err(wrongField), wrongField.body).toEqual([400, 'validation_error']);
    expect(err(await complete('rvw-n3-c2', ['11111111-1111-4111-8111-111111111111']))).toEqual([404, 'not_found']);
    expect(err(await complete('rvw-n3-c3', [northIssue, southIssue]))).toEqual([400, 'validation_error']);
    const ok = await post('/checks/complete', {clientEntryId: 'rvw-n3-c4', checkId, completedOn: TODAY, result: 'issues_found', issueIds: [northIssue]});
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('N4: replaying an issue event whose issue is not of this farm and mode is a conflict, not a stale success', async () => {
    const made = await post('/issues', issue('rvw-n4-issue'));
    const id = made.json().data.id as string;
    const ev = {clientEntryId: 'rvw-n4-note', occurredOn: TODAY, kind: 'note_added', note: 'Still there'};
    expect((await post(`/issues/${id}/events`, ev)).statusCode).toBe(201);
    expect((await post(`/issues/${id}/events`, ev)).statusCode).toBe(200);
    await h.pool.query(`UPDATE field_issues SET mode='live' WHERE id=$1`, [id]);
    expect(err(await post(`/issues/${id}/events`, ev))).toEqual([409, 'idempotency_conflict']);
    await h.pool.query(`UPDATE field_issues SET mode='synthetic' WHERE id=$1`, [id]);
  });
});

describe('S4: a location needs a drawn farm boundary', () => {
  it('is 400 location_outside_boundary with the draw-first message; without a location nothing changes', async () => {
    const id = await newFarm({boundary: null, cycles: [{...CYCLES[0]!, id: 'plain', fieldId: undefined}]});
    const res = await a.call('POST', `${base(id)}/issues`, {payload: issue('rvw-s4-loc', {fieldId: undefined, location: {lat: 13.2505, lon: 76.2505}})});
    expect(err(res)).toEqual([400, 'location_outside_boundary']);
    expect(res.json().error.message).toBe('Draw the farm boundary first, then mark a location');
    expect((await a.call('POST', `${base(id)}/issues`, {payload: issue('rvw-s4-none', {fieldId: undefined})})).statusCode).toBe(201);
  });
});

describe('S5: season report entries follow the cycle the entry names', () => {
  it('an issue entry on field A\'s cycle dated inside both windows is in A\'s report and CSV only', async () => {
    const id = await newFarm({boundary: BOUNDARY, cycles: CYCLES, fields: FIELDS});
    // d(-2) lies in both windows (north from d(-20), south from d(-5)); the date rule alone would give it to the later-started south crop.
    const made = await a.call('POST', `${base(id)}/issues`, {payload: issue('rvw-s5-issue', {title: 'North edge holes', observedOn: d(-2)})});
    expect(made.statusCode, made.body).toBe(201);
    const plain = await a.call('POST', '/api/v1/journal', {payload: {clientEntryId: 'rvw-s5-plain-note', farmId: id, observedOn: d(-2), activity: 'other', note: 'Plain note by date'}});
    expect(plain.statusCode, plain.body).toBe(201);
    const read = async (cycleId: string) => {
      const json = SeasonReport.parse((await a.call('GET', `${base(id)}/season-report?cycleId=${cycleId}`)).json().data);
      const csv = (await a.call('GET', `${base(id)}/season-report.csv?cycleId=${cycleId}`)).body;
      return {notes: json.entries.map((e) => e.note ?? ''), csv, issues: json.issues.map((i) => i.title)};
    };
    const north = await read('cycle-north'), south = await read('cycle-south');
    expect(north.notes.some((n) => n.includes('North edge holes'))).toBe(true);
    expect(south.notes.some((n) => n.includes('North edge holes'))).toBe(false);
    expect(north.issues).toEqual(['North edge holes']);
    expect(south.issues).toEqual([]);
    // The CSV carries the entry (and the issue row) for A only.
    expect(north.csv).toContain('North edge holes');
    expect(south.csv).not.toContain('North edge holes');
    // An entry without a cycle fact still goes by date, to the crop that started last.
    expect(north.notes).not.toContain('Plain note by date');
    expect(south.notes).toContain('Plain note by date');
  });
});
