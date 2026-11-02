/**
 * Field and neighbourhood NDVI series for the Today view (Stream B), computed in code from Sentinel-2 L2A bands.
 *
 * Owner isolation: every entry point resolves the farm through `getFarm(pool, ownerId, farmId)` first, so a foreign
 * or deleted farm is a 404 in every runtime mode; cached rows are read and written with owner_id and farm_id.
 * Mode separation: only live mode lists scenes, reads cached rows or calls the provider. Synthetic and replay return
 * `status:'unavailable'` (images: 409 mode_mismatch) without any network call.
 * Cost bound: at most `maxScenes` (default 12) uncached scenes are analysed per call, newest first, two requests per
 * scene (field + 1 km neighbourhood), two scenes at a time. Scene lists are cached for a day per window.
 * Indices (2026-11-01): each read also yields EVI, NDRE, GNDVI, SAVI, NDMI, LSWI and NDWI (`NdviStats.indices`). Rows
 * stored before that carry NDVI only; they stay visible but count as not analysed, and are re-read and upserted in place
 * within the same `maxScenes` budget, newest first. The polygon hash is unchanged, so their image keys are kept. When the
 * re-read's neighbourhood request fails permanently, the previously stored neighbourhood statistics are kept, not nulled.
 *
 * Integration (done 2026-11-01): `todayNdviRoutes` is registered in routes/index.ts and `deleteFarm` (services/farms.ts)
 * removes the `image_keys` objects of ndvi_scene_stats before the cascade. A worker job type for background back-fill
 * is not wired.
 */
import {z} from 'zod';
import type {Config} from '../../config';
import type {Pool} from '../../db/pool';
import {StorageError, type StorageAdapter} from '../../storage/types';
import {pgCache} from '../../ingest/cache';
import {getFarm} from '../farms';
import {fieldOf, getWorkspace} from '../workspace';
import {ApiError, notFound} from '../errors';
import {sha256Hex} from '../hash';
import {NdviStats, type NdviReading, type NdviSeries, type NeighbourhoodSeasonality} from '@harvest/contracts';
import {
  DEFAULT_MAX_SCENE_CLOUD_PCT, INDEX_METHOD_VERSION, ITEM_ID_RE, MIN_CLEAR_FRACTION, MIN_CLEAR_PIXELS, NDVI_METHOD_VERSION, SCL_KEEP, SENTINEL2_ATTRIBUTION,
  baselineOffset, bboxProblem, displayBbox, fieldBbox, fieldRenderSize, listScenes, neighbourhoodBands, polygonBands, prepareRing, renderScene, ringBbox, squareAround,
  type Bbox, type ImageKind, type LonLat, type SceneSummary, type Sentinel2Fetch,
} from '../../providers/sentinel2';

export interface NdviDeps {
  config: Pick<Config, 'RUNTIME_MODE'>;
  pool: Pool;
  fetchImpl?: Sentinel2Fetch | undefined;
  now?: (() => Date) | undefined;
}
export interface NdviImageDeps extends NdviDeps { storage: StorageAdapter }
export interface NdviSeriesOptions {
  from?: string | undefined; to?: string | undefined; maxScenes?: number | undefined; maxSceneCloudPct?: number | undefined;
  /** 2026-11-03: read the named field's polygon instead of the farm boundary (404 field_not_found when unknown). */
  fieldId?: string | undefined;
}

export const DEFAULT_MAX_SCENES = 12;
const MAX_WINDOW_DAYS = 400;
const SCENE_LIST_TTL_MS = 24 * 3600_000;
/** Fallback field when no boundary is drawn: a 100 m square (1 ha) centred on the farm point. */
const FALLBACK_SQUARE_M = 100;
const SMALL_FIELD_PIXELS = 12;
export const ACTIVE_NDVI_THRESHOLD = 0.45;

const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const istToday = (now: Date) => new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
const tileFromId = (id: string) => /_T(\d{2}[A-Z]{3})_/.exec(id)?.[1] ?? null;

const METHOD = {version: NDVI_METHOD_VERSION, indexMethodVersion: INDEX_METHOD_VERSION, sclClassesKept: [...SCL_KEEP], minClearFraction: MIN_CLEAR_FRACTION, minClearPixels: MIN_CLEAR_PIXELS};
const BASE_LIMITATIONS = [
  'NDVI is computed in code from Sentinel-2 L2A B04 and B08 at 10 m after the +1000 offset correction (processing baseline 04.00 or later) and the SCL mask; it is not validated against field observations.',
  'SCL is an algorithmic classification and may miss thin haze; low NDVI or SCL class 5 (not vegetated) is not by itself evidence of bare soil or crop failure.',
  'The neighbourhood covers all land within about 1 km of the field (including the field, trees, water and settlements), not cropland only.',
  'Boundary vertices are rounded to 4 decimal places (about 11 m) before leaving the server; edge pixels mix the field with its surroundings.',
  'Imagery comes from the Microsoft Planetary Computer Preview service, which may change or be unavailable without notice.',
  'B05, B8A and B11 are 20 m bands resampled to the 10 m grid, so a 1 ha field has about 25 independent pixels for NDRE, LSWI and NDMI.',
  'EVI, NDRE, GNDVI, SAVI, NDMI, LSWI and NDWI are computed in code from the same clear pixels as NDVI and are not validated against field observations either; over a crop field NDWI (McFeeters) equals the negative of GNDVI and is meaningful mainly as an open-water flag.',
];

// ------------------------------------------------------------------ field polygon

interface FieldPolygon { ring: LonLat[]; basis: 'boundary' | 'farm_point_square'; hash: string; limitations: string[]; fieldId: string | null }

/** Hash of a prepared ring under the current method: the `polygon_hash` of ndvi_scene_stats rows. */
const ringHash = (ring: readonly LonLat[]) => sha256Hex(`${NDVI_METHOD_VERSION}|${JSON.stringify(ring)}`);
/** The `polygon_hash` a drawn boundary's rows are stored under (same rounding and hash as fieldPolygon), or null when the ring is unusable. */
export function boundaryPolygonHash(boundary: {coordinates: readonly (readonly (readonly number[])[])[]}): string | null {
  const ring = prepareRing(boundary.coordinates[0] ?? []);
  return ring ? ringHash(ring) : null;
}

/**
 * Owner-scoped; throws 404 for a foreign or deleted farm before anything else happens. With `fieldId` (2026-11-03) the
 * field's own ring is the polygon (basis 'boundary'), 404 field_not_found when the farm has no such field; the hash rule is
 * unchanged, so stored rows are naturally per field.
 */
async function fieldPolygon(pool: Pool, ownerId: string, farmId: string, fieldId?: string): Promise<FieldPolygon | {reason: string}> {
  const farm = await getFarm(pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const workspace = await getWorkspace(pool, ownerId, farmId);
  let ring: LonLat[] | null;
  let basis: FieldPolygon['basis'];
  const limitations: string[] = [];
  if (fieldId !== undefined) {
    const field = fieldOf(workspace, fieldId);
    ring = prepareRing(field.boundary.coordinates[0]!);
    if (!ring) return {reason: 'boundary_too_small'};
    basis = 'boundary';
  } else if (workspace.boundary) {
    ring = prepareRing(workspace.boundary.coordinates[0]!);
    if (!ring) return {reason: 'boundary_too_small'};
    basis = 'boundary';
  } else {
    const {lat, lon, precision} = farm.location;
    if (lat === null || lon === null) return {reason: 'farm_location_missing'};
    if (precision === 'district') return {reason: 'farm_location_too_coarse'};
    ring = squareAround(lat, lon, FALLBACK_SQUARE_M);
    if (!ring) return {reason: 'farm_location_invalid'};
    basis = 'farm_point_square';
    limitations.push('No field boundary is drawn; a 100 m square around the farm location stands in for the field.');
    if (precision === 'approximate') limitations.push('The farm location is approximate (about 1 km), so the field reading may describe a neighbouring area.');
  }
  if (bboxProblem(ringBbox(ring))) return {reason: 'boundary_too_large'};
  return {ring, basis, hash: ringHash(ring), limitations, fieldId: fieldId ?? null};
}

// ------------------------------------------------------------------ scene list (cached per window per day)

const CachedScenes = z.object({
  scenes: z.array(z.object({id: z.string().regex(ITEM_ID_RE), datetime: z.string(), cloudPct: z.number().nullable(), baseline: z.string().nullable(), tileId: z.string().nullable(), platform: z.string().nullable()})),
  truncated: z.boolean(), duplicatesSkipped: z.number().int(),
});
type SceneList = z.infer<typeof CachedScenes>;

async function sceneList(deps: NdviDeps, bbox: Bbox, from: string, to: string, maxCloud: number, now: Date): Promise<SceneList | {reason: string}> {
  const cache = pgCache(deps.pool);
  // Hash, not raw coordinates, in the shared cache key.
  const key = `sentinel2:scenes:v1:${sha256Hex(JSON.stringify({bbox, from, to, maxCloud}))}`;
  const hit = await cache.get(key);
  if (hit && hit.expiresAt.getTime() > now.getTime()) {
    const parsed = CachedScenes.safeParse(hit.payload);
    if (parsed.success) return parsed.data;
  }
  const listed = await listScenes({bbox, from, to, maxCloudPct: maxCloud, fetchImpl: deps.fetchImpl});
  if (listed.status !== 'ok') return {reason: listed.reason};
  const payload: SceneList = {scenes: listed.scenes, truncated: listed.truncated, duplicatesSkipped: listed.duplicatesSkipped};
  await cache.put({key, provider: 'planetary-computer-stac', fetchedAt: now, expiresAt: new Date(now.getTime() + SCENE_LIST_TTL_MS), payload});
  return payload;
}

// ------------------------------------------------------------------ cached statistics rows

interface StatsRow { id: string; item_id: string; acquired_at: Date; baseline: string | null; scene_cloud_pct: number | null; field_stats: unknown; neighbourhood_stats: unknown; usable: boolean; image_keys: Record<string, string> | null }

function toReading(row: StatsRow, scene?: SceneSummary): NdviReading | null {
  const field = NdviStats.safeParse(row.field_stats);
  const nb = row.neighbourhood_stats === null ? null : NdviStats.safeParse(row.neighbourhood_stats);
  if (!field.success || (nb && !nb.success)) return null;
  const acquiredAt = row.acquired_at.toISOString();
  return {
    itemId: row.item_id, date: acquiredAt.slice(0, 10), acquiredAt, tileId: scene?.tileId ?? tileFromId(row.item_id),
    baseline: row.baseline, offsetApplied: baselineOffset(row.baseline) === 1000, sceneCloudPct: row.scene_cloud_pct,
    usable: field.data.usable, field: field.data, neighbourhood: nb && nb.success ? nb.data : null,
  };
}

/**
 * Analysed under the current method: the field stats carry `indices`. Rows written before the indices existed parse but are
 * incomplete; they are shown and re-analysed like missing scenes. The neighbourhood is not part of the test: a re-read whose
 * neighbourhood failed permanently keeps the earlier NDVI-only neighbourhood, and must not be re-read on every request.
 */
const isComplete = (r: NdviReading) => r.field.indices !== undefined;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

// ------------------------------------------------------------------ public entry points

/**
 * NDVI readings for the farm's field polygon between `from` and `to` (calendar dates, default the last 365 days).
 * Serves cached rows, analyses up to `maxScenes` missing or incomplete (NDVI-only) scenes newest first, and stores them.
 * scenesAnalysed counts complete readings and scenesPending the missing or incomplete scenes left for later requests.
 */
export async function ndviSeries(deps: NdviDeps, ownerId: string, farmId: string, opts: NdviSeriesOptions = {}): Promise<NdviSeries> {
  const now = (deps.now ?? (() => new Date()))();
  const today = istToday(now);
  const to = opts.to ?? today;
  const from = opts.from ?? addDays(to, -364);
  if (!isoDay.test(from) || !isoDay.test(to) || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from > to || to > addDays(today, 1) || dayDiff(from, to) > MAX_WINDOW_DAYS) {
    throw new ApiError(400, 'validation_error', `NDVI window must be valid dates, from <= to, not in the future, and at most ${MAX_WINDOW_DAYS} days`);
  }
  const maxScenes = Math.max(0, Math.min(120, Math.trunc(opts.maxScenes ?? DEFAULT_MAX_SCENES)));
  const maxCloud = Math.max(1, Math.min(100, opts.maxSceneCloudPct ?? DEFAULT_MAX_SCENE_CLOUD_PCT));
  const field = await fieldPolygon(deps.pool, ownerId, farmId, opts.fieldId);
  const base: NdviSeries = {
    farmId, status: 'unavailable', reason: null, window: {from, to}, polygonBasis: null, polygonPixels: null, smallField: false, imageBbox: null,
    scenesListed: 0, scenesAnalysed: 0, scenesPending: 0, scenesFailed: 0, readings: [], latestUsable: null,
    method: {...METHOD, maxSceneCloudPct: maxCloud}, attribution: SENTINEL2_ATTRIBUTION, limitations: [...BASE_LIMITATIONS],
  };
  if (deps.config.RUNTIME_MODE !== 'live') return {...base, reason: 'live_mode_required', limitations: ['Satellite readings are only fetched in live mode; no synthetic NDVI is shown.']};
  if ('reason' in field) return {...base, reason: field.reason};
  const {ring, hash} = field;
  const located: NdviSeries = {...base, polygonBasis: field.basis, imageBbox: [...displayBbox(ring)] as [number, number, number, number], limitations: [...field.limitations, ...BASE_LIMITATIONS]};

  const cachedRows = async () => (await deps.pool.query<StatsRow>(
    `SELECT id,item_id,acquired_at,baseline,scene_cloud_pct,field_stats,neighbourhood_stats,usable,image_keys FROM ndvi_scene_stats
     WHERE owner_id=$1 AND farm_id=$2 AND polygon_hash=$3 AND acquired_at >= ($4::date::timestamp AT TIME ZONE 'UTC') AND acquired_at < (($5::date + 1)::timestamp AT TIME ZONE 'UTC')
     ORDER BY acquired_at`, [ownerId, farmId, hash, from, to])).rows;
  const listing = await sceneList(deps, ringBbox(ring), from, to, maxCloud, now);
  let rows = await cachedRows();
  const limitations = [...located.limitations];
  let scenesListed = 0, scenesPending = 0, scenesFailed = 0;
  const scenesById = new Map<string, SceneSummary>();
  if ('reason' in listing) {
    if (!rows.length) return {...located, reason: listing.reason};
    limitations.unshift(`The scene catalogue could not be read now (${listing.reason}); only previously analysed scenes are shown.`);
  } else {
    for (const s of listing.scenes) scenesById.set(s.id, s);
    scenesListed = listing.scenes.length;
    const have = new Set(rows.filter((r) => { const reading = toReading(r); return reading !== null && isComplete(reading); }).map((r) => r.item_id));
    const missing = listing.scenes.filter((s) => !have.has(s.id));
    const batch = missing.slice(0, maxScenes);
    // Stored neighbourhood statistics that still parse, kept when a re-read's neighbourhood request fails permanently.
    const storedNeighbourhood = new Map(rows.filter((r) => r.neighbourhood_stats !== null && NdviStats.safeParse(r.neighbourhood_stats).success).map((r) => [r.item_id, r.neighbourhood_stats]));
    const failures: string[] = [];
    await mapLimit(batch, 2, async (scene) => {
      const fieldRead = await polygonBands({itemId: scene.id, polygon: ring, baseline: scene.baseline, fetchImpl: deps.fetchImpl});
      if (fieldRead.status !== 'ok') { failures.push(fieldRead.reason); return; }
      const nbRead = await neighbourhoodBands({itemId: scene.id, polygon: ring, baseline: scene.baseline, fetchImpl: deps.fetchImpl});
      if (nbRead.status !== 'ok' && nbRead.transient) { failures.push(nbRead.reason); return; }
      const neighbourhood = nbRead.status === 'ok' ? nbRead.stats : storedNeighbourhood.get(scene.id) ?? null;
      try {
        await deps.pool.query(
          `INSERT INTO ndvi_scene_stats(owner_id,farm_id,polygon_hash,item_id,acquired_at,baseline,scene_cloud_pct,field_stats,neighbourhood_stats,usable)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
           ON CONFLICT (farm_id,polygon_hash,item_id) DO UPDATE SET field_stats=EXCLUDED.field_stats,neighbourhood_stats=EXCLUDED.neighbourhood_stats,
             usable=EXCLUDED.usable,baseline=EXCLUDED.baseline,scene_cloud_pct=EXCLUDED.scene_cloud_pct,fetched_at=now()
           WHERE ndvi_scene_stats.owner_id=EXCLUDED.owner_id`,
          [ownerId, farmId, hash, scene.id, scene.datetime, scene.baseline, scene.cloudPct, JSON.stringify(fieldRead.stats), neighbourhood === null ? null : JSON.stringify(neighbourhood), fieldRead.stats.usable]);
      } catch (e) {
        if ((e as {code?: string}).code === '23503') throw notFound('Farm'); // farm deleted mid-request
        throw e;
      }
    });
    scenesFailed = failures.length;
    scenesPending = Math.max(0, missing.length - batch.length);
    if (batch.length) rows = await cachedRows();
    if (scenesPending) limitations.unshift(`${scenesPending} older scenes in this window are not analysed yet (at most ${maxScenes} per request); they are added on later requests.`);
    if (scenesFailed) limitations.unshift(`${scenesFailed} scenes could not be read from the provider (${[...new Set(failures)].join(', ')}) and will be retried.`);
    if (listing.truncated) limitations.push('The scene catalogue returned its maximum page; the oldest scenes in the window may be missing.');
    if (listing.duplicatesSkipped) limitations.push(`${listing.duplicatesSkipped} duplicate acquisitions from overlapping Sentinel-2 tiles were skipped.`);
  }
  const readings = rows.map((r) => toReading(r, scenesById.get(r.item_id))).filter((r): r is NdviReading => r !== null);
  const newest = readings.at(-1) ?? null;
  const polygonPixels = newest ? newest.field.totalPixels : null;
  const smallField = polygonPixels !== null && polygonPixels < SMALL_FIELD_PIXELS;
  if (smallField) limitations.unshift(`The boundary covers ${polygonPixels} Sentinel-2 pixels (fewer than ${SMALL_FIELD_PIXELS}); the field-only reading is unreliable, so rely on the neighbourhood value.`);
  if (readings.length && !readings.some((r) => r.usable)) limitations.unshift('No analysed scene in this window had a clear, plausible view of the field.');
  const listedIds = new Set(scenesById.keys());
  return {
    ...located, status: 'available', reason: 'reason' in listing ? 'scene_catalogue_unavailable_cached_only' : null,
    polygonPixels, smallField, scenesListed,
    scenesAnalysed: readings.filter((r) => isComplete(r) && ('reason' in listing || listedIds.has(r.itemId))).length,
    scenesPending, scenesFailed, readings, latestUsable: [...readings].reverse().find((r) => r.usable) ?? null,
    limitations: limitations.slice(0, 20),
  };
}

/**
 * Monthly mean of usable neighbourhood NDVI over the last 12 complete calendar months (IST; the current partial month
 * is excluded). Months with no usable neighbourhood scene are null, never inactive. Active months have a mean at or
 * above 0.45 (design threshold).
 */
export async function neighbourhoodSeasonality(deps: NdviDeps, ownerId: string, farmId: string, opts: {maxScenes?: number | undefined} = {}): Promise<NeighbourhoodSeasonality> {
  const now = (deps.now ?? (() => new Date()))();
  const today = istToday(now);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const monthKeys = Array.from({length: 12}, (_, i) => new Date(Date.UTC(y, m - 13 + i, 1)).toISOString().slice(0, 7));
  const from = `${monthKeys[0]}-01`;
  const to = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10); // last day of the previous month
  const series = await ndviSeries(deps, ownerId, farmId, {from, to, maxScenes: opts.maxScenes});
  const groups = new Map(monthKeys.map((k) => [k, {sum: 0, usable: 0, analysed: 0}]));
  for (const r of series.readings) {
    const g = groups.get(r.date.slice(0, 7));
    if (!g || !r.neighbourhood) continue;
    g.analysed++;
    if (r.neighbourhood.usable && r.neighbourhood.mean !== null) { g.sum += r.neighbourhood.mean; g.usable++; }
  }
  const months = monthKeys.map((k) => {
    const g = groups.get(k)!;
    return {month: k, monthOfYear: Number(k.slice(5, 7)), meanNdvi: g.usable ? Math.round((g.sum / g.usable) * 1e4) / 1e4 : null, usableScenes: g.usable, analysedScenes: g.analysed};
  });
  const limitations = [
    'Months without a usable neighbourhood scene (often monsoon cloud) are unknown, not inactive.',
    `The ${ACTIVE_NDVI_THRESHOLD} active-month threshold is a design choice, not a validated crop-calendar rule.`,
    'Neighbourhood NDVI mixes all land cover within about 1 km of the field, so it describes the landscape rather than any one crop.',
  ];
  if (series.scenesPending) limitations.unshift(`${series.scenesPending} scenes in the last 12 months are not analysed yet; monthly means may change as they are added.`);
  return {
    farmId, status: series.status, reason: series.reason, window: {from, to}, activeThreshold: ACTIVE_NDVI_THRESHOLD, months,
    activeMonths: [...new Set(months.filter((x) => x.meanNdvi !== null && x.meanNdvi >= ACTIVE_NDVI_THRESHOLD).map((x) => x.monthOfYear))],
    scenesPending: series.scenesPending, limitations: [...limitations, ...series.limitations].slice(0, 20),
  };
}

/**
 * Latest stored usable reading for a drawn polygon, newest acquired_at (2026-11-03, FieldSummary.greenness). Stored rows only:
 * no scene list, no provider call. Live mode only, like every other NDVI read; the caller has already resolved the farm for
 * the owner. `smallField` uses the row's own pixel count, as ndviSeries does for its newest reading.
 */
export async function latestStoredReading(pool: Pool, ownerId: string, farmId: string, polygonHash: string): Promise<{reading: NdviReading; smallField: boolean} | null> {
  const rows = (await pool.query<StatsRow>(
    `SELECT id,item_id,acquired_at,baseline,scene_cloud_pct,field_stats,neighbourhood_stats,usable,image_keys FROM ndvi_scene_stats
     WHERE owner_id=$1 AND farm_id=$2 AND polygon_hash=$3 AND usable ORDER BY acquired_at DESC LIMIT 5`, [ownerId, farmId, polygonHash])).rows;
  for (const row of rows) {
    const reading = toReading(row);
    if (reading && reading.usable && reading.field.mean !== null) return {reading, smallField: reading.field.totalPixels < SMALL_FIELD_PIXELS};
  }
  return null;
}

export type SceneZoom = 'wide' | 'field';
export interface SceneImage { bytes: Buffer; contentType: 'image/png'; acquiredAt: string; bbox: Bbox; cached: boolean }

/**
 * Storage key and `image_keys` name for a render (2026-11-03, FIELDS_MULTICROP_SOIL_SPEC.md 3.4). Two fields of one farm must
 * never share a render, so the name carries the first 8 hex characters of the polygon hash:
 * - field zoom: `{kind}-field-{hash8}` for every polygon (a farm without fields uses its farm ring's hash8);
 * - wide: `{kind}` for the farm polygon (unchanged), `{kind}-{hash8}` for a field's polygon (its 600 m frame is centred on
 *   the field, so it differs per field; the spec names only the field zoom, the wide key follows the same rule for fields).
 * Earlier `{kind}-field` entries stay in image_keys, so farm deletion still removes those objects.
 */
export function sceneImageName(kind: ImageKind, zoom: SceneZoom, polygonHash: string, scope: 'farm' | 'field' = 'farm'): string {
  const hash8 = polygonHash.slice(0, 8);
  if (zoom === 'field') return `${kind}-field-${hash8}`;
  return scope === 'field' ? `${kind}-${hash8}` : kind;
}
export const sceneImageKey = (farmId: string, itemId: string, kind: ImageKind, zoom: SceneZoom, polygonHash: string, scope: 'farm' | 'field' = 'farm') =>
  `ndvi/${farmId}/${itemId}/${sceneImageName(kind, zoom, polygonHash, scope)}.png`;

const fieldQuery = (fieldId: string | null | undefined) => (fieldId ? `&fieldId=${encodeURIComponent(fieldId)}` : '');
/** Owner-private route URLs of a scene's wide renders; a field view adds `&fieldId=` so the route reads that field's polygon. */
export function wideScenePaths(farmId: string, itemId: string, fieldId?: string | null): {imagePath: string; ndviImagePath: string} {
  const base = `/api/v1/farms/${farmId}/ndvi/${itemId}/image`;
  return {imagePath: `${base}?kind=visual${fieldQuery(fieldId)}`, ndviImagePath: `${base}?kind=ndvi${fieldQuery(fieldId)}`};
}
/** Owner-private route URLs of a scene's field-zoom renders (true colour and NDVI colour map), for `SceneRef`. */
export function fieldScenePaths(farmId: string, itemId: string, fieldId?: string | null): {fieldImagePath: string; fieldNdviImagePath: string} {
  const base = `/api/v1/farms/${farmId}/ndvi/${itemId}/image`;
  return {fieldImagePath: `${base}?kind=visual&zoom=field${fieldQuery(fieldId)}`, fieldNdviImagePath: `${base}?kind=ndvi&zoom=field${fieldQuery(fieldId)}`};
}

/** Window of the field-zoom render, for `TodayView.fieldImageBbox` (same for every scene of a polygon). */
export const fieldImageBbox = (boundary: readonly LonLat[]): [number, number, number, number] => [...fieldBbox(boundary)] as [number, number, number, number];

/**
 * Rendered PNG for a scene that the farm's (or, with `fieldId`, the field's) series already analysed. Stored once under the
 * owner's private key ndvi/{farmId}/{itemId}/{name}.png (see sceneImageName: wide 600 m window, or the field window at
 * native 10 m pixels, see `fieldBbox`) and served from storage afterwards.
 */
export async function sceneImage(deps: NdviImageDeps, ownerId: string, farmId: string, itemId: string, kind: ImageKind, zoom: SceneZoom = 'wide', fieldId?: string): Promise<SceneImage> {
  if (!ITEM_ID_RE.test(itemId)) throw new ApiError(400, 'validation_error', 'Invalid satellite scene id');
  if (kind !== 'visual' && kind !== 'ndvi') throw new ApiError(400, 'validation_error', 'Image kind must be visual or ndvi');
  if (zoom !== 'wide' && zoom !== 'field') throw new ApiError(400, 'validation_error', 'Image zoom must be wide or field');
  const field = await fieldPolygon(deps.pool, ownerId, farmId, fieldId);
  if (deps.config.RUNTIME_MODE !== 'live') throw new ApiError(409, 'mode_mismatch', 'Satellite images are only available in live mode');
  if ('reason' in field) throw notFound('Satellite scene');
  const row = (await deps.pool.query<StatsRow>(
    'SELECT id,item_id,acquired_at,baseline,scene_cloud_pct,field_stats,neighbourhood_stats,usable,image_keys FROM ndvi_scene_stats WHERE owner_id=$1 AND farm_id=$2 AND polygon_hash=$3 AND item_id=$4',
    [ownerId, farmId, field.hash, itemId])).rows[0];
  if (!row) throw notFound('Satellite scene');
  const bbox = zoom === 'field' ? fieldBbox(field.ring) : displayBbox(field.ring);
  const scope = field.fieldId ? 'field' : 'farm';
  const name = sceneImageName(kind, zoom, field.hash, scope);
  const key = sceneImageKey(farmId, itemId, kind, zoom, field.hash, scope);
  const acquiredAt = row.acquired_at.toISOString();
  if (row.image_keys?.[name] === key) {
    try {
      return {bytes: Buffer.from(await deps.storage.get({ownerId, key})), contentType: 'image/png', acquiredAt, bbox, cached: true};
    } catch (e) {
      if (!(e instanceof StorageError && e.code === 'not_found')) throw e;
    }
  }
  const rendered = await renderScene({itemId, bbox, kind, baseline: row.baseline, fetchImpl: deps.fetchImpl, ...(zoom === 'field' ? {size: fieldRenderSize(bbox)} : {})});
  if (rendered.status !== 'ok') throw new ApiError(424, 'provider_unavailable', 'The satellite image could not be rendered now', {reason: rendered.reason});
  await deps.storage.put({ownerId, key}, rendered.bytes);
  await deps.pool.query(`UPDATE ndvi_scene_stats SET image_keys=COALESCE(image_keys,'{}'::jsonb) || jsonb_build_object($3::text,$4::text) WHERE id=$1 AND owner_id=$2`, [row.id, ownerId, name, key]);
  // The farm wide key is per farm/item/kind, not per polygon: rows for an earlier boundary must not claim the re-rendered
  // file. Hashed names only meet here on an 8-hex prefix collision, which this also keeps correct.
  await deps.pool.query('UPDATE ndvi_scene_stats SET image_keys=image_keys - $4::text WHERE farm_id=$1 AND owner_id=$2 AND item_id=$3 AND id<>$5 AND image_keys ? $4::text', [farmId, ownerId, itemId, name, row.id]);
  return {bytes: rendered.bytes, contentType: 'image/png', acquiredAt, bbox, cached: false};
}
