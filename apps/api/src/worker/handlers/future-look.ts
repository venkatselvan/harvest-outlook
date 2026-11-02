/**
 * Worker job `today.future-look`: one Muse Image edit of the latest usable observed Sentinel-2 scene for one
 * future_look_assets row (services/today/future-look.ts explains the request rules and the budget bound).
 *
 * Paid-call discipline copied from visuals/job.ts: estimate -> reserve (worst case two images: one retry on 429/503) ->
 * committed `claimDispatch` marker -> editImage (one retry on 429/503 inside the client) -> settle the returned image at
 * the price-table unit price, release when nothing was returned, mark uncertain when the outcome is unknown. A marker
 * left open by a crashed attempt is never re-dispatched: the reservation is held as uncertain and the row fails as
 * `uncertain_needs_review` (counted as billed).
 *
 * The edited image is accepted only if deterministic QA (`evaluateFutureLook`) finds the outside of the field unchanged
 * within the documented threshold. A rejected image is billed but not stored. An accepted image is stored as the real scene
 * with the model's pixels pasted strictly inside the cycle's field ring (compositeInsideField, 2026-11-03). The image edit endpoint returns no
 * response id, so `response_deleted` stays NULL (nothing to delete); provider-side retention of the input image is unknown.
 *
 * Prompt (2026-11-03): `buildFutureLookPrompt` with the row's `kind` and stored `guidance` (prompt version future-look-v2);
 * rows without guidance use the v1 template. Stage and gap looks share every other step, including the QA.
 *
 * Registered in worker/handlers/index.ts as `today.future-look` (wrapped there by the generic model-activity wrapper).
 * The registry wrapper's model-activity purpose is overridden here by `future_look`.
 */
import sharp from 'sharp';
import {getWorkspace} from '../../services/workspace';
import {z} from 'zod';
import type {Config} from '../../config';
import type {Pool} from '../../db/pool';
import type {Budget} from '../../services/budget';
import {ApiError} from '../../services/errors';
import {withModelActivity} from '../../services/model-activity';
import type {StorageAdapter} from '../../storage/types';
import {displayBbox, type Sentinel2Fetch} from '../../providers/sentinel2';
import {sceneImage as defaultSceneImage, type NdviImageDeps, type SceneImage} from '../../services/today/ndvi';
import type {FutureLookQa, FutureLookStatus} from '@harvest/contracts';
import {
  buildFutureLookPrompt, compositeInsideField, evaluateFutureLook, futureLookField, futureLookStorageKey, ringToImage,
  type FutureLookRow,
} from '../../services/today/future-look';
import {claimDispatch, finishDispatch, unresolvedDispatches} from '../../visuals/dispatch';
import {editImage, MuseImageError} from '../../visuals/muse-image';
import type {JobHandler} from '../main';

export const PROVIDER = 'meta';
export const FUTURE_LOOK_PURPOSE = 'future_look';
export const FUTURE_LOOK_DISPATCH_KEY = 'future-look';
export const UNCERTAIN_REASON = 'uncertain_needs_review';
/** Outline drawn on the image sent to the model (the prompt refers to "the field outlined in red"). */
export const OUTLINE_COLOUR = '#ff2a2a';

export const futureLookPayload = z.object({assetId: z.uuid(), farmId: z.uuid(), sessionId: z.uuid().nullable().optional()}).strict();

export interface FutureLookHandlerDeps {
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

export interface FutureLookJobResult {
  assetId: string;
  /** Final row status, or `skipped` when this job no longer owns the row. */
  status: FutureLookStatus | 'skipped';
  reason: string | null;
  providerCalls: number;
  qa: FutureLookQa | null;
  cost: {reservedUsd: number; settledUsd: number; images: number; outcome: 'settled' | 'released' | 'uncertain'} | null;
}

interface JobLike { id: string; owner_id: string | null; payload: unknown }
interface CtxLike { heartbeat: (progress?: number) => Promise<void>; isCancelled?: (() => Promise<boolean>) | undefined }

export function createFutureLookHandler(deps: FutureLookHandlerDeps): JobHandler {
  return (job, ctx) => runFutureLook(deps, job, ctx);
}

export async function runFutureLook(deps: FutureLookHandlerDeps, job: JobLike, ctx: CtxLike): Promise<FutureLookJobResult> {
  const {pool, config, storage, budget} = deps;
  const parsed = futureLookPayload.safeParse(job.payload);
  if (!parsed.success || !job.owner_id) throw Object.assign(new Error('invalid today.future-look payload'), {retryable: false});
  const {assetId, farmId} = parsed.data;
  const sessionId = parsed.data.sessionId ?? null;
  const ownerId = job.owner_id;
  const model = config.META_IMAGE_MODEL;
  const result = (status: FutureLookJobResult['status'], reason: string | null, extra: Partial<FutureLookJobResult> = {}): FutureLookJobResult =>
    ({assetId, status, reason, providerCalls: 0, qa: null, cost: null, ...extra});

  const row = (await pool.query<FutureLookRow>('SELECT * FROM future_look_assets WHERE id=$1 AND owner_id=$2 AND farm_id=$3', [assetId, ownerId, farmId])).rows[0];
  if (!row) return result('skipped', 'asset_missing');
  if (row.job_id !== job.id || (row.status !== 'queued' && row.status !== 'running')) return result('skipped', 'superseded');

  /** Writes the outcome only while this job still owns the row. */
  const close = async (status: FutureLookStatus, fields: {reason?: string | null; billed?: boolean; qa?: FutureLookQa | null; storageKey?: string | null; requestId?: string | null; withModel?: boolean} = {}) => {
    const u = await pool.query(
      `UPDATE future_look_assets SET status=$3, failure_reason=$4, billed = billed OR $5, qa=$6::jsonb, storage_key=$7, model=$8, provider_request_id=$9, response_deleted=NULL
       WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')`,
      [assetId, job.id, status, fields.reason ?? null, fields.billed ?? false, fields.qa ? JSON.stringify(fields.qa) : null, fields.storageKey ?? null, fields.withModel ? model : null, fields.requestId ?? null]);
    return (u.rowCount ?? 0) > 0;
  };

  // A marker without an outcome means an earlier attempt of this job may have sent the paid call and lost the result.
  const open = await unresolvedDispatches(pool, job.id);
  if (open.length) {
    for (const d of open) {
      if (d.outcome === null) {
        if (d.reservation_id) await budget.markUncertain(d.reservation_id).catch(() => undefined);
        await finishDispatch(pool, job.id, d.stage_key, 'uncertain');
      }
    }
    await close('failed', {reason: UNCERTAIN_REASON, billed: true, withModel: true});
    return result('failed', UNCERTAIN_REASON);
  }
  // A crash between reserve and claimDispatch leaves a reservation without a marker: nothing was sent, give it back.
  const stale = await pool.query<{id: string}>(
    "SELECT r.id FROM usage_reservations r WHERE r.job_id=$1 AND r.state='reserved' AND NOT EXISTS (SELECT 1 FROM job_dispatches d WHERE d.reservation_id=r.id)", [job.id]);
  for (const s of stale.rows) await budget.release(s.id).catch(() => undefined);
  await pool.query("UPDATE future_look_assets SET status='running' WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')", [assetId, job.id]);

  // Gates: never a provider call outside live mode or without a credential.
  if (config.RUNTIME_MODE !== 'live') { await close('unavailable', {reason: 'live_mode_required'}); return result('unavailable', 'live_mode_required'); }
  const apiKey = config.MODEL_API_KEY;
  if (!apiKey) { await close('unavailable', {reason: 'provider_unavailable'}); return result('unavailable', 'provider_unavailable'); }
  if (ctx.isCancelled && (await ctx.isCancelled())) { await close('unavailable', {reason: 'cancelled'}); return result('unavailable', 'cancelled'); }

  // Source scene: the stored observed visual PNG for the farm's current field polygon (rendered once if missing).
  let field: Awaited<ReturnType<typeof futureLookField>>;
  let scene: SceneImage;
  try {
    // Fields (2026-11-03): the cycle's own field polygon (ring, scene render and mask), as the request path chose it.
    const fieldId = (await getWorkspace(pool, ownerId, farmId)).cycles.find((c) => c.id === row.cycle_id)?.fieldId;
    field = await futureLookField(pool, ownerId, farmId, fieldId);
    if ('reason' in field) { await close('unavailable', {reason: 'field_unavailable'}); return result('unavailable', 'field_unavailable'); }
    scene = await (deps.sceneImage ?? defaultSceneImage)({config, pool, storage, fetchImpl: deps.sentinelFetch}, ownerId, farmId, row.source_item_id, 'visual', 'wide', fieldId);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const reason = e.statusCode === 404 ? 'scene_unavailable' : `scene_${e.code}`.slice(0, 80);
    await close('unavailable', {reason});
    return result('unavailable', reason);
  }
  const expected = displayBbox(field.ring);
  if (scene.bbox.some((v, i) => Math.abs(v - expected[i]!) > 1e-9)) { await close('failed', {reason: 'field_mismatch'}); return result('failed', 'field_mismatch'); }

  // Image sent to the model: the observed scene with the field outline drawn in red, JPEG (the live-verified encoding).
  const base = sharp(scene.bytes).flatten({background: '#000000'}).toColourspace('srgb');
  const meta = await sharp(scene.bytes).metadata();
  const W = meta.width ?? 512, H = meta.height ?? 512;
  const norm = ringToImage(field.ring, scene.bbox);
  const pts = norm.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' ');
  const stroke = Math.max(2, Math.round(W / 170));
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><polygon points="${pts}" fill="none" stroke="${OUTLINE_COLOUR}" stroke-width="${stroke}" stroke-linejoin="round"/></svg>`);
  const sent = await base.composite([{input: svg, top: 0, left: 0}]).jpeg({quality: 92}).toBuffer();
  const imageDataUrl = `data:image/jpeg;base64,${sent.toString('base64')}`;
  // Prompt v2 (2026-11-03): the row's stored code guidance (and kind) go into the prompt; a row without guidance (made
  // before v2) gets the v1 template, so queued v1 rows render exactly what was decided when they were requested.
  const prompt = buildFutureLookPrompt({stageId: row.stage_id, stageName: row.stage_name, cropName: row.crop_name, kind: row.kind, guidance: row.guidance, promptVersion: row.prompt_version});
  await ctx.heartbeat(0.2).catch(() => undefined);

  const unitUsd = budget.estimate(PROVIDER, model, {images: 1}).usd ?? 0;
  const reserveUsd = budget.estimate(PROVIDER, model, {images: 2}).usd ?? 0;
  let reservationId: string;
  try {
    ({reservationId} = await budget.reserve({ownerId, sessionId, provider: PROVIDER, model, estimate: reserveUsd, jobId: job.id, requestId: assetId}));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'budget_exceeded') { await close('unavailable', {reason: 'budget_exceeded'}); return result('unavailable', 'budget_exceeded'); }
    throw e;
  }
  // Committed marker BEFORE the paid call; a lost outcome is then visible to any re-claim of this job.
  if (!(await claimDispatch(pool, job.id, FUTURE_LOOK_DISPATCH_KEY, reservationId))) {
    await budget.markUncertain(reservationId).catch(() => undefined);
    await close('failed', {reason: UNCERTAIN_REASON, billed: true, withModel: true});
    return result('failed', UNCERTAIN_REASON, {cost: {reservedUsd: reserveUsd, settledUsd: 0, images: 0, outcome: 'uncertain'}});
  }

  let calls = 0, billed = 0, unknown = false;
  let dispatchOutcome: 'completed' | 'failed' | 'uncertain' = 'uncertain';
  let requestId: string | null = null;
  let qa: FutureLookQa | null = null;
  let final: {status: FutureLookStatus; reason: string | null} = {status: 'failed', reason: 'internal_error'};
  try {
    calls++;
    const res = await withModelActivity({pool, ownerId, sessionId, mode: config.RUNTIME_MODE, purpose: FUTURE_LOOK_PURPOSE}, () => editImage({
      baseUrl: config.META_BASE_URL, apiKey, model, prompt, imageDataUrl, size: `${W}x${H}`,
      ...(deps.fetchImpl ? {fetchImpl: deps.fetchImpl} : {}), ...(deps.sleep ? {sleep: deps.sleep} : {}), ...(deps.timeoutMs ? {timeoutMs: deps.timeoutMs} : {}),
    }));
    billed++; // an image came back: billable even if QA rejects it
    dispatchOutcome = 'completed';
    requestId = res.requestId;
    qa = await evaluateFutureLook({input: sent, output: res.png, field: norm});
    if (!qa.passed) {
      final = {status: 'failed', reason: `qa_${qa.reasons[0] ?? 'failed'}`.slice(0, 80)};
      await close('failed', {reason: final.reason, billed: true, qa, requestId, withModel: true});
    } else {
      // Stored at the observed scene's size so the illustration and the real scene line up in the view. 2026-11-03: only the
      // pixels strictly inside the cycle's field ring come from the model; the rest (and the outline band) is the clean real
      // scene, so a redrawn or resized outline (seen live on a narrow field) cannot change what is stored.
      const png = await compositeInsideField({scene: scene.bytes, output: res.png, field: norm, width: W, height: H, edgePx: Math.ceil(stroke / 2)});
      const key = futureLookStorageKey(farmId, assetId);
      await storage.put({ownerId, key}, png);
      if (await close('ready', {billed: true, qa, storageKey: key, requestId, withModel: true})) final = {status: 'ready', reason: null};
      else { await storage.delete({ownerId, key}).catch(() => undefined); final = {status: 'failed', reason: 'superseded'}; }
    }
  } catch (e) {
    if (e instanceof MuseImageError) {
      if (e.outcomeUnknown) unknown = true;
      else dispatchOutcome = 'failed';
      requestId = e.opts.requestId ?? requestId;
      final = {status: 'failed', reason: `provider_${e.kind}`};
      await close('failed', {reason: final.reason, billed: e.outcomeUnknown, requestId, withModel: true}).catch(() => undefined);
    } else {
      // A non-provider error after a returned image still counts as billed (billed > 0 settles below).
      final = {status: 'failed', reason: 'internal_error'};
      await close('failed', {reason: 'internal_error', billed: billed > 0, qa, requestId, withModel: true}).catch(() => undefined);
    }
  } finally {
    await finishDispatch(pool, job.id, FUTURE_LOOK_DISPATCH_KEY, unknown ? 'uncertain' : dispatchOutcome, requestId).catch(() => undefined);
  }

  const settledUsd = billed * unitUsd;
  let outcome: 'settled' | 'released' | 'uncertain';
  if (unknown) {
    await budget.markUncertain(reservationId).catch(() => undefined);
    outcome = 'uncertain';
  } else if (billed === 0) {
    await budget.release(reservationId).catch(() => undefined);
    outcome = 'released';
  } else {
    await budget.settle(reservationId, settledUsd, requestId, {images: billed, reservedWorstCaseUsd: reserveUsd, model}, 'estimated');
    outcome = 'settled';
  }
  await ctx.heartbeat(1).catch(() => undefined);
  return result(final.status, final.reason, {providerCalls: calls, qa, cost: {reservedUsd: reserveUsd, settledUsd, images: billed, outcome}});
}
