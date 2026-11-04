/**
 * Worker job `today.crop-journey` (docs/research/EVARA_ACTIONS_SPEC.md 3.2, 2026-11-04): renders the illustrated stages of one
 * crop_journeys row in stage order, one Muse Image edit per stage, and updates the journey after each stage so the GET shows
 * progress. services/today/crop-journey.ts explains the request rules and caps.
 *
 * Per stage, the paid-call discipline of the future look (worker/handlers/future-look.ts, copied from visuals/job.ts):
 * reserve the worst case (two images: one retry on 429/503) -> committed `claimDispatch` marker (stage key `cj:<assetId>`) ->
 * renderFieldEdit (services/today/future-look.ts: outline, edit, the future look's QA, the inside-field composite) -> settle the
 * returned image at the price-table unit price, release when nothing was returned, mark uncertain when the outcome is unknown.
 * A marker left open by a crashed attempt is never re-dispatched: that stage fails `uncertain_needs_review` (billed) and the
 * others continue. When the claim itself loses to a marker another attempt holds, this attempt's reservation is released
 * (nothing was sent by it). A refused reservation leaves that stage and the later ones `unavailable` / `budget`.
 *
 * A failed stage (QA rejected, provider error) is `failed` with its reason and the next stage still renders. The image edit
 * endpoint returns no response id, so `response_deleted` stays NULL (nothing to delete on the provider).
 *
 * Registered in worker/handlers/index.ts (wrapped there by the generic model-activity wrapper; each paid call is recorded
 * with purpose `crop_journey`).
 */
import sharp from 'sharp';
import {z} from 'zod';
import type {FutureLookQa, FutureLookStatus} from '@harvest/contracts';
import type {Config} from '../../config';
import type {Pool} from '../../db/pool';
import type {Budget} from '../../services/budget';
import {ApiError} from '../../services/errors';
import {getMedia, readContent} from '../../services/media';
import type {StorageAdapter} from '../../storage/types';
import {displayBbox, type Sentinel2Fetch} from '../../providers/sentinel2';
import {sceneImage as defaultSceneImage, type NdviImageDeps, type SceneImage} from '../../services/today/ndvi';
import {futureLookField, futureLookStorageKey, renderFieldEdit, ringToImage, type FutureLookRow} from '../../services/today/future-look';
import {JOURNEY_COLS, MODEL_PROVIDER, journeyOutcome, journeyPrompt, type JourneyRow} from '../../services/today/crop-journey';
import {claimDispatch, finishDispatch, unresolvedDispatches} from '../../visuals/dispatch';
import {MuseImageError} from '../../visuals/muse-image';
import type {JobHandler} from '../main';

export const CROP_JOURNEY_PURPOSE = 'crop_journey';
export const UNCERTAIN_REASON = 'uncertain_needs_review';
/** Longest side of a field photo sent to the model (as the visual journey, visuals/job.ts MAX_SENT_SIDE). */
export const PHOTO_MAX_SIDE = 1024;
export const dispatchKey = (assetId: string) => `cj:${assetId}`;

export const cropJourneyPayload = z.object({journeyId: z.uuid(), farmId: z.uuid(), sessionId: z.uuid().nullable().optional()}).strict();

export interface CropJourneyHandlerDeps {
  config: Config;
  pool: Pool;
  storage: StorageAdapter;
  budget: Budget;
  /** Meta transport; tests inject a fake. */
  fetchImpl?: typeof fetch | undefined;
  /** Planetary Computer transport for rendering the source scene when it is not stored yet. */
  sentinelFetch?: Sentinel2Fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Test injection; defaults to services/today/ndvi.ts sceneImage. */
  sceneImage?: ((deps: NdviImageDeps, ownerId: string, farmId: string, itemId: string, kind: 'visual', zoom?: 'wide', fieldId?: string) => Promise<SceneImage>) | undefined;
  timeoutMs?: number | undefined;
}

export interface CropJourneyStageResult { assetId: string; stageId: string; status: FutureLookStatus; reason: string | null; qa: FutureLookQa | null }
export interface CropJourneyJobResult {
  journeyId: string;
  /** Final journey status, or `skipped` when this job no longer owns the journey. */
  status: JourneyRow['status'] | 'skipped';
  reason: string | null;
  providerCalls: number;
  stages: CropJourneyStageResult[];
  cost: {reservedUsd: number; settledUsd: number; images: number};
}

interface JobLike { id: string; owner_id: string | null; payload: unknown }
interface CtxLike { heartbeat: (progress?: number) => Promise<void>; isCancelled?: (() => Promise<boolean>) | undefined }

export function createCropJourneyHandler(deps: CropJourneyHandlerDeps): JobHandler {
  return (job, ctx) => runCropJourney(deps, job, ctx);
}

interface LoadedSource { image: Buffer; field: [number, number][] }

export async function runCropJourney(deps: CropJourneyHandlerDeps, job: JobLike, ctx: CtxLike): Promise<CropJourneyJobResult> {
  const {pool, config, storage, budget} = deps;
  const parsed = cropJourneyPayload.safeParse(job.payload);
  if (!parsed.success || !job.owner_id) throw Object.assign(new Error('invalid today.crop-journey payload'), {retryable: false});
  const {journeyId, farmId} = parsed.data;
  const sessionId = parsed.data.sessionId ?? null;
  const ownerId = job.owner_id;
  const model = config.META_IMAGE_MODEL;
  const cost = {reservedUsd: 0, settledUsd: 0, images: 0};
  let providerCalls = 0;

  const journey = (await pool.query<JourneyRow>(`SELECT ${JOURNEY_COLS} FROM crop_journeys WHERE id=$1 AND owner_id=$2 AND farm_id=$3`, [journeyId, ownerId, farmId])).rows[0];
  const skipped = (reason: string): CropJourneyJobResult => ({journeyId, status: 'skipped', reason, providerCalls: 0, stages: [], cost});
  if (!journey) return skipped('journey_missing');
  if (journey.job_id !== job.id || (journey.status !== 'queued' && journey.status !== 'running')) return skipped('superseded');

  // The illustrated stages in stage order, with this job's asset rows.
  const order = journey.stages.flatMap((s) => (s.illustrated && s.assetId ? [s.assetId] : []));
  const loadAssets = async () => {
    const rows = (await pool.query<FutureLookRow>('SELECT * FROM future_look_assets WHERE journey_id=$1 AND owner_id=$2 AND farm_id=$3 AND id = ANY($4::uuid[])', [journeyId, ownerId, farmId, order])).rows;
    return order.flatMap((id) => rows.filter((r) => r.id === id));
  };
  const qaOf = new Map<string, FutureLookQa | null>();

  /** Writes a stage outcome only while this job still owns the asset row. */
  const close = async (assetId: string, status: FutureLookStatus, f: {reason?: string | null; billed?: boolean; qa?: FutureLookQa | null; storageKey?: string | null; requestId?: string | null; withModel?: boolean} = {}) => {
    if (f.qa !== undefined) qaOf.set(assetId, f.qa);
    const u = await pool.query(
      `UPDATE future_look_assets SET status=$3, failure_reason=$4, billed = billed OR $5, qa=$6::jsonb, storage_key=$7, model=$8, provider_request_id=$9, response_deleted=NULL
       WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')`,
      [assetId, job.id, status, f.reason ?? null, f.billed ?? false, f.qa ? JSON.stringify(f.qa) : null, f.storageKey ?? null, f.withModel ? model : null, f.requestId ?? null]);
    return (u.rowCount ?? 0) > 0;
  };
  /** Progress: touch the journey (updated_at) while this job owns it. */
  const touch = async (done: number) => {
    await pool.query("UPDATE crop_journeys SET status='running' WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')", [journeyId, job.id]);
    await ctx.heartbeat(order.length ? Math.min(0.99, done / order.length) : 0.5).catch(() => undefined);
  };
  const closeRest = async (reason: string) => {
    for (const a of await loadAssets()) if (a.status === 'queued' || a.status === 'running') await close(a.id, 'unavailable', {reason});
  };
  const finish = async (): Promise<CropJourneyJobResult> => {
    const assets = await loadAssets();
    const o = journeyOutcome(assets.map((a) => ({status: a.status, reason: a.failure_reason})));
    const status = o.status === 'running' ? 'failed' : o.status;
    const reason = status === 'failed' || status === 'unavailable' ? (o.reason ?? 'failed') : null;
    await pool.query("UPDATE crop_journeys SET status=$3, reason=$4 WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')", [journeyId, job.id, status, reason]);
    await ctx.heartbeat(1).catch(() => undefined);
    return {
      journeyId, status, reason, providerCalls, cost: {...cost, reservedUsd: round6(cost.reservedUsd), settledUsd: round6(cost.settledUsd)},
      stages: assets.map((a) => ({assetId: a.id, stageId: a.stage_id, status: a.status, reason: a.failure_reason, qa: qaOf.get(a.id) ?? null})),
    };
  };

  // A marker without an outcome (or judged uncertain) means an earlier attempt may have sent that stage's paid call and lost
  // the result: that stage is never re-dispatched by this job.
  for (const d of await unresolvedDispatches(pool, job.id)) {
    if (d.outcome === null) {
      if (d.reservation_id) await budget.markUncertain(d.reservation_id).catch(() => undefined);
      await finishDispatch(pool, job.id, d.stage_key, 'uncertain');
    }
    const assetId = d.stage_key.startsWith('cj:') ? d.stage_key.slice(3) : null;
    if (assetId && order.includes(assetId)) await close(assetId, 'failed', {reason: UNCERTAIN_REASON, billed: true, withModel: true});
  }
  // A crash between reserve and claimDispatch leaves a reservation without a marker: nothing was sent, give it back.
  const stale = await pool.query<{id: string}>(
    "SELECT r.id FROM usage_reservations r WHERE r.job_id=$1 AND r.state='reserved' AND NOT EXISTS (SELECT 1 FROM job_dispatches d WHERE d.reservation_id=r.id)", [job.id]);
  for (const s of stale.rows) await budget.release(s.id).catch(() => undefined);
  await touch(0);

  // Gates: never a provider call outside live mode or without a credential.
  const apiKey = config.MODEL_API_KEY;
  if (config.RUNTIME_MODE !== 'live' || !apiKey) { await closeRest('runtime_mode'); return finish(); }

  // Source: the stored scene for the journey's field polygon, or the owner field photo it named (with the same confirmed region).
  let src: LoadedSource;
  try {
    const loaded = await loadSource(deps, ownerId, farmId, journey);
    if ('reason' in loaded) { await closeRest(loaded.reason); return finish(); }
    src = loaded;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    await closeRest(e.statusCode === 404 ? 'source_unavailable' : `source_${e.code}`.slice(0, 80));
    return finish();
  }

  const unitUsd = budget.estimate(MODEL_PROVIDER, model, {images: 1}).usd ?? 0;
  const reserveUsd = budget.estimate(MODEL_PROVIDER, model, {images: 2}).usd ?? 0;
  const source = journey.source_kind === 'photo' ? 'photo' : 'satellite';
  let done = 0;
  for (const asset of await loadAssets()) {
    if (asset.status !== 'queued' && asset.status !== 'running') { done++; continue; }
    if (ctx.isCancelled && (await ctx.isCancelled())) { await closeRest('cancelled'); break; }
    let reservationId: string;
    try {
      ({reservationId} = await budget.reserve({ownerId, sessionId, provider: MODEL_PROVIDER, model, estimate: reserveUsd, jobId: job.id, requestId: asset.id}));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'budget_exceeded') { await closeRest('budget'); break; }
      throw e;
    }
    cost.reservedUsd += reserveUsd;
    // Committed marker BEFORE the paid call; a lost outcome is then visible to any re-claim of this job.
    if (!(await claimDispatch(pool, job.id, dispatchKey(asset.id), reservationId))) {
      // Another attempt holds an open (or uncertain) marker for this stage: THIS attempt sent nothing, so its own reservation
      // is given back (review fix E7c-5). The stage still fails uncertain because the other attempt may have been billed.
      await budget.release(reservationId).catch(() => undefined);
      await close(asset.id, 'failed', {reason: UNCERTAIN_REASON, billed: true, withModel: true});
      done++; await touch(done);
      continue;
    }
    await pool.query("UPDATE future_look_assets SET status='running' WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')", [asset.id, job.id]);
    const prompt = journeyPrompt({source, stageId: asset.stage_id, stageName: asset.stage_name, cropName: asset.crop_name, guidance: asset.guidance});
    let billed = false, unknown = false, requestId: string | null = null;
    let outcome: 'completed' | 'failed' | 'uncertain' = 'uncertain';
    try {
      providerCalls++;
      const res = await renderFieldEdit({
        source: src.image, field: src.field, prompt,
        edit: {baseUrl: config.META_BASE_URL, apiKey, model, fetchImpl: deps.fetchImpl, sleep: deps.sleep, timeoutMs: deps.timeoutMs},
        activity: {pool, ownerId, sessionId, mode: config.RUNTIME_MODE, purpose: CROP_JOURNEY_PURPOSE},
      });
      billed = true; // an image came back: billable even if QA rejects it
      outcome = 'completed';
      requestId = res.requestId;
      if (res.status === 'failed') {
        await close(asset.id, 'failed', {reason: res.reason, billed: true, qa: res.qa, requestId, withModel: true});
      } else {
        const key = futureLookStorageKey(farmId, asset.id);
        await storage.put({ownerId, key}, res.png);
        if (!(await close(asset.id, 'ready', {billed: true, qa: res.qa, storageKey: key, requestId, withModel: true}))) await storage.delete({ownerId, key}).catch(() => undefined);
      }
    } catch (e) {
      if (e instanceof MuseImageError) {
        if (e.outcomeUnknown) unknown = true;
        else outcome = 'failed';
        requestId = e.opts.requestId ?? requestId;
        await close(asset.id, 'failed', {reason: `provider_${e.kind}`, billed: e.outcomeUnknown, requestId, withModel: true}).catch(() => undefined);
      } else {
        // renderFieldEdit returns (billed) once an image came back, so an error here happened before or without a provider result.
        if (!billed) outcome = 'failed';
        await close(asset.id, 'failed', {reason: 'internal_error', billed, requestId, withModel: true}).catch(() => undefined);
      }
    } finally {
      await finishDispatch(pool, job.id, dispatchKey(asset.id), unknown ? 'uncertain' : outcome, requestId).catch(() => undefined);
    }
    if (unknown) await budget.markUncertain(reservationId).catch(() => undefined);
    else if (!billed) await budget.release(reservationId).catch(() => undefined);
    else {
      await budget.settle(reservationId, unitUsd, requestId, {images: 1, reservedWorstCaseUsd: reserveUsd, model}, 'estimated');
      cost.settledUsd += unitUsd; cost.images++;
    }
    done++;
    await touch(done);
  }
  return finish();
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Source image and the field ring (or photo region) in its normalised coordinates; `{reason}` when it can no longer be used. */
async function loadSource(deps: CropJourneyHandlerDeps, ownerId: string, farmId: string, j: JourneyRow): Promise<LoadedSource | {reason: string}> {
  const {pool, config, storage} = deps;
  if (j.source_kind === 'satellite' && j.source_ref) {
    const fieldId = j.field_id ?? undefined;
    const field = await futureLookField(pool, ownerId, farmId, fieldId);
    if ('reason' in field) return {reason: 'field_unavailable'};
    const scene = await (deps.sceneImage ?? defaultSceneImage)({config, pool, storage, fetchImpl: deps.sentinelFetch}, ownerId, farmId, j.source_ref, 'visual', 'wide', fieldId);
    const expected = displayBbox(field.ring);
    if (scene.bbox.some((v, i) => Math.abs(v - expected[i]!) > 1e-9)) return {reason: 'field_mismatch'};
    return {image: scene.bytes, field: ringToImage(field.ring, scene.bbox)};
  }
  if (j.source_kind === 'photo' && j.source_ref && j.source_media_id) {
    // The photo must still be on the farm and its confirmed region unchanged since the request.
    const still = (await pool.query('SELECT 1 FROM field_photos WHERE id=$1 AND owner_id=$2 AND farm_id=$3 AND media_id=$4', [j.source_ref, ownerId, farmId, j.source_media_id])).rowCount;
    const media = await getMedia(pool, ownerId, j.source_media_id);
    if (!still || !media?.region || media.region.version !== j.source_region_version) return {reason: 'source_changed'};
    const content = await readContent(pool, storage, ownerId, j.source_media_id, 'normalized');
    // The normalised derivative already has EXIF orientation applied (media.ts processImage), the frame the region refers to.
    const image = await sharp(Buffer.from(content.data)).rotate().resize({width: PHOTO_MAX_SIDE, height: PHOTO_MAX_SIDE, fit: 'inside', withoutEnlargement: true}).png().toBuffer();
    return {image, field: media.region.polygon};
  }
  return {reason: 'no_source_image'};
}
