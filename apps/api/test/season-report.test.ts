import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {SeasonReport} from '@harvest/contracts';
import {farmBody, login, setupHarness, type Client, type Harness} from './helpers';
import {istToday} from '../src/services/scouting/issues';
import {addDays} from '../src/services/scouting/schedule';
import {csvCell, issueTrend, mondayOf} from '../src/services/season-report';

/**
 * SYNTHETIC: farms, fields, cycles, entries, issues and alerts are invented test data; runtime mode is synthetic and no provider is
 * called. Dates are relative to the real IST date because the routes use the server clock.
 */
const TODAY = istToday();
const d = (n: number) => addDays(TODAY, n);
const rect = (x0: number, y0: number, x1: number, y1: number) => ({type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]});
const FIELDS = [
  {id: 'north', name: 'North strip', boundary: rect(76.25, 13.25, 76.251, 13.251)},
  {id: 'south', name: 'South strip', boundary: rect(76.251, 13.25, 76.252, 13.251)},
];
const CYCLES = [
  {id: 'prev-north', cropId: 'ragi', cropName: 'Ragi', sowingDate: d(-200), establishmentDate: d(-200), establishmentMethod: 'direct_sowing', stage: 'harvested', harvestDate: d(-110), fieldId: 'north'},
  {id: 'cycle-north', cropId: 'maize', cropName: 'Maize', sowingDate: d(-20), establishmentDate: d(-20), establishmentMethod: 'direct_sowing', stage: 'growing', fieldId: 'north'},
  {id: 'cycle-south', cropId: 'maize', cropName: 'Maize', sowingDate: d(-5), establishmentDate: d(-5), establishmentMethod: 'direct_sowing', stage: 'growing', fieldId: 'south'},
];

let h: Harness, a: Client, b: Client, farmId: string, plainFarmId: string, issueId: string;
const base = () => `/api/v1/farms/${farmId}`;
const report = async (query: string, c: Client = a) => c.call('GET', `${base()}/season-report${query}`);

/** Minimal RFC 4180 reader for the cells the report writes (every cell quoted, CRLF rows). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  return rows;
}

const entry = (clientEntryId: string, observedOn: string, over: Record<string, unknown> = {}) => a.call('POST', '/api/v1/journal', {payload: {clientEntryId, farmId, observedOn, ...over}});

beforeAll(async () => {
  h = await setupHarness();
  a = await login(h.app);
  b = await login(h.app);
  farmId = (await a.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id;
  const put = await a.call('PUT', `${base()}/workspace`, {payload: {expectedVersion: 0, boundary: rect(76.25, 13.25, 76.252, 13.251), previousHarvest: {status: 'unknown'}, cycles: CYCLES, rotationPlans: [], fields: FIELDS, checkIntervalDays: 7}});
  expect(put.statusCode, put.body).toBe(200);
  plainFarmId = (await a.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id;

  // Journal entries: two inside the north window, one before establishment, one inside the later-started south crop's window.
  expect((await entry('entry-irrigation-1', d(-10), {activity: 'irrigation', quantity: {value: 20, unit: 'mm'}, note: 'Canal water\nsecond line'})).statusCode).toBe(201);
  expect((await entry('entry-formula-001', d(-9), {activity: 'expense', expense: {amountInr: '1200', category: 'seed'}, note: `=HYPERLINK("http://example.invalid")${'x'.repeat(700)}`})).statusCode).toBe(201);
  expect((await entry('entry-before-0001', d(-30), {activity: 'other', note: 'Before this crop'})).statusCode).toBe(201);
  expect((await entry('entry-south-0001', d(-3), {activity: 'other', note: 'Belongs to the crop that started last'})).statusCode).toBe(201);

  // An issue with a response, a completed check (the first slot, d(-13), rolled forward to the latest slot on or before today), a care completion and alerts.
  const issue = await a.call('POST', `${base()}/issues`, {payload: {clientEntryId: 'issue-north-1', fieldId: 'north', observedOn: d(-8), category: 'pest', severity: 'medium', title: 'Holes in young leaves', detail: 'East edge'}});
  expect(issue.statusCode, issue.body).toBe(201);
  issueId = issue.json().data.id;
  const resp = await a.call('POST', `${base()}/issues/${issueId}/events`, {payload: {clientEntryId: 'issue-north-1-r', occurredOn: d(-7), kind: 'response_recorded', response: {method: 'mechanical', description: 'Hand-picked the worst plants', labelWaitDays: 0}}});
  expect(resp.statusCode, resp.body).toBe(201);
  const check = await a.call('POST', `${base()}/checks/complete`, {payload: {clientEntryId: 'check-north-0001', checkId: `check:cycle-north:${d(-6)}`, completedOn: d(-6), result: 'nothing_found'}});
  expect(check.statusCode, check.body).toBe(201);
  const care = await entry('entry-care-00001', d(-15), {activity: 'weeding', note: 'First weeding done'});
  await h.pool.query(`INSERT INTO farm_cycle_actions(owner_id,farm_id,cycle_id,action_key,client_entry_id,payload_hash,journal_entry_id,completed_on,mode,source_snapshot)
    SELECT owner_id, farm_id, 'cycle-north', 'weeding-1', 'care-client-0001', 'h', id, $2::date, mode, '{"task":{"title":"First weeding"}}'::jsonb FROM journal_entries WHERE id=$1`, [care.json().data.entry.id, d(-15)]);
  const alert = (title: string, from: string, to: string, fieldId: string | null, dismissed: boolean) => h.pool.query(
    `INSERT INTO farm_alerts(owner_id,farm_id,mode,type,severity,origin,title,detail,source,valid_from,valid_to,fingerprint,field_id,dismissed_at)
     SELECT owner_id, id, $1, 'weather', 'watch', 'rule', $2, 'Synthetic detail', '{"name":"Synthetic source","url":"https://example.invalid/a","date":"2026-01-01"}'::jsonb, $3::date, $4::date, $2, $5, ${dismissed ? 'now()' : 'NULL'} FROM farms WHERE id=$6`,
    [h.config.RUNTIME_MODE, title, from, to, fieldId, farmId]);
  await alert('Heavy rain expected', d(-14), d(-12), null, true);
  await alert('Old alert outside the period', d(-100), d(-90), null, false);
  await alert('South strip only', d(-14), d(-4), 'south', false);
}, 60_000);
afterAll(async () => h?.close());

describe('season report JSON', () => {
  it('holds the cycle\'s entries, issue with events, completed check, care completion and alert inside the period', async () => {
    const res = await report('?cycleId=cycle-north');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json().schemaVersion).toBe('1.0');
    const r = SeasonReport.parse(res.json().data);
    expect(r.farm).toMatchObject({id: farmId, name: 'North plot', state: 'IN-KL'});
    expect(r.field).toMatchObject({id: 'north', name: 'North strip'});
    expect(r.field!.areaHa).toBeGreaterThan(0);
    expect(r.cycle.id).toBe('cycle-north');
    expect(r.period).toEqual({from: d(-20), to: TODAY});
    // Entries: the same attribution as the Journal's season totals (the entry dated inside the later crop's window is not here; the entry before establishment neither).
    const notes = r.entries.map((e) => e.note);
    expect(notes).toContain('Canal water\nsecond line');
    expect(notes).not.toContain('Before this crop');
    expect(notes).not.toContain('Belongs to the crop that started last');
    expect(r.entries.find((e) => e.activity === 'irrigation')).toMatchObject({quantity: {value: 20, unit: 'mm'}, observedOn: d(-10)});
    expect(r.entries.find((e) => e.activity === 'expense')!.expense).toEqual({amountInr: '1200.00', category: 'seed'});
    expect(r.entries.map((e) => e.observedOn)).toEqual([...r.entries.map((e) => e.observedOn)].sort());
    // The issue, its events, the check and the care completion.
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({id: issueId, status: 'open', category: 'pest'});
    expect(r.issues[0]!.events.map((e) => e.kind)).toEqual(['reported', 'response_recorded']);
    expect(r.checks.map((c) => [c.id, c.status, c.completedOn])).toEqual([[`check:cycle-north:${d(-6)}`, 'completed', d(-6)]]);
    expect(r.careCompletions).toEqual([{taskId: 'weeding-1', title: 'First weeding', completedOn: d(-15)}]);
    // Only the alert valid inside the period for this field or the whole farm, dismissed one included.
    expect(r.alerts.map((x) => [x.title, x.dismissedAt !== null])).toEqual([['Heavy rain expected', true]]);
    expect(r.issueTrend).toEqual([{weekStart: mondayOf(d(-8)), counts: {pest: 1, disease: 0, weed: 0, water_stress: 0, nutrient: 0, weather_damage: 0, animal_damage: 0, other: 0}}]);
    expect(r.previousSeasons).toEqual([{cycleId: 'prev-north', cropName: 'Ragi', sowingDate: d(-200), harvestDate: d(-110), issueCount: 0, checksCompleted: 0}]);
    // Missing data is named, not hidden.
    expect(r.ndvi).toEqual([]);
    expect(r.limitations.join(' ')).toMatch(/satellite readings/i);
  });

  it('a harvested crop\'s period ends at harvest + 90 days or before the next crop starts', async () => {
    const r = SeasonReport.parse((await report('?cycleId=prev-north')).json().data);
    expect(r.period).toEqual({from: d(-200), to: d(-21)}); // harvest d(-110) + 90 = d(-20), capped the day before cycle-north starts
    expect(r.previousSeasons).toEqual([]);
    expect(r.limitations.join(' ')).toMatch(/No issues were recorded/);
    expect(r.entries.map((e) => e.note)).not.toContain('Canal water\nsecond line');
  });

  it('fieldId selects the field\'s current cycle; the later-started crop on another field owns the entry in its window', async () => {
    const south = SeasonReport.parse((await report('?fieldId=south')).json().data);
    expect(south.cycle.id).toBe('cycle-south');
    expect(south.entries.map((e) => e.note)).toEqual(['Belongs to the crop that started last']);
    expect(south.alerts.map((x) => x.title)).toEqual(['South strip only']);
    expect(south.issues).toEqual([]);
    const north = SeasonReport.parse((await report('?fieldId=north')).json().data);
    expect(north.cycle.id).toBe('cycle-north');
  });

  it('errors: cycle_not_found, field_required, field_not_found, a cycle on another field, another owner', async () => {
    const code = async (query: string, c: Client = a) => { const r = await report(query, c); return [r.statusCode, r.json().error?.code]; };
    expect(await code('?cycleId=nope')).toEqual([404, 'cycle_not_found']);
    expect(await code('')).toEqual([400, 'field_required']);
    expect(await code('?fieldId=west')).toEqual([404, 'field_not_found']);
    expect(await code('?cycleId=cycle-north&fieldId=south')).toEqual([404, 'cycle_not_found']);
    expect(await code('?cycleId=cycle-north', b)).toEqual([404, 'not_found']);
    expect(await code('?cycleId=cycle-north&bogus=1')).toEqual([400, 'validation_error']);
    expect((await h.app.inject({method: 'GET', url: `${base()}/season-report?cycleId=cycle-north`})).statusCode).toBe(401);
  });

  it('a farm without fields defaults to its current crop; without any crop it is cycle_not_found', async () => {
    const plain = `/api/v1/farms/${plainFarmId}`;
    expect((await a.call('GET', `${plain}/season-report`)).json().error.code).toBe('cycle_not_found');
    const put = await a.call('PUT', `${plain}/workspace`, {payload: {expectedVersion: 0, boundary: null, previousHarvest: {status: 'unknown'}, cycles: [{id: 'plain', cropId: 'maize', cropName: 'Maize', sowingDate: d(-9), establishmentDate: d(-9), establishmentMethod: 'direct_sowing', stage: 'growing'}], rotationPlans: []}});
    expect(put.statusCode, put.body).toBe(200);
    const r = SeasonReport.parse((await a.call('GET', `${plain}/season-report`)).json().data);
    expect([r.cycle.id, r.field, r.period.from]).toEqual(['plain', null, d(-9)]);
  });
});

describe('season report CSV', () => {
  it('has the header, one row per dated record, quoted cells, flattened newlines, a 500-character detail cap and a formula guard', async () => {
    const res = await a.call('GET', `${base()}/season-report.csv?cycleId=cycle-north`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="season-maize-${d(-20)}.csv"`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const [header, ...rows] = parseCsv(res.body);
    expect(header).toEqual(['date', 'kind', 'field', 'title', 'detail', 'category', 'severity', 'status', 'quantity', 'unit', 'amount_inr', 'source']);
    expect(res.body.split('\r\n')[0]).toBe('date,kind,field,title,detail,category,severity,status,quantity,unit,amount_inr,source');
    expect(rows.every((r) => r.length === 12)).toBe(true);
    expect(rows.map((r) => r[0])).toEqual([...rows.map((r) => r[0])].sort());
    const byKind = (k: string) => rows.filter((r) => r[1] === k);
    const irrigation = byKind('journal').find((r) => r[3] === 'irrigation')!;
    expect([irrigation[0], irrigation[4], irrigation[8], irrigation[9]]).toEqual([d(-10), 'Canal water second line', '20', 'mm']);
    const expense = byKind('journal').find((r) => r[3] === 'expense')!;
    expect(expense[4]).toHaveLength(500);
    expect(expense[4]!.startsWith(`'=HYPERLINK`)).toBe(true);
    expect([expense[5], expense[10], expense[11]]).toEqual(['expense: seed', '1200.00', 'farmer']);
    expect(byKind('issue')).toEqual([[d(-8), 'issue', 'North strip', 'Holes in young leaves', 'East edge', 'pest', 'medium', 'open', '', '', '', 'farmer']]);
    expect(byKind('issue_event').map((r) => [r[0], r[3], r[4], r[7]])).toEqual([[d(-7), 'Holes in young leaves: response recorded (mechanical)', 'Hand-picked the worst plants; label wait 0 days (farmer-entered)', '']]);
    expect(byKind('check').map((r) => [r[0], r[3], r[7]])).toEqual([[d(-6), 'Field check completed', 'completed']]);
    expect(byKind('care').map((r) => [r[0], r[3]])).toEqual([[d(-15), 'First weeding']]);
    expect(byKind('alert').map((r) => [r[0], r[3], r[7], r[11]])).toEqual([[d(-14), 'Heavy rain expected', 'dismissed', `Synthetic source (https://example.invalid/a, 2026-01-01)`]]);
    // Same selection rules and owner scoping as the JSON.
    expect((await a.call('GET', `${base()}/season-report.csv`)).json().error.code).toBe('field_required');
    expect((await a.call('GET', `${base()}/season-report.csv?cycleId=nope`)).json().error.code).toBe('cycle_not_found');
    expect((await b.call('GET', `${base()}/season-report.csv?cycleId=cycle-north`)).statusCode).toBe(404);
  });

  it('csvCell defuses formulas, doubles quotes, flattens newlines and caps length', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+91 98')).toBe(`"'+91 98"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('  =x')).toBe(`"'=x"`);
    expect(csvCell('say "hi"\r\nnext\nline')).toBe('"say ""hi"" next line"');
    expect(csvCell('x'.repeat(600), 500)).toHaveLength(502);
    expect(csvCell(`=${'x'.repeat(600)}`, 500)).toHaveLength(502); // the guard quote counts toward the cap
    expect(csvCell(null)).toBe('""');
    expect(csvCell(12.5)).toBe('"12.5"');
  });
});

describe('issue trend', () => {
  it('uses Monday weeks without gaps and zero-fills categories', () => {
    expect(mondayOf('2026-11-01')).toBe('2026-10-26'); // a Sunday
    expect(mondayOf('2026-11-02')).toBe('2026-11-02'); // a Monday
    const trend = issueTrend([{observedOn: '2026-10-28', category: 'pest'}, {observedOn: '2026-11-17', category: 'weed'}, {observedOn: '2026-11-18', category: 'weed'}]);
    expect(trend.map((w) => w.weekStart)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
    expect(trend.map((w) => w.counts.pest + w.counts.weed)).toEqual([1, 0, 0, 2]);
    expect(issueTrend([])).toEqual([]);
  });
});
