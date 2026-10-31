/**
 * Live smoke for the Today "future look" (one paid Muse Image edit, documented $0.01; nothing else is paid).
 * Creates and removes its own temporary owner and farm near Hassan whose boundary is a public test rectangle drawn on a
 * visibly bare parcel in the 2026-10-27 Sentinel-2 scene (about 12.9434-12.9441 N, 76.1315-76.1324 E), never a farmer's
 * field. Uses the production request path (requestFutureLook with the real stage timeline), the production job
 * (runFutureLook: budget reserve/claimDispatch/settle, QA) and the production NDVI series for the latest usable scene.
 * The output is a generated illustration of a typical stage, not an observation or prediction.
 * Run: pnpm --filter @harvest/api exec tsx ../../scripts/smoke/future-look-smoke.ts
 */
import '../../apps/api/src/env';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {loadConfig} from '../../apps/api/src/config';
import {createPool} from '../../apps/api/src/db/pool';
import {Budget} from '../../apps/api/src/services/budget';
import {createFarm} from '../../apps/api/src/services/farms';
import {putWorkspace} from '../../apps/api/src/services/workspace';
import {FsStorage} from '../../apps/api/src/storage/fs';
import {ndviSeries} from '../../apps/api/src/services/today/ndvi';
import {buildFutureLookPrompt, futureLookStatus, requestFutureLook} from '../../apps/api/src/services/today/future-look';
import {runFutureLook} from '../../apps/api/src/worker/handlers/future-look';

const sharp = createRequire(new URL('../../apps/api/package.json', import.meta.url))('sharp') as typeof import('sharp');
const config = loadConfig();
const database = new URL(config.DATABASE_URL);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname)) throw new Error('smoke_requires_local_database');
if (config.RUNTIME_MODE !== 'live') throw new Error('smoke_requires_live_mode');
const key = config.MODEL_API_KEY;
if (!key) { console.log('MODEL_API_KEY not set; skipping future-look smoke'); process.exit(0); }
const pool = createPool(config.DATABASE_URL);
const DAY = '2026-11-01';
const RING: [number, number][] = [[76.1315, 12.9434], [76.1324, 12.9434], [76.1324, 12.9441], [76.1315, 12.9441], [76.1315, 12.9434]];
const OUT_JSON = resolve(import.meta.dirname, `../../evals/results/live-smoke/future-look-${DAY}.json`);
const OUT_SOURCE = resolve(import.meta.dirname, `../../evals/results/live-smoke/future-look-${DAY}-source.jpg`);
const OUT_SAMPLE = resolve(import.meta.dirname, `../../docs/reference/redesign/future-look-sample-${DAY}.png`);

// Meta transport wrapper: records the response shape (never the key or the base64), keeps the returned PNG and the sent image.
const metaOrigin = new URL(config.META_BASE_URL).origin;
let metaCalls = 0, sent: Buffer | null = null, sentPrompt: string | null = null, returned: Buffer | null = null, shape: unknown = null, latencyMs: number | null = null;
const metaFetch: typeof fetch = async (url, init) => {
  if (new URL(String(url)).origin !== metaOrigin) throw new Error('smoke_unexpected_provider');
  metaCalls++;
  const req = JSON.parse(String(init?.body)) as {prompt: string; images: {image_url: string}[]};
  sentPrompt = req.prompt;
  sent = Buffer.from(req.images[0]!.image_url.split(',')[1]!, 'base64');
  const t0 = Date.now();
  const res = await fetch(url, init);
  latencyMs = Date.now() - t0;
  const text = await res.text();
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const data = Array.isArray(j.data) ? (j.data as Record<string, unknown>[]) : [];
    if (typeof data[0]?.b64_json === 'string') returned = Buffer.from(data[0].b64_json, 'base64');
    shape = {status: res.status, topLevelKeys: Object.keys(j), dataItemKeys: data[0] ? Object.keys(data[0]) : [], usage: j.usage ?? null, error: j.error ?? null, hasId: typeof j.id === 'string', requestIdHeader: res.headers.has('x-request-id')};
  } catch { shape = {status: res.status, nonJson: true}; }
  return new Response(text, {status: res.status, headers: res.headers});
};

let ownerId: string | undefined, farmId: string | undefined;
const storageRoot = await mkdtemp(join(tmpdir(), 'ho-future-look-smoke-'));
let report: Record<string, unknown> = {
  kind: 'future_look_live_smoke', startedAt: new Date().toISOString(), mode: config.RUNTIME_MODE, model: config.META_IMAGE_MODEL, baseUrl: config.META_BASE_URL,
  label: 'Generated illustration of a typical stage made by editing public Copernicus Sentinel-2 imagery (Microsoft Planetary Computer). Not an observation of any field and not a prediction.',
  polygon: {ring: RING, description: 'Public test rectangle (~97 m x 76 m) on a bare-looking parcel near Hassan, not a farm boundary.'},
  cycle: {cropId: 'maize', sowingDate: '2026-09-20', stageId: 'mid_season'},
};
try {
  ownerId = (await pool.query<{id: string}>('INSERT INTO owners DEFAULT VALUES RETURNING id')).rows[0]!.id;
  farmId = (await createFarm(pool, ownerId, {name: `Temporary future-look QA ${randomUUID()}`, location: {stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 12.94375, lon: 76.13195}})).id;
  await putWorkspace(pool, ownerId, farmId, {expectedVersion: 0, boundary: {type: 'Polygon', coordinates: [RING]}, previousHarvest: {status: 'unknown'},
    cycles: [{id: 'smoke-maize', cropId: 'maize', cropName: 'Maize', sowingDate: '2026-09-20', stage: 'growing'}], rotationPlans: []});
  const series = await ndviSeries({config: {RUNTIME_MODE: 'live'}, pool}, ownerId, farmId, {from: '2026-09-15', maxScenes: 12});
  const latest = series.latestUsable;
  if (!latest) throw Object.assign(new Error('no usable scene'), {code: 'no_usable_scene'});
  report.scene = {itemId: latest.itemId, date: latest.date, fieldNdviMean: latest.field.mean, polygonPixels: series.polygonPixels, scenesAnalysed: series.scenesAnalysed};
  const deps = {config, pool};
  const req = await requestFutureLook(deps, ownerId, farmId, {itemId: latest.itemId, stageId: 'mid_season', cycleId: 'smoke-maize'});
  report.request = req;
  if (req.status !== 'queued') throw Object.assign(new Error('not queued'), {code: `request_${req.reason ?? req.status}`});
  const job = (await pool.query<{id: string; owner_id: string; payload: unknown}>('SELECT j.id, j.owner_id, j.payload FROM jobs j JOIN future_look_assets a ON a.job_id=j.id WHERE a.id=$1', [req.assetId])).rows[0]!;
  const storage = new FsStorage(storageRoot);
  const result = await runFutureLook({config, pool, storage, budget: Budget.fromConfig(pool, config), fetchImpl: metaFetch, timeoutMs: 180_000}, job, {heartbeat: async () => undefined});
  const asset = await futureLookStatus(deps, ownerId, farmId, req.assetId!);
  const row = (await pool.query<{storage_key: string | null; stage_name: string; crop_name: string}>('SELECT storage_key, stage_name, crop_name FROM future_look_assets WHERE id=$1', [req.assetId])).rows[0]!;
  const reservations = (await pool.query('SELECT state, estimated_usd, settled_usd FROM usage_reservations WHERE job_id=$1', [job.id])).rows;
  const ledger = (await pool.query('SELECT settled_usd, cost_basis, usage FROM usage_ledger WHERE reservation_id IN (SELECT id FROM usage_reservations WHERE job_id=$1)', [job.id])).rows;
  const invocations = (await pool.query("SELECT purpose, status, requested_model, model FROM ai_invocations WHERE owner_id=$1", [ownerId])).rows;
  await mkdir(resolve(OUT_SAMPLE, '..'), {recursive: true});
  let sample: string | null = null;
  if (row.storage_key && asset.status === 'ready') {
    await writeFile(OUT_SAMPLE, Buffer.from(await storage.get({ownerId, key: row.storage_key})));
    sample = 'stored illustration (QA passed), 512x512 as served';
  } else if (returned) {
    await sharp(returned).resize(512, 512, {fit: 'fill'}).png().toFile(OUT_SAMPLE);
    sample = 'provider output resized to 512x512; NOT stored by the product because QA rejected it';
  }
  if (sent) await writeFile(OUT_SOURCE, sent);
  report = {
    ...report, completedAt: new Date().toISOString(),
    prompt: sentPrompt, promptMatchesTemplate: sentPrompt === buildFutureLookPrompt({stageId: 'mid_season', stageName: row.stage_name, cropName: row.crop_name}),
    stage: {stageId: asset.stageId, stageName: asset.stageName, note: 'The maize StageTimeline has no "tasselling" stage; mid_season (FAO-56: effective full cover, for many crops at the initiation of flowering, to the start of maturity) is the stage that starts around tasselling.'},
    job: {status: result.status, reason: result.reason, providerCalls: result.providerCalls, metaHttpCalls: metaCalls, latencyMs, cost: result.cost},
    qa: result.qa, asset: {status: asset.status, label: asset.label, derivedFromDate: asset.derivedFromDate, model: asset.model, responseDeleted: asset.responseDeleted, failureReason: asset.failureReason},
    responseDeletion: 'not applicable: POST /images/edits returned no response id (see responseShape.hasId), so there is no stored response to delete; provider-side retention of the input image is not documented here',
    responseShape: shape, returnedImage: returned ? await sharp(returned).metadata().then((m) => ({width: m.width, height: m.height, format: m.format})) : null,
    budget: {reservations, ledger}, aiInvocations: invocations,
    artifacts: {sample: sample ? {path: 'docs/reference/redesign/future-look-sample-2026-11-01.png', what: sample} : null, source: sent ? 'evals/results/live-smoke/future-look-2026-11-01-source.jpg (the image sent: observed scene with the red field outline)' : null},
  };
} catch (e) {
  report = {...report, failed: true, reason: (e as {code?: string}).code ?? String((e as Error).message).slice(0, 200), metaHttpCalls: metaCalls, responseShape: shape};
  process.exitCode = 1;
} finally {
  if (ownerId) await pool.query('DELETE FROM jobs WHERE owner_id=$1', [ownerId]);
  if (farmId && ownerId) await pool.query('DELETE FROM farms WHERE id=$1 AND owner_id=$2', [farmId, ownerId]);
  if (ownerId) await pool.query('DELETE FROM owners WHERE id=$1', [ownerId]);
  const left = async (sql: string, id: string | undefined) => (id ? (await pool.query(sql, [id])).rowCount ?? 0 : 0);
  const leftovers = {owner: await left('SELECT 1 FROM owners WHERE id=$1', ownerId), assets: await left('SELECT 1 FROM future_look_assets WHERE farm_id=$1', farmId), ndvi: await left('SELECT 1 FROM ndvi_scene_stats WHERE farm_id=$1', farmId)};
  await rm(storageRoot, {recursive: true, force: true});
  report.cleanup = {...leftovers, storageRemoved: true, clean: Object.values(leftovers).every((n) => n === 0), kept: 'usage_reservations/usage_ledger rows (owner set to NULL) as the spend record; the public STAC scene-list cache row (hash key).'};
  await mkdir(resolve(OUT_JSON, '..'), {recursive: true});
  await writeFile(OUT_JSON, `${JSON.stringify(report, null, 2).split(key).join('[redacted]')}\n`);
  console.log(JSON.stringify({failed: report.failed ?? false, reason: report.reason, scene: report.scene, request: report.request, job: report.job, qa: (report.qa as {passed?: boolean; scores?: unknown} | undefined) && {passed: (report.qa as {passed: boolean}).passed, scores: (report.qa as {scores: unknown}).scores}, asset: report.asset, budget: report.budget, cleanup: report.cleanup}, null, 2));
  await pool.end();
}
