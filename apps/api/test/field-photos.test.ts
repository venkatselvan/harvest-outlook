import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { setupHarness, login, farmBody, upload, type Harness, type Client, testConfig } from './helpers';
import { photoGallery, requestPhotoPrediction } from '../src/services/today/field-photos';
import { exifCreatedDate } from '../src/services/exif-date';
import { createFieldPhotoHandler } from '../src/worker/handlers/field-photo';
import { Budget } from '../src/services/budget';
import { providerOk } from './fixtures/muse-image/build';

let h: Harness, owner: Client, stranger: Client, jpeg: Buffer;
beforeAll(async () => {
  h = await setupHarness(); owner = await login(h.app); stranger = await login(h.app);
  jpeg = await sharp({create: {width: 80, height: 60, channels: 3, background: '#638743'}}).withExif({IFD0: {DateTime: '2026:10:25 10:30:00'}, IFD2: {DateTimeOriginal: '2026:10:20 09:45:00'}}).jpeg().toBuffer();
});
afterAll(async () => h?.close());
async function setup() {
  const farmId = (await owner.call('POST', '/api/v1/farms', {payload: farmBody()})).json().data.id;
  const response = await owner.call('PUT', `/api/v1/farms/${farmId}/workspace`, {payload: {expectedVersion: 0, boundary: null, previousHarvest: {status: 'unknown'}, cycles: [{id: 'crop-a', cropId: 'maize', sowingDate: '2026-09-01', stage: 'growing'}, {id: 'crop-b', cropId: 'ginger', sowingDate: '2026-09-01', stage: 'growing'}], rotationPlans: []}});
  expect(response.statusCode, response.body).toBe(200);
  const ownerId = (await h.pool.query('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0].owner_id;
  const scope = {ownerId, farmId, cycleId: 'crop-a'};
  const base = `/api/v1/farms/${farmId}/cycles/crop-a/field-photos`;
  const media = (await upload(owner, jpeg, {farmId})).json().data;
  return {farmId, ownerId, scope, base, media};
}
const photoBody = (id: string, date = '2026-10-20') => ({photos: [{mediaId: id, capturedOn: date}]});

describe('private field photos', () => {
  it('reads original EXIF date before stripping metadata, accepts date correction, isolates cycles and owners', async () => {
    const {base, media, farmId} = await setup();
    expect(media.exifCreatedAt).toBe('2026-10-20');
    const normalized = await owner.call('GET', media.contentPath);
    expect((await sharp(normalized.rawPayload).metadata()).exif).toBeUndefined();
    const saved = await owner.call('POST', base, {payload: photoBody(media.id)});
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data.photos[0].capturedOn).toBe('2026-10-20');
    expect((await owner.call('POST', base, {payload: photoBody(media.id, '2026-10-19')})).json().data.photos).toHaveLength(1);
    expect((await owner.call('GET', base)).json().data.photos[0].capturedOn).toBe('2026-10-19');
    expect((await owner.call('GET', base.replace('crop-a', 'crop-b'))).json().data.photos).toEqual([]);
    expect((await stranger.call('GET', base)).statusCode).toBe(404);
    const foreignMedia = (await upload(stranger, jpeg)).json().data;
    expect((await owner.call('POST', base, {payload: photoBody(foreignMedia.id)})).statusCode).toBe(404);
    expect((await owner.call('POST', base, {payload: photoBody(media.id, '2099-01-01')})).statusCode).toBe(400);
    expect((await owner.call('POST', base, {payload: photoBody(media.id, '2026-02-30')})).statusCode).toBe(400);
    expect((await owner.call('POST', base, {payload: photoBody(media.id), csrf: null})).statusCode).toBe(403);
    expect(farmId).toBeTruthy();
  });
  it('enforces six photos even across concurrent uploads, permits removal and persists the gallery', async () => {
    const {base, media, farmId} = await setup();
    const ids = [media.id];
    for (let i = 0; i < 6; i++) ids.push((await upload(owner, jpeg, {farmId})).json().data.id);
    const saved = await owner.call('POST', base, {payload: {photos: ids.slice(0, 5).map(id => ({mediaId: id, capturedOn: '2026-10-20'}))}});
    expect(saved.statusCode, saved.body).toBe(200);
    const results = await Promise.all(ids.slice(5).map(id => owner.call('POST', base, {payload: photoBody(id)})));
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const gallery = (await owner.call('GET', base)).json().data;
    expect(gallery.photos).toHaveLength(6);
    expect((await owner.call('DELETE', `${base}/${gallery.photos[0].id}`)).json().data.photos).toHaveLength(5);
  });
  it('allows prediction from a single photo, uses the exact target date, deduplicates and invalidates corrected dates', async () => {
    const {base, scope, media} = await setup();
    const p = (await owner.call('POST', base, {payload: photoBody(media.id)})).json().data.photos[0];
    const sessionId = (await h.pool.query('SELECT id FROM sessions WHERE owner_id=$1 LIMIT 1', [scope.ownerId])).rows[0].id;
    const deps = {pool: h.pool, config: testConfig({RUNTIME_MODE: 'live', MODEL_API_KEY: 'fake-test-key'})};
    await expect(requestPhotoPrediction(deps, scope, p.id, '2026-10-20', sessionId)).rejects.toThrow('after the photo');
    const first = await requestPhotoPrediction(deps, scope, p.id, '2026-11-13', sessionId);
    expect(first).toMatchObject({status: 'queued', sourceDate: '2026-10-20', targetDate: '2026-11-13'});
    expect((await requestPhotoPrediction(deps, scope, p.id, '2026-11-13', sessionId)).id).toBe(first.id);
    const row = (await h.pool.query('SELECT prompt FROM field_photo_predictions WHERE id=$1', [first.id])).rows[0];
    expect(row.prompt).toContain('Advance the crop 24 days');
    expect(row.prompt).toContain('recorded establishment 2026-09-01');
    expect((await photoGallery(h.pool, scope)).predictions[0]).toMatchObject({promptVersion: 'field-photo-v2', outdated: false, guidance: {elapsedDays: 24}});
    // Older previews survive, but do not win the cache lookup for the new prompt version.
    await h.pool.query("INSERT INTO field_photo_predictions(owner_id,farm_id,cycle_id,photo_id,source_date,target_date,status,prompt) VALUES ($1,$2,$3,$4,'2026-10-20','2026-11-13','ready','legacy')", [scope.ownerId,scope.farmId,scope.cycleId,p.id]);
    expect((await requestPhotoPrediction(deps, scope, p.id, '2026-11-13', sessionId)).id).toBe(first.id);
    expect((await photoGallery(h.pool, scope)).predictions.some(p => p.outdated)).toBe(true);
    const oldJob = (await h.pool.query('SELECT job_id FROM field_photo_predictions WHERE id=$1', [first.id])).rows[0].job_id;
    await h.pool.query("UPDATE field_photo_predictions SET status='unavailable', failure_reason='budget_exceeded' WHERE id=$1", [first.id]);
    expect((await requestPhotoPrediction(deps, scope, p.id, '2026-11-13', sessionId)).status).toBe('queued');
    expect((await h.pool.query('SELECT job_id FROM field_photo_predictions WHERE id=$1', [first.id])).rows[0].job_id).not.toBe(oldJob);
    await h.pool.query("UPDATE field_photo_predictions SET status='failed', failure_reason='provider_timeout' WHERE id=$1", [first.id]);
    expect((await requestPhotoPrediction(deps, scope, p.id, '2026-11-13', sessionId)).status).toBe('failed');
    expect((await owner.call('POST', `${base}/${p.id}/predict`, {payload: {targetDate: '2026-11-14'}})).statusCode).toBe(409); // synthetic mode cannot dispatch
    await owner.call('POST', base, {payload: photoBody(media.id, '2026-10-18')});
    expect((await photoGallery(h.pool, scope)).predictions.every(p => p.sourceDate === '2026-10-20')).toBe(true); // original expectations survive date corrections
  });
  it('worker edits the uploaded photo, stores a private result and never repeats a finished provider call', async () => {
    const {base, scope, media} = await setup();
    const photo = (await owner.call('POST', base, {payload: photoBody(media.id)})).json().data.photos[0];
    const sessionId = (await h.pool.query('SELECT id FROM sessions WHERE owner_id=$1 LIMIT 1', [scope.ownerId])).rows[0].id;
    const config = testConfig({RUNTIME_MODE: 'live', MODEL_API_KEY: 'fake-test-key'});
    const prediction = await requestPhotoPrediction({pool: h.pool, config}, scope, photo.id, '2026-11-14', sessionId);
    const job = (await h.pool.query('SELECT * FROM jobs WHERE id=(SELECT job_id FROM field_photo_predictions WHERE id=$1)', [prediction.id])).rows[0];
    const png = await sharp(jpeg).modulate({hue: 45, saturation: 0.6}).png().toBuffer();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.images[0].image_url).toMatch(/^data:image\/jpeg;base64,/);
      expect(body.prompt).toContain('2026-11-14');
      return providerOk(png);
    });
    const budget = Budget.fromConfig(h.pool, config);
    const handler = createFieldPhotoHandler({pool: h.pool, storage: h.storage, config, budget, fetchImpl: fetchImpl as typeof fetch});
    const ctx = {heartbeat: async () => {}, isCancelled: async () => false};
    await handler(job, ctx as never);
    const result = (await photoGallery(h.pool, scope)).predictions[0]!;
    expect(result.status).toBe('ready');
    expect((await owner.call('GET', result.imagePath!)).statusCode).toBe(200);
    expect((await stranger.call('GET', result.imagePath!)).statusCode).toBe(404);
    await handler(job, ctx as never);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const storageKey = (await h.pool.query('SELECT storage_key FROM field_photo_predictions WHERE id=$1', [prediction.id])).rows[0].storage_key;
    await owner.call('DELETE', `${base}/${photo.id}`);
    await expect(h.storage.get({ownerId: scope.ownerId, key: storageKey})).rejects.toThrow();
  });
  it('ignores absent and corrupt EXIF offsets', () => {
    expect(exifCreatedDate(undefined)).toBeNull();
    expect(exifCreatedDate(new Uint8Array([73,73,42,0,255,255,255,255]))).toBeNull();
  });
});
