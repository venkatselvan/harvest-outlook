/**
 * Live Sentinel-2 NDVI smoke (anonymous Microsoft Planetary Computer; no keys, no Meta, nothing paid).
 * Creates and removes its own QA owner and farm whose boundary is a public 0.02 degree test square near Hassan
 * (13.24-13.26 N, 76.24-76.26 E), never a farmer's field. Writes a sanitized record without owner/farm ids.
 * Run: pnpm --filter @harvest/api exec tsx ../../scripts/smoke/sentinel2-ndvi-smoke.ts
 */
import '../../apps/api/src/env';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {loadConfig} from '../../apps/api/src/config';
import {createPool} from '../../apps/api/src/db/pool';
import {createFarm} from '../../apps/api/src/services/farms';
import {putWorkspace} from '../../apps/api/src/services/workspace';
import {FsStorage} from '../../apps/api/src/storage/fs';
import {NdviSeries, NeighbourhoodSeasonality} from '../../packages/contracts/src/ndvi';
import {PC_ORIGIN, type Sentinel2Fetch} from '../../apps/api/src/providers/sentinel2';
import {ndviSeries, neighbourhoodSeasonality, sceneImage, type NdviDeps} from '../../apps/api/src/services/today/ndvi';

const config = loadConfig();
const database = new URL(config.DATABASE_URL);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(database.hostname)) throw new Error('smoke_requires_local_database');
if (config.RUNTIME_MODE !== 'live') throw new Error('smoke_requires_live_mode');
const pool = createPool(config.DATABASE_URL);
const FROM = '2025-11-01', TO = '2026-10-31';
const SQUARE = [[76.24, 13.24], [76.26, 13.24], [76.26, 13.26], [76.24, 13.26], [76.24, 13.24]] as [number, number][];
const calls: {kind: string; status: number; ms: number}[] = [];
const fetchImpl: Sentinel2Fetch = async (url, init) => {
  const u = new URL(url);
  if (u.origin !== PC_ORIGIN) throw new Error('smoke_unexpected_provider');
  const started = Date.now();
  const res = await fetch(url, init);
  calls.push({kind: u.pathname.endsWith('/search') ? 'stac_search' : u.pathname.endsWith('feature.npy') ? 'feature_npy' : u.pathname.includes('/item/bbox/') ? 'bbox_png' : 'other', status: res.status, ms: Date.now() - started});
  return res;
};
const tally = (list: typeof calls) => Object.fromEntries(['stac_search', 'feature_npy', 'bbox_png', 'other'].map((k) => [k, list.filter((c) => c.kind === k).length]));

let ownerId: string | undefined, farmId: string | undefined;
const storageRoot = await mkdtemp(join(tmpdir(), 'ho-ndvi-smoke-'));
const startedAt = new Date().toISOString();
let report: Record<string, unknown> = {
  startedAt, mode: config.RUNTIME_MODE, provider: 'Microsoft Planetary Computer (Preview; anonymous)', collection: 'sentinel-2-l2a', metaCalls: 0,
  polygon: {bbox: [76.24, 13.24, 76.26, 13.26], description: 'Public 0.02 degree test square around 13.25 N, 76.25 E (Hassan district), not a farm boundary; about 4.8 km2.'},
  window: {from: FROM, to: TO},
};
try {
  ownerId = (await pool.query<{id: string}>('INSERT INTO owners DEFAULT VALUES RETURNING id')).rows[0]!.id;
  farmId = (await createFarm(pool, ownerId, {name: `Temporary NDVI QA ${randomUUID()}`, location: {stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 13.25, lon: 76.25}})).id;
  await putWorkspace(pool, ownerId, farmId, {expectedVersion: 0, boundary: {type: 'Polygon', coordinates: [SQUARE]}, previousHarvest: {status: 'unknown'}, cycles: [], rotationPlans: []});
  const deps: NdviDeps = {config: {RUNTIME_MODE: 'live'}, pool, fetchImpl};
  const t0 = Date.now();
  const series = NdviSeries.parse(await ndviSeries(deps, ownerId, farmId, {from: FROM, to: TO, maxScenes: 120}));
  const firstMs = Date.now() - t0, firstCalls = calls.length;
  const repeat = NdviSeries.parse(await ndviSeries(deps, ownerId, farmId, {from: FROM, to: TO, maxScenes: 120}));
  const repeatCalls = calls.length - firstCalls;
  const seasonality = NeighbourhoodSeasonality.parse(await neighbourhoodSeasonality(deps, ownerId, farmId, {maxScenes: 120}));
  const seasonalityCalls = calls.length - firstCalls - repeatCalls;
  const images: Record<string, unknown> = {};
  if (series.latestUsable) {
    const storage = new FsStorage(storageRoot);
    for (const kind of ['visual', 'ndvi'] as const) {
      const before = calls.length;
      const image = await sceneImage({...deps, storage}, ownerId, farmId, series.latestUsable.itemId, kind).catch((e: {code?: string; details?: unknown}) => ({error: e.code ?? 'error', details: e.details}));
      if ('bytes' in image) {
        const meta = {width: image.bytes.readUInt32BE(16), height: image.bytes.readUInt32BE(20)}; // PNG IHDR
        const again = await sceneImage({...deps, storage}, ownerId, farmId, series.latestUsable.itemId, kind);
        images[kind] = {date: series.latestUsable.date, contentType: image.contentType, bytes: image.bytes.length, width: meta.width, height: meta.height, providerCalls: calls.length - before, servedFromStorageOnRepeat: again.cached};
      } else images[kind] = image;
    }
  }
  const usable = series.readings.filter((r) => r.usable);
  const rejected = series.readings.find((r) => r.date === '2026-10-29') ?? null;
  report = {
    ...report, completedAt: new Date().toISOString(), firstCallMs: firstMs,
    series: {
      status: series.status, reason: series.reason, polygonPixels: series.polygonPixels, smallField: series.smallField, method: series.method,
      scenesListed: series.scenesListed, scenesAnalysed: series.scenesAnalysed, scenesPending: series.scenesPending, scenesFailed: series.scenesFailed,
      usableCount: usable.length, usableNeighbourhoodCount: series.readings.filter((r) => r.neighbourhood?.usable).length,
      latestUsable: series.latestUsable && {date: series.latestUsable.date, itemId: series.latestUsable.itemId, fieldMean: series.latestUsable.field.mean, fieldMedian: series.latestUsable.field.median, neighbourhoodMean: series.latestUsable.neighbourhood?.mean ?? null},
      readings: series.readings.map((r) => ({date: r.date, itemId: r.itemId, sceneCloudPct: r.sceneCloudPct === null ? null : Math.round(r.sceneCloudPct * 100) / 100, baseline: r.baseline, usable: r.usable, rejection: r.field.rejection,
        field: {mean: r.field.mean, median: r.field.median, p10: r.field.p10, p90: r.field.p90, clearFraction: r.field.clearFraction, cloudOrShadowFraction: r.field.cloudOrShadowFraction, b04P95: r.field.b04P95},
        neighbourhood: r.neighbourhood && {mean: r.neighbourhood.mean, clearFraction: r.neighbourhood.clearFraction, usable: r.neighbourhood.usable, rejection: r.neighbourhood.rejection, totalPixels: r.neighbourhood.totalPixels}})),
      limitations: series.limitations,
    },
    rejectedScene20261029: rejected && {itemId: rejected.itemId, sceneCloudPct: rejected.sceneCloudPct, usable: rejected.usable, fieldRejection: rejected.field.rejection, fieldB04P95: rejected.field.b04P95, neighbourhoodRejection: rejected.neighbourhood?.rejection ?? null, neighbourhoodB04P95: rejected.neighbourhood?.b04P95 ?? null},
    cacheRepeat: {providerCalls: repeatCalls, readingsIdentical: JSON.stringify(repeat.readings) === JSON.stringify(series.readings)},
    seasonality: {window: seasonality.window, providerCalls: seasonalityCalls, months: seasonality.months, activeMonths: seasonality.activeMonths, threshold: seasonality.activeThreshold},
    images,
    networkCalls: {total: calls.length, byKind: tally(calls), nonOkStatuses: calls.filter((c) => c.status !== 200).map((c) => ({kind: c.kind, status: c.status})), maxMs: Math.max(0, ...calls.map((c) => c.ms))},
  };
} catch (e) {
  report = {...report, failed: true, reason: (e as {code?: string}).code ?? 'ndvi_smoke_failed', networkCalls: {total: calls.length, byKind: tally(calls)}};
  process.exitCode = 1;
} finally {
  if (farmId && ownerId) await pool.query('DELETE FROM farms WHERE id=$1 AND owner_id=$2', [farmId, ownerId]);
  if (ownerId) await pool.query('DELETE FROM owners WHERE id=$1', [ownerId]);
  const ownerLeft = ownerId ? (await pool.query('SELECT 1 FROM owners WHERE id=$1', [ownerId])).rowCount : 0;
  const rowsLeft = farmId ? (await pool.query('SELECT 1 FROM ndvi_scene_stats WHERE farm_id=$1', [farmId])).rowCount : 0;
  await rm(storageRoot, {recursive: true, force: true});
  report.qaRecordsCleaned = ownerLeft === 0 && rowsLeft === 0;
  report.scope = 'Dedicated temporary QA owner/farm and temporary private storage only, all deleted; the public STAC scene-list cache row in provider_cache remains (hash key, no coordinates). No other farm, session or owner touched.';
  const out = resolve(import.meta.dirname, '../../evals/results/live-smoke/ndvi-2026-11-01.json');
  await mkdir(resolve(out, '..'), {recursive: true});
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  const s = report.series as {scenesListed?: number; scenesAnalysed?: number; usableCount?: number} | undefined;
  console.log(JSON.stringify({failed: report.failed ?? false, scenesListed: s?.scenesListed, scenesAnalysed: s?.scenesAnalysed, usable: s?.usableCount, rejected: report.rejectedScene20261029, cacheRepeat: report.cacheRepeat, images: report.images, networkCalls: report.networkCalls, qaRecordsCleaned: report.qaRecordsCleaned}, null, 2));
  await pool.end();
}
