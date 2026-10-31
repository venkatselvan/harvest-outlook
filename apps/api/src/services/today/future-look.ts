/**
 * "Future look" for the Today satellite view (Stream B, TODAY_VIEW_SPEC section 4): for a current or future stage of the
 * farm's crop cycle, a Muse Image edit of the latest usable observed Sentinel-2 scene in which only the surface inside
 * the field outline is changed to a typical look of that stage. Always labelled "Illustration of a typical <stage>" with
 * the real scene date it was derived from; it is a generated illustration, never an observation or a prediction.
 *
 * Request path (this file): owner-scoped, live mode only, generated only on an explicit request. Synthetic and replay
 * return `unavailable` with no network call and no row. The worker job `today.future-look`
 * (worker/handlers/future-look.ts) makes the paid call.
 *
 * Budget bound, enforced under a per-farm-cycle advisory lock:
 * - one queued/running/ready asset per stage per cycle: a request for a stage that already has one returns it
 *   (whatever source scene it was derived from);
 * - at most FUTURE_LOOK_CYCLE_CAP (6) assets per farm cycle that are queued, running, ready or billed (an image was
 *   returned, or the outcome is unknown); beyond that the result is `unavailable` / `cycle_limit_reached`;
 * - a second request for the same (farm, cycle, stage, scene, prompt version) returns the existing row. Only a failure
 *   that was not billed (provider refused, rate limited, budget exhausted, scene unavailable) is re-armed on request, at
 *   most FUTURE_LOOK_MAX_ATTEMPTS times; a billed failure (for example scene QA rejected the edit) is final for that tuple.
 *
 * Validation choices (documented here because they change results):
 * - the stage must exist in the cycle's StageTimeline (services/today/stage-timeline.ts) and must not have ended
 *   (`stage.to >= today`, IST); the stage name used in the prompt comes from that timeline, never from the client;
 * - the source scene must be the latest usable scene already analysed for the farm's current field polygon
 *   (ndvi_scene_stats, written by services/today/ndvi.ts). Otherwise 409 with `reason: scene_not_latest`.
 *
 * Integration notes for the orchestrator (shared files, not edited here):
 * - Register the routes plugin `todayFutureRoutes` and the handler `createFutureLookHandler` under `today.future-look`.
 * - `deleteFarm` (services/farms.ts) must collect `storage_key` from future_look_assets before the cascade, otherwise
 *   the PNGs stay in the owner's private storage until the owner is deleted. Jobs carry `farmId` in the payload, so the
 *   existing job cleanup in deleteFarm already removes them.
 * - `futureLookField` mirrors the private `fieldPolygon` in services/today/ndvi.ts (same ring rounding, fallback square
 *   and polygon hash). Exporting that function from ndvi.ts would remove the copy; the test suite checks they agree.
 * - The zod schemas below belong in packages/contracts once the shape is accepted.
 */
import sharp from 'sharp';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {StageTimeline} from '@harvest/contracts';
import type {Config} from '../../config';
import {withTransaction, type Pool} from '../../db/pool';
import {StorageError, type StorageAdapter} from '../../storage/types';
import {rasterizePolygon} from '../../visuals/qa';
import {ITEM_ID_RE, NDVI_METHOD_VERSION, bboxProblem, prepareRing, ringBbox, squareAround, type Bbox, type LonLat} from '../../providers/sentinel2';
import {getFarm} from '../farms';
import {getWorkspace} from '../workspace';
import {ApiError, notFound} from '../errors';
import {sha256Hex} from '../hash';
import {enqueue} from '../jobs';
import {stageTimeline, type StageTimelineInput} from './stage-timeline';

export const FUTURE_LOOK_JOB_TYPE = 'today.future-look';
export const FUTURE_LOOK_PROMPT_VERSION = 'future-look-v1';
/** Max assets per farm cycle that are queued, running, ready or billed. */
export const FUTURE_LOOK_CYCLE_CAP = 6;
/** Max arms of one (farm, cycle, stage, scene, prompt version) row; only non-billed failures are re-armed. */
export const FUTURE_LOOK_MAX_ATTEMPTS = 3;
export const FUTURE_LOOK_DISCLAIMER = 'Generated illustration of a typical stage, made by editing a real satellite image. Not an observation of this field and not a prediction.';

export const FutureLookStatus = z.enum(['queued', 'running', 'ready', 'failed', 'unavailable']);
export type FutureLookStatus = z.infer<typeof FutureLookStatus>;
const PENDING: ReadonlySet<string> = new Set(['queued', 'running']);

const STAGE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ deps and shapes

export interface FutureLookDeps {
  config: Pick<Config, 'RUNTIME_MODE'> & {MODEL_API_KEY?: string | undefined};
  pool: Pool;
  now?: (() => Date) | undefined;
  /** Test injection; production computes the timeline from the repo's stage sources. */
  timeline?: ((input: StageTimelineInput) => StageTimeline) | undefined;
}
export interface FutureLookImageDeps extends FutureLookDeps { storage: StorageAdapter }

export interface FutureLookRequest {
  itemId: string;
  stageId: string;
  /** Default: the most recently established cycle that is not harvested (same rule as the stage-timeline route). */
  cycleId?: string | null | undefined;
  /** Budget attribution only. */
  sessionId?: string | null | undefined;
}

export const FutureLookRequestResult = z.object({
  assetId: z.uuid().nullable(),
  status: FutureLookStatus,
  /** failure/unavailability code, else null. */
  reason: z.string().max(80).nullable(),
  cycleId: z.string().max(120).nullable(),
  stageId: z.string().max(80),
  /** True when an existing asset was returned instead of a new generation being queued. */
  deduplicated: z.boolean(),
}).strict();
export type FutureLookRequestResult = z.infer<typeof FutureLookRequestResult>;

export const FutureLookQa = z.object({
  version: z.string(),
  passed: z.boolean(),
  reasons: z.array(z.enum(['output_undecodable', 'aspect_mismatch', 'outside_region_too_small', 'scene_changed_outside_field'])),
  scores: z.object({
    outsideChannelMad: z.object({r: z.number(), g: z.number(), b: z.number()}).strict().nullable(),
    outsideMaxChannelMad: z.number().nullable(),
    insideMeanAbsDiff: z.number().nullable(),
    outsideFraction: z.number().nullable(),
    aspectError: z.number().nullable(),
    outputWidth: z.number().int().nullable(),
    outputHeight: z.number().int().nullable(),
  }).strict(),
  thresholds: z.object({outsideChannelMadMax: z.number(), boundaryMarginPx: z.number().int(), aspectTolerance: z.number(), minOutsideFraction: z.number(), grid: z.string()}).strict(),
}).strict();
export type FutureLookQa = z.infer<typeof FutureLookQa>;

export const FutureLookAsset = z.object({
  assetId: z.uuid(),
  farmId: z.uuid(),
  cycleId: z.string(),
  stageId: z.string(),
  stageName: z.string(),
  cropId: z.string(),
  cropName: z.string(),
  sourceItemId: z.string(),
  sourceAcquiredAt: z.iso.datetime().nullable(),
  /** Real acquisition date (UTC calendar date) of the scene the illustration was derived from. */
  derivedFromDate: z.iso.date().nullable(),
  status: FutureLookStatus,
  failureReason: z.string().nullable(),
  label: z.string(),
  disclaimer: z.string(),
  /** Owner-private path on this API, only when ready. */
  imagePath: z.string().nullable(),
  qa: FutureLookQa.nullable(),
  /** Requested model id; the image edit response does not echo a model. */
  model: z.string().nullable(),
  /** Null = not applicable: the image edit endpoint returns no response id, so there is nothing to delete. */
  responseDeleted: z.boolean().nullable(),
  promptVersion: z.string(),
  attempt: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type FutureLookAsset = z.infer<typeof FutureLookAsset>;

export interface FutureLookRow {
  id: string; owner_id: string; farm_id: string; cycle_id: string; source_item_id: string; source_acquired_at: Date | null;
  stage_id: string; stage_name: string; crop_id: string; crop_name: string; prompt_version: string; status: FutureLookStatus;
  attempt: number; job_id: string | null; billed: boolean; storage_key: string | null; qa: unknown; failure_reason: string | null;
  model: string | null; provider_request_id: string | null; response_deleted: boolean | null; created_at: Date; updated_at: Date;
}

// ------------------------------------------------------------------ small helpers

const istToday = (now: Date) => new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const humanize = (id: string) => id.replace(/[_-]+/g, ' ').trim();

/** Text that may enter a prompt: letters, digits and a few separators only, collapsed, at most `max` characters. */
export function promptSafe(s: string | null | undefined, max = 60): string | null {
  if (!s) return null;
  const t = s.normalize('NFKC').replace(/[^\p{L}\p{N} ()'.,/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t.length ? t : null;
}

export const futureLookImagePath = (farmId: string, assetId: string) => `/api/v1/farms/${farmId}/future-look/${assetId}/image`;
export const futureLookStorageKey = (farmId: string, assetId: string) => `future-look/${farmId}/${assetId}.png`;
const stageLabelOf = (name: string) => (/\bstage\b/i.test(name) ? name : `${name} stage`);
export const futureLookLabel = (stageName: string) => `Illustration of a typical ${stageLabelOf(stageName)}`;

// ------------------------------------------------------------------ field polygon (mirror of ndvi.ts fieldPolygon)

const FALLBACK_SQUARE_M = 100;
export interface FutureLookField { ring: LonLat[]; hash: string }

/**
 * Same polygon and hash as services/today/ndvi.ts `fieldPolygon` (not exported there): the drawn boundary rounded to
 * 4 decimals, else a 100 m square around a precise or approximate farm point. Throws 404 for a foreign or deleted farm.
 */
export async function futureLookField(pool: Pool, ownerId: string, farmId: string): Promise<FutureLookField | {reason: string}> {
  const farm = await getFarm(pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const workspace = await getWorkspace(pool, ownerId, farmId);
  let ring: LonLat[] | null;
  if (workspace.boundary) {
    ring = prepareRing(workspace.boundary.coordinates[0]!);
    if (!ring) return {reason: 'boundary_too_small'};
  } else {
    const {lat, lon, precision} = farm.location;
    if (lat === null || lon === null) return {reason: 'farm_location_missing'};
    if (precision === 'district') return {reason: 'farm_location_too_coarse'};
    ring = squareAround(lat, lon, FALLBACK_SQUARE_M);
    if (!ring) return {reason: 'farm_location_invalid'};
  }
  if (bboxProblem(ringBbox(ring))) return {reason: 'boundary_too_large'};
  return {ring, hash: sha256Hex(`${NDVI_METHOD_VERSION}|${JSON.stringify(ring)}`)};
}

/** Field ring in normalised image coordinates (x right, y down) for an EPSG:4326 render of `bbox`. */
export function ringToImage(ring: readonly LonLat[], bbox: Bbox): [number, number][] {
  const [w, s, e, n] = bbox;
  return ring.map(([lon, lat]) => [(lon - w) / (e - w), (n - lat) / (n - s)]);
}

// ------------------------------------------------------------------ prompt (fixed template)

/**
 * Visual cues for the four FAO-56 Kc stages, paraphrased from the stage definitions in FAO Irrigation and Drainage
 * Paper 56, chapter 5 "Crop growth stages" (https://www.fao.org/4/x0490e/x0490e0a.htm): initial = planting to about 10%
 * ground cover; development = 10% cover to effective full cover (for many crops the initiation of flowering); mid-season
 * = effective full cover to the start of maturity; late season = start of maturity (ageing, yellowing or senescence of
 * leaves) to harvest. They describe ground cover, not crop health, and are applied only to these four stage ids.
 */
export const FAO_STAGE_CUES: Readonly<Record<string, string>> = {
  initial: 'mostly bare soil with small young plants, less than about a tenth of the ground covered by green leaves',
  development: 'green leaves spreading from about a tenth of the ground towards full cover, with soil still visible between the plants',
  mid_season: 'a full, dense green crop canopy covering the ground',
  late_season: 'a mature crop whose leaves are ageing, yellowing or drying towards harvest',
};
const GENERIC_CUE = 'the texture and colour this stage typically shows when seen from above';

/**
 * Prompt template `future-look-v1`. Stage and crop names come from the server-side timeline and cycle and pass through
 * `promptSafe`; nothing the client sends reaches the prompt.
 */
export function buildFutureLookPrompt(p: {stageId: string; stageName: string; cropName: string}): string {
  const stage = stageLabelOf(p.stageName).toLowerCase();
  const crop = p.cropName.toLowerCase();
  const cue = FAO_STAGE_CUES[p.stageId] ?? GENERIC_CUE;
  return [
    'Edit this top-down satellite image (true colour, north up).',
    'Keep every field boundary, road, path, tree line, building, water body and neighbouring plot exactly as it is, in the same position, shape, colour and lighting.',
    `Change only the surface inside the field outlined in red so that it shows a typical ${stage} of ${crop}: ${cue}.`,
    'Keep the red outline where it is.',
    'No text, no labels, no arrows, no borders, no watermark.',
    'Photographic satellite style at the same scale, resolution and viewing angle as the original.',
  ].join(' ');
}

// ------------------------------------------------------------------ deterministic QA

export const FUTURE_QA_VERSION = 'future-look-qa-1';
/** Both images are resampled to this square-ish grid (width; height follows the input aspect) before comparison. */
export const FUTURE_QA_GRID = 128;
/**
 * Fail when the mean absolute difference outside the field (any of R, G, B, scaled 0..1) exceeds 0.08, i.e. about 20 of
 * 255 levels on average. Engineering heuristic chosen before any live output was seen (same order as the 0.08 grayscale
 * limit in visuals/qa.ts); NOT validated. It is meant to catch a re-drawn or re-coloured neighbourhood, not fine detail.
 */
export const FUTURE_QA_OUTSIDE_CHANNEL_MAX = 0.08;
/** Grid pixels around the field edge excluded from the outside check (the outline and edge bleed). 4 px is about 19 m on the 600 m minimum window. */
export const FUTURE_QA_MARGIN_PX = 4;
export const FUTURE_QA_ASPECT_TOLERANCE = 0.02;
/** Fail closed when less than this fraction of the frame is available for the outside comparison. */
export const FUTURE_QA_MIN_OUTSIDE_FRACTION = 0.2;

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w) out[yy * w + xx] = 1;
      }
    }
  }
  return out;
}

async function rgbGrid(buf: Buffer, w: number, h: number): Promise<Uint8Array> {
  const {data} = await sharp(buf).flatten({background: '#000000'}).toColourspace('srgb').removeAlpha().resize({width: w, height: h, fit: 'fill'}).raw().toBuffer({resolveWithObject: true});
  return new Uint8Array(data);
}

/**
 * Compares the generated output with the image that was sent, outside the field (minus a margin), per channel.
 * `field` is the field ring in normalised image coordinates of the input.
 */
export async function evaluateFutureLook(input: {input: Buffer; output: Buffer; field: [number, number][]}): Promise<FutureLookQa> {
  const thresholds = {outsideChannelMadMax: FUTURE_QA_OUTSIDE_CHANNEL_MAX, boundaryMarginPx: FUTURE_QA_MARGIN_PX, aspectTolerance: FUTURE_QA_ASPECT_TOLERANCE, minOutsideFraction: FUTURE_QA_MIN_OUTSIDE_FRACTION, grid: `${FUTURE_QA_GRID}px wide, RGB`};
  const empty = {outsideChannelMad: null, outsideMaxChannelMad: null, insideMeanAbsDiff: null, outsideFraction: null, aspectError: null, outputWidth: null, outputHeight: null};
  let ow: number, oh: number, iw: number, ih: number;
  try {
    const om = await sharp(input.output, {failOn: 'error'}).metadata();
    await sharp(input.output, {failOn: 'error'}).stats(); // full decode
    const im = await sharp(input.input).metadata();
    if (!om.width || !om.height || !im.width || !im.height) throw new Error('no size');
    [ow, oh, iw, ih] = [om.width, om.height, im.width, im.height];
  } catch {
    return {version: FUTURE_QA_VERSION, passed: false, reasons: ['output_undecodable'], scores: empty, thresholds};
  }
  const aspect = iw / ih;
  const aspectError = Math.abs(ow / oh - aspect) / aspect;
  const scores = {...empty, aspectError, outputWidth: ow, outputHeight: oh};
  if (aspectError > FUTURE_QA_ASPECT_TOLERANCE) return {version: FUTURE_QA_VERSION, passed: false, reasons: ['aspect_mismatch'], scores, thresholds};

  const w = FUTURE_QA_GRID, h = Math.max(1, Math.round(w / aspect));
  const [a, b] = await Promise.all([rgbGrid(input.input, w, h), rgbGrid(input.output, w, h)]);
  const inMask = rasterizePolygon(input.field, w, h);
  const guard = dilate(inMask, w, h, FUTURE_QA_MARGIN_PX);
  let outR = 0, outG = 0, outB = 0, outN = 0, inSum = 0, inN = 0;
  for (let i = 0; i < w * h; i++) {
    const dr = Math.abs(a[3 * i]! - b[3 * i]!), dg = Math.abs(a[3 * i + 1]! - b[3 * i + 1]!), db = Math.abs(a[3 * i + 2]! - b[3 * i + 2]!);
    if (inMask[i]) { inSum += (dr + dg + db) / 3; inN++; }
    else if (!guard[i]) { outR += dr; outG += dg; outB += db; outN++; }
  }
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  const outsideFraction = round(outN / (w * h));
  const insideMeanAbsDiff = inN ? round(inSum / inN / 255) : null;
  if (outsideFraction < FUTURE_QA_MIN_OUTSIDE_FRACTION || outN === 0) {
    return {version: FUTURE_QA_VERSION, passed: false, reasons: ['outside_region_too_small'], scores: {...scores, insideMeanAbsDiff, outsideFraction}, thresholds};
  }
  const mad = {r: round(outR / outN / 255), g: round(outG / outN / 255), b: round(outB / outN / 255)};
  const max = Math.max(mad.r, mad.g, mad.b);
  const passed = max <= FUTURE_QA_OUTSIDE_CHANNEL_MAX;
  return {
    version: FUTURE_QA_VERSION, passed, reasons: passed ? [] : ['scene_changed_outside_field'],
    scores: {...scores, outsideChannelMad: mad, outsideMaxChannelMad: max, insideMeanAbsDiff, outsideFraction}, thresholds,
  };
}

// ------------------------------------------------------------------ row mapping

export function toFutureLookAsset(r: FutureLookRow): FutureLookAsset {
  const qa = r.qa === null ? null : FutureLookQa.safeParse(r.qa);
  return {
    assetId: r.id, farmId: r.farm_id, cycleId: r.cycle_id, stageId: r.stage_id, stageName: r.stage_name, cropId: r.crop_id, cropName: r.crop_name,
    sourceItemId: r.source_item_id, sourceAcquiredAt: r.source_acquired_at?.toISOString() ?? null, derivedFromDate: r.source_acquired_at?.toISOString().slice(0, 10) ?? null,
    status: r.status, failureReason: r.status === 'failed' || r.status === 'unavailable' ? r.failure_reason : null,
    label: futureLookLabel(r.stage_name), disclaimer: FUTURE_LOOK_DISCLAIMER,
    imagePath: r.status === 'ready' ? futureLookImagePath(r.farm_id, r.id) : null,
    qa: qa && qa.success ? qa.data : null, model: r.model, responseDeleted: r.response_deleted, promptVersion: r.prompt_version, attempt: r.attempt,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

const resultOf = (r: FutureLookRow, deduplicated: boolean): FutureLookRequestResult => ({
  assetId: r.id, status: r.status, reason: r.status === 'failed' || r.status === 'unavailable' ? r.failure_reason : null, cycleId: r.cycle_id, stageId: r.stage_id, deduplicated,
});

// ------------------------------------------------------------------ request

/**
 * Ensures an asset row and queues `today.future-look` for it, or returns the existing asset (see the header for the
 * dedup, per-stage and per-cycle rules). Throws 404 (farm, cycle), 422 `unknown_stage`, 409 `conflict` with
 * `details.reason` in stage_in_past | no_usable_scene | scene_not_latest | field reasons, 400 on malformed ids.
 */
export async function requestFutureLook(deps: FutureLookDeps, ownerId: string, farmId: string, req: FutureLookRequest): Promise<FutureLookRequestResult> {
  if (!ITEM_ID_RE.test(req.itemId)) throw new ApiError(400, 'validation_error', 'Invalid satellite scene id');
  if (!STAGE_ID_RE.test(req.stageId)) throw new ApiError(400, 'validation_error', 'Invalid stage id');
  if (req.cycleId !== undefined && req.cycleId !== null && (req.cycleId.length < 1 || req.cycleId.length > 120)) throw new ApiError(400, 'validation_error', 'Invalid cycle id');
  const {pool} = deps;
  const farm = await getFarm(pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const none = (reason: string): FutureLookRequestResult => ({assetId: null, status: 'unavailable', reason, cycleId: req.cycleId ?? null, stageId: req.stageId, deduplicated: false});
  // Mode separation: nothing below runs outside live mode (no network, no rows).
  if (deps.config.RUNTIME_MODE !== 'live') return none('live_mode_required');
  if (!deps.config.MODEL_API_KEY) return none('provider_unavailable');

  const workspace = await getWorkspace(pool, ownerId, farmId);
  const anchorOf = (c: (typeof workspace.cycles)[number]) => c.establishmentDate ?? c.sowingDate;
  const cycle = req.cycleId
    ? workspace.cycles.find((c) => c.id === req.cycleId)
    : [...workspace.cycles].filter((c) => c.stage !== 'harvested').sort((a, b) => anchorOf(b).localeCompare(anchorOf(a)))[0];
  if (!cycle) {
    if (req.cycleId) throw notFound('Crop cycle');
    throw new ApiError(409, 'conflict', 'This farm has no current crop cycle', {reason: 'no_current_cycle'});
  }
  const timeline = (deps.timeline ?? stageTimeline)({
    cropId: cycle.cropId, productId: cycle.productId ?? null, establishmentMethod: cycle.establishmentMethod ?? null, anchorDate: anchorOf(cycle),
    stateId: farm.location.stateCode, districtId: farm.location.districtId,
  });
  const stage = timeline.stages.find((s) => s.id === req.stageId);
  if (!stage) throw new ApiError(422, 'unknown_stage', 'This stage is not part of the crop cycle timeline', {stageId: req.stageId});
  const today = istToday((deps.now ?? (() => new Date()))());
  if (stage.to < today) throw new ApiError(409, 'conflict', 'Illustrations are only made for current or future stages', {reason: 'stage_in_past'});

  const field = await futureLookField(pool, ownerId, farmId);
  if ('reason' in field) throw new ApiError(409, 'conflict', 'The field has no usable outline for satellite images', {reason: field.reason});
  const latest = (await pool.query<{item_id: string; acquired_at: Date}>(
    'SELECT item_id, acquired_at FROM ndvi_scene_stats WHERE owner_id=$1 AND farm_id=$2 AND polygon_hash=$3 AND usable ORDER BY acquired_at DESC, item_id DESC LIMIT 1',
    [ownerId, farmId, field.hash])).rows[0];
  if (!latest) throw new ApiError(409, 'conflict', 'No usable satellite scene has been analysed for this field yet', {reason: 'no_usable_scene'});
  if (latest.item_id !== req.itemId) throw new ApiError(409, 'conflict', 'Illustrations are derived from the latest usable satellite scene only', {reason: 'scene_not_latest', latestItemId: latest.item_id});

  const cropName = promptSafe(cycle.cropName) ?? promptSafe(humanize(cycle.cropId)) ?? 'crop';
  const stageName = promptSafe(stage.name, 80) ?? promptSafe(humanize(stage.id), 80) ?? 'growth';
  const sessionId = req.sessionId && UUID_RE.test(req.sessionId) ? req.sessionId : null;

  return withTransaction(pool, async (c: PoolClient) => {
    // Serialises the per-stage and per-cycle checks for this farm cycle.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`future-look:${farmId}:${cycle.id}`]);
    const scope = [ownerId, farmId, cycle.id];
    const stageActive = (await c.query<FutureLookRow>(
      `SELECT * FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND stage_id=$4 AND status IN ('queued','running','ready')
       ORDER BY (status='ready') DESC, created_at DESC LIMIT 1`, [...scope, stage.id])).rows[0];
    if (stageActive) return resultOf(stageActive, true);
    const same = (await c.query<FutureLookRow>(
      'SELECT * FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND stage_id=$4 AND source_item_id=$5 AND prompt_version=$6',
      [...scope, stage.id, req.itemId, FUTURE_LOOK_PROMPT_VERSION])).rows[0];
    if (same && (same.billed || same.attempt >= FUTURE_LOOK_MAX_ATTEMPTS)) return resultOf(same, true);
    const counted = (await c.query<{n: number}>(
      `SELECT count(*)::int AS n FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND (status IN ('queued','running','ready') OR billed)`, scope)).rows[0]!.n;
    if (counted >= FUTURE_LOOK_CYCLE_CAP) return {...none('cycle_limit_reached'), cycleId: cycle.id};

    const row = same
      ? (await c.query<FutureLookRow>(
          `UPDATE future_look_assets SET status='queued', attempt=attempt+1, failure_reason=NULL, qa=NULL, storage_key=NULL, model=NULL, provider_request_id=NULL,
             response_deleted=NULL, stage_name=$2, crop_name=$3, source_acquired_at=$4 WHERE id=$1 RETURNING *`,
          [same.id, stageName, cropName, latest.acquired_at])).rows[0]!
      : (await c.query<FutureLookRow>(
          `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, source_acquired_at, stage_id, stage_name, crop_id, crop_name, prompt_version, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued') RETURNING *`,
          [ownerId, farmId, cycle.id, req.itemId, latest.acquired_at, stage.id, stageName, cycle.cropId, cropName, FUTURE_LOOK_PROMPT_VERSION])).rows[0]!;
    // One job per arm of the row: fl:{assetId}:{attempt}. farmId in the payload lets deleteFarm's job cleanup find it.
    const q = await enqueue(c, FUTURE_LOOK_JOB_TYPE, {assetId: row.id, farmId, sessionId}, ownerId, `fl:${row.id}:${row.attempt}`);
    await c.query('UPDATE future_look_assets SET job_id=$2 WHERE id=$1', [row.id, q.job.id]);
    return resultOf(row, false);
  });
}

// ------------------------------------------------------------------ reads

/** A pending row whose job is gone, failed or cancelled is closed as failed; billed if a paid call may have been sent. */
async function reconcile(pool: Pool, r: FutureLookRow): Promise<FutureLookRow> {
  if (!PENDING.has(r.status)) return r;
  const job = r.job_id ? (await pool.query<{state: string}>('SELECT state FROM jobs WHERE id=$1', [r.job_id])).rows[0] : undefined;
  if (job && (job.state === 'queued' || job.state === 'running')) return r;
  const dispatched = r.job_id ? ((await pool.query('SELECT 1 FROM job_dispatches WHERE job_id=$1 LIMIT 1', [r.job_id])).rowCount ?? 0) > 0 : true;
  const reason = !job ? 'job_missing' : job.state === 'succeeded' ? 'job_finished_without_result' : 'job_failed';
  const u = await pool.query<FutureLookRow>(
    `UPDATE future_look_assets SET status='failed', failure_reason=$3, billed = billed OR $4 WHERE id=$1 AND status IN ('queued','running') AND job_id IS NOT DISTINCT FROM $2 RETURNING *`,
    [r.id, r.job_id, reason, dispatched]);
  return u.rows[0] ?? (await pool.query<FutureLookRow>('SELECT * FROM future_look_assets WHERE id=$1', [r.id])).rows[0] ?? r;
}

async function ownedRow(deps: FutureLookDeps, ownerId: string, farmId: string, assetId: string): Promise<FutureLookRow> {
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  if (deps.config.RUNTIME_MODE !== 'live') throw new ApiError(409, 'mode_mismatch', 'Satellite illustrations are only available in live mode');
  if (!UUID_RE.test(assetId)) throw notFound('Illustration');
  const row = (await deps.pool.query<FutureLookRow>('SELECT * FROM future_look_assets WHERE id=$1 AND owner_id=$2 AND farm_id=$3', [assetId, ownerId, farmId])).rows[0];
  if (!row) throw notFound('Illustration');
  return row;
}

export async function futureLookStatus(deps: FutureLookDeps, ownerId: string, farmId: string, assetId: string): Promise<FutureLookAsset> {
  return toFutureLookAsset(await reconcile(deps.pool, await ownedRow(deps, ownerId, farmId, assetId)));
}

export interface FutureLookImage { bytes: Buffer; contentType: 'image/png'; label: string; sourceAcquiredAt: string | null }

/** PNG bytes of a ready illustration; 404 for any other state, a foreign asset or a missing object. */
export async function futureLookImage(deps: FutureLookImageDeps, ownerId: string, farmId: string, assetId: string): Promise<FutureLookImage> {
  const row = await ownedRow(deps, ownerId, farmId, assetId);
  if (row.status !== 'ready' || !row.storage_key) throw notFound('Illustration');
  try {
    const bytes = Buffer.from(await deps.storage.get({ownerId, key: row.storage_key}));
    return {bytes, contentType: 'image/png', label: futureLookLabel(row.stage_name), sourceAcquiredAt: row.source_acquired_at?.toISOString() ?? null};
  } catch (e) {
    if (e instanceof StorageError) throw notFound('Illustration');
    throw e;
  }
}

/**
 * Ready illustrations of one crop cycle, oldest first, for the Today aggregator's illustration SceneRef entries.
 * Owner-scoped (404 for a foreign or deleted farm); empty outside live mode.
 */
export async function listReadyFutureLooks(deps: FutureLookDeps, ownerId: string, farmId: string, cycleId: string): Promise<Array<{assetId: string; stageId: string; sourceItemId: string; cropId: string; createdAt: string; imagePath: string}>> {
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  if (deps.config.RUNTIME_MODE !== 'live') return [];
  const rows = (await deps.pool.query<FutureLookRow>(
    "SELECT * FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND status='ready' AND storage_key IS NOT NULL ORDER BY created_at, id",
    [ownerId, farmId, cycleId])).rows;
  return rows.map((r) => ({assetId: r.id, stageId: r.stage_id, sourceItemId: r.source_item_id, cropId: r.crop_id, createdAt: r.created_at.toISOString(), imagePath: futureLookImagePath(farmId, r.id)}));
}
