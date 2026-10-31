import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {NdviSeries, NeighbourhoodSeasonality} from '@harvest/contracts';
import {buildServer} from '../src/server';
import {ndviSeries, neighbourhoodSeasonality, sceneImage, type NdviDeps} from '../src/services/today/ndvi';
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
    expect(fake.calls.length).toBe(before);
  });
});
