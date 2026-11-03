import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FarmAlerts, type FarmWorkspace } from '@harvest/contracts';
import { setupHarness, login, farmBody, ORIGIN, type Harness, type Client } from './helpers';
import { addDays, alertFingerprint, istDate, listAlerts, normalizeUrl, persistAlerts, structuredAlerts, type AlertDraft } from '../src/services/today/alerts';
import { canonicalJson, sha256Hex } from '../src/services/hash';
import { PC_ORIGIN } from '../src/providers/sentinel2';
import { fakePlanetary, type FakeScene } from './fixtures/sentinel2/fake-provider';
import type { MonitoringSnapshot } from '../src/services/monitoring';
import { createMonitorHandler, SATELLITE_MONITOR_MAX_FIELDS } from '../src/worker/handlers/monitoring';
import { ndviSeries } from '../src/services/today/ndvi';
import { Budget } from '../src/services/budget';
import { enqueue } from '../src/services/jobs';

/**
 * Per-field alerts (FIELDS_MULTICROP_SOIL_SPEC.md 12.4). The sourced crop-threat window is a SYNTHETIC research fixture (the
 * stored research has none yet); farms, forecasts and satellite scenes are synthetic test data; no network, no model.
 */
const research = vi.hoisted(() => ({
  value: {
    crops: [{ cropId: 'maize', seasonalRisks: [{ id: 'faw', title: 'Fall armyworm scouting window', anchor: 'sowing', startDay: 25, endDay: 45, sourceRefs: [{ sourceId: 's1', locator: 'p. 3' }] }] }],
    sources: [{ id: 's1', url: 'https://example.test/maize-guide', publisher: 'Example University', title: 'Maize guide', retrievedAt: '2026-10-20T00:00:00Z' }],
  },
}));
vi.mock('../src/services/focused-crops', async (orig) => ({ ...(await orig<typeof import('../src/services/focused-crops')>()), focusedResearch: async () => research.value }));
// The real series reader, observed: which fields the monitor reads, in which order.
vi.mock('../src/services/today/ndvi', async (orig) => { const m = await orig<typeof import('../src/services/today/ndvi')>(); return { ...m, ndviSeries: vi.fn(m.ndviSeries) }; });

const ASOF = '2026-11-01T06:00:00Z';
const rect = (x0: number, y0: number, x1: number, y1: number) => ({ type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] as [number, number][][] });
const FARM = rect(76.249, 13.2495, 76.251, 13.2505);
const FIELDS = [{ id: 'west', name: 'West strip', boundary: rect(76.249, 13.2495, 76.2498, 13.2505) }, { id: 'east', name: 'East strip', boundary: rect(76.2498, 13.2495, 76.251, 13.2505) }];
const HASSAN = { districtName: 'Hassan', stateId: 'IN-KA', precision: 'approximate', lat: 13.25, lon: 76.25 };
const workspace = (over: Partial<FarmWorkspace> = {}): FarmWorkspace => ({ farmId: randomUUID(), version: 1, updatedAt: null, boundary: null, previousHarvest: { status: 'unknown' }, cycles: [], rotationPlans: [], fields: [], ...over });
const day = (date: string, rainMm: number) => ({ date, rainMm, tMinC: 18, tMaxC: 28, et0Mm: 3 });
const snapshot = (days: ReturnType<typeof day>[]): MonitoringSnapshot => ({
  mode: 'live', farmId: randomUUID(), checkedAt: ASOF,
  weather: { status: 'fresh', reason: null, issuedAt: '2026-11-01T01:00:00Z', attribution: 'Open-Meteo', point: { lat: 13, lon: 76 }, coordinateBasis: 'farm_location', days },
  market: { status: 'unavailable', reason: null, products: [] }, meta: { status: 'available', reason: null, automatic: false },
});
const maize = (id: string, fieldId?: string, sowingDate = '2026-10-01') => ({ id, cropId: 'maize', sowingDate, stage: 'growing', ...(fieldId ? { fieldId } : {}) }) as FarmWorkspace['cycles'][number];

describe('structured alerts per cycle (code only)', () => {
  it('a crop-threat alert carries the fieldId of its cycle; a cycle recorded without a field stays farm-wide; weather alerts never carry a field', () => {
    const ws = workspace({ cycles: [maize('c-west', 'west'), maize('c-east', 'east'), maize('c-legacy'), { ...maize('c-done', 'west', '2026-06-01'), stage: 'harvested', harvestDate: '2026-09-20' } as FarmWorkspace['cycles'][number]] });
    const { alerts } = structuredAlerts(snapshot([day('2026-11-02', 120)]), ws, [], ASOF, research.value);
    const threats = alerts.filter((a) => a.type === 'crop_threat');
    expect(threats.map((a) => a.fieldId)).toEqual(['west', 'east', undefined]);
    expect(threats.map((a) => 'fieldId' in a)).toEqual([true, true, false]);
    // Same crop, same window, same source: only the field tells the alerts apart.
    expect(new Set(threats.map((a) => [a.title, a.source.url, a.validFrom].join('|'))).size).toBe(1);
    expect(new Set(threats.map(alertFingerprint)).size).toBe(3);
    const rain = alerts.filter((a) => a.type === 'weather');
    expect(rain.length).toBeGreaterThan(0);
    expect(rain.every((a) => !('fieldId' in a))).toBe(true);
  });

  it('the fingerprint of a farm-wide alert is unchanged (stored rows keep matching); a field adds itself to the identity', () => {
    const d: AlertDraft = { type: 'weather', severity: 'watch', origin: 'rule', title: 'Heavy Rain in the forecast', detail: 'x', source: { name: 'Open-Meteo', url: 'https://open-meteo.com/', date: '2026-11-01' }, validFrom: '2026-11-03', validTo: '2026-11-04', suggestedStep: null };
    expect(alertFingerprint(d)).toBe(sha256Hex(canonicalJson(['weather', 'heavy rain in the forecast', normalizeUrl('https://open-meteo.com/'), '2026-11-03'])));
    expect(alertFingerprint({ ...d, fieldId: 'west' })).not.toBe(alertFingerprint(d));
    expect(alertFingerprint({ ...d, fieldId: 'west' })).not.toBe(alertFingerprint({ ...d, fieldId: 'east' }));
    expect(alertFingerprint({ ...d, fieldId: 'west' })).toBe(alertFingerprint({ ...d, fieldId: 'west', ...({ detail: 'other', severity: 'warning' } as object) }));
  });
});

// ------------------------------------------------------------------------------------------------ database tests
let h: Harness, owner: Client, stranger: Client;
beforeAll(async () => { h = await setupHarness(); owner = await login(h.app); stranger = await login(h.app); }, 60_000);
afterAll(async () => h?.close());
const ownerOf = async (farmId: string) => (await h.pool.query('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0].owner_id as string;
const recent = (n: number) => istDate(new Date(Date.now() - n * 86_400_000));
const createFarm = async (c: Client = owner) => (await c.call('POST', '/api/v1/farms', { payload: farmBody({ facts: {}, location: HASSAN }) })).json().data.id as string;
async function farmWith(fields: unknown[], cycles: unknown[], boundary: unknown = FARM) {
  const id = await createFarm();
  const put = await owner.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { expectedVersion: 0, boundary, fields, previousHarvest: { status: 'unknown' }, cycles, rotationPlans: [] } });
  expect(put.statusCode, put.body).toBe(200);
  await h.pool.query('UPDATE farm_monitors SET meta_enabled=false WHERE farm_id=$1', [id]); // no news review here
  return id;
}

describe('alert rows, listing and the alerts route per field', () => {
  const draft = (over: Partial<AlertDraft> = {}): AlertDraft => ({ type: 'crop_threat', severity: 'watch', origin: 'rule', title: 'Fall armyworm scouting window', detail: 'Calendar window.', source: { name: 'Example University: Maize guide', url: 'https://example.test/maize-guide', date: '2026-10-20' }, validFrom: '2026-10-26', validTo: '2026-11-15', suggestedStep: null, ...over });
  const rain = (): AlertDraft => ({ type: 'weather', severity: 'watch', origin: 'rule', title: 'Heavy rain in the forecast', detail: '62 mm.', source: { name: 'Open-Meteo', url: 'https://open-meteo.com/', date: '2026-11-01' }, validFrom: '2026-11-03', validTo: '2026-11-05', suggestedStep: null });

  it('stores the field per alert, keeps two fields\' alerts apart, updates in place on a repeat, and lists field plus farm-wide alerts for one field', async () => {
    const id = await farmWith(FIELDS, []);
    const ownerId = await ownerOf(id);
    expect(await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ fieldId: 'west' }), draft({ fieldId: 'east' }), draft(), rain()])).toEqual({ inserted: 4, updated: 0 });
    expect(await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ fieldId: 'west', detail: 'Updated.' }), draft()])).toEqual({ inserted: 0, updated: 2 }); // the batch also names the farm-wide twin, so it is not read as a legacy row
    expect((await h.pool.query<{ field_id: string | null }>("SELECT field_id FROM farm_alerts WHERE farm_id=$1 AND type='crop_threat' ORDER BY field_id NULLS LAST", [id])).rows.map((r) => r.field_id)).toEqual(['east', 'west', null]);
    expect((await h.pool.query("SELECT count(DISTINCT fingerprint) AS n FROM farm_alerts WHERE farm_id=$1", [id])).rows[0].n).toBe('4');
    const all = FarmAlerts.parse(await listAlerts(h.pool, ownerId, id, 'synthetic', ASOF));
    expect(all.alerts).toHaveLength(4);
    const west = FarmAlerts.parse(await listAlerts(h.pool, ownerId, id, 'synthetic', ASOF, { fieldId: 'west' })).alerts;
    expect(west.map((a) => [a.type, a.fieldId ?? null, a.scope]).sort()).toEqual([['crop_threat', 'west', 'field'], ['crop_threat', null, 'farm'], ['weather', null, 'farm']].sort());
    expect(west.find((a) => a.fieldId === 'west')!.detail).toBe('Updated.');
    const east = (await listAlerts(h.pool, ownerId, id, 'synthetic', ASOF, { fieldId: 'east' })).alerts;
    expect(east.filter((a) => a.type === 'crop_threat').map((a) => a.fieldId ?? 'farm').sort()).toEqual(['east', 'farm']);
    expect(all.alerts.filter((a) => a.scope === 'farm').every((a) => a.fieldId === undefined)).toBe(true);
    await expect(listAlerts(h.pool, ownerId, id, 'synthetic', ASOF, { fieldId: 'north' })).rejects.toMatchObject({ statusCode: 404, code: 'field_not_found' });
  });

  it('a stored field-less row of the same alert is migrated to the field (keeping its dismissal) instead of duplicated; a remaining one is retired', async () => {
    const id = await farmWith(FIELDS, []);
    const ownerId = await ownerOf(id);
    const d = draft();
    const insertLegacy = async (dismissed: boolean) => h.pool.query(
      `INSERT INTO farm_alerts (owner_id, farm_id, mode, type, severity, origin, title, detail, source, valid_from, valid_to, fingerprint, field_id, dismissed_at)
       VALUES ($1,$2,'synthetic',$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,NULL,$12)`,
      [ownerId, id, d.type, d.severity, d.origin, d.title, d.detail, JSON.stringify(d.source), d.validFrom, d.validTo, alertFingerprint(d), dismissed ? new Date() : null]);
    await insertLegacy(true);
    expect(await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ fieldId: 'west' })])).toEqual({ inserted: 0, updated: 1 }); // reuses the row: no duplicate
    let stored = (await h.pool.query<{ field_id: string | null; fingerprint: string; dismissed: boolean }>('SELECT field_id, fingerprint, dismissed_at IS NOT NULL AS dismissed FROM farm_alerts WHERE farm_id=$1', [id])).rows;
    expect(stored).toEqual([{ field_id: 'west', fingerprint: alertFingerprint(draft({ fieldId: 'west' })), dismissed: true }]);
    // A second field with the same alert has no old row left to migrate: it is a new row; the first keeps its field.
    expect(await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ fieldId: 'west' }), draft({ fieldId: 'east' })])).toEqual({ inserted: 1, updated: 1 });
    // Old row AND a field row already present (the duplicate the first round-1 monitor run made): the old one is retired.
    await insertLegacy(false);
    await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ fieldId: 'east' })]);
    stored = (await h.pool.query('SELECT field_id, fingerprint, dismissed_at IS NOT NULL AS dismissed FROM farm_alerts WHERE farm_id=$1 ORDER BY field_id NULLS LAST', [id])).rows;
    expect(stored.map((r) => [r.field_id, r.dismissed])).toEqual([['east', false], ['west', true], [null, true]]);
    expect((await listAlerts(h.pool, ownerId, id, 'synthetic', ASOF)).alerts.filter((a) => a.scope === 'farm')).toEqual([]);
    // A farm-wide twin in the same batch (a cycle recorded without a field) is live, so it is neither migrated nor retired.
    const other = await farmWith(FIELDS, []);
    const otherOwner = await ownerOf(other);
    await persistAlerts(h.pool, otherOwner, other, 'synthetic', [draft()]);
    await persistAlerts(h.pool, otherOwner, other, 'synthetic', [draft({ fieldId: 'west' }), draft()]);
    expect((await h.pool.query('SELECT field_id, dismissed_at IS NOT NULL AS dismissed FROM farm_alerts WHERE farm_id=$1 ORDER BY field_id NULLS LAST', [other])).rows).toEqual([{ field_id: 'west', dismissed: false }, { field_id: null, dismissed: false }]);
  });

  it('GET /alerts?fieldId=: the field\'s alerts plus the farm-wide ones; 404 for an unknown field (also on a farm without fields), 400 for a malformed id, 404 for a stranger', async () => {
    const app = await h.make();
    const call = (c: Client, url: string) => app.inject({ method: 'GET', url, headers: { cookie: c.cookie, origin: ORIGIN } });
    const id = await farmWith(FIELDS, []);
    const ownerId = await ownerOf(id);
    await persistAlerts(h.pool, ownerId, id, 'synthetic', [draft({ fieldId: 'west', validFrom: recent(0), validTo: addDays(recent(0), 5) }), draft({ fieldId: 'east', validFrom: recent(0), validTo: addDays(recent(0), 5) }), { ...rain(), validFrom: recent(0), validTo: addDays(recent(0), 5) }]);
    const url = (q = '') => `/api/v1/farms/${id}/alerts${q}`;
    const west = await call(owner, url('?fieldId=west'));
    expect(west.statusCode, west.body).toBe(200);
    expect(west.json().data.alerts.map((a: { type: string; fieldId?: string; scope: string }) => [a.type, a.fieldId ?? null, a.scope]).sort()).toEqual([['crop_threat', 'west', 'field'], ['weather', null, 'farm']].sort());
    expect((await call(owner, url())).json().data.alerts).toHaveLength(3);
    const unknown = await call(owner, url('?fieldId=north'));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('field_not_found');
    const plain = await createFarm();
    expect((await call(owner, `/api/v1/farms/${plain}/alerts?fieldId=west`)).statusCode).toBe(404);
    expect((await call(owner, `/api/v1/farms/${plain}/alerts`)).statusCode).toBe(200);
    expect((await call(owner, url('?fieldId=a%20b'))).statusCode).toBe(400);
    expect((await call(owner, url('?field=west'))).statusCode).toBe(400);
    expect((await call(stranger, url('?fieldId=west'))).statusCode).toBe(404);
  });
});

describe('farm.monitor per field', () => {
  const ctx = { pool: undefined as never, heartbeat: async () => {}, isCancelled: async () => false };
  const job = async (ownerId: string, farmId: string) => ({ id: (await enqueue(h.pool, 'farm.monitor', { farmId }, ownerId, `t-${randomUUID()}`)).job.id, owner_id: ownerId, type: 'farm.monitor', attempt: 1, max_attempts: 1, payload: { farmId } });
  const weatherBody = () => JSON.stringify(JSON.parse(readFileSync(new URL('./fixtures/openmeteo/forecast_hassan.json', import.meta.url), 'utf8')).body);
  const s2Id = (date: string) => `S2B_MSIL2A_${date.replace(/-/g, '')}T052229_R062_T43PFQ_${date.replace(/-/g, '')}T090011`;
  const liveConfig = () => ({ ...h.config, RUNTIME_MODE: 'live' as const });
  const handlerFor = (scenes: FakeScene[]) => {
    const sat = fakePlanetary(scenes);
    const routed = vi.fn(async (url: string, init: RequestInit) => (String(url).startsWith(PC_ORIGIN) ? sat.fetchImpl(url, init as never) : new Response(weatherBody(), { status: 200 })));
    return { sat, handler: createMonitorHandler({ config: liveConfig(), pool: h.pool, budget: Budget.fromConfig(h.pool, h.config), fetchImpl: routed as unknown as typeof fetch }) };
  };
  const run = async (handler: ReturnType<typeof createMonitorHandler>, ownerId: string, id: string) => (await handler(await job(ownerId, id), { ...ctx, pool: h.pool })) as { status: string; alerts: { structured: number; satellite: number; notes: string[] } };
  const fieldCalls = () => vi.mocked(ndviSeries).mock.calls.map((c) => (c[3] as { fieldId?: string } | undefined)?.fieldId ?? null);
  const at = (n: number, field: FakeScene['field'], neighbourhood?: FakeScene['neighbourhood']): FakeScene => ({ id: s2Id(recent(n)), datetime: `${recent(n)}T05:22:29Z`, field, ...(neighbourhood ? { neighbourhood } : {}) });
  // Green-up, then a field-only fall on the latest clear scene (the scene set of today-alerts.test.ts).
  const dropScenes = () => [at(52, { ndvi: 0.3 }, { ndvi: 0.5 }), at(42, { ndvi: 0.45 }, { ndvi: 0.55 }), at(32, { ndvi: 0.6 }, { ndvi: 0.58 }), at(22, { ndvi: 0.7 }, { ndvi: 0.6 }), at(12, { ndvi: 0.72 }, { ndvi: 0.6 }), at(7, 'cloudy', { ndvi: 0.6 }), at(2, { ndvi: 0.5 }, { ndvi: 0.59 })];
  const rows = async (id: string, type: string) => (await h.pool.query<{ field_id: string | null; fingerprint: string }>('SELECT field_id, fingerprint FROM farm_alerts WHERE farm_id=$1 AND type=$2 ORDER BY field_id NULLS LAST', [id, type])).rows;

  it('crop-threat alerts of the daily run carry the field of their cycle, with a separate fingerprint per field; the farm-wide cycle stays farm-wide', async () => {
    const sown = recent(30);
    const id = await farmWith(FIELDS, [maize('c-west', 'west', sown), maize('c-east', 'east', sown), maize('c-legacy', undefined, sown)]);
    const ownerId = await ownerOf(id);
    const { handler } = handlerFor([]);
    const result = await run(handler, ownerId, id);
    expect(result.status).toBe('checked');
    const threats = await rows(id, 'crop_threat');
    expect(threats.map((r) => r.field_id)).toEqual(['east', 'west', null]);
    expect(new Set(threats.map((r) => r.fingerprint)).size).toBe(3);
    // Every stored alert that is not a crop threat or a satellite alert (weather, price, news) is farm-wide.
    expect((await h.pool.query("SELECT count(*) AS n FROM farm_alerts WHERE farm_id=$1 AND type NOT IN ('crop_threat','satellite') AND field_id IS NOT NULL", [id])).rows[0].n).toBe('0');
    // A second run updates in place: no new rows.
    await run(handler, ownerId, id);
    expect((await rows(id, 'crop_threat')).length).toBe(3);
    const listed = (await listAlerts(h.pool, ownerId, id, 'live', new Date().toISOString(), { fieldId: 'east' })).alerts.filter((a) => a.type === 'crop_threat');
    expect(listed.map((a) => a.fieldId ?? 'farm').sort()).toEqual(['east', 'farm']);
  });

  it('the next monitor run migrates a stored field-less crop-threat row of a cycle that gained a field: no duplicate, no "Farm-wide" leftover', async () => {
    const id = await farmWith(FIELDS, [maize('c-west', 'west', recent(30))]);
    const ownerId = await ownerOf(id);
    const { handler } = handlerFor([]);
    await run(handler, ownerId, id);
    // Put the row back as round 1 stored it: no field, the field-less fingerprint.
    const row = (await h.pool.query<{ id: string; title: string; source: { url: string }; valid_from: string; type: string }>("SELECT id, title, source, to_char(valid_from,'YYYY-MM-DD') valid_from, type FROM farm_alerts WHERE farm_id=$1 AND type='crop_threat'", [id])).rows[0]!;
    const legacy = alertFingerprint({ type: 'crop_threat', title: row.title, source: row.source, validFrom: row.valid_from });
    await h.pool.query('UPDATE farm_alerts SET field_id=NULL, fingerprint=$2 WHERE id=$1', [row.id, legacy]);
    await run(handler, ownerId, id);
    const after = await rows(id, 'crop_threat');
    expect(after).toHaveLength(1);
    expect(after[0]!.field_id).toBe('west');
    expect((await h.pool.query('SELECT id FROM farm_alerts WHERE id=$1', [row.id])).rowCount).toBe(1); // same row, migrated in place
  });

  it('the satellite check runs once per field with a current cycle, on its own polygon, and each drop alert names its field', async () => {
    const third = { id: 'north', name: 'North strip', boundary: rect(76.2498, 13.2503, 76.2502, 13.2505) };
    const fields = [{ ...FIELDS[0]!, boundary: rect(76.249, 13.2495, 76.2498, 13.2503) }, { ...FIELDS[1]!, boundary: rect(76.2502, 13.2495, 76.251, 13.2503) }, third];
    const id = await farmWith(fields, [maize('c-west', 'west', recent(70)), maize('c-east', 'east', recent(70))]);
    const ownerId = await ownerOf(id);
    await h.pool.query("DELETE FROM provider_cache WHERE provider='planetary-computer-stac'");
    vi.mocked(ndviSeries).mockClear();
    const { handler, sat } = handlerFor(dropScenes());
    const first = await run(handler, ownerId, id);
    expect(first.status).toBe('checked');
    expect(fieldCalls()).toEqual(['west', 'east']); // north has no crop: not read; no farm-level read on a farm with fields
    expect(first.alerts.notes.filter((n) => n.startsWith('satellite_check_skipped'))).toEqual([]);
    expect(sat.calls.length).toBeLessThanOrEqual(2 * 9);
    const sats = await rows(id, 'satellite');
    expect(sats.map((r) => r.field_id)).toEqual(['east', 'west']);
    expect(new Set(sats.map((r) => r.fingerprint)).size).toBe(2);
    expect(first.alerts.satellite).toBeGreaterThanOrEqual(2);
    // Stored scene statistics are kept per field polygon.
    expect(Number((await h.pool.query('SELECT count(DISTINCT polygon_hash) AS n FROM ndvi_scene_stats WHERE farm_id=$1', [id])).rows[0].n)).toBe(2);
    const west = (await listAlerts(h.pool, ownerId, id, 'live', new Date().toISOString(), { fieldId: 'west' })).alerts.filter((a) => a.type === 'satellite');
    expect(west.map((a) => a.fieldId)).toEqual(['west']);
    expect(west[0]).toMatchObject({ severity: 'watch', origin: 'rule', scope: 'field' });
  });

  it('with no field crop the check is skipped with a note; a farm without fields reads once on the farm polygon; a field with only a farm-wide cycle is read on its own polygon', async () => {
    const empty = await farmWith(FIELDS, []);
    vi.mocked(ndviSeries).mockClear();
    const none = await run(handlerFor([]).handler, await ownerOf(empty), empty);
    expect(fieldCalls()).toEqual([]);
    expect(none.alerts.notes).toContain('satellite_check_skipped:no_current_cycle');
    const plain = await farmWith([], [maize('c1', undefined, recent(60))], null);
    vi.mocked(ndviSeries).mockClear();
    await run(handlerFor([]).handler, await ownerOf(plain), plain);
    expect(fieldCalls()).toEqual([null]);
    // A cycle recorded for the whole farm before fields were drawn is the current cycle of every field (12.1): both are read.
    const legacy = await farmWith(FIELDS, [maize('c-legacy', undefined, recent(60))]);
    vi.mocked(ndviSeries).mockClear();
    await run(handlerFor([]).handler, await ownerOf(legacy), legacy);
    expect(fieldCalls()).toEqual(['west', 'east']);
  });

  it('stops at ten fields per run, in stored order, counting only fields with a current cycle, and notes how many were skipped', async () => {
    expect(SATELLITE_MONITOR_MAX_FIELDS).toBe(10);
    const xs = Array.from({ length: 14 }, (_, i) => Number((76.249 + i * 0.000142).toFixed(6)));
    const names = Array.from({ length: 13 }, (_, i) => `f${String(i + 1).padStart(2, '0')}`);
    const fields = names.map((n, i) => ({ id: n, name: `Field ${n}`, boundary: rect(xs[i]!, 13.2495, xs[i + 1]!, 13.2505) }));
    // f02 has no crop: 12 fields have one, so the 10 first of those are read and the last two are skipped.
    const cycles = names.filter((n) => n !== 'f02').map((n) => maize(`c-${n}`, n, recent(40)));
    const id = await farmWith(fields, cycles);
    vi.mocked(ndviSeries).mockClear();
    const result = await run(handlerFor([]).handler, await ownerOf(id), id);
    expect(result.status).toBe('checked');
    expect(fieldCalls()).toEqual(names.filter((n) => n !== 'f02').slice(0, 10));
    expect(fieldCalls()).toHaveLength(SATELLITE_MONITOR_MAX_FIELDS);
    expect(result.alerts.notes).toContain('satellite_check_skipped:field_limit:2');
  });
});
