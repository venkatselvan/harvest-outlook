import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import sharp from 'sharp';
import type {FastifyInstance} from 'fastify';
import {CropJourney, FutureLookAsset, StageTimeline} from '@harvest/contracts';
import {buildServer} from '../src/server';
import {Budget} from '../src/services/budget';
import {ApiError} from '../src/services/errors';
import {ndviSeries, type NdviDeps, type SceneImage} from '../src/services/today/ndvi';
import {
  CROP_JOURNEY_DAILY_CAP, CROP_JOURNEY_JOB_TYPE, SCHEMATIC_LABEL, cropJourneyStatus, illustratedIndices, journeyGuidance, journeyOutcome, journeyPrompt,
  requestCropJourney, type CropJourneyDeps,
} from '../src/services/today/crop-journey';
import {CROP_JOURNEY_LABEL, buildFutureLookPrompt, futureLookImage, futureLookStatus, ringToImage} from '../src/services/today/future-look';
import {createCropJourneyHandler, runCropJourney, type CropJourneyHandlerDeps} from '../src/worker/handlers/crop-journey';
import {claimDispatch} from '../src/visuals/dispatch';
import {displayBbox, prepareRing} from '../src/providers/sentinel2';
import {dataUrlToBuffer, providerOk, REGION, sceneJpeg} from './fixtures/muse-image/build';
import {fakePlanetary, type FakeScene} from './fixtures/sentinel2/fake-provider';
import {farmBody, login, ORIGIN, setupHarness, testConfig, upload, type Client, type Harness} from './helpers';

// SYNTHETIC: the Meta image transport, the Planetary Computer, the scene image and the stage timelines are fakes. Nothing here
// calls a provider. Field photos are programmatic drawings, not farm photos.
const KEY = 'unit-test-key-not-real';
const LIVE = {RUNTIME_MODE: 'live', MODEL_API_KEY: KEY};
const NOW = () => new Date('2026-11-01T06:00:00Z'); // IST 2026-11-01 11:30
const TODAY = '2026-11-01';
const HA_RING: [number, number][] = [[76.2495, 13.2495], [76.2505, 13.2495], [76.2505, 13.2505], [76.2495, 13.2505], [76.2495, 13.2495]];
const HA = {type: 'Polygon', coordinates: [HA_RING]};
const STRIP: [number, number][] = [[76.2499, 13.2496], [76.2502, 13.2496], [76.2502, 13.2504], [76.2499, 13.2504], [76.2499, 13.2496]];
const ID = (date: string) => `S2A_MSIL2A_${date.replace(/-/g, '')}T052231_R062_T43PFQ_${date.replace(/-/g, '')}T101714`;
const scene = (date: string, ndvi: number): FakeScene => ({id: ID(date), datetime: `${date}T05:22:31.024Z`, field: {ndvi}, neighbourhood: {ndvi}});
const LATEST = ID('2026-10-27');
const hb = {heartbeat: async () => undefined};
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const NUMBER_WITH_DECIMAL = /\d[.,]\d/;

const basis = {kind: 'duration' as const, label: 'test timeline', sourceId: null, url: null, scope: null, note: null};
const st = (id: string, name: string, from: string, to: string) => ({id, name, from, to, basis: 'fao_generic' as const});
/** Fixed timelines anchored on the requested sowing date (the real stage-timeline module reads evolving data files). */
const timelineOf = (names: [string, string][], days = 20) => vi.fn((input: {cropId: string; anchorDate: string}) => StageTimeline.parse({
  cropId: input.cropId, productId: null, establishmentMethod: null, anchorDate: input.anchorDate, harvest: {earliest: plusDays(input.anchorDate, names.length * days - 5), latest: plusDays(input.anchorDate, names.length * days)}, basis,
  stages: names.map(([id, name], i) => st(id, name, plusDays(input.anchorDate, i * days), plusDays(input.anchorDate, (i + 1) * days))),
}));
const SIX: [string, string][] = [['initial', 'Initial'], ['development', 'Crop development'], ['tillering', 'Tillering'], ['flowering', 'Flowering'], ['grain_fill', 'Grain filling'], ['late_season', 'Late season']];
const THREE: [string, string][] = [['initial', 'Initial'], ['mid_season', 'Mid-season'], ['late_season', 'Late season']];

let h: Harness, owner: Client, stranger: Client;
beforeAll(async () => { h = await setupHarness(); owner = await login(h.app); stranger = await login(h.app); }, 60_000);
afterAll(async () => h?.close());
beforeEach(async () => { await h.pool.query("DELETE FROM provider_cache WHERE provider='planetary-computer-stac'"); });

const svc = (over: Partial<CropJourneyDeps> = {}): CropJourneyDeps => ({config: testConfig(LIVE), pool: h.pool, now: NOW, timeline: timelineOf(SIX), ...over});
const ownerOf = async (farmId: string) => (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
const errOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof ApiError ? {status: e.statusCode, code: e.code, details: e.details as Record<string, unknown> | undefined} : {status: 500, code: String(e)}));
const count = async (sql: string, args: unknown[]) => (await h.pool.query<{n: number}>(`SELECT count(*)::int AS n FROM ${sql}`, args)).rows[0]!.n;
const auth = (ownerId: string) => ({ownerId, sessionId: null});

/** A farm with the 1 ha boundary, a maize cycle and (optionally) two analysed usable scenes (latest 2026-10-27). */
async function farm(client: Client = owner, opts: {scenes?: boolean; fields?: boolean} = {}) {
  const farmId = (await client.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id as string;
  const fields = opts.fields ? [{id: 'strip', name: 'Strip', boundary: {type: 'Polygon', coordinates: [STRIP]}}] : [];
  const cycles = [{id: 'cycle-1', cropId: 'maize', cropName: 'Maize', sowingDate: '2026-09-20', stage: 'growing', ...(opts.fields ? {fieldId: 'strip'} : {})}];
  const put = await client.call('PUT', `/api/v1/farms/${farmId}/workspace`, {payload: {expectedVersion: 0, boundary: HA, ...(opts.fields ? {fields} : {}), previousHarvest: {status: 'unknown'}, cycles, rotationPlans: []}});
  expect(put.statusCode, put.body).toBe(200);
  const ownerId = await ownerOf(farmId);
  if (opts.scenes !== false) {
    const fake = fakePlanetary([scene('2026-10-27', 0.63), scene('2026-10-12', 0.55)]);
    const nd: NdviDeps = {config: {RUNTIME_MODE: 'live'}, pool: h.pool, fetchImpl: fake.fetchImpl, now: NOW};
    expect((await ndviSeries(nd, ownerId, farmId, opts.fields ? {fieldId: 'strip'} : {})).latestUsable?.itemId).toBe(LATEST);
  }
  return {farmId, ownerId};
}

// ------------------------------------------------------------------ scene and provider doubles (as today-future-look.test.ts)

const RING = prepareRing(HA_RING)!;
const BBOX = displayBbox(RING);
const FIELD = ringToImage(RING, BBOX);
const SRING = prepareRing(STRIP)!;
const SBBOX = displayBbox(SRING);
const inside = (poly: readonly [number, number][], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
async function scenePng(): Promise<Buffer> {
  const w = 512, raw = Buffer.alloc(w * w * 3);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, block = ((x >> 5) + (y >> 5)) % 2 ? 25 : 0;
    raw[i] = 70 + Math.round((x / w) * 80) + block; raw[i + 1] = 90 + Math.round((y / w) * 70); raw[i + 2] = 60 + block;
  }
  return sharp(raw, {raw: {width: w, height: w, channels: 3}}).png().toBuffer();
}
let SCENE: Buffer;
beforeAll(async () => { SCENE = await scenePng(); });
const fakeScene = vi.fn(async (): Promise<SceneImage> => ({bytes: SCENE, contentType: 'image/png', acquiredAt: '2026-10-27T05:22:31.024Z', bbox: BBOX, cached: true}));

/** Returns the sent image (upscaled 2x like the live service) with only the polygon edited, or with everything changed. */
async function edited(sent: Buffer, poly: readonly [number, number][], mode: 'field' | 'all'): Promise<Buffer> {
  const {data, info} = await sharp(sent).removeAlpha().raw().toBuffer({resolveWithObject: true});
  const out = Buffer.from(data);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 3;
    if (mode === 'all') { out[i] = 255 - out[i]!; out[i + 1] = 255 - out[i + 1]!; out[i + 2] = 255 - out[i + 2]!; }
    else if (inside(poly, (x + 0.5) / info.width, (y + 0.5) / info.height)) { out[i] = 30; out[i + 1] = 170; out[i + 2] = 40; }
  }
  return sharp(out, {raw: {width: info.width, height: info.height, channels: 3}}).resize(info.width * 2, info.height * 2).png().toBuffer();
}
/** One response per call: 'field' (passes QA), 'all' (fails QA), or an HTTP status. */
const scriptedFetch = (poly: readonly [number, number][], ...script: ('field' | 'all' | number)[]) => {
  let n = 0;
  return vi.fn(async (_u: string, init: RequestInit) => {
    const step = script[Math.min(n++, script.length - 1)]!;
    if (typeof step === 'number') return new Response('{}', {status: step});
    return providerOk(await edited(dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url), poly, step), `req_fixture_cj_${n}`);
  });
};

function handlerDeps(fetchImpl: unknown, over: Record<string, string> = {}): CropJourneyHandlerDeps {
  const config = testConfig({...LIVE, ...over});
  return {config, pool: h.pool, storage: h.storage, budget: Budget.fromConfig(h.pool, config), fetchImpl: fetchImpl as typeof fetch, sleep: async () => undefined, sceneImage: fakeScene};
}
const jobOf = async (journeyId: string) => (await h.pool.query<{id: string; owner_id: string; payload: unknown; idempotency_key: string; type: string}>(
  'SELECT j.id, j.owner_id, j.payload, j.idempotency_key, j.type FROM jobs j JOIN crop_journeys c ON c.job_id=j.id WHERE c.id=$1', [journeyId])).rows[0]!;
const assetsOf = async (journeyId: string) => (await h.pool.query('SELECT * FROM future_look_assets WHERE journey_id=$1 ORDER BY target_date', [journeyId])).rows;

// ------------------------------------------------------------------ pure rules

describe('stage selection, guidance and prompts (code)', () => {
  it('illustrates every stage up to five, else first, last and three evenly spaced', () => {
    expect(illustratedIndices(0)).toEqual([]);
    expect(illustratedIndices(1)).toEqual([0]);
    expect(illustratedIndices(3)).toEqual([0, 1, 2]);
    expect(illustratedIndices(5)).toEqual([0, 1, 2, 3, 4]);
    expect(illustratedIndices(6)).toEqual([0, 1, 3, 4, 5]);
    expect(illustratedIndices(9)).toEqual([0, 2, 4, 6, 8]);
    expect(illustratedIndices(12)).toEqual([0, 3, 6, 8, 11]);
    for (let n = 5; n <= 12; n++) {
      const ix = illustratedIndices(n);
      expect(ix).toHaveLength(5);
      expect(ix[0]).toBe(0);
      expect(ix[4]).toBe(n - 1);
      expect(new Set(ix).size).toBe(5);
    }
  });

  it('writes the stage guidance from the stage name and the days from sowing, never an index number', () => {
    expect(journeyGuidance({stage: {id: 'initial', name: 'Initial', from: '2026-11-01'}, index: 0, sowing: '2026-11-01', cropName: 'Maize'}))
      .toBe('At sowing, in the initial stage of maize: mostly soil with small young plants, only a little green.');
    expect(journeyGuidance({stage: {id: 'flowering', name: 'Flowering', from: '2026-12-31'}, index: 3, sowing: '2026-11-01', cropName: 'Maize'}))
      .toBe('60 days after sowing, in the flowering stage of maize: a full, closed canopy of deep green covers the ground.');
    // Pigeon pea's duration-only split: "Growing" matches no class (first stage falls back to establishing), "Maturing" is late season.
    expect(journeyGuidance({stage: {id: 'growing', name: 'Growing', from: '2026-11-01'}, index: 0, sowing: '2026-11-01', cropName: 'Pigeon pea'})).toContain('mostly soil with small young plants');
    expect(journeyGuidance({stage: {id: 'maturing', name: 'Maturing', from: '2027-02-01'}, index: 1, sowing: '2026-11-01', cropName: 'Pigeon pea'})).toContain('the green fades to yellow-brown');
    expect(journeyGuidance({stage: {id: 'x', name: 'Odd phase', from: '2026-11-02'}, index: 2, sowing: '2026-11-01', cropName: 'Maize'}))
      .toBe('1 day after sowing, in the odd phase stage of maize: the crop as it typically looks at this stage.');
  });

  it('uses the future look stage template for a satellite source and a ground-photo template for a photo', () => {
    const g = 'At sowing, in the initial stage of maize: mostly soil with small young plants, only a little green.';
    expect(journeyPrompt({source: 'satellite', stageId: 'initial', stageName: 'Initial', cropName: 'Maize', guidance: g}))
      .toBe(buildFutureLookPrompt({stageId: 'initial', stageName: 'Initial', cropName: 'Maize', kind: 'stage', guidance: g}));
    const photo = journeyPrompt({source: 'photo', stageId: 'initial', stageName: 'Initial', cropName: 'Maize', guidance: g});
    expect(photo).toMatch(/^Edit this photo of a farm field\. Keep everything outside the area outlined in red exactly as it is/);
    expect(photo).toContain('Change only the ground inside the red outline so that it shows a typical initial stage of maize: mostly bare soil');
    expect(photo).toContain(`Expected change: ${g}`);
    expect(photo).toContain('do not redraw, move, widen or resize it. No text, no labels');
    expect(photo).not.toMatch(NUMBER_WITH_DECIMAL);
  });

  it('derives the journey status from its illustrated stages', () => {
    const r = (status: 'ready' | 'failed' | 'unavailable' | 'queued', reason: string | null = null) => ({status, reason});
    expect(journeyOutcome([r('ready'), r('ready')])).toEqual({status: 'ready', reason: null});
    expect(journeyOutcome([r('ready'), r('failed', 'qa_scene_changed_outside_field')])).toEqual({status: 'partial', reason: null});
    expect(journeyOutcome([r('failed', 'provider_bad_request'), r('unavailable', 'budget')])).toEqual({status: 'failed', reason: 'provider_bad_request'});
    expect(journeyOutcome([r('unavailable', 'budget'), r('unavailable', 'budget')])).toEqual({status: 'unavailable', reason: 'budget'});
    expect(journeyOutcome([r('ready'), r('queued')])).toEqual({status: 'running', reason: null});
  });
});

// ------------------------------------------------------------------ request

describe('requestCropJourney', () => {
  it('queues one job for a six-stage crop: five illustrated stages (first, last, evenly spaced), one schematic, assets of kind journey', async () => {
    const {farmId, ownerId} = await farm();
    const j = CropJourney.parse(await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize', sowingDate: '2026-11-10'}));
    expect(j).toMatchObject({status: 'queued', reason: null, deduplicated: false, farmId, fieldId: null, cropId: 'maize', cropName: 'Maize', sowingDate: '2026-11-10', source: {kind: 'satellite', itemId: LATEST, date: '2026-10-27'}});
    expect(j.stages.map((s) => [s.stageId, s.illustrated, s.status])).toEqual([
      ['initial', true, 'queued'], ['development', true, 'queued'], ['tillering', false, 'schematic'], ['flowering', true, 'queued'], ['grain_fill', true, 'queued'], ['late_season', true, 'queued'],
    ]);
    expect(j.stages[0]).toMatchObject({from: '2026-11-10', to: '2026-11-30', targetDate: '2026-11-10', label: CROP_JOURNEY_LABEL, imagePath: null, guidance: 'At sowing, in the initial stage of maize: mostly soil with small young plants, only a little green.'});
    expect(j.stages[2]).toMatchObject({label: SCHEMATIC_LABEL, assetId: null, guidance: null, reason: null});
    const assets = await assetsOf(j.journeyId);
    expect(assets).toHaveLength(5);
    expect(assets.map((a) => a.stage_id)).toEqual(['initial', 'development', 'flowering', 'grain_fill', 'late_season']);
    for (const a of assets) {
      expect(a).toMatchObject({owner_id: ownerId, farm_id: farmId, kind: 'journey', journey_id: j.journeyId, cycle_id: `journey:${j.journeyId}`, source_item_id: LATEST, status: 'queued', prompt_version: 'crop-journey-sat-v1', billed: false, target_week: null});
      expect(j.stages.find((s) => s.assetId === a.id)).toBeTruthy();
    }
    const job = await jobOf(j.journeyId);
    expect(job).toMatchObject({type: CROP_JOURNEY_JOB_TYPE, idempotency_key: `cj:${j.journeyId}:1`, payload: {journeyId: j.journeyId, farmId, sessionId: null}});
    expect(assets.every((a) => a.job_id === job.id)).toBe(true);
    // Journey assets are invisible to the farm cycle's future-look caps and lists (their cycle id is the journey's).
    expect(await count("future_look_assets WHERE farm_id=$1 AND cycle_id='cycle-1'", [farmId])).toBe(0);
  });

  it('illustrates every stage of a three-stage crop', async () => {
    const {farmId, ownerId} = await farm();
    const j = await requestCropJourney(svc({timeline: timelineOf(THREE)}), auth(ownerId), farmId, {cropId: 'paddy', sowingDate: '2026-11-10'});
    expect(j.stages.map((s) => s.illustrated)).toEqual([true, true, true]);
    expect(await assetsOf(j.journeyId)).toHaveLength(3);
  });

  it('defaults the sowing date to the stored crop-fit candidate for the crop on the field, else today (IST)', async () => {
    const {farmId, ownerId} = await farm();
    const tl = timelineOf(THREE);
    const a = await requestCropJourney(svc({timeline: tl}), auth(ownerId), farmId, {cropId: 'maize'});
    expect(a.sowingDate).toBe(TODAY);
    expect(a.limitations).toContain('No sowing date was given, so today is used.');
    expect(tl.mock.calls[0]![0]).toMatchObject({cropId: 'maize', anchorDate: TODAY, productId: null, establishmentMethod: null});

    const result = {fieldId: undefined, candidates: [
      {cropId: 'tomato', productId: 'tomato', cropName: 'Tomato', establishmentMethod: 'transplanted', rank: 2, sowing: '2026-12-05'},
      {cropId: 'tomato', productId: 'tomato-processing', cropName: 'Tomato', establishmentMethod: null, rank: 5, sowing: '2027-01-10'},
    ]};
    await h.pool.query(`INSERT INTO crop_fit_reviews (owner_id, farm_id, mode, fit_mode, request_key, context_hash, request, result, status)
      VALUES ($1,$2,'live','next','next::','h1','{}'::jsonb,$3::jsonb,'ready')`, [ownerId, farmId, JSON.stringify(result)]);
    const b = await requestCropJourney(svc({timeline: tl}), auth(ownerId), farmId, {cropId: 'tomato'});
    expect(b).toMatchObject({sowingDate: '2026-12-05', cropName: 'Tomato', productId: 'tomato'});
    expect(b.limitations).toContain('Sowing date from the latest crop-fit review for this field.');
    expect(tl.mock.calls.at(-1)![0]).toMatchObject({cropId: 'tomato', anchorDate: '2026-12-05', productId: 'tomato', establishmentMethod: 'transplanted'});
    // Bound on nonsense dates: more than 730 days from today is refused.
    expect(await errOf(requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize', sowingDate: '2029-01-01'}))).toMatchObject({status: 400, details: {reason: 'sowing_out_of_range'}});
  });

  it('validates the request and isolates owners', async () => {
    const {farmId, ownerId} = await farm();
    const strangerId = (await farm(stranger)).ownerId;
    expect(await errOf(requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'bad id!'}))).toMatchObject({status: 400});
    expect(await errOf(requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize', extra: 1} as never))).toMatchObject({status: 400});
    expect(await errOf(requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize', fieldId: 'nope'}))).toMatchObject({status: 404, code: 'field_not_found'});
    expect(await errOf(requestCropJourney(svc({timeline: timelineOf([])}), auth(ownerId), farmId, {cropId: 'maize'}))).toMatchObject({status: 422, code: 'no_stage_data'});
    expect(await errOf(requestCropJourney(svc(), auth(strangerId), farmId, {cropId: 'maize'}))).toMatchObject({status: 404});
    const mine = await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize'});
    expect(await errOf(cropJourneyStatus(svc(), strangerId, farmId, mine.journeyId))).toMatchObject({status: 404});
    expect(await errOf(futureLookStatus(svc(), strangerId, farmId, mine.stages[0]!.assetId!))).toMatchObject({status: 404});
    expect(await count('crop_journeys WHERE farm_id=$1', [farmId])).toBe(1);
  });

  it('synthetic and replay mode, or no model key: unavailable runtime_mode with schematic stages, no row, no job', async () => {
    const {farmId, ownerId} = await farm();
    for (const over of [{RUNTIME_MODE: 'synthetic'}, {RUNTIME_MODE: 'replay'}, {RUNTIME_MODE: 'live'}]) {
      const j = CropJourney.parse(await requestCropJourney(svc({config: testConfig(over)}), auth(ownerId), farmId, {cropId: 'maize'}));
      expect(j).toMatchObject({status: 'unavailable', reason: 'runtime_mode', deduplicated: false, source: {kind: 'none', itemId: null, date: null}});
      expect(j.stages.filter((s) => s.illustrated).every((s) => s.status === 'unavailable' && s.reason === 'runtime_mode' && s.assetId === null)).toBe(true);
      expect(j.stages.filter((s) => !s.illustrated).every((s) => s.status === 'schematic')).toBe(true);
      expect(await errOf(cropJourneyStatus(svc({config: testConfig(over)}), ownerId, farmId, j.journeyId))).toMatchObject({status: over.RUNTIME_MODE === 'live' ? 404 : 409});
    }
    expect(await count('crop_journeys WHERE farm_id=$1', [farmId])).toBe(0);
    expect(await count('future_look_assets WHERE farm_id=$1', [farmId])).toBe(0);
    expect(await count("jobs WHERE payload->>'farmId'=$1", [farmId])).toBe(0);
  });

  it('no usable scene and no confirmed photo: unavailable no_source_image, re-evaluated in place once a scene exists', async () => {
    const {farmId, ownerId} = await farm(owner, {scenes: false});
    const a = await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize'});
    expect(a).toMatchObject({status: 'unavailable', reason: 'no_source_image', source: {kind: 'none'}});
    expect(await count("jobs WHERE payload->>'farmId'=$1", [farmId])).toBe(0);
    expect(await cropJourneyStatus(svc(), ownerId, farmId, a.journeyId)).toMatchObject({journeyId: a.journeyId, status: 'unavailable', reason: 'no_source_image'});
    const fake = fakePlanetary([scene('2026-10-27', 0.63)]);
    await ndviSeries({config: {RUNTIME_MODE: 'live'}, pool: h.pool, fetchImpl: fake.fetchImpl, now: NOW}, ownerId, farmId);
    const b = await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize'});
    expect(b).toMatchObject({journeyId: a.journeyId, status: 'queued', deduplicated: false, source: {kind: 'satellite', itemId: LATEST}});
    expect((await jobOf(b.journeyId)).idempotency_key).toBe(`cj:${b.journeyId}:2`);
  });

  it('falls back to the latest owner field photo with a confirmed region', async () => {
    const {farmId, ownerId} = await farm(owner, {scenes: false});
    const media = (await upload(owner, await sceneJpeg(320, 240), {farmId})).json().data as {id: string; normalized: {width: number; height: number}};
    // A photo without a region is not a source.
    await h.pool.query("INSERT INTO field_photos (owner_id, farm_id, cycle_id, media_id, captured_on) VALUES ($1,$2,'cycle-1',$3,'2026-10-30')", [ownerId, farmId, media.id]);
    expect(await requestCropJourney(svc({timeline: timelineOf(THREE)}), auth(ownerId), farmId, {cropId: 'maize'})).toMatchObject({status: 'unavailable', reason: 'no_source_image'});
    const region = await owner.call('PUT', `/api/v1/media/${media.id}/region`, {payload: {polygon: REGION, source: 'manual', transform: {orientationApplied: true, normalizedWidth: media.normalized.width, normalizedHeight: media.normalized.height}}});
    expect(region.statusCode, region.body).toBe(200);
    const photoId = (await h.pool.query<{id: string}>('SELECT id FROM field_photos WHERE media_id=$1', [media.id])).rows[0]!.id;
    const j = await requestCropJourney(svc({timeline: timelineOf(THREE)}), auth(ownerId), farmId, {cropId: 'maize'});
    expect(j).toMatchObject({status: 'queued', source: {kind: 'photo', itemId: photoId, date: '2026-10-30'}});
    expect((await assetsOf(j.journeyId)).map((a) => [a.source_item_id, a.prompt_version])).toEqual(Array(3).fill([`photo.${photoId}`, 'crop-journey-photo-v1']));

    // The handler edits the photo inside the confirmed region with the ground-photo prompt; QA and the composite use the region.
    const f = scriptedFetch(REGION, 'field');
    fakeScene.mockClear();
    const out = await runCropJourney(handlerDeps(f), await jobOf(j.journeyId), hb);
    expect(out).toMatchObject({status: 'ready', providerCalls: 3, cost: {images: 3}});
    expect(fakeScene).not.toHaveBeenCalled(); // no satellite scene is read for a photo journey
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.prompt).toMatch(/^Edit this photo of a farm field\./);
    expect(body.size).toBe(`${media.normalized.width}x${media.normalized.height}`);
    expect(out.stages.every((s) => s.qa?.passed === true)).toBe(true);
  });

  it('a farm with fields must name the field; a field journey uses that field polygon', async () => {
    const {farmId, ownerId} = await farm(owner, {fields: true});
    expect(await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize'})).toMatchObject({status: 'unavailable', reason: 'field_required', fieldId: null});
    const j = await requestCropJourney(svc({timeline: timelineOf(THREE)}), auth(ownerId), farmId, {cropId: 'maize', fieldId: 'strip'});
    expect(j).toMatchObject({status: 'queued', fieldId: 'strip', source: {kind: 'satellite', itemId: LATEST}});
    const stripScene = vi.fn(async (_d: unknown, _o: string, _f: string, _i: string, _k: string, _z?: string, fieldId?: string): Promise<SceneImage> => {
      expect(fieldId).toBe('strip');
      return {bytes: SCENE, contentType: 'image/png', acquiredAt: '2026-10-27T05:22:31.024Z', bbox: SBBOX, cached: true};
    });
    const out = await runCropJourney({...handlerDeps(scriptedFetch(ringToImage(SRING, SBBOX), 'field')), sceneImage: stripScene as never}, await jobOf(j.journeyId), hb);
    expect(out).toMatchObject({status: 'ready', providerCalls: 3});
    expect(stripScene).toHaveBeenCalledTimes(1);
    // The image route's fieldId check: the journey's field only.
    const deps = {...svc(), storage: h.storage};
    const assetId = (await cropJourneyStatus(svc(), ownerId, farmId, j.journeyId)).stages[0]!.assetId!;
    expect((await futureLookImage(deps, ownerId, farmId, assetId, 'strip')).kind).toBe('journey');
    expect(await errOf(futureLookImage(deps, ownerId, farmId, assetId, 'other'))).toMatchObject({status: 404});
  });

  it('dedups per crop, field and IST day; caps a farm at three journeys a day; refuses when the image budget cannot cover it', async () => {
    expect(CROP_JOURNEY_DAILY_CAP).toBe(3);
    const {farmId, ownerId} = await farm();
    const first = await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize', sowingDate: '2026-11-10'});
    // Another sowing date or product the same day returns the day's journey (whatever it names).
    const again = await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize', sowingDate: '2026-12-01', productId: 'maize-green-cob'});
    expect(again).toMatchObject({journeyId: first.journeyId, deduplicated: true, status: 'queued', sowingDate: '2026-11-10', productId: null});
    expect(await count("jobs WHERE payload->>'farmId'=$1", [farmId])).toBe(1);
    // The next IST day is a new journey (the clock crosses midnight IST at 18:30 UTC).
    const nextDay = await requestCropJourney(svc({now: () => new Date('2026-11-01T18:31:00Z')}), auth(ownerId), farmId, {cropId: 'maize'});
    expect(nextDay).toMatchObject({status: 'queued', sowingDate: '2026-11-02'});
    expect(nextDay.journeyId).not.toBe(first.journeyId);

    await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'paddy'});
    await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'tomato'});
    const fourth = await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'ragi'});
    expect(fourth).toMatchObject({status: 'unavailable', reason: 'daily_cap', source: {kind: 'satellite'}});
    expect(await count("crop_journeys WHERE farm_id=$1 AND ist_day=$2::date AND status <> 'unavailable'", [farmId, TODAY])).toBe(3);
    expect(await count("jobs WHERE payload->>'farmId'=$1", [farmId])).toBe(4); // three today plus the next day's
    // An unavailable journey does not count; the repeat of a capped crop stays capped.
    expect(await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'ragi'})).toMatchObject({journeyId: fourth.journeyId, status: 'unavailable', reason: 'daily_cap'});

    const {farmId: f2, ownerId: o2} = await farm();
    const real = Budget.fromConfig(h.pool, testConfig(LIVE));
    const broke = {summary: async () => ({currency: 'USD' as const, devAllocationUsd: 1, remainingDevUsd: 0.04, demoReserveUsd: 0, exhausted: false, overrunCount: 0, overrunUsd: 0}), estimate: real.estimate.bind(real)};
    expect(await requestCropJourney(svc({budget: broke}), auth(o2), f2, {cropId: 'maize'})).toMatchObject({status: 'unavailable', reason: 'budget'}); // 5 images x $0.01 > $0.04
    expect(await requestCropJourney(svc({budget: broke, timeline: timelineOf(THREE)}), auth(o2), f2, {cropId: 'maize'})).toMatchObject({status: 'queued'}); // 3 x $0.01 fits
  });
});

// ------------------------------------------------------------------ handler and GET

describe('today.crop-journey handler', () => {
  it('renders stages in order with QA; a failed stage leaves the others ready (partial); GET shows each stage as it finishes', async () => {
    const {farmId, ownerId} = await farm();
    const j = await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize', sowingDate: '2026-11-10'});
    expect((await cropJourneyStatus(svc(), ownerId, farmId, j.journeyId)).status).toBe('queued');
    const seen: string[][] = [];
    // Stage 2 comes back with the whole scene changed (QA rejects it); stage 4 is a provider 400 (not billed).
    const script = scriptedFetch(FIELD, 'field', 'all', 'field', 400, 'field');
    const f = vi.fn(async (u: string, init: RequestInit) => {
      const g = await cropJourneyStatus(svc(), ownerId, farmId, j.journeyId);
      seen.push([g.status, ...g.stages.filter((s) => s.illustrated).map((s) => s.status)]);
      return script(u, init);
    });
    const out = await createCropJourneyHandler(handlerDeps(f))((await jobOf(j.journeyId)) as never, {...hb, pool: h.pool, isCancelled: async () => false});
    expect(out).toMatchObject({status: 'partial', reason: null, providerCalls: 5, cost: {reservedUsd: 0.1, settledUsd: 0.04, images: 4}});
    expect((out as {stages: {stageId: string; status: string; reason: string | null}[]}).stages.map((s) => [s.stageId, s.status, s.reason])).toEqual([
      ['initial', 'ready', null], ['development', 'failed', 'qa_scene_changed_outside_field'], ['flowering', 'ready', null], ['grain_fill', 'failed', 'provider_bad_request'], ['late_season', 'ready', null],
    ]);
    // Progress: each call saw the earlier stages finished and the current one running.
    expect(seen).toEqual([
      ['running', 'running', 'queued', 'queued', 'queued', 'queued'],
      ['running', 'ready', 'running', 'queued', 'queued', 'queued'],
      ['running', 'ready', 'failed', 'running', 'queued', 'queued'],
      ['running', 'ready', 'failed', 'ready', 'running', 'queued'],
      ['running', 'ready', 'failed', 'ready', 'failed', 'running'],
    ]);
    // The prompts are the satellite stage template with each stage's stored guidance.
    const assets = await assetsOf(j.journeyId);
    const prompts = f.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).prompt as string);
    expect(prompts[0]).toBe(buildFutureLookPrompt({stageId: 'initial', stageName: 'Initial', cropName: 'Maize', kind: 'stage', guidance: assets[0].guidance}));
    expect(prompts[2]).toContain('typical flowering stage of maize');
    expect(prompts.every((p) => !NUMBER_WITH_DECIMAL.test(p))).toBe(true);

    const g = CropJourney.parse(await cropJourneyStatus(svc(), ownerId, farmId, j.journeyId));
    expect(g.status).toBe('partial');
    const ready = g.stages.filter((s) => s.status === 'ready');
    expect(ready.map((s) => s.stageId)).toEqual(['initial', 'flowering', 'late_season']);
    for (const s of ready) expect(s.imagePath).toBe(`/api/v1/farms/${farmId}/future-look/${s.assetId}/image`);
    expect(g.stages.find((s) => s.stageId === 'development')).toMatchObject({status: 'failed', reason: 'qa_scene_changed_outside_field', imagePath: null});
    expect(g.stages.find((s) => s.stageId === 'tillering')).toMatchObject({status: 'schematic'});
    // Rows: ready ones stored and billed; the QA reject billed without an object; the 400 neither.
    const byStage = Object.fromEntries(assets.map((a) => [a.stage_id, a]));
    expect(byStage.initial).toMatchObject({status: 'ready', billed: true, storage_key: `future-look/${farmId}/${byStage.initial.id}.png`, model: 'muse-image-1.0', response_deleted: null, provider_request_id: 'req_fixture_cj_1'});
    expect(byStage.development).toMatchObject({status: 'failed', billed: true, storage_key: null});
    expect(byStage.grain_fill).toMatchObject({status: 'failed', billed: false, storage_key: null});
    expect(await sharp(Buffer.from(await h.storage.get({ownerId, key: byStage.initial.storage_key}))).metadata()).toMatchObject({format: 'png', width: 512, height: 512});
    const reservations = (await h.pool.query<{state: string}>('SELECT state FROM usage_reservations WHERE job_id=$1 ORDER BY created_at', [(await jobOf(j.journeyId)).id])).rows.map((r) => r.state);
    expect(reservations).toEqual(['settled', 'settled', 'settled', 'released', 'settled']);
    expect((await h.pool.query("SELECT DISTINCT purpose FROM ai_invocations WHERE owner_id=$1", [ownerId])).rows).toEqual([{purpose: 'crop_journey'}]);
    // The asset as the future-look status route reads it.
    expect(FutureLookAsset.parse(await futureLookStatus(svc(), ownerId, farmId, byStage.initial.id))).toMatchObject({kind: 'journey', journeyId: j.journeyId, label: CROP_JOURNEY_LABEL, status: 'ready'});
    // A second run of the same job does nothing.
    expect(await runCropJourney(handlerDeps(f), await jobOf(j.journeyId), hb)).toMatchObject({status: 'skipped', reason: 'superseded'});
  });

  it('a worker in synthetic mode makes no call; budget refusal mid-run leaves the rest unavailable; an open dispatch marker is never re-sent', async () => {
    const fresh = await login(h.app);
    const {farmId, ownerId} = await farm(fresh);
    const j1 = await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'maize'});
    const f = scriptedFetch(FIELD, 'field');
    fakeScene.mockClear();
    expect(await runCropJourney(handlerDeps(f, {RUNTIME_MODE: 'synthetic'}), await jobOf(j1.journeyId), hb)).toMatchObject({status: 'unavailable', reason: 'runtime_mode', providerCalls: 0});
    expect(f).not.toHaveBeenCalled();
    expect(fakeScene).not.toHaveBeenCalled();

    // Owner-day limit $0.03: stage 1 reserves 0.02 and settles 0.01, stage 2 reserves 0.02 (total 0.03), stage 3 is refused.
    const j2 = await requestCropJourney(svc(), auth(ownerId), farmId, {cropId: 'paddy'});
    const out = await runCropJourney(handlerDeps(f, {BUDGET_PER_OWNER_DAY_USD: '0.03'}), await jobOf(j2.journeyId), hb);
    expect(out).toMatchObject({status: 'partial', providerCalls: 2});
    expect(out.stages.map((s) => [s.status, s.reason])).toEqual([['ready', null], ['ready', null], ['unavailable', 'budget'], ['unavailable', 'budget'], ['unavailable', 'budget']]);

    // A crashed attempt left stage 1's marker open: it fails uncertain (billed, reservation held), the others render.
    const j3 = await requestCropJourney(svc({timeline: timelineOf(THREE)}), auth(ownerId), farmId, {cropId: 'tomato'});
    const job = await jobOf(j3.journeyId);
    const firstAsset = (await cropJourneyStatus(svc(), ownerId, farmId, j3.journeyId)).stages[0]!.assetId!;
    const budget = Budget.fromConfig(h.pool, testConfig(LIVE));
    const {reservationId} = await budget.reserve({ownerId, sessionId: null, provider: 'meta', model: 'muse-image-1.0', estimate: 0.02, jobId: job.id});
    expect(await claimDispatch(h.pool, job.id, `cj:${firstAsset}`, reservationId)).toBe(true);
    const f3 = scriptedFetch(FIELD, 'field');
    const out3 = await runCropJourney(handlerDeps(f3), job, hb);
    expect(f3).toHaveBeenCalledTimes(2);
    expect(out3).toMatchObject({status: 'partial'});
    expect(out3.stages.map((s) => [s.status, s.reason])).toEqual([['failed', 'uncertain_needs_review'], ['ready', null], ['ready', null]]);
    expect((await h.pool.query('SELECT state FROM usage_reservations WHERE id=$1', [reservationId])).rows[0]).toEqual({state: 'uncertain'});
    expect((await h.pool.query('SELECT billed FROM future_look_assets WHERE id=$1', [firstAsset])).rows[0]).toEqual({billed: true});
  });

  it('a claim lost to a marker another attempt holds releases this attempt\'s reservation (nothing was sent); the stage fails uncertain', async () => {
    const fresh = await login(h.app);
    const {farmId, ownerId} = await farm(fresh);
    const j = await requestCropJourney(svc({timeline: timelineOf(THREE)}), auth(ownerId), farmId, {cropId: 'maize'});
    const job = await jobOf(j.journeyId);
    const ids = (await cropJourneyStatus(svc(), ownerId, farmId, j.journeyId)).stages.map((s) => s.assetId!);
    expect(ids).toHaveLength(3);
    // While stage 1 is at the provider, a concurrent attempt opens stage 2's marker (outcome NULL): this attempt must not send it.
    const inner = scriptedFetch(FIELD, 'field');
    let raced = false;
    const f = vi.fn(async (u: string, init: RequestInit) => {
      if (!raced) { raced = true; await h.pool.query('INSERT INTO job_dispatches (job_id, stage_key, reservation_id) VALUES ($1,$2,NULL)', [job.id, `cj:${ids[1]}`]); }
      return inner(u, init);
    });
    const out = await runCropJourney(handlerDeps(f), job, hb);
    expect(f).toHaveBeenCalledTimes(2);
    expect(out.stages.map((s) => [s.status, s.reason])).toEqual([['ready', null], ['failed', 'uncertain_needs_review'], ['ready', null]]);
    const state = async (assetId: string) => (await h.pool.query<{state: string}>('SELECT state FROM usage_reservations WHERE job_id=$1 AND request_id=$2', [job.id, assetId])).rows.map((r) => r.state);
    expect(await state(ids[0]!)).toEqual(['settled']);
    expect(await state(ids[1]!)).toEqual(['released']);
    expect(await state(ids[2]!)).toEqual(['settled']);
    expect(await count("usage_reservations WHERE job_id=$1 AND state IN ('uncertain','reserved')", [job.id])).toBe(0);
  });

  it('GET closes a journey whose job died', async () => {
    const {farmId, ownerId} = await farm();
    const j = await requestCropJourney(svc({timeline: timelineOf(THREE)}), auth(ownerId), farmId, {cropId: 'maize'});
    await h.pool.query("UPDATE jobs SET state='failed' WHERE id=$1", [(await jobOf(j.journeyId)).id]);
    const g = await cropJourneyStatus(svc(), ownerId, farmId, j.journeyId);
    expect(g).toMatchObject({status: 'failed', reason: 'job_failed'});
    expect(g.stages.every((s) => s.status === 'failed' && s.reason === 'job_failed')).toBe(true);
  });
});

// ------------------------------------------------------------------ routes

describe('routes (registered on a test server, real stage timeline)', () => {
  let liveApp: FastifyInstance, synthApp: FastifyInstance;
  beforeAll(async () => {
    liveApp = await buildServer(testConfig(LIVE), h.pool, {storage: h.storage});
    synthApp = await buildServer(testConfig(), h.pool, {storage: h.storage});
  });
  afterAll(async () => { await liveApp?.close(); await synthApp?.close(); });
  const call = (app: FastifyInstance, c: Client, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({method, url, headers: {cookie: c.cookie, origin: ORIGIN, ...(method === 'POST' ? {'x-csrf-token': c.csrf} : {})}, ...(payload === undefined ? {} : {payload: payload as object})});

  it('POST 202 then deduplicated, GET progress, private journey image through the future-look route, 400/404, synthetic 200 unavailable, 6 per minute', async () => {
    const {farmId, ownerId} = await farm();
    const url = `/api/v1/farms/${farmId}/crop-journey`;
    const first = await call(liveApp, owner, 'POST', url, {cropId: 'maize', sowingDate: '2026-11-10'});
    expect(first.statusCode, first.body).toBe(202);
    const j = CropJourney.parse(first.json().data);
    expect(j.stages.map((s) => s.stageId)).toEqual(['initial', 'development', 'mid_season', 'late_season']);
    expect(j.stages.every((s) => s.illustrated && s.status === 'queued')).toBe(true);
    const again = await call(liveApp, owner, 'POST', url, {cropId: 'maize'});
    expect(again.statusCode).toBe(202);
    expect(again.json().data).toMatchObject({journeyId: j.journeyId, deduplicated: true});
    expect((await call(liveApp, stranger, 'POST', url, {cropId: 'maize'})).statusCode).toBe(404);
    expect((await call(liveApp, owner, 'POST', url, {cropId: 'maize', extra: 1})).statusCode).toBe(400);
    expect((await call(liveApp, owner, 'POST', url, {cropId: 'maize', sowingDate: '2026-02-30'})).statusCode).toBe(400);

    const get = await call(liveApp, owner, 'GET', `${url}/${j.journeyId}`);
    expect(get.statusCode).toBe(200);
    expect(get.headers['cache-control']).toBe('private, no-store');
    expect(get.json().data).toMatchObject({status: 'queued'});
    expect((await call(liveApp, stranger, 'GET', `${url}/${j.journeyId}`)).statusCode).toBe(404);

    await runCropJourney(handlerDeps(scriptedFetch(FIELD, 'field')), await jobOf(j.journeyId), hb);
    const done = CropJourney.parse((await call(liveApp, owner, 'GET', `${url}/${j.journeyId}`)).json().data);
    expect(done.status).toBe('ready');
    const img = await call(liveApp, owner, 'GET', done.stages[1]!.imagePath!);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-illustration']).toBe('generated');
    expect(img.headers['x-derived-from-acquired-at']).toBe('2026-10-27T05:22:31.024Z');
    expect(img.rawPayload.equals(Buffer.from(await h.storage.get({ownerId, key: `future-look/${farmId}/${done.stages[1]!.assetId}.png`})))).toBe(true);
    expect((await call(liveApp, owner, 'GET', `${done.stages[1]!.imagePath!}?fieldId=strip`)).statusCode).toBe(404); // the journey names no field
    expect((await call(liveApp, stranger, 'GET', done.stages[1]!.imagePath!)).statusCode).toBe(404);
    // Ready: a repeat is 200 with the same journey.
    const ready = await call(liveApp, owner, 'POST', url, {cropId: 'maize'});
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data).toMatchObject({journeyId: j.journeyId, status: 'ready', deduplicated: true});

    const synth = await call(synthApp, owner, 'POST', url, {cropId: 'maize'});
    expect(synth.statusCode).toBe(200);
    expect(synth.json().data).toMatchObject({status: 'unavailable', reason: 'runtime_mode'});
    expect((await call(synthApp, owner, 'GET', `${url}/${j.journeyId}`)).statusCode).toBe(409);

    // Six POSTs so far on liveApp in this minute (the two 400s count); the seventh is rate limited.
    expect((await call(liveApp, owner, 'POST', url, {cropId: 'maize'})).statusCode).toBe(429);
  });
});

// ------------------------------------------------------------------ migration

describe('0046_crop_journey', () => {
  it("accepts kind 'journey' only with a journey id, and a journey id only on kind 'journey'", async () => {
    const {farmId, ownerId} = await farm(owner, {scenes: false});
    const jid = (await h.pool.query<{id: string}>(`INSERT INTO crop_journeys (owner_id, farm_id, crop_id, crop_name, sowing_date, sowing_basis, ist_day, status, source_kind, stages)
      VALUES ($1,$2,'maize','Maize','2026-11-01','today','2026-11-01','unavailable','none','[]') RETURNING id`, [ownerId, farmId])).rows[0]!.id;
    const insert = (kind: string, journeyId: string | null) => h.pool.query(
      `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, stage_id, stage_name, crop_id, crop_name, prompt_version, status, kind, journey_id)
       VALUES ($1,$2,$3,$4,'initial','Initial','maize','Maize','crop-journey-sat-v1','queued',$5,$6)`, [ownerId, farmId, `journey:${jid}`, LATEST, kind, journeyId]);
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: {code?: string}) => e.code);
    expect(await code(insert('journey', null))).toBe('23514');
    expect(await code(insert('stage', jid))).toBe('23514');
    expect(await code(insert('other', jid))).toBe('23514');
    expect(await code(insert('journey', jid))).toBe('ok');
    // One journey per farm, field, crop and day (NULLS NOT DISTINCT on the field).
    expect(await code(h.pool.query(`INSERT INTO crop_journeys (owner_id, farm_id, crop_id, crop_name, sowing_date, sowing_basis, ist_day, status, source_kind, stages)
      VALUES ($1,$2,'maize','Maize','2026-11-02','today','2026-11-01','unavailable','none','[]')`, [ownerId, farmId]))).toBe('23505');
    // A journey with no source can only be unavailable.
    expect(await code(h.pool.query(`INSERT INTO crop_journeys (owner_id, farm_id, crop_id, crop_name, sowing_date, sowing_basis, ist_day, status, source_kind, stages)
      VALUES ($1,$2,'paddy','Paddy','2026-11-02','today','2026-11-01','queued','none','[]')`, [ownerId, farmId]))).toBe('23514');
  });
});
