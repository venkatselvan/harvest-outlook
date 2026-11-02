import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import sharp from 'sharp';
import type {FastifyInstance} from 'fastify';
import {FutureLookAsset, StageTimeline} from '@harvest/contracts';
import {buildServer} from '../src/server';
import {Budget} from '../src/services/budget';
import {ApiError} from '../src/services/errors';
import {ndviSeries, type NdviDeps, type SceneImage} from '../src/services/today/ndvi';
import {
  FUTURE_LOOK_CYCLE_CAP, FUTURE_LOOK_JOB_TYPE, FUTURE_QA_OUTSIDE_CHANNEL_MAX, PREDICTED_LOOK_DISCLAIMER, buildFutureLookPrompt, evaluateFutureLook, futureLookField, futureLookImage,
  futureLookStatus, listReadyFutureLooks, pendingGapLooks, requestFutureLook, ringToImage, toFutureLookAsset, type FutureLookDeps, type FutureLookRow,
} from '../src/services/today/future-look';
import {createFutureLookHandler, runFutureLook, type FutureLookHandlerDeps} from '../src/worker/handlers/future-look';
import {claimDispatch} from '../src/visuals/dispatch';
import {displayBbox, prepareRing} from '../src/providers/sentinel2';
import {rasterizePolygon} from '../src/visuals/qa';
import {dataUrlToBuffer, providerOk} from './fixtures/muse-image/build';
import {fakePlanetary, type FakeScene} from './fixtures/sentinel2/fake-provider';
import {farmBody, login, ORIGIN, setupHarness, testConfig, type Client, type Harness} from './helpers';

// SYNTHETIC: the Meta image transport, the Planetary Computer and the scene image are fakes. Nothing here calls a provider.
const KEY = 'unit-test-key-not-real';
const LIVE = {RUNTIME_MODE: 'live', MODEL_API_KEY: KEY};
const NOW = () => new Date('2026-11-01T06:00:00Z');
const HA_RING: [number, number][] = [[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]];
const HA = {type: 'Polygon', coordinates: [HA_RING]};
const ID = (date: string) => `S2A_MSIL2A_${date.replace(/-/g, '')}T052231_R062_T43PFQ_${date.replace(/-/g, '')}T101714`;
const scene = (date: string, ndvi: number): FakeScene => ({id: ID(date), datetime: `${date}T05:22:31.024Z`, field: {ndvi}, neighbourhood: {ndvi}});
const LATEST = ID('2026-10-27');
const hb = {heartbeat: async () => undefined};

const st = (id: string, name: string, from: string, to: string) => ({id, name, from, to, basis: 'fao_generic' as const});
const basis = {kind: 'duration' as const, label: 'test timeline', sourceId: null, url: null, scope: null, note: null};
/** Fixed timelines (the real stage-timeline module is another worker's and reads evolving data files). */
const MAIZE = StageTimeline.parse({
  cropId: 'maize', productId: null, establishmentMethod: null, anchorDate: '2026-09-20', harvest: {earliest: '2027-01-03', latest: '2027-01-08'}, basis,
  stages: [st('initial', 'Initial', '2026-09-20', '2026-10-10'), st('development', 'Crop development', '2026-10-10', '2026-11-14'), st('mid_season', 'Mid-season', '2026-11-14', '2026-12-24'), st('late_season', 'Late season', '2026-12-24', '2027-01-23')],
});
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const LONG = StageTimeline.parse({...MAIZE, stages: Array.from({length: 12}, (_, i) => st(`s${i + 1}`, `Stage ${i + 1}`, plusDays('2026-11-02', i * 3), plusDays('2026-11-04', i * 3)))});
const NUMBER_WITH_DECIMAL = /\d[.,]\d/;

let h: Harness, owner: Client, stranger: Client;
beforeAll(async () => { h = await setupHarness(); owner = await login(h.app); stranger = await login(h.app); });
afterAll(async () => h?.close());
beforeEach(async () => { await h.pool.query("DELETE FROM provider_cache WHERE provider='planetary-computer-stac'"); });

const svc = (over: Partial<FutureLookDeps> = {}): FutureLookDeps => ({config: {RUNTIME_MODE: 'live', MODEL_API_KEY: KEY}, pool: h.pool, now: NOW, timeline: () => MAIZE, ...over});
const ownerOf = async (farmId: string) => (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
const errOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof ApiError ? {status: e.statusCode, code: e.code, details: e.details as Record<string, unknown> | undefined} : {status: 500, code: String(e)}));

/** A farm with the 1 ha test boundary, a maize cycle and two analysed usable scenes (latest 2026-10-27). */
async function farmWithCycle(client: Client = owner) {
  const farmId = (await client.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id as string;
  const cycles = [{id: 'cycle-1', cropId: 'maize', cropName: 'Maize', sowingDate: '2026-09-20', stage: 'growing'}];
  const put = await client.call('PUT', `/api/v1/farms/${farmId}/workspace`, {payload: {expectedVersion: 0, boundary: HA, previousHarvest: {status: 'unknown'}, cycles, rotationPlans: []}});
  expect(put.statusCode, put.body).toBe(200);
  const ownerId = await ownerOf(farmId);
  const fake = fakePlanetary([scene('2026-10-27', 0.63), scene('2026-10-12', 0.55)]);
  const nd: NdviDeps = {config: {RUNTIME_MODE: 'live'}, pool: h.pool, fetchImpl: fake.fetchImpl, now: NOW};
  expect((await ndviSeries(nd, ownerId, farmId)).latestUsable?.itemId).toBe(LATEST);
  return {farmId, ownerId};
}

const RING = prepareRing(HA_RING)!;
const BBOX = displayBbox(RING);
const FIELD = ringToImage(RING, BBOX);
const inPoly = (x: number, y: number) => {
  let c = false;
  for (let i = 0, j = FIELD.length - 1; i < FIELD.length; j = i++) {
    const [xi, yi] = FIELD[i]!, [xj, yj] = FIELD[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/** Textured 512x512 "satellite" scene: gradients plus a block pattern, so differences are measurable. */
async function scenePng(): Promise<Buffer> {
  const w = 512, raw = Buffer.alloc(w * w * 3);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, block = ((x >> 5) + (y >> 5)) % 2 ? 25 : 0;
    raw[i] = 70 + Math.round((x / w) * 80) + block; raw[i + 1] = 90 + Math.round((y / w) * 70); raw[i + 2] = 60 + block;
  }
  return sharp(raw, {raw: {width: w, height: w, channels: 3}}).png().toBuffer();
}
let SCENE: Buffer;
const fakeScene = vi.fn(async (): Promise<SceneImage> => ({bytes: SCENE, contentType: 'image/png', acquiredAt: '2026-10-27T05:22:31.024Z', bbox: BBOX, cached: true}));

/** Provider doubles: return the sent image (upscaled 2x like the live service) with only the field edited, or everything changed. */
async function edited(sent: Buffer, mode: 'field' | 'all'): Promise<Buffer> {
  const {data, info} = await sharp(sent).removeAlpha().raw().toBuffer({resolveWithObject: true});
  const out = Buffer.from(data);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 3;
    if (mode === 'all') { out[i] = 255 - out[i]!; out[i + 1] = 255 - out[i + 1]!; out[i + 2] = 255 - out[i + 2]!; }
    else if (inPoly((x + 0.5) / info.width, (y + 0.5) / info.height)) { out[i] = 30; out[i + 1] = 170; out[i + 2] = 40; }
  }
  return sharp(out, {raw: {width: info.width, height: info.height, channels: 3}}).resize(info.width * 2, info.height * 2).png().toBuffer();
}
const editFetch = (mode: 'field' | 'all') => vi.fn(async (_u: string, init: RequestInit) => providerOk(await edited(dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url), mode), 'req_fixture_fl'));
const statusFetch = (...statuses: number[]) => { let n = 0; return vi.fn(async () => new Response('{}', {status: statuses[Math.min(n++, statuses.length - 1)]!})); };

function handlerDeps(fetchImpl: unknown, over: Record<string, string> = {}): FutureLookHandlerDeps {
  const config = testConfig({...LIVE, ...over});
  return {config, pool: h.pool, storage: h.storage, budget: Budget.fromConfig(h.pool, config), fetchImpl: fetchImpl as typeof fetch, sleep: async () => undefined, sceneImage: fakeScene};
}
const assetRow = async (id: string) => (await h.pool.query('SELECT * FROM future_look_assets WHERE id=$1', [id])).rows[0];
const jobOf = async (assetId: string) => (await h.pool.query<{id: string; owner_id: string; payload: unknown; idempotency_key: string}>('SELECT j.id, j.owner_id, j.payload, j.idempotency_key FROM jobs j JOIN future_look_assets a ON a.job_id=j.id WHERE a.id=$1', [assetId])).rows[0]!;
const reservation = async (jobId: string) => (await h.pool.query<{state: string; estimated_usd: string; settled_usd: string | null}>('SELECT state, estimated_usd, settled_usd FROM usage_reservations WHERE job_id=$1', [jobId])).rows;
const count = async (sql: string, args: unknown[]) => (await h.pool.query<{n: number}>(`SELECT count(*)::int AS n FROM ${sql}`, args)).rows[0]!.n;

beforeAll(async () => { SCENE = await scenePng(); });

describe('requestFutureLook', () => {
  it('queues one job per tuple; a repeat returns the same asset without a second job', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const first = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season', cycleId: 'cycle-1'});
    expect(first).toMatchObject({status: 'queued', deduplicated: false, cycleId: 'cycle-1', stageId: 'mid_season', reason: null});
    const again = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'}); // default cycle = cycle-1
    expect(again).toMatchObject({assetId: first.assetId, status: 'queued', deduplicated: true});
    expect(await count("jobs WHERE owner_id=$1 AND type=$2 AND payload->>'farmId'=$3", [ownerId, FUTURE_LOOK_JOB_TYPE, farmId])).toBe(1);
    const job = await jobOf(first.assetId!);
    expect(job.idempotency_key).toBe(`fl:${first.assetId}:1`);
    expect(job.payload).toEqual({assetId: first.assetId, farmId, sessionId: null});
    const row = await assetRow(first.assetId!);
    expect(row).toMatchObject({owner_id: ownerId, farm_id: farmId, cycle_id: 'cycle-1', stage_id: 'mid_season', stage_name: 'Mid-season', crop_id: 'maize', crop_name: 'Maize', source_item_id: LATEST, prompt_version: 'future-look-v3', status: 'queued', attempt: 1, billed: false, kind: 'stage', target_week: null});
    // Prompt v2: a stage look is guided from the real scene (27 Oct) to the stage start (14 Nov); no NDVI number in it.
    expect(first).toMatchObject({kind: 'stage', targetDate: '2026-11-14'});
    expect(row.guidance).toBe('18 days after the real image, in the mid-season stage of maize: a full, closed canopy of deep green covers the ground.');
  });

  it('keeps one asset per stage: after a newer scene arrives the stage returns its existing asset, and only the latest scene is accepted', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const a = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'late_season'});
    const field = await futureLookField(h.pool, ownerId, farmId);
    if ('reason' in field) throw new Error(field.reason);
    const newer = ID('2026-10-30');
    await h.pool.query(`INSERT INTO ndvi_scene_stats(owner_id,farm_id,polygon_hash,item_id,acquired_at,baseline,scene_cloud_pct,field_stats,usable)
      SELECT owner_id,farm_id,polygon_hash,$2,'2026-10-30T05:22:31Z',baseline,scene_cloud_pct,field_stats,true FROM ndvi_scene_stats WHERE farm_id=$1 AND item_id=$3`, [farmId, newer, LATEST]);
    const b = await requestFutureLook(svc(), ownerId, farmId, {itemId: newer, stageId: 'late_season'});
    expect(b).toMatchObject({assetId: a.assetId, deduplicated: true, status: 'queued'});
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'}))).toMatchObject({status: 409, details: {reason: 'scene_not_latest', latestItemId: newer}});
  });

  it('caps a farm cycle at 10 queued/running/ready or billed assets', async () => {
    expect(FUTURE_LOOK_CYCLE_CAP).toBe(10);
    const {farmId, ownerId} = await farmWithCycle();
    const deps = svc({timeline: () => LONG});
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) ids.push((await requestFutureLook(deps, ownerId, farmId, {itemId: LATEST, stageId: `s${i}`})).assetId!);
    expect(new Set(ids).size).toBe(10);
    expect(await requestFutureLook(deps, ownerId, farmId, {itemId: LATEST, stageId: 's11'})).toMatchObject({assetId: null, status: 'unavailable', reason: 'cycle_limit_reached'});
    // Gap looks share the cap.
    expect(await requestFutureLook(deps, ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-20'})).toMatchObject({assetId: null, status: 'unavailable', reason: 'cycle_limit_reached', kind: 'gap'});
    expect(await count('future_look_assets WHERE farm_id=$1', [farmId])).toBe(10);
    // A failure that was not billed frees its slot; a billed failure keeps it.
    await h.pool.query("UPDATE future_look_assets SET status='failed', failure_reason='provider_bad_request' WHERE id=$1", [ids[0]]);
    expect(await requestFutureLook(deps, ownerId, farmId, {itemId: LATEST, stageId: 's11'})).toMatchObject({status: 'queued'});
    await h.pool.query("UPDATE future_look_assets SET status='failed', failure_reason='qa_scene_changed_outside_field', billed=true WHERE id=$1", [ids[1]]);
    expect(await requestFutureLook(deps, ownerId, farmId, {itemId: LATEST, stageId: 's12'})).toMatchObject({status: 'unavailable', reason: 'cycle_limit_reached'});
    // The billed failure is final for its tuple: requesting it again returns the failed row, no new job.
    const jobs = await count("jobs WHERE payload->>'farmId'=$1", [farmId]);
    expect(await requestFutureLook(deps, ownerId, farmId, {itemId: LATEST, stageId: 's2'})).toMatchObject({assetId: ids[1], status: 'failed', reason: 'qa_scene_changed_outside_field', deduplicated: true});
    expect(await count("jobs WHERE payload->>'farmId'=$1", [farmId])).toBe(jobs);
  });

  it('validates the stage, the cycle and the scene', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'initial'}))).toMatchObject({status: 409, details: {reason: 'stage_in_past'}});
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'tasselling'}))).toMatchObject({status: 422, code: 'unknown_stage'});
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season', cycleId: 'nope'}))).toMatchObject({status: 404});
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: ID('2026-10-12'), stageId: 'mid_season'}))).toMatchObject({status: 409, details: {reason: 'scene_not_latest'}});
    // farmWithCycle has no fields, so the farm-wide fallback still finds its cycle (the rejection above is about the scene, not the cycle).
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: 'bad id!', stageId: 'mid_season'}))).toMatchObject({status: 400});
    expect(await count('future_look_assets WHERE farm_id=$1', [farmId])).toBe(0);
  });

  it('synthetic and replay mode, or no model key: unavailable with no row, no job and no provider call', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    for (const RUNTIME_MODE of ['synthetic', 'replay'] as const) {
      expect(await requestFutureLook(svc({config: {RUNTIME_MODE, MODEL_API_KEY: KEY}}), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'}))
        .toEqual({assetId: null, status: 'unavailable', reason: 'live_mode_required', cycleId: null, stageId: 'mid_season', deduplicated: false});
    }
    expect(await requestFutureLook(svc({config: {RUNTIME_MODE: 'live'}}), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'})).toMatchObject({status: 'unavailable', reason: 'provider_unavailable'});
    expect(await count('future_look_assets WHERE farm_id=$1', [farmId])).toBe(0);
    expect(await count("jobs WHERE owner_id=$1 AND type=$2 AND payload->>'farmId'=$3", [ownerId, FUTURE_LOOK_JOB_TYPE, farmId])).toBe(0);
    // A queued row picked up by a worker running in synthetic mode makes no provider or scene call.
    const queued = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    const f = editFetch('field');
    fakeScene.mockClear();
    const out = await runFutureLook(handlerDeps(f, {RUNTIME_MODE: 'synthetic'}), await jobOf(queued.assetId!), hb);
    expect(out).toMatchObject({status: 'unavailable', reason: 'live_mode_required', providerCalls: 0, cost: null});
    expect(f).not.toHaveBeenCalled();
    expect(fakeScene).not.toHaveBeenCalled();
    expect(await count('usage_reservations WHERE job_id=$1', [(await jobOf(queued.assetId!)).id])).toBe(0);
  });

  it('isolates owners: another owner gets 404 for the farm, the asset and the list', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const {farmId: otherFarm, ownerId: otherOwner} = await farmWithCycle(stranger);
    const mine = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    expect(await errOf(requestFutureLook(svc(), otherOwner, farmId, {itemId: LATEST, stageId: 'mid_season'}))).toMatchObject({status: 404});
    expect(await errOf(futureLookStatus(svc(), otherOwner, farmId, mine.assetId!))).toMatchObject({status: 404});
    expect(await errOf(futureLookStatus(svc(), otherOwner, otherFarm, mine.assetId!))).toMatchObject({status: 404});
    expect(await errOf(futureLookImage({...svc(), storage: h.storage}, otherOwner, otherFarm, mine.assetId!))).toMatchObject({status: 404});
    expect(await errOf(listReadyFutureLooks(svc(), otherOwner, farmId, 'cycle-1'))).toMatchObject({status: 404});
    expect(await futureLookStatus(svc(), ownerId, farmId, mine.assetId!)).toMatchObject({assetId: mine.assetId, status: 'queued'});
  });
});

describe('today.future-look handler', () => {
  it('generates, passes QA, stores the PNG, settles one image and is listed for the Today view', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const req = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    const job = await jobOf(req.assetId!);
    const f = editFetch('field');
    const out = await createFutureLookHandler(handlerDeps(f))(job as never, {...hb, pool: h.pool, isCancelled: async () => false});
    expect(out).toMatchObject({status: 'ready', reason: null, providerCalls: 1, cost: {reservedUsd: 0.02, settledUsd: 0.01, images: 1, outcome: 'settled'}, qa: {passed: true}});
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({model: 'muse-image-1.0', n: 1, size: '512x512', response_format: 'b64_json', output_format: 'png', tool_enablement: {enable_image_search: false, enable_web_search: false, enable_shell: false}});
    expect(body.images[0].image_url).toMatch(/^data:image\/jpeg;base64,/);
    const guidance = (await assetRow(req.assetId!)).guidance as string;
    expect(body.prompt).toBe(buildFutureLookPrompt({stageId: 'mid_season', stageName: 'Mid-season', cropName: 'Maize', kind: 'stage', guidance}));
    expect(body.prompt).toContain('typical mid-season stage of maize: a full, dense green crop canopy covering the ground. Expected change: 18 days after the real image');
    expect(body.prompt).toContain('Keep the red outline exactly where it is, with the same shape and size; do not redraw, move, widen or resize it. No text, no labels');
    expect(body.prompt).not.toMatch(NUMBER_WITH_DECIMAL);
    const qa = (out as {qa: {scores: {outsideMaxChannelMad: number; insideMeanAbsDiff: number}}}).qa;
    expect(qa.scores.outsideMaxChannelMad).toBeLessThan(0.03);
    expect(qa.scores.insideMeanAbsDiff).toBeGreaterThan(0.1);

    const row = await assetRow(req.assetId!);
    expect(row).toMatchObject({status: 'ready', billed: true, model: 'muse-image-1.0', response_deleted: null, provider_request_id: 'req_fixture_fl', storage_key: `future-look/${farmId}/${req.assetId}.png`});
    const stored = await h.storage.get({ownerId, key: row.storage_key});
    expect(await sharp(Buffer.from(stored)).metadata()).toMatchObject({format: 'png', width: 512, height: 512});
    expect(await reservation(job.id)).toEqual([{state: 'settled', estimated_usd: '0.020000', settled_usd: '0.010000'}]);
    expect((await h.pool.query("SELECT purpose, status FROM ai_invocations WHERE owner_id=$1 AND started_at >= now() - interval '1 minute'", [ownerId])).rows).toEqual([{purpose: 'future_look', status: 'succeeded'}]);
    expect((await h.pool.query('SELECT outcome FROM job_dispatches WHERE job_id=$1', [job.id])).rows).toEqual([{outcome: 'completed'}]);

    const asset = FutureLookAsset.parse(await futureLookStatus(svc(), ownerId, farmId, req.assetId!));
    expect(asset).toMatchObject({status: 'ready', label: 'Illustration of a typical Mid-season stage', derivedFromDate: '2026-10-27', imagePath: `/api/v1/farms/${farmId}/future-look/${req.assetId}/image`, responseDeleted: null, kind: 'stage', targetDate: '2026-11-14', guidance});
    const img = await futureLookImage({...svc(), storage: h.storage}, ownerId, farmId, req.assetId!);
    expect(img.bytes.equals(Buffer.from(stored))).toBe(true);
    expect(await listReadyFutureLooks(svc(), ownerId, farmId, 'cycle-1')).toEqual([{assetId: req.assetId, stageId: 'mid_season', sourceItemId: LATEST, cropId: 'maize', createdAt: asset.createdAt, imagePath: asset.imagePath, kind: 'stage', targetDate: '2026-11-14', guidance}]);
    expect(await listReadyFutureLooks(svc({config: {RUNTIME_MODE: 'synthetic'}}), ownerId, farmId, 'cycle-1')).toEqual([]);
    // Ready is final: the same stage returns it, and re-running the job does nothing.
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'})).toMatchObject({assetId: req.assetId, status: 'ready', deduplicated: true});
    expect(await runFutureLook(handlerDeps(f), job, hb)).toMatchObject({status: 'skipped'});
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('QA rejects an output whose surroundings changed: billed, settled, not stored, final for the tuple', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const req = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    const job = await jobOf(req.assetId!);
    const out = await runFutureLook(handlerDeps(editFetch('all')), job, hb);
    expect(out).toMatchObject({status: 'failed', reason: 'qa_scene_changed_outside_field', cost: {settledUsd: 0.01, outcome: 'settled'}, qa: {passed: false, reasons: ['scene_changed_outside_field']}});
    expect(out.qa!.scores.outsideMaxChannelMad!).toBeGreaterThan(FUTURE_QA_OUTSIDE_CHANNEL_MAX);
    const row = await assetRow(req.assetId!);
    expect(row).toMatchObject({status: 'failed', billed: true, storage_key: null, failure_reason: 'qa_scene_changed_outside_field'});
    expect(await h.storage.exists({ownerId, key: `future-look/${farmId}/${req.assetId}.png`})).toBe(false);
    expect(await reservation(job.id)).toEqual([{state: 'settled', estimated_usd: '0.020000', settled_usd: '0.010000'}]);
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'})).toMatchObject({assetId: req.assetId, status: 'failed', deduplicated: true});
    expect(await errOf(futureLookImage({...svc(), storage: h.storage}, ownerId, farmId, req.assetId!))).toMatchObject({status: 404});
  });

  it('releases the reservation when the provider refuses, and the next request re-arms the same asset', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const req = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    const job = await jobOf(req.assetId!);
    const f = statusFetch(400);
    expect(await runFutureLook(handlerDeps(f), job, hb)).toMatchObject({status: 'failed', reason: 'provider_bad_request', cost: {settledUsd: 0, images: 0, outcome: 'released'}});
    expect(await reservation(job.id)).toMatchObject([{state: 'released'}]);
    expect(await assetRow(req.assetId!)).toMatchObject({status: 'failed', billed: false});
    const again = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    expect(again).toMatchObject({assetId: req.assetId, status: 'queued', deduplicated: false});
    const job2 = await jobOf(req.assetId!);
    expect(job2.idempotency_key).toBe(`fl:${req.assetId}:2`);
    expect(await runFutureLook(handlerDeps(editFetch('field')), job2, hb)).toMatchObject({status: 'ready'});
    // The earlier job no longer owns the row.
    expect(await runFutureLook(handlerDeps(f), job, hb)).toMatchObject({status: 'skipped'});
  });

  it('retries once on 429, then releases; a lost outcome is held as uncertain and never re-sent', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const a = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    const f429 = statusFetch(429, 429);
    expect(await runFutureLook(handlerDeps(f429), await jobOf(a.assetId!), hb)).toMatchObject({status: 'failed', reason: 'provider_rate_limited', cost: {outcome: 'released'}});
    expect(f429).toHaveBeenCalledTimes(2);

    const b = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'late_season'});
    const jb = await jobOf(b.assetId!);
    const lost = vi.fn(async () => { throw Object.assign(new Error('socket hang up'), {name: 'TypeError'}); });
    expect(await runFutureLook(handlerDeps(lost), jb, hb)).toMatchObject({status: 'failed', reason: 'provider_network', cost: {outcome: 'uncertain'}});
    expect(lost).toHaveBeenCalledTimes(1);
    expect(await reservation(jb.id)).toMatchObject([{state: 'uncertain'}]);
    expect(await assetRow(b.assetId!)).toMatchObject({status: 'failed', billed: true});
    expect((await h.pool.query('SELECT outcome FROM job_dispatches WHERE job_id=$1', [jb.id])).rows).toEqual([{outcome: 'uncertain'}]);
  });

  it('a crash after the dispatch marker: the re-claimed job makes no call and holds the reservation as uncertain', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const req = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    const job = await jobOf(req.assetId!);
    const deps = handlerDeps(editFetch('field'));
    const {reservationId} = await deps.budget.reserve({ownerId, sessionId: null, provider: 'meta', model: 'muse-image-1.0', estimate: 0.02, jobId: job.id});
    expect(await claimDispatch(h.pool, job.id, 'future-look', reservationId)).toBe(true); // ...and the process died here
    const f = editFetch('field');
    expect(await runFutureLook({...deps, fetchImpl: f as unknown as typeof fetch}, job, hb)).toMatchObject({status: 'failed', reason: 'uncertain_needs_review'});
    expect(f).not.toHaveBeenCalled();
    expect(await reservation(job.id)).toMatchObject([{state: 'uncertain'}]);
    expect(await assetRow(req.assetId!)).toMatchObject({status: 'failed', billed: true});
  });

  it('a crash between reserve and dispatch: the stale reservation is released and the call is made once', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const req = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    const job = await jobOf(req.assetId!);
    const deps = handlerDeps(editFetch('field'));
    await deps.budget.reserve({ownerId, sessionId: null, provider: 'meta', model: 'muse-image-1.0', estimate: 0.02, jobId: job.id}); // ...then the process died
    expect(await runFutureLook(deps, job, hb)).toMatchObject({status: 'ready', providerCalls: 1});
    expect((await reservation(job.id)).map((r) => r.state).sort()).toEqual(['released', 'settled']);
  });

  it('budget exhausted: no call, the asset is unavailable and can be requested again later', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const req = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    const f = editFetch('field');
    expect(await runFutureLook(handlerDeps(f, {BUDGET_PER_OWNER_DAY_USD: '0.015'}), await jobOf(req.assetId!), hb)).toMatchObject({status: 'unavailable', reason: 'budget_exceeded', providerCalls: 0, cost: null});
    expect(f).not.toHaveBeenCalled();
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'})).toMatchObject({assetId: req.assetId, status: 'queued', deduplicated: false});
  });

  it('a status read closes a row whose job failed outside the handler', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const req = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'});
    await h.pool.query("UPDATE jobs SET state='failed' WHERE id=$1", [(await jobOf(req.assetId!)).id]);
    expect(await futureLookStatus(svc(), ownerId, farmId, req.assetId!)).toMatchObject({status: 'failed', failureReason: 'job_failed'});
    expect(await assetRow(req.assetId!)).toMatchObject({status: 'failed', billed: false});
  });
});

describe('evaluateFutureLook (deterministic QA)', () => {
  it('passes an unchanged surrounding, fails a global tint and an aspect change', async () => {
    const field: [number, number][] = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]];
    expect(await evaluateFutureLook({input: SCENE, output: SCENE, field})).toMatchObject({passed: true, scores: {outsideMaxChannelMad: 0, insideMeanAbsDiff: 0}});
    const tinted = await sharp(SCENE).linear([1, 1, 1], [0, 0, 30]).png().toBuffer(); // blue +30 everywhere
    const t = await evaluateFutureLook({input: SCENE, output: tinted, field});
    expect(t).toMatchObject({passed: false, reasons: ['scene_changed_outside_field']});
    expect(t.scores.outsideChannelMad!.b).toBeGreaterThan(0.1);
    expect(t.scores.outsideChannelMad!.r).toBeLessThan(0.01);
    const wide = await sharp(SCENE).resize(768, 512, {fit: 'fill'}).png().toBuffer();
    expect(await evaluateFutureLook({input: SCENE, output: wide, field})).toMatchObject({passed: false, reasons: ['aspect_mismatch']});
    expect(await evaluateFutureLook({input: SCENE, output: Buffer.from('not an image'), field})).toMatchObject({passed: false, reasons: ['output_undecodable']});
  });
});

describe('routes (registered on a test server)', () => {
  let liveApp: FastifyInstance, synthApp: FastifyInstance;
  const routeDeps = () => ({now: NOW, timeline: () => MAIZE});
  beforeAll(async () => {
    liveApp = await buildServer(testConfig(LIVE), h.pool, {storage: h.storage, today: {future: routeDeps()}});
    synthApp = await buildServer(testConfig(), h.pool, {storage: h.storage, today: {future: routeDeps()}});
  });
  afterAll(async () => { await liveApp?.close(); await synthApp?.close(); });
  const call = (app: FastifyInstance, c: Client, method: 'GET' | 'POST', url: string) =>
    app.inject({method, url, headers: {cookie: c.cookie, origin: ORIGIN, ...(method === 'POST' ? {'x-csrf-token': c.csrf} : {})}});

  it('202 then the same asset, status JSON, private PNG once ready, 404 for strangers, unavailable in synthetic mode, 6 per minute', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const url = `/api/v1/farms/${farmId}/ndvi/${LATEST}/future?stageId=mid_season&cycleId=cycle-1`;
    const first = await call(liveApp, owner, 'POST', url);
    expect(first.statusCode, first.body).toBe(202);
    const assetId = first.json().data.assetId as string;
    const second = await call(liveApp, owner, 'POST', url);
    expect(second.statusCode).toBe(202);
    expect(second.json().data).toMatchObject({assetId, deduplicated: true});
    expect((await call(liveApp, stranger, 'POST', url)).statusCode).toBe(404);
    expect((await call(liveApp, owner, 'POST', `/api/v1/farms/${farmId}/ndvi/${LATEST}/future?stageId=initial`)).statusCode).toBe(409);

    const status = await call(liveApp, owner, 'GET', `/api/v1/farms/${farmId}/future-look/${assetId}`);
    expect(status.statusCode).toBe(200);
    expect(FutureLookAsset.parse(status.json().data)).toMatchObject({status: 'queued', imagePath: null});
    expect((await call(liveApp, owner, 'GET', `/api/v1/farms/${farmId}/future-look/${assetId}/image`)).statusCode).toBe(404);

    await runFutureLook(handlerDeps(editFetch('field')), await jobOf(assetId), hb);
    const ready = await call(liveApp, owner, 'POST', url);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data).toMatchObject({assetId, status: 'ready'});
    const img = await call(liveApp, owner, 'GET', `/api/v1/farms/${farmId}/future-look/${assetId}/image`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toBe('private, max-age=3600');
    expect(img.headers['x-derived-from-acquired-at']).toBe('2026-10-27T05:22:31.024Z');
    expect(img.rawPayload.equals(Buffer.from(await h.storage.get({ownerId, key: `future-look/${farmId}/${assetId}.png`})))).toBe(true);
    expect((await call(liveApp, stranger, 'GET', `/api/v1/farms/${farmId}/future-look/${assetId}/image`)).statusCode).toBe(404);
    expect((await call(liveApp, stranger, 'GET', `/api/v1/farms/${farmId}/future-look/${assetId}`)).statusCode).toBe(404);

    const synth = await call(synthApp, owner, 'POST', url);
    expect(synth.statusCode).toBe(200);
    expect(synth.json().data).toMatchObject({assetId: null, status: 'unavailable', reason: 'live_mode_required'});
    expect((await call(synthApp, owner, 'GET', `/api/v1/farms/${farmId}/future-look/${assetId}`)).statusCode).toBe(409);

    // Five POSTs so far on liveApp in this minute; the seventh is rate limited.
    expect((await call(liveApp, owner, 'POST', url)).statusCode).toBe(200);
    expect((await call(liveApp, owner, 'POST', url)).statusCode).toBe(429);
  });

  it('gap looks through the POST body: 202, 400 without targetDate or stageId, 409 before the scene', async () => {
    const app = await buildServer(testConfig(LIVE), h.pool, {storage: h.storage, today: {future: routeDeps()}});
    try {
      const {farmId} = await farmWithCycle();
      const url = `/api/v1/farms/${farmId}/ndvi/${LATEST}/future`;
      const post = (payload?: unknown) => app.inject({method: 'POST', url, headers: {cookie: owner.cookie, origin: ORIGIN, 'x-csrf-token': owner.csrf}, ...(payload === undefined ? {} : {payload: payload as object})});
      const ok = await post({kind: 'gap', targetDate: '2026-11-05'});
      expect(ok.statusCode, ok.body).toBe(202);
      expect(ok.json().data).toMatchObject({status: 'queued', kind: 'gap', targetDate: '2026-11-02', deduplicated: false});
      expect((await post({kind: 'gap'})).statusCode).toBe(400);
      expect((await post({kind: 'gap', targetDate: '2026-10-20'})).statusCode).toBe(409);
      const noStage = await post();
      expect(noStage.statusCode).toBe(400);
      expect(noStage.json().error).toMatchObject({code: 'validation_error'});
      expect((await post({kind: 'gap', targetDate: '2026-11-05', extra: 1})).statusCode).toBe(400);
      const img = await app.inject({method: 'GET', url: `/api/v1/farms/${farmId}/future-look/${ok.json().data.assetId}/image?fieldId=north`, headers: {cookie: owner.cookie, origin: ORIGIN}});
      expect(img.statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe('requestFutureLook: gap (predicted) looks', () => {
  it('validates the target date: required, after the real scene, at most 120 days after today', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap'}))).toMatchObject({status: 400, details: {reason: 'target_date_required'}});
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-02-30'}))).toMatchObject({status: 400});
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-10-27'}))).toMatchObject({status: 409, details: {reason: 'target_not_after_scene', sourceDate: '2026-10-27'}});
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-10-20'}))).toMatchObject({status: 409, details: {reason: 'target_not_after_scene'}});
    // Today is 2026-11-01 (IST); +120 days = 2027-03-01 is allowed, 2027-03-02 is not.
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2027-03-02'}))).toMatchObject({status: 400, details: {reason: 'target_too_far'}});
    expect(await count('future_look_assets WHERE farm_id=$1', [farmId])).toBe(0);
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2027-03-01'})).toMatchObject({status: 'queued', kind: 'gap', targetDate: '2027-03-01'});
    // The stage is still validated for stage looks, and the source scene must be the latest for gap looks too.
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST}))).toMatchObject({status: 400});
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: ID('2026-10-12'), kind: 'gap', targetDate: '2026-11-20'}))).toMatchObject({status: 409, details: {reason: 'scene_not_latest'}});
  });

  it('stores the week start (or the day after the scene), keeps one look per cycle per week, and guides it by code', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    // 2026-10-29 is a Thursday; its Monday (26 Oct) is before the real scene (27 Oct), so the target is 28 Oct.
    const early = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-10-29'});
    expect(early).toMatchObject({status: 'queued', kind: 'gap', targetDate: '2026-10-28', stageId: 'development', deduplicated: false});
    // 2026-11-05 (Thursday) and 2026-11-08 (Sunday) share the week of Monday 2 Nov.
    const a = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-05'});
    expect(a).toMatchObject({status: 'queued', targetDate: '2026-11-02', deduplicated: false});
    const b = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-08'});
    expect(b).toMatchObject({assetId: a.assetId, deduplicated: true});
    const c = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-09'});
    expect(c.assetId).not.toBe(a.assetId);
    const row = await assetRow(a.assetId!);
    expect(row).toMatchObject({kind: 'gap', stage_id: 'development', stage_name: 'Crop development', prompt_version: 'future-look-v3'});
    // The stored readings (0.55 on 12 Oct, 0.63 on 27 Oct) are too few for a curve phase, so the calendar decides.
    expect(row.guidance).toBe('6 days after the real image, in the crop development stage of maize: the canopy fills in, so the field turns a denser, more uniform green with less bare soil between the rows.');
    expect(row.guidance).not.toMatch(NUMBER_WITH_DECIMAL);
    // A gap look does not block the stage look of the same stage, and vice versa.
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'development'})).toMatchObject({status: 'queued', kind: 'stage', deduplicated: false});
    expect(await count("future_look_assets WHERE farm_id=$1 AND kind='gap'", [farmId])).toBe(3);
    expect(await pendingGapLooks(svc(), ownerId, farmId, 'cycle-1')).toBe(3);
    await h.pool.query("UPDATE jobs SET state='failed' WHERE id=$1", [(await jobOf(c.assetId!)).id]);
    expect(await pendingGapLooks(svc(), ownerId, farmId, 'cycle-1')).toBe(2); // a dead job is not waited on
    expect(await pendingGapLooks(svc({config: {RUNTIME_MODE: 'synthetic'}}), ownerId, farmId, 'cycle-1')).toBe(0);
    // Asset shape: predicted label and disclaimer.
    const asset = FutureLookAsset.parse(await futureLookStatus(svc(), ownerId, farmId, a.assetId!));
    expect(asset).toMatchObject({kind: 'gap', targetDate: '2026-11-02', guidance: row.guidance, label: 'Predicted look for 2026-11-02, made from the real image of 2026-10-27. Not an observation.', disclaimer: PREDICTED_LOOK_DISCLAIMER});
  });

  it('after the harvest window the guidance is stubble and bare soil', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const out = await requestFutureLook(svc({timeline: () => StageTimeline.parse({...MAIZE, harvest: {earliest: '2026-11-03', latest: '2026-11-05'}, stages: MAIZE.stages.slice(0, 2).map((x) => ({...x, to: x.to > '2026-11-05' ? '2026-11-05' : x.to}))})}),
      ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-18'});
    expect(out).toMatchObject({status: 'queued', stageId: 'after_harvest', targetDate: '2026-11-16'});
    expect((await assetRow(out.assetId!)).guidance).toMatch(/^20 days after the real image, after the maize harvest: the crop has been harvested, so the field shows stubble and bare soil/);
  });

  it('automatic requests: no re-arm of a failed look this week, and at most 2 gap rows per farm in 24 hours', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const ctx = {sourcePhase: null, latestNdvi: null, conditionsAt: () => null};
    const first = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-01', auto: true, context: ctx});
    expect(first).toMatchObject({status: 'queued', deduplicated: false, targetDate: '2026-10-28'});
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-01', auto: true, context: ctx})).toMatchObject({assetId: first.assetId, deduplicated: true});
    await h.pool.query("UPDATE future_look_assets SET status='failed', failure_reason='provider_bad_request' WHERE id=$1", [first.assetId]);
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-01', auto: true, context: ctx})).toMatchObject({assetId: null, status: 'unavailable', reason: 'auto_week_exists'});
    // An explicit request re-arms it.
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-01'})).toMatchObject({assetId: first.assetId, status: 'queued', deduplicated: false});
    // One more gap row today (explicit, another week) reaches the automatic daily cap of 2 for the farm.
    await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-10'});
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-20', auto: true, context: ctx})).toMatchObject({status: 'unavailable', reason: 'auto_daily_limit'});
    // Explicit requests are not bound by the automatic cap.
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-20'})).toMatchObject({status: 'queued'});
    // Rows older than 24 hours no longer count.
    await h.pool.query("UPDATE future_look_assets SET created_at = now() - interval '25 hours' WHERE farm_id=$1", [farmId]);
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-25', auto: true, context: ctx})).toMatchObject({status: 'queued'});
  });

  it('rows made before v2 stay readable and render with the v1 prompt', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const v1 = (await h.pool.query<FutureLookRow>(
      `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, source_acquired_at, stage_id, stage_name, crop_id, crop_name, prompt_version, status)
       VALUES ($1,$2,'cycle-1',$3,'2026-10-27T05:22:31Z','mid_season','Mid-season','maize','Maize','future-look-v1','queued') RETURNING *`, [ownerId, farmId, LATEST])).rows[0]!;
    expect(FutureLookAsset.parse(toFutureLookAsset(v1))).toMatchObject({kind: 'stage', targetDate: null, guidance: null, label: 'Illustration of a typical Mid-season stage'});
    // A v1 row of the same stage is still the stage's active asset.
    expect(await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, stageId: 'mid_season'})).toMatchObject({assetId: v1.id, deduplicated: true});
    const job = (await h.pool.query<{id: string}>(
      `INSERT INTO jobs (type, payload, owner_id, idempotency_key) VALUES ($1, $2::jsonb, $3, $4) RETURNING id`,
      [FUTURE_LOOK_JOB_TYPE, JSON.stringify({assetId: v1.id, farmId, sessionId: null}), ownerId, `fl:${v1.id}:1`])).rows[0]!;
    await h.pool.query('UPDATE future_look_assets SET job_id=$2 WHERE id=$1', [v1.id, job.id]);
    const f = editFetch('field');
    expect(await runFutureLook(handlerDeps(f), {id: job.id, owner_id: ownerId, payload: {assetId: v1.id, farmId, sessionId: null}}, hb)).toMatchObject({status: 'ready'});
    const prompt = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string).prompt as string;
    expect(prompt).toBe(buildFutureLookPrompt({stageId: 'mid_season', stageName: 'Mid-season', cropName: 'Maize'}));
    expect(prompt).not.toContain('Expected change');
  });

  it('the worker renders a gap look from the stored guidance (prompt v2, no NDVI number)', async () => {
    const {farmId, ownerId} = await farmWithCycle();
    const req = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-05'});
    const f = editFetch('field');
    expect(await runFutureLook(handlerDeps(f), await jobOf(req.assetId!), hb)).toMatchObject({status: 'ready', providerCalls: 1});
    const prompt = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string).prompt as string;
    const row = await assetRow(req.assetId!);
    expect(prompt).toBe(buildFutureLookPrompt({stageId: row.stage_id, stageName: row.stage_name, cropName: 'Maize', kind: 'gap', guidance: row.guidance}));
    expect(prompt).toContain('so that it shows how this maize field is expected to look on a later date. Expected change: 6 days after the real image');
    expect(prompt).toContain('Keep every field boundary, road, path');
    expect(prompt).not.toMatch(NUMBER_WITH_DECIMAL);
    expect(await listReadyFutureLooks(svc(), ownerId, farmId, 'cycle-1')).toMatchObject([{assetId: req.assetId, kind: 'gap', targetDate: '2026-11-02', guidance: row.guidance}]);
    const img = await futureLookImage({...svc(), storage: h.storage}, ownerId, farmId, req.assetId!);
    expect(img).toMatchObject({kind: 'gap', label: 'Predicted look for 2026-11-02, made from the real image of 2026-10-27. Not an observation.'});
    // fieldId must be the asset cycle's field (this cycle names none).
    expect(await errOf(futureLookImage({...svc(), storage: h.storage}, ownerId, farmId, req.assetId!, 'north'))).toMatchObject({status: 404});
  });
});

describe('narrow field: outline, mask and stored look follow the field ring (live finding 2026-11-03)', () => {
  // A 0.0003 by 0.0008 degree strip (about 32 m by 89 m) inside the 1 ha farm, off the farm centre.
  const STRIP: [number, number][] = [[76.2499, 13.2496], [76.2502, 13.2496], [76.2502, 13.2504], [76.2499, 13.2504], [76.2499, 13.2496]];
  const SRING = prepareRing(STRIP)!;
  const SBBOX = displayBbox(SRING);
  const SFIELD = ringToImage(SRING, SBBOX);
  const red = (r: number, g: number, b: number) => r > 190 && g < 90 && b < 90;
  async function rawOf(buf: Buffer) { const {data, info} = await sharp(buf).removeAlpha().raw().toBuffer({resolveWithObject: true}); return {data, w: info.width, h: info.height}; }

  it('sends the strip outline (not the farm square), and stores the model pixels only inside the strip even when the model paints a square', async () => {
    const farmId = (await owner.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id as string;
    const cycles = [{id: 'cycle-strip', cropId: 'maize', cropName: 'Maize', sowingDate: '2026-09-20', stage: 'growing', fieldId: 'strip'}];
    const put = await owner.call('PUT', `/api/v1/farms/${farmId}/workspace`, {payload: {expectedVersion: 0, boundary: HA, fields: [{id: 'strip', name: 'Strip', boundary: {type: 'Polygon', coordinates: [STRIP]}}], previousHarvest: {status: 'unknown'}, cycles, rotationPlans: []}});
    expect(put.statusCode, put.body).toBe(200);
    const ownerId = await ownerOf(farmId);
    const fake = fakePlanetary([scene('2026-10-27', 0.63), scene('2026-10-12', 0.55)]);
    expect((await ndviSeries({config: {RUNTIME_MODE: 'live'}, pool: h.pool, fetchImpl: fake.fetchImpl, now: NOW}, ownerId, farmId, {fieldId: 'strip'})).latestUsable?.itemId).toBe(LATEST);
    const field = await futureLookField(h.pool, ownerId, farmId, 'strip');
    if ('reason' in field) throw new Error(field.reason);
    expect(field.ring).toEqual(SRING);

    // A farm with fields must name the cycle: no fallback to the farm-wide latest cycle, no row, no job.
    expect(await errOf(requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-05'}))).toMatchObject({status: 400, code: 'cycle_required'});
    expect(await count('future_look_assets WHERE farm_id=$1', [farmId])).toBe(0);
    const req = await requestFutureLook(svc(), ownerId, farmId, {itemId: LATEST, kind: 'gap', targetDate: '2026-11-05', cycleId: 'cycle-strip'});
    expect(req).toMatchObject({status: 'queued', cycleId: 'cycle-strip'});
    const stripScene = vi.fn(async (_d: unknown, _o: string, _f: string, _i: string, _k: string, _z?: string, fieldId?: string): Promise<SceneImage> => {
      expect(fieldId).toBe('strip');
      return {bytes: SCENE, contentType: 'image/png', acquiredAt: '2026-10-27T05:22:31.024Z', bbox: SBBOX, cached: true};
    });
    // The live failure: the model fills and outlines a square (35% to 65% of the frame) instead of the strip.
    let sent: Buffer | null = null;
    const squareFetch = vi.fn(async (_u: string, init: RequestInit) => {
      sent = dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url);
      const {data, w, h: hh} = await rawOf(sent);
      const out = Buffer.from(data);
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
        const fx = x / w, fy = y / hh, i = (y * w + x) * 3;
        if (fx < 0.35 || fx > 0.65 || fy < 0.35 || fy > 0.65) continue;
        const edge = fx < 0.355 || fx > 0.645 || fy < 0.355 || fy > 0.645;
        [out[i], out[i + 1], out[i + 2]] = edge ? [255, 30, 30] : [30, 170, 40];
      }
      return providerOk(await sharp(out, {raw: {width: w, height: hh, channels: 3}}).resize(w * 2, hh * 2).png().toBuffer(), 'req_fixture_square');
    });
    const out = await runFutureLook({...handlerDeps(squareFetch), sceneImage: stripScene as never}, await jobOf(req.assetId!), hb);
    expect(out).toMatchObject({status: 'ready', qa: {passed: true}}); // the frame-wide QA alone does not catch it

    // 1. The outline sent to the model is the strip: red pixel bbox equals the strip ring's image bbox (within the stroke).
    const s1 = await rawOf(sent!);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
    for (let y = 0; y < s1.h; y++) for (let x = 0; x < s1.w; x++) {
      const i = (y * s1.w + x) * 3;
      if (red(s1.data[i]!, s1.data[i + 1]!, s1.data[i + 2]!)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    const xs = SFIELD.map(([x]) => x * s1.w), ys = SFIELD.map(([, y]) => y * s1.h);
    const stroke = Math.max(2, Math.round(s1.w / 170));
    const tol = stroke + 1;
    expect(Math.abs(x0 - Math.min(...xs))).toBeLessThanOrEqual(tol);
    expect(Math.abs(x1 - Math.max(...xs))).toBeLessThanOrEqual(tol);
    expect(Math.abs(y0 - Math.min(...ys))).toBeLessThanOrEqual(tol);
    expect(Math.abs(y1 - Math.max(...ys))).toBeLessThanOrEqual(tol);
    // The strip is narrow: about 3.6 times taller than wide in the image.
    expect((y1 - y0) / (x1 - x0)).toBeGreaterThan(2.5);

    // 2. The stored look: the real scene outside the strip (no square, no red), the model's green inside it.
    const row = await assetRow(req.assetId!);
    const stored = await rawOf(Buffer.from(await h.storage.get({ownerId, key: row.storage_key})));
    const base = await rawOf(SCENE);
    expect([stored.w, stored.h]).toEqual([base.w, base.h]);
    const inside = rasterizePolygon(SFIELD, stored.w, stored.h);
    let outsideDiff = 0, insideGreen = 0, insideN = 0, redCount = 0;
    for (let i = 0; i < stored.w * stored.h; i++) {
      const [r, g, b] = [stored.data[3 * i]!, stored.data[3 * i + 1]!, stored.data[3 * i + 2]!];
      if (red(r, g, b)) redCount++;
      if (!inside[i]) outsideDiff = Math.max(outsideDiff, Math.abs(r - base.data[3 * i]!), Math.abs(g - base.data[3 * i + 1]!), Math.abs(b - base.data[3 * i + 2]!));
      else { insideN++; if (g > 150 && r < 60) insideGreen++; }
    }
    expect(outsideDiff).toBe(0);
    expect(redCount).toBe(0);
    expect(insideGreen / insideN).toBeGreaterThan(0.6); // the edge band (half the stroke) keeps the real scene
  });

  it('prompt v3 asks to keep the outline shape and size; a v2 row keeps its own sentence', () => {
    const g = '6 days after the real image, in the crop development stage of maize: the canopy fills in.';
    expect(buildFutureLookPrompt({stageId: 'development', stageName: 'Crop development', cropName: 'Maize', kind: 'gap', guidance: g}))
      .toContain('Keep the red outline exactly where it is, with the same shape and size; do not redraw, move, widen or resize it.');
    const v2 = buildFutureLookPrompt({stageId: 'development', stageName: 'Crop development', cropName: 'Maize', kind: 'gap', guidance: g, promptVersion: 'future-look-v2'});
    expect(v2).toContain('Keep the red outline where it is. No text');
  });
});
