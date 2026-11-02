import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {TodayView, type FarmWorkspace} from '@harvest/contracts';
import {setupHarness, login, testConfig, ORIGIN, type Harness, type Client} from './helpers';
import {fakePlanetary, type FakeScene} from './fixtures/sentinel2/fake-provider';
import {loadCatalogueIntoDb} from '../src/catalogue/load';
import {buildServer} from '../src/server';
import {currentCycle, todayView, type TodayViewDeps} from '../src/services/today/view';
import {boundaryPolygonHash, fieldImageBbox, ndviSeries} from '../src/services/today/ndvi';
import {boundaryMetrics} from '../src/services/workspace';
import {persistAlerts} from '../src/services/today/alerts';
import {farmBriefing} from '../src/agent/bindings/briefing';
import {Budget} from '../src/services/budget';
import {futureLookField, requestFutureLook} from '../src/services/today/future-look';
import {eachDate} from '../src/plans/weather';
import type {DailyWeather, WeatherSource} from '../src/plans/sources';

/** Fields inside a farm (FIELDS_MULTICROP_SOIL_SPEC.md sections 2 and 3). Every farm, scene, forecast and alert here is SYNTHETIC test data; no network. */
const NOW = new Date('2026-11-01T04:00:00Z');
const rect = (x0: number, y0: number, x1: number, y1: number) => ({type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] as [number, number][][]});
const FARM = rect(76.249, 13.2495, 76.251, 13.2505), WEST = rect(76.249, 13.2495, 76.25, 13.2505), EAST = rect(76.25, 13.2495, 76.251, 13.2505);
const FIELDS = [{id: 'west', name: 'West strip', boundary: WEST}, {id: 'east', name: 'East strip', boundary: EAST}];
const HASSAN = {districtId: 'IN-KA-hassan', stateId: 'IN-KA', lat: 13.25, lon: 76.25, precision: 'approximate'};
const paddyWest = {id: 'c-paddy', cropId: 'paddy', cropName: 'Paddy', productId: 'paddy-grain', sowingDate: '2026-07-01', establishmentDate: '2026-07-01', establishmentMethod: 'transplanting', stage: 'growing', fieldId: 'west', companion: {cropId: 'black-gram', cropName: 'Black gram', rowRatio: '4:2'}};
const maizeEast = {id: 'c-maize', cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', sowingDate: '2026-09-01', establishmentDate: '2026-09-01', establishmentMethod: 'direct_sowing', stage: 'growing', fieldId: 'east'};
const ID = (d: string) => `S2A_MSIL2A_${d.replace(/-/g, '')}T052231_R062_T43PFQ_${d.replace(/-/g, '')}T101714`;
const SCENES: FakeScene[] = [{id: ID('2026-10-27'), datetime: '2026-10-27T05:22:31.024Z', field: {ndvi: 0.7}, neighbourhood: {ndvi: 0.55}}];
const dw = (date: string): DailyWeather => ({date, rainMm: 1, et0Mm: null, tMinC: 20, tMaxC: 30, sourceId: 'open-meteo-archive'});
const weather: WeatherSource = {
  modes: ['live', 'replay', 'synthetic'], dataVersion: async () => 'v',
  getDailyObservations: async (_s, r) => eachDate(r.start, r.end).map(dw),
  getForecast: async () => ({issuedAt: '2026-11-01T01:00:00Z', sourceId: 'open-meteo-forecast', days: eachDate('2026-11-01', '2026-11-07').map(dw)}),
  getClimatology: async (_s, r) => ({years: {from: 2019, to: 2025}, qualifyingYears: [2019, 2020, 2021], sourceId: 'open-meteo-archive', days: eachDate(r.start, r.end).map(dw)}),
};
const noPrice = async (): Promise<never> => { throw new Error('no prices in this test'); };

let h: Harness, a: Client, b: Client, farmId: string, ownerId: string;
const ownerOf = async (id: string) => (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [id])).rows[0]!.owner_id;
const createFarm = async (c: Client) => (await c.call('POST', '/api/v1/farms', {payload: {name: 'Strips', location: HASSAN}})).json().data.id as string;
const put = (id: string, body: Record<string, unknown>) => a.call('PUT', `/api/v1/farms/${id}/workspace`, {payload: {previousHarvest: {status: 'unknown'}, rotationPlans: [], cycles: [], ...body}});
function deps(fake = fakePlanetary(SCENES)): TodayViewDeps & {fake: typeof fake} {
  return {config: {RUNTIME_MODE: 'live'}, pool: h.pool, now: () => NOW, sentinelFetch: fake.fetchImpl, fake, providers: {priceSeries: noPrice, harvestPriceOutlook: noPrice, priceTrend: noPrice, weatherSource: weather, readyFutureLooks: async () => []}};
}

beforeAll(async () => {
  h = await setupHarness();
  await loadCatalogueIntoDb(h.pool);
  a = await login(h.app); b = await login(h.app);
  farmId = await createFarm(a); ownerId = await ownerOf(farmId);
  const res = await put(farmId, {expectedVersion: 0, boundary: FARM, fields: FIELDS, cycles: [paddyWest, maizeEast]});
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data.fields.map((f: {id: string}) => f.id)).toEqual(['west', 'east']);
  await persistAlerts(h.pool, ownerId, farmId, 'live', [{type: 'weather', severity: 'watch', origin: 'rule', title: 'Heavy rain watch', detail: 'Synthetic test alert.', source: {name: 'Synthetic', url: 'https://example.test/rain', date: '2026-10-30'}, validFrom: '2026-10-30', validTo: '2026-11-10', suggestedStep: null}]);
}, 120_000);
afterAll(async () => h?.close());

describe('currentCycle with a field', () => {
  it('without fieldId keeps the farm-level rule (latest unharvested of any field); with fieldId only that field counts', async () => {
    const ws = (await a.call('GET', `/api/v1/farms/${farmId}/workspace`)).json().data as FarmWorkspace;
    expect(currentCycle(ws)?.id).toBe('c-maize');
    expect(currentCycle(ws, 'west')?.id).toBe('c-paddy');
    expect(currentCycle(ws, 'east')?.id).toBe('c-maize');
    expect(currentCycle(ws, 'nowhere')).toBeNull();
  });
});

describe('todayView per field', () => {
  it('fieldId=east: the field cycle, its own polygon for NDVI, renders, bbox and area; field, fields and farmBoundary', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('network disabled'); });
    const d = deps();
    const view = TodayView.parse(await todayView(d, ownerId, farmId, {fieldId: 'east'}));
    const eastHa = boundaryMetrics(EAST).areaHectares;
    expect(view.cycle?.id).toBe('c-maize');
    expect(view.field).toEqual({id: 'east', name: 'East strip', areaHa: eastHa});
    expect(view.farmBoundary).toEqual(FARM);
    expect(view.fields!.map((f) => [f.id, f.cycle?.cropId, f.cycle?.companion?.cropId ?? null, f.alertCount])).toEqual([['west', 'paddy', 'black-gram', 1], ['east', 'maize', null, 1]]);
    expect(view.fields![0]!.cycle!.stage?.progress ?? 0).toBeGreaterThan(0);
    // NDVI read the east ring only, stored under its own polygon hash.
    const rings = d.fake.calls.filter((c) => c.path.endsWith('feature.npy')).map((c) => (c.body as {geometry: {coordinates: number[][][]}}).geometry.coordinates[0]!);
    expect(rings.some((r) => Math.min(...r.map((p) => p[0]!)) === 76.25 && Math.max(...r.map((p) => p[0]!)) === 76.251)).toBe(true);
    const hashes = (await h.pool.query<{polygon_hash: string}>('SELECT DISTINCT polygon_hash FROM ndvi_scene_stats WHERE farm_id=$1', [farmId])).rows.map((r) => r.polygon_hash);
    expect(hashes).toEqual([boundaryPolygonHash(EAST)]);
    const observed = view.scenes.filter((s) => s.kind === 'observed');
    expect(observed.length).toBe(1);
    expect(observed[0]).toMatchObject({imagePath: expect.stringMatching(/kind=visual&fieldId=east$/), fieldImagePath: expect.stringMatching(/zoom=field&fieldId=east$/)});
    expect(view.fieldImageBbox).toEqual(fieldImageBbox(EAST.coordinates[0]!));
    if (view.harvestEconomics?.fieldAreaHa != null) expect(view.harvestEconomics.fieldAreaHa).toBeCloseTo(eastHa, 6);
    expect(view.limitations).toContain('This farm has 2 fields; this view describes East strip.');
    // Greenness: east was viewed (stored usable row), west never was (no fetch for the overview).
    expect(view.fields![1]!.greenness).toMatchObject({observedOn: '2026-10-27', verdict: 'above_typical'});
    expect(view.fields![0]!.greenness).toBeNull();
    vi.restoreAllMocks();
  });
  it('without fieldId describes the first field in stored order with a current cycle (west), not the farm-level latest', async () => {
    const view = TodayView.parse(await todayView(deps(), ownerId, farmId));
    expect(view.field?.id).toBe('west');
    expect(view.cycle?.id).toBe('c-paddy');
    expect(view.cycle?.companion).toMatchObject({cropId: 'black-gram', rowRatio: '4:2'});
  });
  it('an unknown field is 404 field_not_found (service and route); a malformed id is 400; strangers get 404', async () => {
    await expect(todayView(deps(), ownerId, farmId, {fieldId: 'nope'})).rejects.toMatchObject({statusCode: 404, code: 'field_not_found'});
    const app = await h.make();
    const get = (c: Client, q: string) => app.inject({method: 'GET', url: `/api/v1/farms/${farmId}/today${q}`, headers: {origin: ORIGIN, cookie: c.cookie}});
    const r = await get(a, '?fieldId=nope');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code, r.body).toBe('field_not_found');
    expect(r.json().error.details?.originalCode).toBeUndefined();
    expect((await get(a, '?fieldId=a%20b')).statusCode).toBe(400);
    expect((await get(b, '?fieldId=east')).statusCode).toBe(404);
    expect((await get(a, '?fieldId=east')).statusCode).toBe(200);
  });
  it('a farm with fields but only a farm-wide (legacy) cycle still shows that cycle on the farm boundary', async () => {
    const id = await createFarm(a);
    const legacy = {id: 'c-legacy', cropId: 'maize', productId: 'maize-grain', sowingDate: '2026-09-01', establishmentDate: '2026-09-01', establishmentMethod: 'direct_sowing', stage: 'growing'};
    expect((await put(id, {expectedVersion: 0, boundary: FARM, fields: FIELDS, cycles: [legacy]})).statusCode).toBe(200);
    const view = TodayView.parse(await todayView({...deps(), config: {RUNTIME_MODE: 'synthetic'}}, ownerId, id));
    expect(view.field).toBeNull();
    expect(view.cycle?.id).toBe('c-legacy');
    expect(view.fields!.every((f) => f.cycle === null && f.greenness === null)).toBe(true);
    expect(view.limitations.join(' ')).toMatch(/no field has a current crop cycle, so this view describes the farm-wide cycle/);
  });
});

describe('field render keys', () => {
  it('two fields of one farm never share a render key; the image route resolves the field polygon from ?fieldId=', async () => {
    const fake = fakePlanetary(SCENES);
    await ndviSeries({config: {RUNTIME_MODE: 'live'}, pool: h.pool, fetchImpl: fake.fetchImpl, now: () => NOW}, ownerId, farmId, {fieldId: 'west', to: '2026-11-01'});
    const app = await buildServer(testConfig({RUNTIME_MODE: 'live'}), h.pool, {storage: h.storage, today: {ndvi: {fetchImpl: fake.fetchImpl}}});
    const get = (q: string) => app.inject({method: 'GET', url: `/api/v1/farms/${farmId}/ndvi/${ID('2026-10-27')}/image?${q}`, headers: {origin: ORIGIN, cookie: a.cookie}});
    for (const f of ['west', 'east']) for (const q of [`kind=visual&fieldId=${f}`, `kind=visual&zoom=field&fieldId=${f}`]) expect((await get(q)).statusCode, q).toBe(200);
    expect((await get('kind=visual&fieldId=nope')).statusCode).toBe(404);
    const [w8, e8] = [boundaryPolygonHash(WEST)!.slice(0, 8), boundaryPolygonHash(EAST)!.slice(0, 8)];
    expect(w8).not.toBe(e8);
    for (const name of [`visual-${w8}`, `visual-field-${w8}`, `visual-${e8}`, `visual-field-${e8}`]) {
      expect(await h.storage.exists({ownerId, key: `ndvi/${farmId}/${ID('2026-10-27')}/${name}.png`}), name).toBe(true);
    }
    const keys = (await h.pool.query<{image_keys: Record<string, string>}>('SELECT image_keys FROM ndvi_scene_stats WHERE farm_id=$1', [farmId])).rows.map((r) => Object.keys(r.image_keys ?? {}).sort());
    expect(keys.sort()).toEqual([[`visual-${e8}`, `visual-field-${e8}`].sort(), [`visual-${w8}`, `visual-field-${w8}`].sort()].sort());
    await app.close();
  });
});

describe('workspace PUT with fields', () => {
  it('keeps stored fields when a PUT omits them, refuses deleting a field a cycle names, a field outside the farm, and a boundary the fields no longer fit', async () => {
    const id = await createFarm(a);
    expect((await put(id, {expectedVersion: 0, boundary: FARM, fields: FIELDS, cycles: [maizeEast]})).statusCode).toBe(200);
    const kept = await put(id, {expectedVersion: 1, boundary: FARM, cycles: [maizeEast]});
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().data.fields.map((f: {id: string}) => f.id)).toEqual(['west', 'east']);
    expect((await put(id, {expectedVersion: 2, boundary: FARM, fields: [FIELDS[0]], cycles: [maizeEast]})).statusCode).toBe(400);
    expect((await put(id, {expectedVersion: 2, boundary: FARM, fields: [...FIELDS, {id: 'far', name: 'Far', boundary: rect(76.3, 13.3, 76.301, 13.301)}], cycles: [maizeEast]})).statusCode).toBe(400);
    const shrunk = await put(id, {expectedVersion: 2, boundary: WEST, cycles: [maizeEast]});
    expect(shrunk.statusCode).toBe(400);
    expect(shrunk.json().error.message).toMatch(/must lie within the farm boundary/);
    // An old row without the key reads back with fields [].
    await h.pool.query(`UPDATE farm_workspaces SET state=state - 'fields' - 'cycles' || '{"cycles":[]}'::jsonb WHERE farm_id=$1`, [id]);
    expect((await a.call('GET', `/api/v1/farms/${id}/workspace`)).json().data.fields).toEqual([]);
  });
});

describe('plant crop on a field', () => {
  it('requires the field on a farm with fields, 404s an unknown one, and records the field and the companion with catalogue names', async () => {
    const id = await createFarm(a);
    expect((await put(id, {expectedVersion: 0, boundary: FARM, fields: FIELDS})).statusCode).toBe(200);
    const base = {clientEntryId: 'f-plant-1', cropId: 'paddy', productId: 'paddy-grain', establishmentMethod: 'transplanting', establishmentDate: '2026-10-01', expectedWorkspaceVersion: 1};
    const plant = (p: Record<string, unknown>) => a.call('POST', `/api/v1/farms/${id}/cycles`, {payload: {...base, ...p}});
    const missing = await plant({});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code, missing.body).toBe('field_required');
    expect((await plant({clientEntryId: 'f-plant-2', fieldId: 'nope'})).json().error.code).toBe('field_not_found');
    expect((await plant({clientEntryId: 'f-plant-3', fieldId: 'west', companion: {cropId: 'paddy'}})).statusCode).toBe(400);
    expect((await plant({clientEntryId: 'f-plant-4', fieldId: 'west', companion: {cropId: 'black-gram', productId: 'maize-grain'}})).statusCode).toBe(400);
    const ok = await plant({clientEntryId: 'f-plant-5', fieldId: 'west', companion: {cropId: 'black-gram'}});
    expect(ok.statusCode, ok.body).toBe(201);
    const cycle = ok.json().data.cycle;
    expect(cycle).toMatchObject({fieldId: 'west', companion: {cropId: 'black-gram', rowRatio: 'not stated'}});
    expect(cycle.companion.cropName).toMatch(/gram/i);
    const text = (await h.pool.query<{text: string}>("SELECT raw_text AS text FROM journal_entries WHERE farm_id=$1", [id]).catch(async () => h.pool.query<{text: string}>('SELECT row_to_json(j)::text AS text FROM journal_entries j WHERE farm_id=$1', [id]))).rows.map((r) => r.text).join(' ');
    expect(text).toMatch(/\(with [^)]*gram[^)]*\) on West strip/i);
  });
});

describe('briefing on a farm with fields', () => {
  it('fills fields.count, viewedField null, and names the field of the farm-level current cycle', async () => {
    const budget = new Budget(h.pool, {totalUsd: 100, devAllocationUsd: 50, demoReserveUsd: 1, perSessionUsd: 40, perOwnerDayUsd: 40});
    await budget.init();
    const run = (await h.pool.query<{id: string}>("INSERT INTO agent_runs (owner_id, mode, purpose, status) VALUES ($1,'synthetic','test','running') RETURNING id", [ownerId])).rows[0]!.id;
    const out = await farmBriefing({config: h.config, budget}, farmId, {ownerId, mode: 'synthetic', requestId: 'req-fields', pool: h.pool, agentRunId: run, asOf: new Date().toISOString()});
    expect(out.fields).toEqual({count: 2, viewedField: null});
    expect(out.cycle?.cropId).toBe('maize');
    expect(out.limitations).toContain('This farm has 2 fields; the figures describe East strip.');
  });
});

describe('stage illustrations per field', () => {
  it('a field cycle derives its illustration from the field polygon (the farm polygon has no analysed scene here)', async () => {
    const east = await futureLookField(h.pool, ownerId, farmId, 'east');
    const farm = await futureLookField(h.pool, ownerId, farmId);
    expect('hash' in east && east.hash).toBe(boundaryPolygonHash(EAST));
    expect('hash' in farm && farm.hash).toBe(boundaryPolygonHash(FARM));
    const farmRows = await h.pool.query('SELECT 1 FROM ndvi_scene_stats WHERE farm_id=$1 AND polygon_hash=$2', [farmId, boundaryPolygonHash(FARM)]);
    expect(farmRows.rowCount).toBe(0);
    const view = await todayView({...deps(), config: {RUNTIME_MODE: 'synthetic'}}, ownerId, farmId, {fieldId: 'east'});
    const stage = view.timeline!.stages.find((st) => st.to >= view.today)!;
    const svc = {config: {RUNTIME_MODE: 'live' as const, MODEL_API_KEY: 'test-key-not-real'}, pool: h.pool, now: () => NOW};
    const res = await requestFutureLook(svc, ownerId, farmId, {itemId: ID('2026-10-27'), stageId: stage.id, cycleId: 'c-maize'});
    expect(res).toMatchObject({status: 'queued', cycleId: 'c-maize', stageId: stage.id});
  });
});
