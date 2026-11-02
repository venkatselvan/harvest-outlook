import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {StageTimeline, TodayView, type FarmWorkspace} from '@harvest/contracts';
import {todayView, predictedScenes, AUTO_PREDICT_AFTER_DAYS, type TodayViewDeps} from '../src/services/today/view';
import {FUTURE_LOOK_JOB_TYPE, requestFutureLook} from '../src/services/today/future-look';
import type {DailyWeather, WeatherSource} from '../src/plans/sources';
import {eachDate} from '../src/plans/weather';
import {fakePlanetary, type FakeScene} from './fixtures/sentinel2/fake-provider';
import {farmBody, login, setupHarness, type Client, type Harness} from './helpers';

/**
 * SYNTHETIC: the farm, scenes, weather and timeline are test data; Planetary Computer and weather are injected fakes and
 * no Meta call is made (the view only queues a job). AI-predicted looks, FIELDS_MULTICROP_SOIL_SPEC.md section 11.
 */
const KEY = 'unit-test-key-not-real';
const HA_RING: [number, number][] = [[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]];
const HA = {type: 'Polygon', coordinates: [HA_RING]};
const ID = (date: string) => `S2A_MSIL2A_${date.replace(/-/g, '')}T052231_R062_T43PFQ_${date.replace(/-/g, '')}T101714`;
const scene = (date: string, ndvi: number): FakeScene => ({id: ID(date), datetime: `${date}T05:22:31.024Z`, field: {ndvi}, neighbourhood: {ndvi}});
const SCENES = [scene('2026-10-27', 0.63), scene('2026-10-12', 0.55)];
const LATEST = ID('2026-10-27');
/** 2026-11-04 09:30 IST (a Wednesday): the latest clear scene (27 Oct) is 8 days old; the week starts on Monday 2 Nov. */
const STALE_NOW = new Date('2026-11-04T04:00:00Z');
/** 2026-11-01 09:30 IST: the latest clear scene is 5 days old, not more. */
const FRESH_NOW = new Date('2026-11-01T04:00:00Z');

const st = (id: string, name: string, from: string, to: string) => ({id, name, from, to, basis: 'fao_generic' as const});
const basis = {kind: 'duration' as const, label: 'test timeline', sourceId: null, url: null, scope: null, note: null};
const MAIZE = StageTimeline.parse({
  cropId: 'maize', productId: null, establishmentMethod: null, anchorDate: '2026-09-20', harvest: {earliest: '2027-01-03', latest: '2027-01-08'}, basis,
  stages: [st('initial', 'Initial', '2026-09-20', '2026-10-10'), st('development', 'Crop development', '2026-10-10', '2026-11-14'), st('mid_season', 'Mid-season', '2026-11-14', '2026-12-24'), st('late_season', 'Late season', '2026-12-24', '2027-01-23')],
});

const dw = (date: string): DailyWeather => ({date, rainMm: 1, et0Mm: null, tMinC: 20, tMaxC: 30, sourceId: 'open-meteo-archive'});
const fakeWeather = (): WeatherSource => ({
  modes: ['live', 'replay', 'synthetic'],
  getDailyObservations: async (_s, range) => eachDate(range.start, range.end).map(dw),
  getForecast: async () => ({issuedAt: '2026-11-01T01:00:00Z', sourceId: 'open-meteo-forecast', days: eachDate('2026-11-01', '2026-11-10').map(dw)}),
  getClimatology: async (_s, range) => ({years: {from: 2019, to: 2025}, qualifyingYears: [2019, 2020, 2021, 2022, 2023, 2024, 2025], sourceId: 'open-meteo-archive', days: eachDate(range.start, range.end).map(dw)}),
  dataVersion: async () => 'v',
});

let h: Harness, owner: Client;
beforeAll(async () => { h = await setupHarness(); owner = await login(h.app); }, 60_000);
afterAll(async () => h?.close());
beforeEach(async () => { await h.pool.query("DELETE FROM provider_cache WHERE provider='planetary-computer-stac'"); vi.restoreAllMocks(); });

const ownerOf = async (farmId: string) => (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
const count = async (sql: string, args: unknown[]) => (await h.pool.query<{n: number}>(`SELECT count(*)::int AS n FROM ${sql}`, args)).rows[0]!.n;

async function farmWithCycle(): Promise<{farmId: string; ownerId: string}> {
  const farmId = (await owner.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id as string;
  const cycles = [{id: 'cycle-1', cropId: 'maize', cropName: 'Maize', sowingDate: '2026-09-20', stage: 'growing'}];
  const put = await owner.call('PUT', `/api/v1/farms/${farmId}/workspace`, {payload: {expectedVersion: 0, boundary: HA, previousHarvest: {status: 'unknown'}, cycles, rotationPlans: []}});
  expect(put.statusCode, put.body).toBe(200);
  return {farmId, ownerId: await ownerOf(farmId)};
}

function deps(now: Date, over: Partial<TodayViewDeps> = {}): TodayViewDeps {
  const fake = fakePlanetary(SCENES);
  return {
    config: {RUNTIME_MODE: 'live', MODEL_API_KEY: KEY}, pool: h.pool, now: () => now, sentinelFetch: fake.fetchImpl,
    snapshot: undefined, providers: {weatherSource: fakeWeather()}, ...over,
  };
}
/** The view computes its timeline from the repo data; these tests pin the timeline the request path sees via the view's own. */
const view = async (d: TodayViewDeps, ownerId: string, farmId: string) => TodayView.parse(await todayView(d, ownerId, farmId));

describe('todayView: automatic predicted look (live only)', () => {
  it(`requests one gap look for this week when the latest clear scene is more than ${AUTO_PREDICT_AFTER_DAYS} days old, then not again`, async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const v = await view(deps(STALE_NOW), ownerId, farmId);
    expect(v.predictions).toEqual({autoRequested: true, pending: 1, reason: null});
    const rows = (await h.pool.query("SELECT kind, target_date::text AS target, source_item_id, guidance, status, cycle_id FROM future_look_assets WHERE farm_id=$1", [farmId])).rows;
    expect(rows).toEqual([expect.objectContaining({kind: 'gap', target: '2026-11-02', source_item_id: LATEST, status: 'queued', cycle_id: 'cycle-1'})]);
    expect(rows[0].guidance).toMatch(/^6 days after the real image, in the .+ of maize: /);
    expect(rows[0].guidance).not.toMatch(/\d[.,]\d/);
    expect(await count("jobs WHERE owner_id=$1 AND type=$2 AND payload->>'farmId'=$3", [ownerId, FUTURE_LOOK_JOB_TYPE, farmId])).toBe(1);
    expect(v.limitations.join(' ')).toContain('The latest clear satellite image is 8 days old, so a predicted look for this week is being made with AI from the real image of 2026-10-27. It is not an observation.');

    const again = await view(deps(STALE_NOW), ownerId, farmId);
    expect(again.predictions).toEqual({autoRequested: false, pending: 1, reason: 'week_exists'});
    expect(await count('future_look_assets WHERE farm_id=$1', [farmId])).toBe(1);
    // A failed look of this week is not re-armed automatically.
    await h.pool.query("UPDATE future_look_assets SET status='failed', failure_reason='provider_bad_request' WHERE farm_id=$1", [farmId]);
    expect((await view(deps(STALE_NOW), ownerId, farmId)).predictions).toEqual({autoRequested: false, pending: 0, reason: 'auto_week_exists'});
    expect((await h.pool.query('SELECT attempt FROM future_look_assets WHERE farm_id=$1', [farmId])).rows).toEqual([{attempt: 1}]);
  });

  it(`does nothing while the latest clear scene is ${AUTO_PREDICT_AFTER_DAYS} days old or newer`, async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const v = await view(deps(FRESH_NOW), ownerId, farmId);
    expect(v.predictions).toEqual({autoRequested: false, pending: 0, reason: 'latest_scene_recent'});
    expect(await count('future_look_assets WHERE farm_id=$1', [farmId])).toBe(0);
  });

  it('makes at most 2 automatic gap requests per farm in 24 hours', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    // Two gap rows of this farm made in the last 24 hours (other cycles), so the farm is at the cap.
    for (const cycleId of ['old-cycle-a', 'old-cycle-b']) {
      await h.pool.query(
        `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, source_acquired_at, stage_id, stage_name, crop_id, crop_name, prompt_version, status, kind, target_date, guidance)
         VALUES ($1,$2,$3,$4,'2026-10-27T05:22:31Z','development','Crop development','maize','Maize','future-look-v2','failed','gap','2026-11-02','test guidance')`,
        [ownerId, farmId, cycleId, LATEST]);
    }
    const v = await view(deps(STALE_NOW), ownerId, farmId);
    expect(v.predictions).toEqual({autoRequested: false, pending: 0, reason: 'auto_daily_limit'});
    expect(await count("future_look_assets WHERE farm_id=$1 AND cycle_id='cycle-1'", [farmId])).toBe(0);
    await h.pool.query("UPDATE future_look_assets SET created_at = now() - interval '25 hours' WHERE farm_id=$1", [farmId]);
    expect((await view(deps(STALE_NOW), ownerId, farmId)).predictions).toMatchObject({autoRequested: true});
  });

  it('never runs in synthetic or replay mode (no request, no row, no predictions)', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    for (const mode of ['synthetic', 'replay'] as const) {
      const spy = vi.fn(requestFutureLook);
      const pending = vi.fn(async () => 0);
      const v = await view(deps(STALE_NOW, {config: {RUNTIME_MODE: mode, MODEL_API_KEY: KEY}, providers: {weatherSource: fakeWeather(), requestFutureLook: spy, pendingGapLooks: pending}}), ownerId, farmId);
      expect(v.predictions, mode).toBeNull();
      expect(spy, mode).not.toHaveBeenCalled();
      expect(pending, mode).not.toHaveBeenCalled();
    }
    expect(await count('future_look_assets WHERE farm_id=$1', [farmId])).toBe(0);
  });

  it('a failing request never fails the view: the section is empty and named in the limitations', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const boom = vi.fn(async () => { throw new Error('database hiccup'); });
    const v = await view(deps(STALE_NOW, {providers: {weatherSource: fakeWeather(), requestFutureLook: boom as never}}), ownerId, farmId);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(v.predictions).toBeNull();
    expect(v.limitations).toContain('The AI predicted look could not be read now (internal_error); that part of the view is left empty.');
    expect(v.scenes.some((s) => s.kind === 'observed')).toBe(true);
  });

  it('lists a ready gap look as a predicted scene dated at its target, with the guidance and the source scene', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    await view(deps(STALE_NOW), ownerId, farmId);
    const row = (await h.pool.query<{id: string; guidance: string}>('SELECT id, guidance FROM future_look_assets WHERE farm_id=$1', [farmId])).rows[0]!;
    await h.pool.query("UPDATE future_look_assets SET status='ready', storage_key=$2, billed=true WHERE id=$1", [row.id, `future-look/${farmId}/${row.id}.png`]);
    const v = await view(deps(STALE_NOW), ownerId, farmId);
    const predicted = v.scenes.filter((s) => s.kind === 'predicted');
    expect(predicted).toEqual([{
      date: '2026-11-02', kind: 'predicted', itemId: null, acquisitionDate: '2026-10-27', cloudPct: expect.any(Number),
      imagePath: `/api/v1/farms/${farmId}/future-look/${row.id}/image`, ndviImagePath: null, derivedFromItemId: LATEST,
      stageId: expect.any(String), targetDate: '2026-11-02', guidance: row.guidance,
    }]);
    expect(v.predictions).toEqual({autoRequested: false, pending: 0, reason: 'week_exists'});
    expect(v.limitations.join(' ')).toContain('Predicted looks are AI image edits (Meta) of the latest real satellite image of this field');
    // Scenes stay date-ordered: the predicted one follows the observed scenes.
    expect(v.scenes.at(-1)).toMatchObject({kind: 'predicted'});
  });
});

describe('predictedScenes (pure)', () => {
  type Look = Parameters<typeof predictedScenes>[0][number];
  const look = (o: Partial<Look>): Look => ({assetId: 'a', stageId: 'development', sourceItemId: LATEST, cropId: 'maize', createdAt: '2026-11-04T00:00:00.000Z', imagePath: '/api/v1/farms/f/future-look/a/image', kind: 'gap', targetDate: '2026-11-02', guidance: 'g', ...o});
  const cycle = {id: 'c', cropId: 'maize', cropName: 'Maize', sowingDate: '2026-09-20', stage: 'growing'} as FarmWorkspace['cycles'][number];

  it('keeps the newest look per week, skips stage looks and other crops, and carries ?fieldId= for a field cycle', () => {
    const out = predictedScenes([
      look({assetId: 'old', imagePath: '/x/old/image', createdAt: '2026-11-03T00:00:00.000Z'}),
      look({assetId: 'new', imagePath: '/x/new/image', targetDate: '2026-11-03', createdAt: '2026-11-04T00:00:00.000Z'}),
      look({assetId: 'stage', kind: 'stage', targetDate: '2026-11-14'}),
      look({assetId: 'wheat', cropId: 'wheat', targetDate: '2026-11-09'}),
    ], {...cycle, fieldId: 'north strip'} as typeof cycle, MAIZE, new Map());
    expect(out.skipped).toBe(1);
    expect(out.scenes).toEqual([expect.objectContaining({kind: 'predicted', date: '2026-11-03', targetDate: '2026-11-03', imagePath: '/x/new/image?fieldId=north%20strip', stageId: 'development', guidance: 'g'})]);
    expect(predictedScenes([look({})], cycle, null, new Map()).scenes[0]).toMatchObject({imagePath: '/api/v1/farms/f/future-look/a/image', stageId: null});
  });
});
