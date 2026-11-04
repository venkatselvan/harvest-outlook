/**
 * Crop journey (docs/research/EVARA_ACTIONS_SPEC.md section 3.2, 2026-11-04): an arbitrary crop's growth cycle on one field as
 * up to five generated stage illustrations. Each illustration is a Meta image edit of this field's latest usable Sentinel-2
 * scene (else its latest owner photo with a confirmed planting region) changed only inside the field outline, QA-checked by the
 * future look's deterministic scene check. Illustrations only: never field data, never a prediction of yield or health.
 *
 * Request path (this file): owner-scoped, explicit request only. The worker job `today.crop-journey`
 * (worker/handlers/crop-journey.ts) makes the paid calls, one stage at a time in stage order, and updates the journey after
 * each, so GET shows progress.
 *
 * Rules, all code (each documented where it changes results):
 * - stages: the stage timeline the season-preview service builds for a custom slot (services/season-preview.ts step 1: the
 *   same `stageTimeline` call with the crop, the product (none for a green manure), the establishment method, the sowing
 *   date as anchor and the farm's state and district). The full season preview is not called: its weather, price and
 *   engine steps are not used here and, in live mode, can trigger a climatology ingest from a POST. No stages = 422
 *   `no_stage_data` (a journey needs at least one stage);
 * - sowing date: the request's, else the sowing of the stored crop-fit candidate for this crop on this field (latest ready,
 *   unarchived review of this runtime mode for the field, best rank; the candidate's product and establishment method are used
 *   with it), else today (IST). At most SOWING_MAX_OFFSET_DAYS from today (400 otherwise, a bound on nonsense dates);
 * - illustrated stages: all when there are at most 5; else the first, the last and three evenly spaced between them
 *   (indices round(i * (n - 1) / 4), i = 0..4). The rest are schematic (the web draws FieldGrowthScene). Target date of each
 *   illustration = the stage start (the first stage starts on the sowing date);
 * - guidance: a code sentence per stage from the stage's name (prediction-guidance.ts keyword classes and change words, FAO-56
 *   stage definitions) and its day count from sowing. The field's own NDVI phase and weather are NOT used: they describe the
 *   crop on the field now, not the crop of the journey;
 * - source image: the latest usable analysed Sentinel-2 scene for the field polygon (ndvi_scene_stats, as the future look),
 *   else the latest owner field photo on this field whose planting region is confirmed (manual or SAM-confirmed), else
 *   `unavailable` / `no_source_image`;
 * - live mode with a model key only. Synthetic and replay return an `unavailable` / `runtime_mode` journey that is NOT stored
 *   (no row, no job, no network; its journeyId is fresh and GET answers 409 mode_mismatch outside live mode, as the future
 *   look's reads do);
 * - a farm with fields must name the field: without fieldId the journey is `unavailable` / `field_required` (the field polygon
 *   decides the scene, the outline and the mask);
 * - caps, under a per-farm advisory lock: one journey per (farm, field, crop, IST day), a repeat returns it with
 *   `deduplicated: true` (whatever sowingDate or product the repeat names); an `unavailable` journey is re-evaluated in place
 *   (no image was made); 5 images per journey; 3 journeys per farm per IST day that are not `unavailable` (`daily_cap`);
 * - budget: the same image budget as the future look. The request is refused (`budget`) when the global development budget
 *   cannot cover one image per illustrated stage at the price-table unit price; the worker then reserves each stage's worst
 *   case (two images: one retry on 429/503) and a refused reservation leaves that stage and the rest `unavailable` / `budget`.
 * Assets are future_look_assets rows of kind 'journey' with the journey's id, cycle_id 'journey:<id>', served by
 * GET /api/v1/farms/:id/future-look/:assetId/image (futureLookImage accepts journey assets; with `fieldId` the journey must
 * name that field).
 */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {CropJourneyRequest, type CropJourney, type CropJourneyStage, type CropJourneyStatus, type FutureLookStatus, type StageTimeline} from '@harvest/contracts';
import type {Config} from '../../config';
import {withTransaction, type Pool} from '../../db/pool';
import type {Budget} from '../budget';
import {ApiError, notFound} from '../errors';
import {getFarm} from '../farms';
import {enqueue} from '../jobs';
import {fieldOf, getWorkspace} from '../workspace';
import {cropDisplayName, isGreenManure} from '../year-plan/data';
import {stageTimeline, type StageTimelineInput} from './stage-timeline';
import {CHANGE_WORDS, stageChange, type ChangeClass} from './prediction-guidance';
import {
  CROP_JOURNEY_DISCLAIMER, CROP_JOURNEY_LABEL, FAO_STAGE_CUES, FUTURE_LOOK_PROMPT_VERSION, buildFutureLookPrompt, futureLookField,
  futureLookImagePath, guidanceSafe, promptSafe, type FutureLookRow,
} from './future-look';

export const CROP_JOURNEY_JOB_TYPE = 'today.crop-journey';
/** Max illustrated stages (= images) per journey (spec 3.2). */
export const CROP_JOURNEY_MAX_IMAGES = 5;
/** Max journeys per farm per IST day that are not `unavailable` (spec 3.2). */
export const CROP_JOURNEY_DAILY_CAP = 3;
/** Max arms of one journey row (only `unavailable` rows are re-armed; none of their stages was billed). */
export const CROP_JOURNEY_MAX_ATTEMPTS = 10;
/** A requested or defaulted sowing date may be at most this many days from today (IST). Engineering bound, not agronomy. */
export const SOWING_MAX_OFFSET_DAYS = 730;
/** Prompt versions stored on the journey's asset rows (the template differs for a satellite scene and a ground photo). */
export const CROP_JOURNEY_SATELLITE_PROMPT_VERSION = 'crop-journey-sat-v1';
export const CROP_JOURNEY_PHOTO_PROMPT_VERSION = 'crop-journey-photo-v1';
export const SCHEMATIC_LABEL = 'Schematic drawing, not a prediction';
export const MODEL_PROVIDER = 'meta';

const PENDING: ReadonlySet<string> = new Set(['queued', 'running']);
const CROP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,119}$/;
const STAGE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const istToday = (now: Date) => new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const humanize = (id: string) => id.replace(/[_-]+/g, ' ').trim();

// ------------------------------------------------------------------ deps and rows

export interface CropJourneyDeps {
  config: Pick<Config, 'RUNTIME_MODE' | 'META_IMAGE_MODEL'> & {MODEL_API_KEY?: string | undefined};
  pool: Pool;
  /** The app's single Budget (the same image budget as the future look). Without it the request-time check is skipped. */
  budget?: Pick<Budget, 'summary' | 'estimate'> | undefined;
  now?: (() => Date) | undefined;
  /** Test injection; production uses the season-preview stage source (stage-timeline.ts). */
  timeline?: ((input: StageTimelineInput) => StageTimeline) | undefined;
}

/** The frozen per-stage decision stored on the journey row (status and image come from the asset rows at read time). */
export interface StoredJourneyStage {
  stageId: string; name: string; from: string; to: string; targetDate: string; illustrated: boolean; guidance: string | null; label: string; assetId: string | null;
}

export interface JourneyRow {
  id: string; owner_id: string; farm_id: string; field_id: string | null; crop_id: string; crop_name: string; product_id: string | null;
  establishment_method: string | null; sowing_date: string; sowing_basis: 'request' | 'crop_fit' | 'today'; ist_day: string;
  status: CropJourneyStatus; reason: string | null; source_kind: 'satellite' | 'photo' | 'none'; source_ref: string | null;
  source_media_id: string | null; source_region_version: number | null; source_date: string | null; source_acquired_at: Date | null;
  stages: StoredJourneyStage[]; calendar_basis: string | null; attempt: number; job_id: string | null; created_at: Date; updated_at: Date;
}
/** Dates cast in SQL so their calendar day does not depend on the client time zone. */
export const JOURNEY_COLS = `id, owner_id, farm_id, field_id, crop_id, crop_name, product_id, establishment_method, sowing_date::text AS sowing_date,
  sowing_basis, ist_day::text AS ist_day, status, reason, source_kind, source_ref, source_media_id, source_region_version, source_date::text AS source_date,
  source_acquired_at, stages, calendar_basis, attempt, job_id, created_at, updated_at`;

export type JourneySource =
  | {kind: 'satellite'; itemId: string; acquiredAt: Date}
  | {kind: 'photo'; photoId: string; mediaId: string; regionVersion: number; capturedOn: string};

// ------------------------------------------------------------------ pure rules

/**
 * Indices of the illustrated stages among `n`: all when n <= 5; else first, last and three evenly spaced between them
 * (round(i * (n - 1) / 4) for i = 0..4, which are distinct for n >= 5).
 */
export function illustratedIndices(n: number, max = CROP_JOURNEY_MAX_IMAGES): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({length: n}, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < max; i++) out.add(Math.round((i * (n - 1)) / (max - 1)));
  return [...out].sort((a, b) => a - b);
}

const stageWords = (name: string) => (/\bstage\b/i.test(name) ? name : `${name} stage`).toLowerCase();
/** Journey-only wording when a stage name matches no keyword class (the future look's generic "small change" does not apply). */
const UNCLASSED_WORDS = 'the crop as it typically looks at this stage';

/**
 * The code-written guidance for one journey stage. Change class from the stage name and id (prediction-guidance.ts
 * `stageChange`, FAO-56 stage keywords); the first stage falls back to `establishing` because its target date is the sowing
 * date (FAO-56 initial: planting to about 10% cover). No other inference: an unclassed later stage gets neutral words.
 * Never an index number; the only number is the whole-day count from sowing.
 */
export function journeyGuidance(a: {stage: {id: string; name: string; from: string}; index: number; sowing: string; cropName: string}): string {
  const change: ChangeClass | null = stageChange({id: a.stage.id, name: a.stage.name}) ?? (a.index === 0 ? 'establishing' : null);
  const days = Math.max(0, dayDiff(a.sowing, a.stage.from));
  const when = days === 0 ? 'At sowing' : `${days} day${days === 1 ? '' : 's'} after sowing`;
  const crop = a.cropName.trim().toLowerCase() || 'crop';
  return cap(`${when}, in the ${stageWords(a.stage.name)} of ${crop}: ${change ? CHANGE_WORDS[change] : UNCLASSED_WORDS}.`, 400);
}

/**
 * Prompt for one journey stage. Satellite: the future look's stage template (future-look-v3 constraints: keep everything
 * outside the red outline, keep the outline's shape and size, no text) with this guidance. Photo: the same constraints worded
 * for a ground photo of the field. Names pass promptSafe and the guidance guidanceSafe; nothing from the client reaches it.
 */
export function journeyPrompt(p: {source: 'satellite' | 'photo'; stageId: string; stageName: string; cropName: string; guidance: string | null}): string {
  if (p.source === 'satellite') {
    return buildFutureLookPrompt({stageId: p.stageId, stageName: p.stageName, cropName: p.cropName, kind: 'stage', guidance: p.guidance, promptVersion: FUTURE_LOOK_PROMPT_VERSION});
  }
  const stage = stageWords(promptSafe(p.stageName, 80) ?? 'growth').toLowerCase();
  const crop = (promptSafe(p.cropName) ?? 'crop').toLowerCase();
  const cue = FAO_STAGE_CUES[p.stageId] ?? 'the plants and ground cover this stage typically shows';
  const guidance = guidanceSafe(p.guidance);
  return [
    'Edit this photo of a farm field.',
    'Keep everything outside the area outlined in red exactly as it is: sky, trees, buildings, paths, people, tools and neighbouring plots, in the same position, shape, colour and lighting.',
    `Change only the ground inside the red outline so that it shows a typical ${stage} of ${crop}: ${cue}.`,
    ...(guidance ? [`Expected change: ${guidance}`] : []),
    'Keep the red outline exactly where it is, with the same shape and size; do not redraw, move, widen or resize it.',
    'No text, no labels, no arrows, no borders, no watermark.',
    'Photographic style from the same viewpoint, at the same scale and in the same light as the original.',
  ].join(' ');
}

/** Journey status from its illustrated stages' statuses (see the header). */
export function journeyOutcome(stages: readonly {status: FutureLookStatus; reason: string | null}[]): {status: CropJourneyStatus; reason: string | null} {
  if (!stages.length) return {status: 'unavailable', reason: 'no_illustrated_stage'};
  if (stages.some((s) => PENDING.has(s.status))) return {status: 'running', reason: null};
  const ready = stages.filter((s) => s.status === 'ready').length;
  if (ready === stages.length) return {status: 'ready', reason: null};
  if (ready > 0) return {status: 'partial', reason: null};
  if (stages.every((s) => s.status === 'unavailable')) return {status: 'unavailable', reason: stages[0]!.reason ?? 'unavailable'};
  return {status: 'failed', reason: stages.find((s) => s.status === 'failed')?.reason ?? 'failed'};
}

// ------------------------------------------------------------------ reads used by the request

/** Loose read of a stored crop-fit result: only the fields used here, so a later contract change cannot hide a candidate. */
const StoredFit = z.object({
  candidates: z.array(z.object({
    cropId: z.string(), productId: z.string(), cropName: z.string().optional(), establishmentMethod: z.string().nullable().optional(),
    rank: z.number(), sowing: z.iso.date(),
  }).passthrough()),
}).passthrough();

export interface FitCandidate { cropName: string | null; productId: string; establishmentMethod: string | null; sowing: string }

/** The stored crop-fit candidate for this crop (and product, when named) on this field: latest ready review, best rank. */
export async function cropFitCandidate(pool: Pool, a: {ownerId: string; farmId: string; mode: string; fieldId: string | null; cropId: string; productId: string | null}): Promise<FitCandidate | null> {
  const row = (await pool.query<{result: unknown}>(
    `SELECT result FROM crop_fit_reviews WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND archived_at IS NULL AND status='ready'
       AND result->>'fieldId' IS NOT DISTINCT FROM $4::text ORDER BY created_at DESC LIMIT 1`,
    [a.farmId, a.ownerId, a.mode, a.fieldId])).rows[0];
  if (!row) return null;
  const fit = StoredFit.safeParse(row.result);
  if (!fit.success) return null;
  const c = fit.data.candidates.filter((x) => x.cropId === a.cropId && (a.productId === null || x.productId === a.productId)).sort((x, y) => x.rank - y.rank)[0];
  return c ? {cropName: c.cropName ?? null, productId: c.productId, establishmentMethod: c.establishmentMethod ?? null, sowing: c.sowing} : null;
}

/** Latest usable scene for the field polygon, else the latest owner field photo on the field with a confirmed region. */
export async function journeySource(pool: Pool, ownerId: string, farmId: string, fieldId: string | null): Promise<JourneySource | null> {
  const field = await futureLookField(pool, ownerId, farmId, fieldId ?? undefined);
  if (!('reason' in field)) {
    const scene = (await pool.query<{item_id: string; acquired_at: Date}>(
      'SELECT item_id, acquired_at FROM ndvi_scene_stats WHERE owner_id=$1 AND farm_id=$2 AND polygon_hash=$3 AND usable ORDER BY acquired_at DESC, item_id DESC LIMIT 1',
      [ownerId, farmId, field.hash])).rows[0];
    if (scene) return {kind: 'satellite', itemId: scene.item_id, acquiredAt: scene.acquired_at};
  }
  const photo = (await pool.query<{id: string; media_id: string; captured_on: string; region_version: number}>(
    `SELECT p.id, p.media_id, p.captured_on::text AS captured_on, m.region_version FROM field_photos p
       JOIN media_objects m ON m.id = p.media_id AND m.owner_id = p.owner_id
      WHERE p.owner_id=$1 AND p.farm_id=$2 AND p.field_id IS NOT DISTINCT FROM $3::text AND m.kind='image' AND m.deleted_at IS NULL
        AND m.region_polygon IS NOT NULL AND m.region_transform IS NOT NULL AND m.region_source IS NOT NULL
      ORDER BY p.captured_on DESC, p.created_at DESC LIMIT 1`,
    [ownerId, farmId, fieldId])).rows[0];
  return photo ? {kind: 'photo', photoId: photo.id, mediaId: photo.media_id, regionVersion: photo.region_version, capturedOn: photo.captured_on} : null;
}

// ------------------------------------------------------------------ output

function limitationsOf(row: Pick<JourneyRow, 'source_kind' | 'source_date' | 'sowing_basis' | 'calendar_basis' | 'stages' | 'crop_name'>): string[] {
  const out: string[] = ['Each image shows a typical look of the stage, not how this field will look and not a prediction of yield or health.'];
  if (row.source_kind === 'satellite') out.push(`Derived from the real satellite image of ${row.source_date ?? 'an earlier date'}; only the area inside the field outline is changed, and that image may show another crop than ${row.crop_name.toLowerCase()}.`);
  if (row.source_kind === 'photo') out.push(`Derived from your field photo of ${row.source_date ?? 'an earlier date'}; only the confirmed planting region is changed.`);
  if (row.sowing_basis === 'crop_fit') out.push('Sowing date from the latest crop-fit review for this field.');
  if (row.sowing_basis === 'today') out.push('No sowing date was given, so today is used.');
  if (row.calendar_basis) out.push(cap(`Stage dates: ${row.calendar_basis}.`, 300));
  const schematic = row.stages.filter((s) => !s.illustrated).length;
  if (schematic) out.push(`${schematic} of ${row.stages.length} stages are drawn as schematics only (at most ${CROP_JOURNEY_MAX_IMAGES} images per journey).`);
  out.push('The scene check that accepts an image is an unvalidated heuristic: it only confirms the area outside the outline is unchanged.');
  return out.slice(0, 10).map((l) => cap(l, 300));
}

/** CropJourney from a row and its asset rows (illustrated stages read their status, reason and image from the asset). */
export function toCropJourney(row: JourneyRow, assets: readonly FutureLookRow[], deduplicated: boolean): CropJourney {
  const stages: CropJourneyStage[] = row.stages.map((s) => {
    const base = {stageId: s.stageId, name: s.name, from: s.from, to: s.to, targetDate: s.targetDate, illustrated: s.illustrated, label: s.label};
    if (!s.illustrated) return {...base, status: 'schematic', reason: null, assetId: null, imagePath: null, guidance: null};
    const a = s.assetId ? assets.find((x) => x.id === s.assetId) : undefined;
    if (!a) return {...base, status: 'unavailable', reason: row.reason ?? 'not_rendered', assetId: null, imagePath: null, guidance: s.guidance};
    return {
      ...base, status: a.status, reason: a.status === 'failed' || a.status === 'unavailable' ? a.failure_reason ?? a.status : null, assetId: a.id,
      imagePath: a.status === 'ready' ? futureLookImagePath(row.farm_id, a.id) : null, guidance: a.guidance ?? s.guidance,
    };
  });
  return {
    journeyId: row.id, farmId: row.farm_id, fieldId: row.field_id, cropId: row.crop_id, cropName: row.crop_name, productId: row.product_id,
    sowingDate: row.sowing_date, status: row.status, reason: row.status === 'unavailable' || row.status === 'failed' ? row.reason : null,
    source: {kind: row.source_kind, itemId: row.source_ref, date: row.source_date}, deduplicated, stages, disclaimer: CROP_JOURNEY_DISCLAIMER,
    limitations: limitationsOf(row), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

async function assetsOf(db: Pool | PoolClient, row: Pick<JourneyRow, 'id' | 'owner_id' | 'farm_id'>): Promise<FutureLookRow[]> {
  return (await db.query<FutureLookRow>('SELECT * FROM future_look_assets WHERE journey_id=$1 AND owner_id=$2 AND farm_id=$3 ORDER BY created_at, id', [row.id, row.owner_id, row.farm_id])).rows;
}

// ------------------------------------------------------------------ request

interface Plan {
  cropId: string; cropName: string; productId: string | null; method: string | null; sowing: string; sowingBasis: JourneyRow['sowing_basis'];
  fieldId: string | null; stages: StoredJourneyStage[]; calendarBasis: string | null; today: string;
}

async function planJourney(deps: CropJourneyDeps, ownerId: string, farmId: string, req: CropJourneyRequest): Promise<{plan: Plan; hasFields: boolean}> {
  const {pool} = deps;
  if (!CROP_ID_RE.test(req.cropId)) throw new ApiError(400, 'validation_error', 'Invalid crop id', {reason: 'invalid_crop_id'});
  const farm = await getFarm(pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const today = istToday((deps.now ?? (() => new Date()))());
  const workspace = await getWorkspace(pool, ownerId, farmId);
  const fieldId = req.fieldId ?? null;
  if (fieldId !== null) fieldOf(workspace, fieldId); // 404 field_not_found
  const fit = await cropFitCandidate(pool, {ownerId, farmId, mode: deps.config.RUNTIME_MODE, fieldId, cropId: req.cropId, productId: req.productId ?? null});
  const sowing = req.sowingDate ?? fit?.sowing ?? today;
  const sowingBasis: Plan['sowingBasis'] = req.sowingDate ? 'request' : fit ? 'crop_fit' : 'today';
  if (Math.abs(dayDiff(today, sowing)) > SOWING_MAX_OFFSET_DAYS) {
    throw new ApiError(400, 'validation_error', `The sowing date must be within ${SOWING_MAX_OFFSET_DAYS} days of today`, {reason: 'sowing_out_of_range'});
  }
  const gm = isGreenManure(req.cropId);
  const productId = req.productId ?? fit?.productId ?? (gm ? req.cropId : null);
  const method = fit?.establishmentMethod ?? null;
  let timeline: StageTimeline;
  try {
    timeline = (deps.timeline ?? stageTimeline)({cropId: req.cropId, productId: gm ? null : productId, establishmentMethod: method, anchorDate: sowing, stateId: farm.location.stateCode, districtId: farm.location.districtId});
  } catch {
    throw new ApiError(422, 'no_stage_data', 'The stage calendar could not be built for this crop', {reason: 'no_stage_data'});
  }
  if (!timeline.stages.length) throw new ApiError(422, 'no_stage_data', 'No sourced stage data for this crop', {reason: 'no_stage_data'});
  const cropName = cap(fit?.cropName ?? cropDisplayName(req.cropId), 120);
  const promptCrop = promptSafe(cropName) ?? promptSafe(humanize(req.cropId)) ?? 'crop';
  const chosen = new Set(illustratedIndices(timeline.stages.length));
  const stages = timeline.stages.map((s, i): StoredJourneyStage => {
    const stageId = STAGE_ID_RE.test(s.id) ? s.id : `stage-${i + 1}`;
    const name = cap(promptSafe(s.name, 80) ?? promptSafe(humanize(s.id), 80) ?? `Stage ${i + 1}`, 80);
    const illustrated = chosen.has(i);
    return {
      stageId, name, from: s.from, to: s.to, targetDate: s.from, illustrated, assetId: null,
      guidance: illustrated ? journeyGuidance({stage: {id: s.id, name, from: s.from}, index: i, sowing, cropName: promptCrop}) : null,
      label: illustrated ? CROP_JOURNEY_LABEL : SCHEMATIC_LABEL,
    };
  });
  return {
    plan: {cropId: req.cropId, cropName, productId: productId ? cap(productId, 200) : null, method, sowing, sowingBasis, fieldId, stages, calendarBasis: cap(timeline.basis.label, 200), today},
    hasFields: workspace.fields.length > 0,
  };
}

/**
 * Ensures a journey for (farm, field, crop, IST day) and queues `today.crop-journey`, or returns the existing journey (see the
 * header). Throws 400 (validation, sowing_out_of_range), 404 (farm, field), 422 no_stage_data.
 */
export async function requestCropJourney(deps: CropJourneyDeps, auth: {ownerId: string; sessionId: string | null}, farmId: string, body: CropJourneyRequest): Promise<CropJourney> {
  const parsed = CropJourneyRequest.safeParse(body);
  if (!parsed.success) throw new ApiError(400, 'validation_error', 'Invalid crop journey request');
  const req = parsed.data;
  const {ownerId} = auth;
  const {pool, config} = deps;
  const {plan, hasFields} = await planJourney(deps, ownerId, farmId, req);
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();

  // Mode separation: nothing is stored and nothing is sent outside live mode or without a model key.
  if (config.RUNTIME_MODE !== 'live' || !config.MODEL_API_KEY) {
    const row: JourneyRow = {
      id: randomUUID(), owner_id: ownerId, farm_id: farmId, field_id: plan.fieldId, crop_id: plan.cropId, crop_name: plan.cropName, product_id: plan.productId,
      establishment_method: plan.method, sowing_date: plan.sowing, sowing_basis: plan.sowingBasis, ist_day: plan.today, status: 'unavailable', reason: 'runtime_mode',
      source_kind: 'none', source_ref: null, source_media_id: null, source_region_version: null, source_date: null, source_acquired_at: null,
      stages: plan.stages, calendar_basis: plan.calendarBasis, attempt: 1, job_id: null, created_at: new Date(nowIso), updated_at: new Date(nowIso),
    };
    return toCropJourney(row, [], false);
  }

  const source = plan.fieldId === null && hasFields ? null : await journeySource(pool, ownerId, farmId, plan.fieldId);
  const sessionId = auth.sessionId && UUID_RE.test(auth.sessionId) ? auth.sessionId : null;
  const illustrated = plan.stages.filter((s) => s.illustrated);

  const out = await withTransaction(pool, async (c: PoolClient) => {
    // Serialises the per-day dedup and the farm's daily count.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`crop-journey:${farmId}`]);
    const existing = (await c.query<JourneyRow>(
      `SELECT ${JOURNEY_COLS} FROM crop_journeys WHERE owner_id=$1 AND farm_id=$2 AND field_id IS NOT DISTINCT FROM $3::text AND crop_id=$4 AND ist_day=$5::date`,
      [ownerId, farmId, plan.fieldId, plan.cropId, plan.today])).rows[0];
    if (existing && (existing.status !== 'unavailable' || existing.attempt >= CROP_JOURNEY_MAX_ATTEMPTS)) return {dedup: existing};

    const write = async (status: CropJourneyStatus, reason: string | null, src: JourneySource | null, stages: StoredJourneyStage[], bumpAttempt: boolean): Promise<JourneyRow> => {
      const s = src?.kind === 'satellite'
        ? {kind: 'satellite', ref: src.itemId, media: null, region: null, date: src.acquiredAt.toISOString().slice(0, 10), at: src.acquiredAt}
        : src?.kind === 'photo'
          ? {kind: 'photo', ref: src.photoId, media: src.mediaId, region: src.regionVersion, date: src.capturedOn, at: new Date(`${src.capturedOn}T00:00:00Z`)}
          : {kind: 'none', ref: null, media: null, region: null, date: null, at: null};
      const values = [plan.cropName, plan.productId, plan.method, plan.sowing, plan.sowingBasis, status, reason, s.kind, s.ref, s.media, s.region, s.date, s.at, JSON.stringify(stages), plan.calendarBasis];
      if (existing) {
        return (await c.query<JourneyRow>(
          `UPDATE crop_journeys SET crop_name=$2, product_id=$3, establishment_method=$4, sowing_date=$5::date, sowing_basis=$6, status=$7, reason=$8, source_kind=$9,
             source_ref=$10, source_media_id=$11, source_region_version=$12, source_date=$13::date, source_acquired_at=$14, stages=$15::jsonb, calendar_basis=$16,
             attempt = attempt + $17::int, job_id=NULL WHERE id=$1 RETURNING ${JOURNEY_COLS}`,
          [existing.id, ...values, bumpAttempt ? 1 : 0])).rows[0]!;
      }
      return (await c.query<JourneyRow>(
        `INSERT INTO crop_journeys (owner_id, farm_id, field_id, crop_id, ist_day, crop_name, product_id, establishment_method, sowing_date, sowing_basis, status, reason,
           source_kind, source_ref, source_media_id, source_region_version, source_date, source_acquired_at, stages, calendar_basis)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15,$16,$17::date,$18,$19::jsonb,$20) RETURNING ${JOURNEY_COLS}`,
        [ownerId, farmId, plan.fieldId, plan.cropId, plan.today, ...values])).rows[0]!;
    };
    const unavailable = async (reason: string, src: JourneySource | null = null) => ({row: await write('unavailable', reason, src, plan.stages, false), assets: [] as FutureLookRow[]});

    if (plan.fieldId === null && hasFields) return unavailable('field_required');
    if (!source) return unavailable('no_source_image');
    const madeToday = (await c.query<{n: number}>(
      `SELECT count(*)::int AS n FROM crop_journeys WHERE owner_id=$1 AND farm_id=$2 AND ist_day=$3::date AND status <> 'unavailable' AND id IS DISTINCT FROM $4::uuid`,
      [ownerId, farmId, plan.today, existing?.id ?? null])).rows[0]!.n;
    if (madeToday >= CROP_JOURNEY_DAILY_CAP) return unavailable('daily_cap', source);
    if (deps.budget) {
      const summary = await deps.budget.summary();
      const need = deps.budget.estimate(MODEL_PROVIDER, config.META_IMAGE_MODEL, {images: illustrated.length}).usd ?? 0;
      if (summary && summary.remainingDevUsd < need) return unavailable('budget', source);
    }

    // Queue: the row, one queued asset per illustrated stage (in stage order), one job.
    let row = await write('queued', null, source, plan.stages, existing !== undefined);
    const promptVersion = source.kind === 'satellite' ? CROP_JOURNEY_SATELLITE_PROMPT_VERSION : CROP_JOURNEY_PHOTO_PROMPT_VERSION;
    const sourceItem = source.kind === 'satellite' ? source.itemId : `photo.${source.photoId}`;
    const sourceAt = source.kind === 'satellite' ? source.acquiredAt : new Date(`${source.capturedOn}T00:00:00Z`);
    const assets: FutureLookRow[] = [];
    const stages: StoredJourneyStage[] = [];
    for (const s of plan.stages) {
      if (!s.illustrated) { stages.push(s); continue; }
      const a = (await c.query<FutureLookRow>(
        `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, source_acquired_at, stage_id, stage_name, crop_id, crop_name, prompt_version, status, kind,
           target_date, guidance, journey_id, evidence_revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued','journey',$11::date,$12,$13,$14) RETURNING *`,
        [ownerId, farmId, `journey:${row.id}`, sourceItem, sourceAt, s.stageId, s.name, plan.cropId, plan.cropName, promptVersion, s.targetDate, s.guidance, row.id, `attempt-${row.attempt}`])).rows[0]!;
      assets.push(a);
      stages.push({...s, assetId: a.id});
    }
    // One job per arm of the journey: cj:{journeyId}:{attempt}. farmId in the payload lets deleteFarm's job cleanup find it.
    const q = await enqueue(c, CROP_JOURNEY_JOB_TYPE, {journeyId: row.id, farmId, sessionId}, ownerId, `cj:${row.id}:${row.attempt}`);
    row = (await c.query<JourneyRow>(`UPDATE crop_journeys SET stages=$2::jsonb, job_id=$3 WHERE id=$1 RETURNING ${JOURNEY_COLS}`, [row.id, JSON.stringify(stages), q.job.id])).rows[0]!;
    await c.query('UPDATE future_look_assets SET job_id=$2 WHERE journey_id=$1 AND id = ANY($3::uuid[])', [row.id, q.job.id, assets.map((a) => a.id)]);
    return {row, assets: assets.map((a) => ({...a, job_id: q.job.id}))};
  });
  if ('dedup' in out) {
    const row = await reconcileJourney(pool, out.dedup);
    return toCropJourney(row, await assetsOf(pool, row), true);
  }
  return toCropJourney(out.row, out.assets, false);
}

// ------------------------------------------------------------------ reads

/**
 * A queued or running journey whose job is gone, failed or cancelled is closed: its pending stages fail with `job_failed`
 * (billed when the stage's dispatch marker shows a paid call may have been sent) and the journey takes its outcome.
 */
export async function reconcileJourney(pool: Pool, row: JourneyRow): Promise<JourneyRow> {
  if (!PENDING.has(row.status)) return row;
  const job = row.job_id ? (await pool.query<{state: string}>('SELECT state FROM jobs WHERE id=$1', [row.job_id])).rows[0] : undefined;
  if (job && (job.state === 'queued' || job.state === 'running')) return row;
  const reason = !job ? 'job_missing' : job.state === 'succeeded' ? 'job_finished_without_result' : 'job_failed';
  for (const a of await assetsOf(pool, row)) {
    if (!PENDING.has(a.status)) continue;
    const dispatched = a.job_id ? ((await pool.query("SELECT 1 FROM job_dispatches WHERE job_id=$1 AND stage_key=$2 AND (outcome IS NULL OR outcome IN ('uncertain','completed'))", [a.job_id, `cj:${a.id}`])).rowCount ?? 0) > 0 : false;
    await pool.query(`UPDATE future_look_assets SET status='failed', failure_reason=$2, billed = billed OR $3 WHERE id=$1 AND status IN ('queued','running')`, [a.id, reason, dispatched]);
  }
  const assets = await assetsOf(pool, row);
  const ids = new Set(row.stages.flatMap((s) => (s.illustrated && s.assetId ? [s.assetId] : [])));
  const o = journeyOutcome(assets.filter((a) => ids.has(a.id)).map((a) => ({status: a.status, reason: a.failure_reason})));
  const status = o.status === 'running' ? 'failed' : o.status;
  const u = await pool.query<JourneyRow>(
    `UPDATE crop_journeys SET status=$2, reason=$3 WHERE id=$1 AND status IN ('queued','running') AND job_id IS NOT DISTINCT FROM $4::uuid RETURNING ${JOURNEY_COLS}`,
    [row.id, status, status === 'failed' || status === 'unavailable' ? (o.reason ?? reason) : null, row.job_id]);
  return u.rows[0] ?? (await pool.query<JourneyRow>(`SELECT ${JOURNEY_COLS} FROM crop_journeys WHERE id=$1`, [row.id])).rows[0] ?? row;
}

/** GET: the journey with per-stage progress. Owner-scoped (404 for a foreign farm or journey); 409 mode_mismatch outside live mode. */
export async function cropJourneyStatus(deps: Pick<CropJourneyDeps, 'config' | 'pool'>, ownerId: string, farmId: string, journeyId: string): Promise<CropJourney> {
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  if (deps.config.RUNTIME_MODE !== 'live') throw new ApiError(409, 'mode_mismatch', 'Crop journeys are only stored in live mode');
  if (!UUID_RE.test(journeyId)) throw notFound('Crop journey');
  const row = (await deps.pool.query<JourneyRow>(`SELECT ${JOURNEY_COLS} FROM crop_journeys WHERE id=$1 AND owner_id=$2 AND farm_id=$3`, [journeyId, ownerId, farmId])).rows[0];
  if (!row) throw notFound('Crop journey');
  const current = await reconcileJourney(deps.pool, row);
  return toCropJourney(current, await assetsOf(deps.pool, current), false);
}
