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
 * - the source scene must be the latest usable scene already analysed for the cycle's polygon (its field's ring when the
 *   cycle names a field, else the farm polygon)
 *   (ndvi_scene_stats, written by services/today/ndvi.ts). Otherwise 409 with `reason: scene_not_latest`.
 *
 * Integration (done 2026-11-01): `todayFutureRoutes` is registered in routes/index.ts, `createFutureLookHandler` under
 * `today.future-look` in worker/handlers/index.ts, and `deleteFarm` (services/farms.ts) removes the `storage_key` objects of
 * future_look_assets before the cascade. Jobs carry `farmId` in the payload, so deleteFarm's job cleanup removes them too.
 * The zod schemas (FutureLookStatus, FutureLookRequestResult, FutureLookQa, FutureLookAsset) live in
 * packages/contracts/src/future-look.ts.
 * - `futureLookField` mirrors the private `fieldPolygon` in services/today/ndvi.ts (same ring rounding, fallback square
 *   and polygon hash). Exporting that function from ndvi.ts would remove the copy; the test suite checks they agree.
 *
 * Predicted looks (FIELDS_MULTICROP_SOIL_SPEC.md section 11, 2026-11-03; prompt version future-look-v2):
 * - two kinds. `stage` as above; `gap` = the predicted look of the field on a target date after the latest usable real
 *   scene. Both carry `target_date` and the code-written `guidance` (services/today/prediction-guidance.ts) that went into
 *   the prompt. Stage looks: target = the stage start, or today when the stage is current. Gap looks: the client's
 *   `targetDate` must be after the source scene date (409 target_not_after_scene) and at most GAP_MAX_DAYS_AHEAD (120) days
 *   after today (400 target_too_far); the stored target is the Monday of its week, or the day after the source scene when
 *   that is later (so it stays in the requested week and after the real image);
 * - one queued/running/ready gap look per cycle per calendar week (`target_week`), whatever scene it came from: a later
 *   real scene does not replace an existing look for that week (the web shows the real scene for dates up to it anyway);
 * - the per-cycle cap is FUTURE_LOOK_CYCLE_CAP (10, raised from 6) across both kinds; FUTURE_LOOK_MAX_ATTEMPTS unchanged;
 * - automatic requests (`auto: true`, made only by the live Today view, services/today/view.ts) also take a per-farm
 *   advisory lock and are refused when any gap row (any status) exists for that cycle and week (`auto_week_exists`: a failed
 *   one is re-armed only by an explicit request) or when the farm already has FUTURE_LOOK_AUTO_DAILY_CAP (2) gap rows created
 *   in the last 24 hours by the database clock (`auto_daily_limit`). Explicit gap requests count towards that figure, so
 *   the automatic path is the more constrained one;
 * - guidance inputs: the view passes its own (index-stage phase, latest NDVI, conditions point); an explicit request reads
 *   them from stored data only (`storedPredictionContext`: stored usable readings of the polygon, stored weather with no
 *   ingest, no provider call). The worker uses the row's stored guidance, so a queued job always renders what was decided.
 */
import sharp from 'sharp';
import type {PoolClient} from 'pg';
import {FutureLookQa, NdviStats, type FieldConditionPoint, type FutureLookAsset, type FutureLookKind, type FutureLookRequestResult, type FutureLookStatus, type IndexStagePhase, type NdviReading, type StageTimeline} from '@harvest/contracts';
import type {Config} from '../../config';
import {withTransaction, type Pool} from '../../db/pool';
import {StorageError, type StorageAdapter} from '../../storage/types';
import {rasterizePolygon} from '../../visuals/qa';
import {ITEM_ID_RE, NDVI_METHOD_VERSION, bboxProblem, prepareRing, ringBbox, squareAround, type Bbox, type LonLat} from '../../providers/sentinel2';
import {getFarm} from '../farms';
import {fieldOf, getWorkspace} from '../workspace';
import {ApiError, notFound} from '../errors';
import {sha256Hex} from '../hash';
import {enqueue} from '../jobs';
import {stageAt, stageTimeline, type StageTimelineInput} from './stage-timeline';
import {buildPredictionGuidance, phaseForTarget, type PredictionGuidance} from './prediction-guidance';
import {readIndexStage} from './index-stage';
import {fieldConditions, soilTextureOf} from './conditions';
import {weatherTrack} from './weather-track';
import {irrigationCategoryOf} from './footprint';

export const FUTURE_LOOK_JOB_TYPE = 'today.future-look';
/**
 * v3 (2026-11-03, after the first live gap look): the outline sentence forbids redrawing, moving or resizing the outline (the
 * live model redrew a 38 m by 115 m field as a square). v2 rows keep their sentence when re-rendered (see buildFutureLookPrompt).
 */
export const FUTURE_LOOK_PROMPT_VERSION = 'future-look-v3';
export const FUTURE_LOOK_PROMPT_VERSION_V2 = 'future-look-v2';
/** Rows made before 2026-11-03 (no guidance); the worker renders them with the v1 template. */
export const FUTURE_LOOK_PROMPT_VERSION_V1 = 'future-look-v1';
/** Max assets per farm cycle (both kinds) that are queued, running, ready or billed. Raised from 6 on 2026-11-03 (spec 11.2). */
export const FUTURE_LOOK_CYCLE_CAP = 10;
/** A gap look's requested target date may be at most this many days after today (spec 11.3). */
export const GAP_MAX_DAYS_AHEAD = 120;
/** Automatic gap requests: at most this many gap rows created per farm in any 24 hours (spec 11.2). */
export const FUTURE_LOOK_AUTO_DAILY_CAP = 2;
/** Max arms of one (farm, cycle, stage, scene, prompt version) row; only non-billed failures are re-armed. */
export const FUTURE_LOOK_MAX_ATTEMPTS = 3;
export const FUTURE_LOOK_DISCLAIMER = 'Generated illustration of a typical stage, made by editing a real satellite image. Not an observation of this field and not a prediction.';
export const PREDICTED_LOOK_DISCLAIMER = 'Predicted with AI: an image edit of the latest real satellite image of this field, guided by the crop calendar, the field\'s greenness curve and the expected weather. Not an observation.';

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

/**
 * Guidance inputs a caller already holds (the live Today view). Without it, `storedPredictionContext` reads them from stored
 * data. `sourcePhase` is the index-stage phase read at the latest real scene (carried to the target by phaseForTarget).
 */
export interface PredictionContext {
  sourcePhase: IndexStagePhase | null;
  latestNdvi: {value: number; date: string} | null;
  conditionsAt: (date: string) => FieldConditionPoint | null;
}

export interface FutureLookRequest {
  itemId: string;
  /** Required for `stage`; ignored for `gap` (the stage at the target date comes from the timeline). */
  stageId?: string | null | undefined;
  /** Default 'stage'. */
  kind?: FutureLookKind | undefined;
  /** Required for `gap` (see the header for the bounds). */
  targetDate?: string | null | undefined;
  /** Set only by the live Today view: adds the per-farm daily cap and the any-status weekly check. */
  auto?: boolean | undefined;
  context?: PredictionContext | undefined;
  /** Default: the most recently established cycle that is not harvested (same rule as the stage-timeline route). */
  cycleId?: string | null | undefined;
  /** Budget attribution only. */
  sessionId?: string | null | undefined;
}

export interface FutureLookRow {
  id: string; owner_id: string; farm_id: string; cycle_id: string; source_item_id: string; source_acquired_at: Date | null;
  stage_id: string; stage_name: string; crop_id: string; crop_name: string; prompt_version: string; status: FutureLookStatus;
  attempt: number; job_id: string | null; billed: boolean; storage_key: string | null; qa: unknown; failure_reason: string | null;
  model: string | null; provider_request_id: string | null; response_deleted: boolean | null; created_at: Date; updated_at: Date;
  /** Added by 0037; node-postgres returns `date` columns as a local-midnight Date. */
  kind: FutureLookKind; target_date: Date | string | null; guidance: string | null; target_week: Date | string | null;
}

// ------------------------------------------------------------------ small helpers

const istToday = (now: Date) => new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
/** Monday of the ISO week of a date (Postgres date_trunc('week') uses the same week). */
export const weekStart = (d: string) => addDays(d, 1 - (new Date(`${d}T00:00:00Z`).getUTCDay() || 7));
const validDate = (d: string) => ISO_DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
/** A pg `date` value as YYYY-MM-DD (node-postgres parses it as local midnight). */
export function pgDate(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
}
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
/** Gap looks: "Predicted with AI" wording of spec 11.2 (the date is the target, the source the real scene). */
export const predictedLookLabel = (targetDate: string | null, sourceDate: string | null) =>
  `Predicted look for ${targetDate ?? 'a later date'}, made from the real image of ${sourceDate ?? 'an earlier date'}. Not an observation.`;
/** Guidance text that may enter a prompt: the code-written sentence, re-filtered (letters, digits, basic punctuation), at most 400 characters. */
export function guidanceSafe(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.normalize('NFKC').replace(/[^\p{L}\p{N} ()'.,;:/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 400).trim();
  return t.length ? t : null;
}

// ------------------------------------------------------------------ field polygon (mirror of ndvi.ts fieldPolygon)

const FALLBACK_SQUARE_M = 100;
export interface FutureLookField { ring: LonLat[]; hash: string }

/**
 * Same polygon and hash as services/today/ndvi.ts `fieldPolygon` (not exported there): the drawn boundary rounded to
 * 4 decimals, else a 100 m square around a precise or approximate farm point. Throws 404 for a foreign or deleted farm.
 * Fields (2026-11-03): with `fieldId` (the cycle's own field) the field's ring is used, exactly as the Today field view reads
 * it, so a field cycle's illustration is derived from, masked to and shown over that field's scene; fields never share one
 * because assets are keyed by cycle and each cycle names one field.
 */
export async function futureLookField(pool: Pool, ownerId: string, farmId: string, fieldId?: string): Promise<FutureLookField | {reason: string}> {
  const farm = await getFarm(pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const workspace = await getWorkspace(pool, ownerId, farmId);
  let ring: LonLat[] | null;
  if (fieldId !== undefined) {
    ring = prepareRing(fieldOf(workspace, fieldId).boundary.coordinates[0]!);
    if (!ring) return {reason: 'boundary_too_small'};
  } else if (workspace.boundary) {
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
 * Prompt templates. Stage and crop names come from the server-side timeline and cycle and pass through `promptSafe`; the
 * guidance is the code-written sentence stored on the row (prediction-guidance.ts) and passes through `guidanceSafe`.
 * Nothing the client sends reaches the prompt.
 *
 * - `future-look-v1` (no guidance): unchanged from 2026-11-01, still used for rows made before v2;
 * - `future-look-v3` (with guidance, 2026-11-03): as v2 with a stricter outline sentence (shape and size kept);
 * - `future-look-v2` (with guidance): the same edit constraints (keep everything outside the red outline, keep the outline,
 *   no text), plus the guidance. A stage look keeps the FAO stage cue and adds the guidance; a gap look describes the field
 *   on the target date by the guidance only. The guidance never contains an NDVI number.
 */
export function buildFutureLookPrompt(p: {stageId: string; stageName: string; cropName: string; kind?: FutureLookKind | undefined; guidance?: string | null | undefined; promptVersion?: string | undefined}): string {
  const stage = stageLabelOf(p.stageName).toLowerCase();
  const crop = p.cropName.toLowerCase();
  const cue = FAO_STAGE_CUES[p.stageId] ?? GENERIC_CUE;
  const guidance = guidanceSafe(p.guidance);
  const change = !guidance
    ? [`Change only the surface inside the field outlined in red so that it shows a typical ${stage} of ${crop}: ${cue}.`]
    : p.kind === 'gap'
      ? [`Change only the surface inside the field outlined in red so that it shows how this ${crop} field is expected to look on a later date.`, `Expected change: ${guidance}`]
      : [`Change only the surface inside the field outlined in red so that it shows a typical ${stage} of ${crop}: ${cue}.`, `Expected change: ${guidance}`];
  return [
    'Edit this top-down satellite image (true colour, north up).',
    'Keep every field boundary, road, path, tree line, building, water body and neighbouring plot exactly as it is, in the same position, shape, colour and lighting.',
    ...change,
    // v3: the outline sentence names shape and size (a narrow field was redrawn as a square by the live model under v2).
    guidance && p.promptVersion !== FUTURE_LOOK_PROMPT_VERSION_V2
      ? 'Keep the red outline exactly where it is, with the same shape and size; do not redraw, move, widen or resize it.'
      : 'Keep the red outline where it is.',
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

/**
 * The stored look (2026-11-03): the clean real scene everywhere except strictly inside the field ring, where the model's
 * output is used. Basis: the first live gap look showed the model can redraw the outline with another shape (a 38 m by
 * 115 m field became a square about 140 m across) while the frame-wide QA still passes, so the stored image is bounded to
 * the field polygon by construction rather than trusted to the model. Pixels within `edgePx` of the ring edge also keep the
 * real scene, so the red outline sent to the model (stroke centred on the edge) never ends up in the stored image; the web
 * draws its own outline. `field` is the ring in normalised image coordinates of `scene`; both images are resized to w x h.
 */
export async function compositeInsideField(a: {scene: Buffer; output: Buffer; field: [number, number][]; width: number; height: number; edgePx: number}): Promise<Buffer> {
  const raw = (b: Buffer) => sharp(b).flatten({background: '#000000'}).toColourspace('srgb').removeAlpha().resize({width: a.width, height: a.height, fit: 'fill'}).raw().toBuffer();
  const [base, out] = await Promise.all([raw(a.scene), raw(a.output)]);
  const inside = rasterizePolygon(a.field, a.width, a.height);
  const outside = new Uint8Array(inside.length);
  for (let i = 0; i < inside.length; i++) outside[i] = inside[i] ? 0 : 1;
  const nearEdge = a.edgePx > 0 ? dilate(outside, a.width, a.height, a.edgePx) : outside;
  const px = Buffer.from(base);
  for (let i = 0; i < inside.length; i++) {
    if (inside[i] && !nearEdge[i]) { px[3 * i] = out[3 * i]!; px[3 * i + 1] = out[3 * i + 1]!; px[3 * i + 2] = out[3 * i + 2]!; }
  }
  return sharp(px, {raw: {width: a.width, height: a.height, channels: 3}}).png().toBuffer();
}

// ------------------------------------------------------------------ row mapping

export function toFutureLookAsset(r: FutureLookRow): FutureLookAsset {
  const qa = r.qa === null ? null : FutureLookQa.safeParse(r.qa);
  const kind: FutureLookKind = r.kind === 'gap' ? 'gap' : 'stage';
  const derivedFromDate = r.source_acquired_at?.toISOString().slice(0, 10) ?? null;
  const targetDate = pgDate(r.target_date);
  return {
    assetId: r.id, farmId: r.farm_id, cycleId: r.cycle_id, stageId: r.stage_id, stageName: r.stage_name, cropId: r.crop_id, cropName: r.crop_name,
    sourceItemId: r.source_item_id, sourceAcquiredAt: r.source_acquired_at?.toISOString() ?? null, derivedFromDate,
    status: r.status, failureReason: r.status === 'failed' || r.status === 'unavailable' ? r.failure_reason : null,
    label: kind === 'gap' ? predictedLookLabel(targetDate, derivedFromDate) : futureLookLabel(r.stage_name),
    disclaimer: kind === 'gap' ? PREDICTED_LOOK_DISCLAIMER : FUTURE_LOOK_DISCLAIMER,
    imagePath: r.status === 'ready' ? futureLookImagePath(r.farm_id, r.id) : null,
    qa: qa && qa.success ? qa.data : null, model: r.model, responseDeleted: r.response_deleted, promptVersion: r.prompt_version, attempt: r.attempt,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    kind, targetDate, guidance: r.guidance ? r.guidance.slice(0, 400) : null,
  };
}

const resultOf = (r: FutureLookRow, deduplicated: boolean): FutureLookRequestResult => ({
  assetId: r.id, status: r.status, reason: r.status === 'failed' || r.status === 'unavailable' ? r.failure_reason : null, cycleId: r.cycle_id, stageId: r.stage_id, deduplicated,
  kind: r.kind === 'gap' ? 'gap' : 'stage', targetDate: pgDate(r.target_date),
});

// ------------------------------------------------------------------ guidance context from stored data

/**
 * Guidance inputs for an explicit request, from stored data only (no provider call, no ingest): the usable stored readings of
 * the cycle's polygon (at most 400 days back) read by the index-stage reader, the latest of them, and the conditions point at
 * the target from stored weather (target minus 4 days to the target, enough for conditions.ts's 3-day and hold rules).
 * Any failure leaves that input empty; the guidance then rests on the calendar.
 */
export async function storedPredictionContext(pool: Pool, a: {
  ownerId: string; farmId: string; polygonHash: string; ring: readonly LonLat[]; cycle: {cropId: string; sowingDate: string; establishmentDate?: string | null | undefined; establishmentMethod?: string | null | undefined};
  timeline: StageTimeline; today: string; targetDate: string; facts: unknown; now: () => Date;
}): Promise<PredictionContext> {
  const rows = (await pool.query<{item_id: string; acquired_at: Date; baseline: string | null; scene_cloud_pct: number | null; field_stats: unknown}>(
    `SELECT item_id, acquired_at, baseline, scene_cloud_pct, field_stats FROM ndvi_scene_stats
      WHERE owner_id=$1 AND farm_id=$2 AND polygon_hash=$3 AND usable AND acquired_at >= $4::date ORDER BY acquired_at`,
    [a.ownerId, a.farmId, a.polygonHash, addDays(a.today, -400)])).rows;
  const readings: NdviReading[] = rows.flatMap((r) => {
    const field = NdviStats.safeParse(r.field_stats);
    if (!field.success || !field.data.usable) return [];
    const acquiredAt = r.acquired_at.toISOString();
    return [{itemId: r.item_id, date: acquiredAt.slice(0, 10), acquiredAt, tileId: null, baseline: r.baseline, offsetApplied: false, sceneCloudPct: r.scene_cloud_pct, usable: true, field: field.data, neighbourhood: null}];
  });
  const latest = [...readings].reverse().find((r) => r.field.mean !== null) ?? null;
  const reading = readIndexStage({readings, today: a.today, timeline: a.timeline, cycle: a.cycle, smallField: false, polygonBasis: 'boundary', series: null});
  let point: FieldConditionPoint | null = null;
  try {
    const n = a.ring.length > 1 ? a.ring.length - 1 : a.ring.length;
    const lon = a.ring.slice(0, n).reduce((x, p) => x + p[0], 0) / n, lat = a.ring.slice(0, n).reduce((x, p) => x + p[1], 0) / n;
    const from = addDays(a.targetDate, -4);
    const track = await weatherTrack({pool, autoIngest: false, now: a.now}, {point: {lat, lon}, from, to: a.targetDate, asOf: a.now().toISOString(), mode: 'live', farmId: a.farmId});
    const weather = track.days.map((d) => ({date: d.date, kind: d.kind, rainMm: d.rainMm, tMinC: d.tMinC, tMaxC: d.tMaxC, basis: {source: (d.basis.source ?? 'none').slice(0, 120), issuedAt: null, years: null}, ...(d.agro ? {agro: d.agro} : {})}));
    const anchor = a.cycle.establishmentDate ?? a.cycle.sowingDate;
    const cond = fieldConditions({
      cropId: a.cycle.cropId, establishmentMethod: a.cycle.establishmentMethod ?? null, anchorDate: anchor, window: {from: a.targetDate, to: a.targetDate},
      timeline: a.timeline, weather, alerts: [], irrigationCategory: irrigationCategoryOf(a.facts as never), soilTexture: soilTextureOf(a.facts as never), readings: [],
    });
    point = cond.points.find((p) => p.date === a.targetDate) ?? null;
  } catch { point = null; }
  return {
    sourcePhase: reading.status === 'available' ? reading.phase : null,
    latestNdvi: latest && latest.field.mean !== null ? {value: latest.field.mean, date: latest.date} : null,
    conditionsAt: (d) => (point && point.date === d ? point : null),
  };
}

/** Guidance for one target date on a timeline (both kinds). */
export function guidanceFor(a: {timeline: StageTimeline; sourceDate: string; targetDate: string; cropName: string; context: PredictionContext}): PredictionGuidance {
  const src = stageAt(a.timeline, a.sourceDate), tgt = stageAt(a.timeline, a.targetDate);
  const sourceStage = src.stage ? {id: src.stage.id, name: src.stage.name} : null;
  const targetStage = tgt.stage ? {id: tgt.stage.id, name: tgt.stage.name} : null;
  return buildPredictionGuidance({
    sourceDate: a.sourceDate, targetDate: a.targetDate, sourceStage, targetStage, targetTimeline: tgt.phase,
    phaseAtTarget: phaseForTarget({phase: a.context.sourcePhase, sourceStageId: sourceStage?.id ?? null, targetStageId: targetStage?.id ?? null}),
    latestNdvi: a.context.latestNdvi, conditions: a.context.conditionsAt(a.targetDate), cropName: a.cropName,
  });
}

// ------------------------------------------------------------------ request

/**
 * Ensures an asset row and queues `today.future-look` for it, or returns the existing asset (see the header for the
 * dedup, per-stage, per-week, per-cycle and automatic rules). Throws 404 (farm, cycle), 422 `unknown_stage`, 409 `conflict`
 * with `details.reason` in stage_in_past | no_usable_scene | scene_not_latest | target_not_after_scene | field reasons,
 * 400 on malformed ids, a gap target that is missing, invalid or more than 120 days ahead, or (`cycle_required`) no `cycleId` on
 * a farm that has fields (a farm without fields falls back to its latest unharvested cycle).
 */
export async function requestFutureLook(deps: FutureLookDeps, ownerId: string, farmId: string, req: FutureLookRequest): Promise<FutureLookRequestResult> {
  const kind: FutureLookKind = req.kind ?? 'stage';
  if (!ITEM_ID_RE.test(req.itemId)) throw new ApiError(400, 'validation_error', 'Invalid satellite scene id');
  if (kind === 'stage' && (!req.stageId || !STAGE_ID_RE.test(req.stageId))) throw new ApiError(400, 'validation_error', 'Invalid stage id');
  if (kind === 'gap' && (!req.targetDate || !validDate(req.targetDate))) throw new ApiError(400, 'validation_error', 'A predicted look needs a valid targetDate (YYYY-MM-DD)', {reason: 'target_date_required'});
  if (req.cycleId !== undefined && req.cycleId !== null && (req.cycleId.length < 1 || req.cycleId.length > 120)) throw new ApiError(400, 'validation_error', 'Invalid cycle id');
  const {pool} = deps;
  const farm = await getFarm(pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const stageIdOut = kind === 'stage' ? req.stageId! : '';
  const none = (reason: string): FutureLookRequestResult => ({assetId: null, status: 'unavailable', reason, cycleId: req.cycleId ?? null, stageId: stageIdOut, deduplicated: false});
  // Mode separation: nothing below runs outside live mode (no network, no rows).
  if (deps.config.RUNTIME_MODE !== 'live') return none('live_mode_required');
  if (!deps.config.MODEL_API_KEY) return none('provider_unavailable');
  const now = deps.now ?? (() => new Date());
  const today = istToday(now());
  if (kind === 'gap' && dayDiff(today, req.targetDate!) > GAP_MAX_DAYS_AHEAD) {
    throw new ApiError(400, 'validation_error', `A predicted look can be made for at most ${GAP_MAX_DAYS_AHEAD} days after today`, {reason: 'target_too_far'});
  }

  const workspace = await getWorkspace(pool, ownerId, farmId);
  const anchorOf = (c: (typeof workspace.cycles)[number]) => c.establishmentDate ?? c.sowingDate;
  // A farm with fields has one current cycle per field, so "the latest cycle of the farm" would pick an arbitrary field's
  // crop: the caller must name the cycle. A farm without fields keeps the farm-wide fallback below.
  if (!req.cycleId && workspace.fields.length > 0) {
    throw new ApiError(400, 'cycle_required', 'This farm has fields; name the crop cycle (cycleId) the look is for', {reason: 'cycle_required'});
  }
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
  let stageId: string, stageNameRaw: string;
  if (kind === 'stage') {
    const stage = timeline.stages.find((s) => s.id === req.stageId);
    if (!stage) throw new ApiError(422, 'unknown_stage', 'This stage is not part of the crop cycle timeline', {stageId: req.stageId});
    if (stage.to < today) throw new ApiError(409, 'conflict', 'Illustrations are only made for current or future stages', {reason: 'stage_in_past'});
    stageId = stage.id; stageNameRaw = stage.name;
  } else {
    stageId = ''; stageNameRaw = ''; // set from the stored target below
  }

  // The polygon the cycle's Today view reads: its field's ring when the cycle names a field, else the farm polygon.
  const field = await futureLookField(pool, ownerId, farmId, cycle.fieldId);
  if ('reason' in field) throw new ApiError(409, 'conflict', 'The field has no usable outline for satellite images', {reason: field.reason});
  const latest = (await pool.query<{item_id: string; acquired_at: Date}>(
    'SELECT item_id, acquired_at FROM ndvi_scene_stats WHERE owner_id=$1 AND farm_id=$2 AND polygon_hash=$3 AND usable ORDER BY acquired_at DESC, item_id DESC LIMIT 1',
    [ownerId, farmId, field.hash])).rows[0];
  if (!latest) throw new ApiError(409, 'conflict', 'No usable satellite scene has been analysed for this field yet', {reason: 'no_usable_scene'});
  if (latest.item_id !== req.itemId) throw new ApiError(409, 'conflict', 'Illustrations are derived from the latest usable satellite scene only', {reason: 'scene_not_latest', latestItemId: latest.item_id});
  const sourceDate = latest.acquired_at.toISOString().slice(0, 10);

  let targetDate: string;
  if (kind === 'gap') {
    if (req.targetDate! <= sourceDate) throw new ApiError(409, 'conflict', 'A predicted look must be for a date after the latest real satellite image', {reason: 'target_not_after_scene', sourceDate});
    // Week start, unless that is not after the real image; either way the stored target stays in the requested week.
    const ws = weekStart(req.targetDate!);
    targetDate = ws > sourceDate ? ws : addDays(sourceDate, 1);
    const at = stageAt(timeline, targetDate);
    if (at.stage) { stageId = at.stage.id; stageNameRaw = at.stage.name; }
    else if (at.phase === 'after_harvest') { stageId = 'after_harvest'; stageNameRaw = 'After harvest'; }
    else if (at.phase === 'before_anchor') { stageId = 'before_establishment'; stageNameRaw = 'Before establishment'; }
    else { stageId = 'unstaged'; stageNameRaw = 'Growing season'; }
  } else {
    const stage = timeline.stages.find((s) => s.id === stageId)!;
    targetDate = stage.from > today ? stage.from : today;
  }

  const cropName = promptSafe(cycle.cropName) ?? promptSafe(humanize(cycle.cropId)) ?? 'crop';
  const stageName = promptSafe(stageNameRaw, 80) ?? promptSafe(humanize(stageId), 80) ?? 'growth';
  const sessionId = req.sessionId && UUID_RE.test(req.sessionId) ? req.sessionId : null;
  const context = req.context ?? await storedPredictionContext(pool, {
    ownerId, farmId, polygonHash: field.hash, ring: field.ring, cycle, timeline, today, targetDate, facts: farm.facts, now,
  });
  const guidance = guidanceFor({timeline, sourceDate, targetDate, cropName, context}).guidance;
  const week = kind === 'gap' ? weekStart(targetDate) : null;

  return withTransaction(pool, async (c: PoolClient) => {
    // Automatic requests serialise per farm first (the daily count spans the farm's cycles), then per farm cycle.
    if (req.auto) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`future-look-auto:${farmId}`]);
    // Serialises the per-stage, per-week and per-cycle checks for this farm cycle.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`future-look:${farmId}:${cycle.id}`]);
    const scope = [ownerId, farmId, cycle.id];
    const unavailable = (reason: string) => ({...none(reason), cycleId: cycle.id, stageId, kind, targetDate});
    if (kind === 'gap' && req.auto) {
      const anyThisWeek = (await c.query<FutureLookRow>(
        `SELECT * FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND kind='gap' AND target_week=$4::date ORDER BY created_at DESC LIMIT 1`, [...scope, week])).rows[0];
      if (anyThisWeek && !PENDING.has(anyThisWeek.status) && anyThisWeek.status !== 'ready') return unavailable('auto_week_exists');
      if (!anyThisWeek) {
        const recent = (await c.query<{n: number}>(
          `SELECT count(*)::int AS n FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND kind='gap' AND created_at > now() - interval '1 day'`, [ownerId, farmId])).rows[0]!.n;
        if (recent >= FUTURE_LOOK_AUTO_DAILY_CAP) return unavailable('auto_daily_limit');
      }
    }
    const active = (await c.query<FutureLookRow>(
      kind === 'stage'
        ? `SELECT * FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND kind='stage' AND stage_id=$4 AND status IN ('queued','running','ready')
           ORDER BY (status='ready') DESC, created_at DESC LIMIT 1`
        : `SELECT * FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND kind='gap' AND target_week=$4::date AND status IN ('queued','running','ready')
           ORDER BY (status='ready') DESC, created_at DESC LIMIT 1`,
      [...scope, kind === 'stage' ? stageId : week])).rows[0];
    if (active) return resultOf(active, true);
    const same = (await c.query<FutureLookRow>(
      `SELECT * FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND kind=$4 AND stage_id=$5 AND target_week IS NOT DISTINCT FROM $6::date
         AND source_item_id=$7 AND prompt_version=$8`,
      [...scope, kind, stageId, week, req.itemId, FUTURE_LOOK_PROMPT_VERSION])).rows[0];
    if (same && (same.billed || same.attempt >= FUTURE_LOOK_MAX_ATTEMPTS)) return resultOf(same, true);
    const counted = (await c.query<{n: number}>(
      `SELECT count(*)::int AS n FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND (status IN ('queued','running','ready') OR billed)`, scope)).rows[0]!.n;
    if (counted >= FUTURE_LOOK_CYCLE_CAP) return unavailable('cycle_limit_reached');

    const row = same
      ? (await c.query<FutureLookRow>(
          `UPDATE future_look_assets SET status='queued', attempt=attempt+1, failure_reason=NULL, qa=NULL, storage_key=NULL, model=NULL, provider_request_id=NULL,
             response_deleted=NULL, stage_name=$2, crop_name=$3, source_acquired_at=$4, target_date=$5::date, guidance=$6 WHERE id=$1 RETURNING *`,
          [same.id, stageName, cropName, latest.acquired_at, targetDate, guidance])).rows[0]!
      : (await c.query<FutureLookRow>(
          `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, source_acquired_at, stage_id, stage_name, crop_id, crop_name, prompt_version, status, kind, target_date, guidance)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12::date,$13) RETURNING *`,
          [ownerId, farmId, cycle.id, req.itemId, latest.acquired_at, stageId, stageName, cycle.cropId, cropName, FUTURE_LOOK_PROMPT_VERSION, kind, targetDate, guidance])).rows[0]!;
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

export interface FutureLookImage { bytes: Buffer; contentType: 'image/png'; label: string; sourceAcquiredAt: string | null; kind: FutureLookKind }

/**
 * PNG bytes of a ready illustration; 404 for any other state, a foreign asset or a missing object. With `fieldId` (the
 * field view's paths carry it, spec 11.2) the asset's cycle must name that field, else 404; the bytes do not depend on it.
 */
export async function futureLookImage(deps: FutureLookImageDeps, ownerId: string, farmId: string, assetId: string, fieldId?: string): Promise<FutureLookImage> {
  const row = await ownedRow(deps, ownerId, farmId, assetId);
  if (row.status !== 'ready' || !row.storage_key) throw notFound('Illustration');
  if (fieldId !== undefined) {
    const cycle = (await getWorkspace(deps.pool, ownerId, farmId)).cycles.find((c) => c.id === row.cycle_id);
    if (!cycle || cycle.fieldId !== fieldId) throw notFound('Illustration');
  }
  try {
    const bytes = Buffer.from(await deps.storage.get({ownerId, key: row.storage_key}));
    const label = row.kind === 'gap' ? predictedLookLabel(pgDate(row.target_date), row.source_acquired_at?.toISOString().slice(0, 10) ?? null) : futureLookLabel(row.stage_name);
    return {bytes, contentType: 'image/png', label, sourceAcquiredAt: row.source_acquired_at?.toISOString() ?? null, kind: row.kind === 'gap' ? 'gap' : 'stage'};
  } catch (e) {
    if (e instanceof StorageError) throw notFound('Illustration');
    throw e;
  }
}

export interface ReadyFutureLook {
  assetId: string; stageId: string; sourceItemId: string; cropId: string; createdAt: string; imagePath: string;
  /** 2026-11-03: rows made before v2 are 'stage' with null targetDate and guidance. */
  kind: FutureLookKind; targetDate: string | null; guidance: string | null;
}

/**
 * Ready illustrations and predicted looks of one crop cycle, oldest first, for the Today aggregator's SceneRef entries.
 * Owner-scoped (404 for a foreign or deleted farm); empty outside live mode.
 */
export async function listReadyFutureLooks(deps: FutureLookDeps, ownerId: string, farmId: string, cycleId: string): Promise<ReadyFutureLook[]> {
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  if (deps.config.RUNTIME_MODE !== 'live') return [];
  const rows = (await deps.pool.query<FutureLookRow>(
    "SELECT * FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND status='ready' AND storage_key IS NOT NULL ORDER BY created_at, id",
    [ownerId, farmId, cycleId])).rows;
  return rows.map((r) => ({
    assetId: r.id, stageId: r.stage_id, sourceItemId: r.source_item_id, cropId: r.crop_id, createdAt: r.created_at.toISOString(), imagePath: futureLookImagePath(farmId, r.id),
    kind: r.kind === 'gap' ? 'gap' : 'stage', targetDate: pgDate(r.target_date), guidance: r.guidance ? r.guidance.slice(0, 400) : null,
  }));
}

/**
 * Gap looks of one cycle that are queued or running with a job that is itself still queued or running (a row whose job
 * died is not counted, so the web never waits on it). Owner-scoped; 0 outside live mode.
 */
export async function pendingGapLooks(deps: FutureLookDeps, ownerId: string, farmId: string, cycleId: string): Promise<number> {
  if (deps.config.RUNTIME_MODE !== 'live') return 0;
  return (await deps.pool.query<{n: number}>(
    `SELECT count(*)::int AS n FROM future_look_assets a JOIN jobs j ON j.id = a.job_id
      WHERE a.owner_id=$1 AND a.farm_id=$2 AND a.cycle_id=$3 AND a.kind='gap' AND a.status IN ('queued','running') AND j.state IN ('queued','running')`,
    [ownerId, farmId, cycleId])).rows[0]!.n;
}
