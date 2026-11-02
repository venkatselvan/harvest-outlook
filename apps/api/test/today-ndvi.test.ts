import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {NdviSeries, NeighbourhoodSeasonality} from '@harvest/contracts';
import {buildServer} from '../src/server';
import {fieldImageBbox, fieldScenePaths, ndviSeries, neighbourhoodSeasonality, sceneImage, sceneImageKey, type NdviDeps} from '../src/services/today/ndvi';
import {bboxMeters, fieldBbox, fieldRenderSize, type Bbox} from '../src/providers/sentinel2';
import {ApiError} from '../src/services/errors';
import {setupHarness, login, farmBody, testConfig, ORIGIN, type Harness, type Client} from './helpers';
import {fakePlanetary, type FakeScene} from './fixtures/sentinel2/fake-provider';

let h: Harness, owner: Client, stranger: Client;
beforeAll(async () => { h = await setupHarness(); owner = await login(h.app); stranger = await login(h.app); });
afterAll(async () => h?.close());
// Scene lists are a shared public cache keyed by bbox and window; start each case from an empty list cache.
beforeEach(async () => { await h.pool.query("DELETE FROM provider_cache WHERE provider='planetary-computer-stac'"); });

const HA = {type: 'Polygon', coordinates: [[[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]]]};
const NOW = () => new Date('2026-11-01T06:00:00Z');
const ID = (date: string, n = 0) => `S2A_MSIL2A_${date.replace(/-/g, '')}T05223${n}_R062_T43PFQ_${date.replace(/-/g, '')}T101714`;
const scene = (date: string, field: FakeScene['field'], neighbourhood?: FakeScene['neighbourhood']): FakeScene => ({id: ID(date), datetime: `${date}T05:22:31.024Z`, field, ...(neighbourhood ? {neighbourhood} : {})});
const ownerOf = async (farmId: string) => (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
async function farmWithBoundary(client: Client, boundary: unknown = HA) {
  const id = (await client.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id as string;
  if (boundary) expect((await client.call('PUT', `/api/v1/farms/${id}/workspace`, {payload: {expectedVersion: 0, boundary, previousHarvest: {status: 'unknown'}, cycles: [], rotationPlans: []}})).statusCode).toBe(200);
  return {farmId: id, ownerId: await ownerOf(id)};
}
const live = (fetchImpl: NdviDeps['fetchImpl']): NdviDeps => ({config: {RUNTIME_MODE: 'live'}, pool: h.pool, fetchImpl, now: NOW});
const status = async (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof ApiError ? e.statusCode : 500));
const npyCalls = (calls: {path: string}[]) => calls.filter((c) => c.path.endsWith('feature.npy')).length;
const stacCalls = (calls: {path: string}[]) => calls.filter((c) => c.path.endsWith('/search')).length;

const OCTOBER = [
  scene('2026-10-29', 'bad'),
  scene('2026-10-27', {ndvi: 0.63}, {ndvi: 0.58}),
  scene('2026-10-12', {ndvi: 0.53}),
  scene('2026-09-27', 'cloudy', {ndvi: 0.4}),
  scene('2026-05-25', {ndvi: 0.38}),
];

describe('ndviSeries (live, injected provider)', () => {
  it('analyses the newest scenes first within maxScenes, stores them, and a repeat call makes zero fetches', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const fake = fakePlanetary(OCTOBER);
    const first = NdviSeries.parse(await ndviSeries(live(fake.fetchImpl), ownerId, farmId, {maxScenes: 3}));
    expect(stacCalls(fake.calls)).toBe(1);
    expect(npyCalls(fake.calls)).toBe(6); // field + neighbourhood for the three newest scenes
    expect(first).toMatchObject({status: 'available', polygonBasis: 'boundary', scenesListed: 5, scenesAnalysed: 3, scenesPending: 2, scenesFailed: 0, polygonPixels: 100, smallField: false, window: {from: '2025-11-02', to: '2026-11-01'}});
    expect(first.readings.map((r) => r.date)).toEqual(['2026-10-12', '2026-10-27', '2026-10-29']);
    const bad = first.readings.find((r) => r.date === '2026-10-29')!;
    expect(bad).toMatchObject({usable: false, offsetApplied: true, field: {rejection: 'implausible_band_values'}, neighbourhood: {rejection: 'implausible_band_values'}});
    expect(first.latestUsable).toMatchObject({date: '2026-10-27', field: {usable: true}, neighbourhood: {usable: true}});
    expect(first.latestUsable!.field.mean).toBeCloseTo(0.63, 3);
    expect(first.latestUsable!.neighbourhood!.mean).toBeCloseTo(0.58, 3);
    expect(first.imageBbox).not.toBeNull();
    expect(first.limitations.some((l) => l.includes('2 older scenes'))).toBe(true);

    const second = NdviSeries.parse(await ndviSeries(live(fake.fetchImpl), ownerId, farmId));
    expect(stacCalls(fake.calls)).toBe(1); // scene list served from the per-day cache
    expect(npyCalls(fake.calls)).toBe(10);
    expect(second).toMatchObject({scenesAnalysed: 5, scenesPending: 0});
    expect(second.readings.find((r) => r.date === '2026-09-27')).toMatchObject({usable: false, field: {rejection: 'insufficient_clear_pixels', cloudOrShadowFraction: 1}, neighbourhood: {usable: true}});

    const before = fake.calls.length;
    const third = NdviSeries.parse(await ndviSeries(live(fake.fetchImpl), ownerId, farmId));
    expect(fake.calls.length).toBe(before); // full cache hit: zero network
    expect(third.readings).toEqual(second.readings);
    const rows = await h.pool.query('SELECT owner_id,usable FROM ndvi_scene_stats WHERE farm_id=$1', [farmId]);
    expect(rows.rowCount).toBe(5);
    expect(rows.rows.every((r) => r.owner_id === ownerId)).toBe(true);
    // Every stored reading carries the seven indices next to NDVI, and the method names their version.
    expect(third.method).toMatchObject({version: 'ndvi-s2l2a-v1', indexMethodVersion: 'indices-s2l2a-v1'});
    expect(third.readings.every((r) => r.field.indices && (r.neighbourhood === null || r.neighbourhood.indices))).toBe(true);
    expect(third.latestUsable!.field.indices!.gndvi!.mean).toBeCloseTo(0.6926, 4); // fake-provider defaults at NDVI 0.63
    expect(third.readings.find((r) => r.date === '2026-09-27')!.field.indices!.evi).toEqual({mean: null, median: null, p10: null, p90: null}); // cloudy field
    expect(third.limitations).toContain('B05, B8A and B11 are 20 m bands resampled to the 10 m grid, so a 1 ha field has about 25 independent pixels for NDRE, LSWI and NDMI.');
  });

  it('re-analyses rows stored before the indices existed, newest first within maxScenes, upserting them in place', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const fake = fakePlanetary(OCTOBER.slice(1)); // 2026-10-27, 10-12, 09-27, 05-25
    await ndviSeries(live(fake.fetchImpl), ownerId, farmId);
    // Make every stored row look like one written before 2026-11-01: NDVI stats without `indices`; one row has a rendered image.
    await h.pool.query(`UPDATE ndvi_scene_stats SET field_stats=field_stats - 'indices', neighbourhood_stats=CASE WHEN neighbourhood_stats IS NULL THEN NULL ELSE neighbourhood_stats - 'indices' END WHERE farm_id=$1`, [farmId]);
    await h.pool.query(`UPDATE ndvi_scene_stats SET image_keys=jsonb_build_object('visual', 'ndvi/' || farm_id || '/' || item_id || '/visual.png') WHERE farm_id=$1 AND item_id=$2`, [farmId, ID('2026-10-27')]);
    const idsBefore = (await h.pool.query('SELECT id,item_id FROM ndvi_scene_stats WHERE farm_id=$1 ORDER BY item_id', [farmId])).rows;
    expect(idsBefore).toHaveLength(4);

    let mark = fake.calls.length;
    const second = NdviSeries.parse(await ndviSeries(live(fake.fetchImpl), ownerId, farmId, {maxScenes: 2}));
    expect(npyCalls(fake.calls.slice(mark))).toBe(4); // the two newest legacy scenes, field + neighbourhood
    expect(second).toMatchObject({status: 'available', scenesListed: 4, scenesAnalysed: 2, scenesPending: 2, scenesFailed: 0});
    expect(second.method.indexMethodVersion).toBe('indices-s2l2a-v1');
    expect(second.limitations.some((l) => l.includes('2 older scenes'))).toBe(true);
    const byDate = Object.fromEntries(second.readings.map((r) => [r.date, r]));
    expect(Object.keys(byDate).sort()).toEqual(['2026-05-25', '2026-09-27', '2026-10-12', '2026-10-27']); // legacy rows stay visible
    expect(byDate['2026-10-27']!.field.indices!.ndre!.mean).toBeCloseTo(0.492, 4);
    expect(byDate['2026-10-27']!.neighbourhood!.indices).toBeDefined();
    expect(byDate['2026-10-12']!.field.indices).toBeDefined();
    expect(byDate['2026-09-27']!.field.indices).toBeUndefined();
    expect(byDate['2026-05-25']!.field.indices).toBeUndefined();
    expect(byDate['2026-05-25']!.field.mean).toBeCloseTo(0.38, 3); // NDVI from the legacy row is still served

    const stored = (await h.pool.query(`SELECT id,item_id,field_stats ? 'indices' AS field_has,neighbourhood_stats ? 'indices' AS nb_has,image_keys FROM ndvi_scene_stats WHERE farm_id=$1 ORDER BY item_id`, [farmId])).rows;
    expect(stored.map((r) => ({id: r.id, item_id: r.item_id}))).toEqual(idsBefore); // upserted in place, no new rows
    const row = (date: string) => stored.find((r) => r.item_id === ID(date))!;
    expect(row('2026-10-27')).toMatchObject({field_has: true, nb_has: true, image_keys: {visual: `ndvi/${farmId}/${ID('2026-10-27')}/visual.png`}});
    expect(row('2026-10-12')).toMatchObject({field_has: true, nb_has: true});
    expect(row('2026-05-25')).toMatchObject({field_has: false});

    mark = fake.calls.length;
    const third = NdviSeries.parse(await ndviSeries(live(fake.fetchImpl), ownerId, farmId, {maxScenes: 2}));
    expect(npyCalls(fake.calls.slice(mark))).toBe(4); // the remaining two
    expect(third).toMatchObject({scenesAnalysed: 4, scenesPending: 0});
    expect(third.readings.every((r) => r.field.indices !== undefined)).toBe(true);
    mark = fake.calls.length;
    await ndviSeries(live(fake.fetchImpl), ownerId, farmId);
    expect(fake.calls.length).toBe(mark); // complete rows are not re-read
  });

  it('keeps the stored neighbourhood when re-reading a legacy row hits a permanent neighbourhood failure', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const scenes = OCTOBER.slice(1, 3); // 2026-10-27 (neighbourhood NDVI 0.58), 2026-10-12
    await ndviSeries(live(fakePlanetary(scenes).fetchImpl), ownerId, farmId);
    await h.pool.query(`UPDATE ndvi_scene_stats SET field_stats=field_stats - 'indices', neighbourhood_stats=neighbourhood_stats - 'indices' WHERE farm_id=$1`, [farmId]);
    const broken = fakePlanetary(scenes, {breakNeighbourhood: new Set([ID('2026-10-27')])});
    const series = NdviSeries.parse(await ndviSeries(live(broken.fetchImpl), ownerId, farmId));
    expect(npyCalls(broken.calls)).toBe(4); // both legacy rows re-read, field + neighbourhood
    expect(series).toMatchObject({scenesAnalysed: 2, scenesPending: 0, scenesFailed: 0});
    const kept = series.readings.find((r) => r.date === '2026-10-27')!;
    expect(kept.field.indices).toBeDefined();
    expect(kept.neighbourhood!.mean).toBeCloseTo(0.58, 3); // the earlier neighbourhood survives instead of becoming null
    expect(kept.neighbourhood!.indices).toBeUndefined(); // and stays NDVI-only
    expect(series.readings.find((r) => r.date === '2026-10-12')!.neighbourhood!.indices).toBeDefined();
    const stored = (await h.pool.query('SELECT neighbourhood_stats FROM ndvi_scene_stats WHERE farm_id=$1 AND item_id=$2', [farmId, ID('2026-10-27')])).rows[0];
    expect(stored.neighbourhood_stats.mean).toBeCloseTo(0.58, 3);
    // Complete by its field stats, so a permanently failing neighbourhood does not cause a re-read on every request.
    const mark = broken.calls.length;
    await ndviSeries(live(broken.fetchImpl), ownerId, farmId);
    expect(broken.calls.length).toBe(mark);
    // A scene analysed for the first time with the same failure still stores no neighbourhood (nothing to keep).
    const fresh = await farmWithBoundary(owner);
    const first = NdviSeries.parse(await ndviSeries(live(broken.fetchImpl), fresh.ownerId, fresh.farmId));
    expect(first.readings.find((r) => r.date === '2026-10-27')!.neighbourhood).toBeNull();
  });

  it('rejects a legacy 4-band answer to the eight-asset request and stores nothing for it', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const fake = fakePlanetary(OCTOBER.slice(1, 2), {legacyLayout: true});
    const series = NdviSeries.parse(await ndviSeries(live(fake.fetchImpl), ownerId, farmId));
    expect(series).toMatchObject({status: 'available', scenesListed: 1, scenesAnalysed: 0, scenesFailed: 1, readings: []});
    expect(series.limitations[0]).toContain('unexpected_band_layout');
    expect((await h.pool.query('SELECT 1 FROM ndvi_scene_stats WHERE farm_id=$1', [farmId])).rowCount).toBe(0);
  });

  it('does not cache a scene whose neighbourhood read failed transiently, and retries it', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const fake = fakePlanetary(OCTOBER.slice(1, 3), {failNeighbourhoodOnce: new Set([ID('2026-10-27')])});
    const first = await ndviSeries(live(fake.fetchImpl), ownerId, farmId);
    expect(first).toMatchObject({scenesFailed: 1, scenesAnalysed: 1});
    expect(first.limitations[0]).toContain('provider_error');
    const second = await ndviSeries(live(fake.fetchImpl), ownerId, farmId);
    expect(second).toMatchObject({scenesFailed: 0, scenesAnalysed: 2});
  });

  it('keeps owners isolated: foreign farms are 404 everywhere with no network, and identical boundaries do not share rows', async () => {
    const a = await farmWithBoundary(owner);
    const b = await farmWithBoundary(stranger);
    const fake = fakePlanetary(OCTOBER.slice(1, 2));
    await ndviSeries(live(fake.fetchImpl), a.ownerId, a.farmId);
    const afterOwner = fake.calls.length;
    expect(await status(ndviSeries(live(fake.fetchImpl), b.ownerId, a.farmId))).toBe(404);
    expect(await status(neighbourhoodSeasonality(live(fake.fetchImpl), b.ownerId, a.farmId))).toBe(404);
    expect(await status(sceneImage({...live(fake.fetchImpl), storage: h.storage}, b.ownerId, a.farmId, ID('2026-10-27'), 'visual'))).toBe(404);
    expect(fake.calls.length).toBe(afterOwner);
    // Same polygon, other owner: computes its own rows (scene list may come from the shared public cache).
    const own = await ndviSeries(live(fake.fetchImpl), b.ownerId, b.farmId);
    expect(own.scenesAnalysed).toBe(1);
    expect(npyCalls(fake.calls.slice(afterOwner))).toBe(2);
    const owners = await h.pool.query('SELECT DISTINCT owner_id FROM ndvi_scene_stats WHERE farm_id=ANY($1::uuid[])', [[a.farmId, b.farmId]]);
    expect(owners.rows.map((r) => r.owner_id).sort()).toEqual([a.ownerId, b.ownerId].sort());
  });

  it('makes no network call in synthetic or replay mode', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const fake = fakePlanetary(OCTOBER);
    for (const mode of ['synthetic', 'replay'] as const) {
      const deps: NdviDeps = {config: {RUNTIME_MODE: mode}, pool: h.pool, fetchImpl: fake.fetchImpl, now: NOW};
      expect(NdviSeries.parse(await ndviSeries(deps, ownerId, farmId))).toMatchObject({status: 'unavailable', reason: 'live_mode_required', readings: []});
      expect(NeighbourhoodSeasonality.parse(await neighbourhoodSeasonality(deps, ownerId, farmId))).toMatchObject({status: 'unavailable', activeMonths: []});
      expect(await status(sceneImage({...deps, storage: h.storage}, ownerId, farmId, ID('2026-10-27'), 'visual'))).toBe(409);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('falls back to a flagged square around a farm point (approximate points flagged); no location is unavailable without network', async () => {
    const fake = fakePlanetary(OCTOBER.slice(1, 2));
    const pointFarm = (await owner.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}, location: {stateId: 'IN-KA', districtName: 'Hassan', precision: 'precise', lat: 13.25, lon: 76.25}})})).json().data.id as string;
    const series = await ndviSeries(live(fake.fetchImpl), await ownerOf(pointFarm), pointFarm);
    expect(series).toMatchObject({status: 'available', polygonBasis: 'farm_point_square'});
    expect(series.limitations[0]).toContain('No field boundary is drawn');
    const ring = (fake.calls.find((c) => c.path.endsWith('feature.npy'))!.body as {geometry: {coordinates: number[][][]}}).geometry.coordinates[0]!;
    const height = Math.max(...ring.map((p) => p[1]!)) - Math.min(...ring.map((p) => p[1]!));
    expect(height).toBeGreaterThanOrEqual(0.0008 - 1e-9); // 100 m, shrunk by 4-decimal rounding
    expect(height).toBeLessThanOrEqual(0.001 + 1e-9);
    const before = fake.calls.length;
    // District precision never carries coordinates through the farm API, so the point-less case is the reachable one.
    const noPointFarm = (await owner.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id as string;
    expect(await ndviSeries(live(fake.fetchImpl), await ownerOf(noPointFarm), noPointFarm)).toMatchObject({status: 'unavailable', reason: 'farm_location_missing'});
    expect(fake.calls.length).toBe(before);
    const approxFarm = (await owner.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}, location: {stateId: 'IN-KA', districtName: 'Hassan', precision: 'approximate', lat: 13.25, lon: 76.25}})})).json().data.id as string;
    const approx = await ndviSeries(live(fake.fetchImpl), await ownerOf(approxFarm), approxFarm);
    expect(approx).toMatchObject({status: 'available', polygonBasis: 'farm_point_square'});
    expect(approx.limitations.some((l) => l.includes('approximate'))).toBe(true);
  });

  it('rejects invalid windows', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner, null);
    const deps = live(fakePlanetary([]).fetchImpl);
    expect(await status(ndviSeries(deps, ownerId, farmId, {from: '2026-10-31', to: '2026-10-01'}))).toBe(400);
    expect(await status(ndviSeries(deps, ownerId, farmId, {from: '2024-01-01', to: '2026-10-01'}))).toBe(400);
    expect(await status(ndviSeries(deps, ownerId, farmId, {from: '2026-10-01', to: '2026-12-01'}))).toBe(400);
  });
});

describe('neighbourhoodSeasonality', () => {
  it('averages usable neighbourhood scenes by month, leaves months without a usable scene null, and marks active months', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const fake = fakePlanetary([
      scene('2025-10-20', {ndvi: 0.7}, {ndvi: 0.7}), // before the 12-month window
      scene('2025-11-05', {ndvi: 0.6}, {ndvi: 0.62}),
      scene('2025-11-20', {ndvi: 0.6}, {ndvi: 0.58}),
      scene('2025-12-10', {ndvi: 0.5}, {ndvi: 0.5}),
      scene('2026-01-10', {ndvi: 0.4}, {ndvi: 0.4}),
      scene('2026-03-10', {ndvi: 0.3}, {ndvi: 0.3}),
      scene('2026-07-11', 'cloudy', 'cloudy'),
      scene('2026-10-27', {ndvi: 0.63}, {ndvi: 0.6}),
      scene('2026-10-29', 'bad'),
    ]);
    const s = NeighbourhoodSeasonality.parse(await neighbourhoodSeasonality(live(fake.fetchImpl), ownerId, farmId, {maxScenes: 20}));
    expect(s.window).toEqual({from: '2025-11-01', to: '2026-10-31'}); // last 12 complete months on 1 Nov 2026
    expect(s.months.map((m) => m.month)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    const by = Object.fromEntries(s.months.map((m) => [m.month, m]));
    expect(by['2025-11']).toMatchObject({meanNdvi: 0.6, usableScenes: 2});
    expect(by['2026-02']).toMatchObject({meanNdvi: null, analysedScenes: 0});
    expect(by['2026-07']).toMatchObject({meanNdvi: null, analysedScenes: 1, usableScenes: 0});
    expect(by['2026-10']).toMatchObject({meanNdvi: 0.6, usableScenes: 1, analysedScenes: 2});
    expect(s.activeMonths.sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(s.scenesPending).toBe(0);
  });
});

describe('sceneImage', () => {
  it('renders once into owner-private storage, records the key, then serves from storage with zero fetches', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const fake = fakePlanetary(OCTOBER.slice(0, 2));
    const deps = {...live(fake.fetchImpl), storage: h.storage};
    await ndviSeries(deps, ownerId, farmId);
    const item = ID('2026-10-27');
    expect(await status(sceneImage(deps, ownerId, farmId, ID('2026-01-01'), 'visual'))).toBe(404);
    const before = fake.calls.length;
    const first = await sceneImage(deps, ownerId, farmId, item, 'ndvi');
    expect(first).toMatchObject({contentType: 'image/png', cached: false, acquiredAt: '2026-10-27T05:22:31.024Z'});
    expect(fake.calls.length).toBe(before + 1);
    expect(new URL(fake.calls.at(-1)!.url).searchParams.get('expression')).toBe('(B08-B04)/(B08+B04-2000)');
    expect(await h.storage.exists({ownerId, key: `ndvi/${farmId}/${item}/ndvi.png`})).toBe(true);
    const row = (await h.pool.query('SELECT image_keys FROM ndvi_scene_stats WHERE farm_id=$1 AND item_id=$2', [farmId, item])).rows[0];
    expect(row.image_keys).toEqual({ndvi: `ndvi/${farmId}/${item}/ndvi.png`});
    const second = await sceneImage(deps, ownerId, farmId, item, 'ndvi');
    expect(second.cached).toBe(true);
    expect(Buffer.compare(second.bytes, first.bytes)).toBe(0);
    expect(fake.calls.length).toBe(before + 1);
    // Redrawing the boundary starts new rows; the re-rendered file is claimed only by the current polygon's row.
    const moved = {type: 'Polygon', coordinates: [[[76.2485, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2485, 13.2505], [76.2485, 13.2495]]]};
    expect((await owner.call('PUT', `/api/v1/farms/${farmId}/workspace`, {payload: {expectedVersion: 1, boundary: moved, previousHarvest: {status: 'unknown'}, cycles: [], rotationPlans: []}})).statusCode).toBe(200);
    await ndviSeries(deps, ownerId, farmId);
    expect((await sceneImage(deps, ownerId, farmId, item, 'ndvi')).cached).toBe(false);
    const claims = (await h.pool.query("SELECT count(*)::int AS n FROM ndvi_scene_stats WHERE farm_id=$1 AND item_id=$2 AND image_keys ? 'ndvi'", [farmId, item])).rows[0].n;
    expect(claims).toBe(1);
  });
});

const ringOf = (lon0: number, lat0: number, lon1: number, lat1: number): [number, number][] => [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]];
const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;
const imageCall = (calls: {path: string; url: string}[]) => calls.filter((c) => c.path.includes('/item/bbox/')).at(-1)!;
const parseImageCall = (c: {path: string}) => {
  const m = /\/item\/bbox\/([^/]+)\/(\d+)x(\d+)\.png$/.exec(c.path)!;
  return {bbox: m[1]!.split(',').map(Number) as unknown as Bbox, width: Number(m[2]), height: Number(m[3])};
};

describe('field window arithmetic', () => {
  it('is a square of 1.6 times the larger field side, centred on the field, rounded outward to 4 decimals', () => {
    const ring = ringOf(76.2495, 13.2495, 76.2505, 13.2505); // about 108 m east-west by 111 m north-south
    const b = fieldBbox(ring);
    for (const v of b) expect(decimals(v)).toBeLessThanOrEqual(4);
    const [w, hgt] = bboxMeters(b);
    const ideal = 1.6 * 111.32; // the larger side is the north-south one
    // Outward 4-decimal rounding adds at most one grid step (about 11.2 m) per edge, never removes any.
    expect(w).toBeGreaterThanOrEqual(ideal - 0.5); expect(w).toBeLessThanOrEqual(ideal + 23);
    expect(hgt).toBeGreaterThanOrEqual(ideal - 0.5); expect(hgt).toBeLessThanOrEqual(ideal + 23);
    expect(Math.abs(w - hgt)).toBeLessThan(23); // square up to the grid
    expect((b[0] + b[2]) / 2).toBeCloseTo(76.25, 3); expect((b[1] + b[3]) / 2).toBeCloseTo(13.25, 3);
    // 1.6 x, not the 600 m / 0.8 x display window.
    const wide = bboxMeters(fieldBbox(ringOf(76.2, 13.2, 76.21, 13.21))); // about 1.08 km by 1.11 km
    expect(wide[1]).toBeGreaterThan(1.6 * 1100); expect(wide[1]).toBeLessThan(1.6 * 1113 + 23);
  });

  it('never goes below 120 m across for a tiny field', () => {
    const b = fieldBbox(ringOf(76.24995, 13.24995, 76.25005, 13.25005)); // about 11 m
    const [w, hgt] = bboxMeters(b);
    expect(w).toBeGreaterThanOrEqual(119.5); expect(hgt).toBeGreaterThanOrEqual(119.5);
    expect(w).toBeLessThanOrEqual(120 + 23); expect(hgt).toBeLessThanOrEqual(120 + 23);
  });

  it('sizes the render at one pixel per 10 m, clamped 12 to 768', () => {
    const tiny = fieldBbox(ringOf(76.24995, 13.24995, 76.25005, 13.25005));
    const [w, hgt] = bboxMeters(tiny);
    expect(fieldRenderSize(tiny)).toBe(Math.ceil(Math.max(w, hgt) / 10));
    expect(fieldRenderSize(tiny)).toBeGreaterThanOrEqual(12);
    expect(fieldRenderSize([76, 13, 76.0004, 13.0004])).toBe(12); // 44 m: clamped up to 12
    expect(fieldRenderSize([76, 13, 76.01, 13.01])).toBe(Math.ceil(1113.2 / 10)); // unclamped middle
    expect(fieldRenderSize([76, 13, 76.1, 13.1])).toBe(768); // 11 km: clamped down
  });

  it('builds the scene paths and the storage key per zoom', () => {
    const farm = '11111111-1111-4111-8111-111111111111', item = ID('2026-10-27');
    expect(fieldScenePaths(farm, item)).toEqual({
      fieldImagePath: `/api/v1/farms/${farm}/ndvi/${item}/image?kind=visual&zoom=field`,
      fieldNdviImagePath: `/api/v1/farms/${farm}/ndvi/${item}/image?kind=ndvi&zoom=field`,
    });
    expect(sceneImageKey(farm, item, 'visual')).toBe(`ndvi/${farm}/${item}/visual.png`);
    expect(sceneImageKey(farm, item, 'ndvi', 'wide')).toBe(`ndvi/${farm}/${item}/ndvi.png`);
    expect(sceneImageKey(farm, item, 'visual', 'field')).toBe(`ndvi/${farm}/${item}/visual-field.png`);
    expect(sceneImageKey(farm, item, 'ndvi', 'field')).toBe(`ndvi/${farm}/${item}/ndvi-field.png`);
    expect(fieldImageBbox(ringOf(76.2495, 13.2495, 76.2505, 13.2505))).toEqual(fieldBbox(ringOf(76.2495, 13.2495, 76.2505, 13.2505)));
  });
});

describe('sceneImage field zoom', () => {
  it('asks the tiler for the field window at native size, stores it apart from the wide render, and serves it from storage', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const fake = fakePlanetary(OCTOBER.slice(0, 2));
    const deps = {...live(fake.fetchImpl), storage: h.storage};
    await ndviSeries(deps, ownerId, farmId);
    const item = ID('2026-10-27');
    const expectedBbox = fieldBbox(HA.coordinates[0] as [number, number][]);

    const first = await sceneImage(deps, ownerId, farmId, item, 'visual', 'field');
    expect(first).toMatchObject({contentType: 'image/png', cached: false, bbox: expectedBbox});
    const call = parseImageCall(imageCall(fake.calls));
    expect(call.bbox).toEqual(expectedBbox);
    expect(call.width).toBe(fieldRenderSize(expectedBbox));
    expect(call.height).toBe(call.width);
    expect(call.width).toBeLessThan(40); // native 10 m pixels, not the 512 px wide render
    expect(new URL(imageCall(fake.calls).url).searchParams.get('resampling')).toBe('nearest');
    expect(await h.storage.exists({ownerId, key: `ndvi/${farmId}/${item}/visual-field.png`})).toBe(true);
    expect(await h.storage.exists({ownerId, key: `ndvi/${farmId}/${item}/visual.png`})).toBe(false);

    // The wide render is a separate object, still 512 px over the 600 m display window.
    const wide = await sceneImage(deps, ownerId, farmId, item, 'visual');
    expect(wide.cached).toBe(false);
    const wideCall = parseImageCall(imageCall(fake.calls));
    expect(wideCall.width).toBe(512);
    expect(wideCall.bbox).not.toEqual(expectedBbox);
    const row = (await h.pool.query('SELECT image_keys FROM ndvi_scene_stats WHERE farm_id=$1 AND item_id=$2', [farmId, item])).rows[0];
    expect(row.image_keys).toEqual({'visual-field': `ndvi/${farmId}/${item}/visual-field.png`, visual: `ndvi/${farmId}/${item}/visual.png`});

    const before = fake.calls.length;
    const again = await sceneImage(deps, ownerId, farmId, item, 'visual', 'field');
    expect(again.cached).toBe(true);
    expect(Buffer.compare(again.bytes, first.bytes)).toBe(0);
    expect(fake.calls.length).toBe(before);

    // NDVI colour map, field zoom: own key, same window and size, offset-aware expression.
    await sceneImage(deps, ownerId, farmId, item, 'ndvi', 'field');
    const ndviCall = imageCall(fake.calls);
    expect(parseImageCall(ndviCall)).toEqual(call);
    expect(new URL(ndviCall.url).searchParams.get('expression')).toBe('(B08-B04)/(B08+B04-2000)');
    expect(await h.storage.exists({ownerId, key: `ndvi/${farmId}/${item}/ndvi-field.png`})).toBe(true);
  });

  it('is a 409 outside live mode and makes no network call', async () => {
    const {farmId, ownerId} = await farmWithBoundary(owner);
    const fake = fakePlanetary(OCTOBER.slice(0, 2));
    for (const mode of ['synthetic', 'replay'] as const) {
      const deps = {...live(fake.fetchImpl), config: {RUNTIME_MODE: mode}, storage: h.storage};
      expect(await status(sceneImage(deps, ownerId, farmId, ID('2026-10-27'), 'visual', 'field'))).toBe(409);
    }
    expect(fake.calls.length).toBe(0);
  });
});

describe('today NDVI routes', () => {
  let liveApp: FastifyInstance, synthApp: FastifyInstance;
  const fake = fakePlanetary(OCTOBER.slice(1, 2));
  beforeAll(async () => {
    // The full server registers the plugin; the fake Planetary Computer is injected through its test hook.
    liveApp = await buildServer(testConfig({RUNTIME_MODE: 'live'}), h.pool, {storage: h.storage, today: {ndvi: {fetchImpl: fake.fetchImpl}}});
    synthApp = await buildServer(testConfig(), h.pool, {storage: h.storage, today: {ndvi: {fetchImpl: fake.fetchImpl}}});
  });
  afterAll(async () => { await liveApp?.close(); await synthApp?.close(); });
  const get = (app: FastifyInstance, c: Client, url: string) => app.inject({method: 'GET', url, headers: {cookie: c.cookie, origin: ORIGIN}});

  it('serves the owner series and a private image; strangers get 404; inputs are validated', async () => {
    const {farmId} = await farmWithBoundary(owner);
    const res = await get(liveApp, owner, `/api/v1/farms/${farmId}/ndvi?from=2026-10-01&to=2026-10-31`);
    expect(res.statusCode).toBe(200);
    const series = NdviSeries.parse(res.json().data);
    expect(series).toMatchObject({status: 'available', scenesAnalysed: 1, window: {from: '2026-10-01', to: '2026-10-31'}});
    const item = series.readings[0]!.itemId;
    const img = await get(liveApp, owner, `/api/v1/farms/${farmId}/ndvi/${item}/image?kind=visual`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toBe('private, max-age=3600');
    expect(img.rawPayload.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect((await get(liveApp, stranger, `/api/v1/farms/${farmId}/ndvi`)).statusCode).toBe(404);
    expect((await get(liveApp, stranger, `/api/v1/farms/${farmId}/ndvi/${item}/image`)).statusCode).toBe(404);
    expect((await liveApp.inject({method: 'GET', url: `/api/v1/farms/${farmId}/ndvi`, headers: {origin: ORIGIN}})).statusCode).toBe(401);
    expect((await get(liveApp, owner, `/api/v1/farms/${farmId}/ndvi/${item}/image?kind=infrared`)).statusCode).toBe(400);
    expect((await get(liveApp, owner, `/api/v1/farms/${farmId}/ndvi/bad%2Fid/image`)).statusCode).toBe(400);
    // zoom: wide (default) and field are served; anything else is a 400.
    const calls0 = fake.calls.length;
    expect((await get(liveApp, owner, `/api/v1/farms/${farmId}/ndvi/${item}/image?kind=visual&zoom=wide`)).statusCode).toBe(200);
    const fieldImg = await get(liveApp, owner, `/api/v1/farms/${farmId}/ndvi/${item}/image?kind=ndvi&zoom=field`);
    expect(fieldImg.statusCode).toBe(200);
    expect(fieldImg.headers['cache-control']).toBe('private, max-age=3600');
    expect(fieldImg.rawPayload.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(parseImageCall(imageCall(fake.calls)).width).toBeLessThan(40);
    expect(fake.calls.length).toBeGreaterThan(calls0);
    expect((await get(liveApp, owner, `/api/v1/farms/${farmId}/ndvi/${item}/image?zoom=close`)).statusCode).toBe(400);
    expect((await get(liveApp, owner, `/api/v1/farms/${farmId}/ndvi/${item}/image?zoom=`)).statusCode).toBe(400);
    expect((await get(liveApp, stranger, `/api/v1/farms/${farmId}/ndvi/${item}/image?zoom=field`)).statusCode).toBe(404);
    expect((await get(liveApp, owner, `/api/v1/farms/${farmId}/ndvi?from=2026-10-31&to=2026-10-01`)).statusCode).toBe(400);
    expect((await get(liveApp, owner, `/api/v1/farms/not-a-uuid/ndvi`)).statusCode).toBe(400);
  });

  it('answers unavailable in synthetic mode without network', async () => {
    const {farmId} = await farmWithBoundary(owner);
    const before = fake.calls.length;
    const res = await get(synthApp, owner, `/api/v1/farms/${farmId}/ndvi`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({status: 'unavailable', reason: 'live_mode_required'});
    expect((await get(synthApp, owner, `/api/v1/farms/${farmId}/ndvi/${ID('2026-10-27')}/image`)).statusCode).toBe(409);
    expect((await get(synthApp, owner, `/api/v1/farms/${farmId}/ndvi/${ID('2026-10-27')}/image?kind=ndvi&zoom=field`)).statusCode).toBe(409);
    expect(fake.calls.length).toBe(before);
  });
});
