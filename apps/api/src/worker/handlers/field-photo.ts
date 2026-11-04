import { checkPhotoProgress } from "../../services/today/field-photo-qa";
import sharp from 'sharp';
import { z } from 'zod';
import type { WorkerDeps } from './index';
import type { JobHandler } from '../main';
import { ApiError } from '../../services/errors';
import { readContent } from '../../services/media';
import { photoCycle, PREDICTION_COLS, type PhotoPredictionRow } from '../../services/today/field-photos';
import { claimDispatch, finishDispatch } from '../../visuals/dispatch';
import { editImage, MuseImageError } from '../../visuals/muse-image';

const payloadSchema = z.object({assetId: z.uuid(), farmId: z.uuid(), cycleId: z.string(), sessionId: z.uuid().nullable()});
export function createFieldPhotoHandler(deps: WorkerDeps): JobHandler {
  return async (job, ctx) => {
    const {pool, storage, config, budget} = deps;
    const payload = payloadSchema.parse(job.payload);
    if (!job.owner_id) throw Object.assign(new Error('Photo prediction requires an owner'), {retryable: false});
    const ownerId = job.owner_id;
    const row = (await pool.query<PhotoPredictionRow>(`SELECT ${PREDICTION_COLS} FROM field_photo_predictions WHERE id=$1 AND owner_id=$2 AND farm_id=$3 AND cycle_id=$4`, [payload.assetId, ownerId, payload.farmId, payload.cycleId])).rows[0];
    if (!row || row.job_id !== job.id || !['queued', 'running'].includes(row.status)) return {status: 'skipped'};
    const close = async (status: string, reason: string | null, key: string | null = null) => {
      const result = await pool.query("UPDATE field_photo_predictions SET status=$3, failure_reason=$4, storage_key=$5 WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')", [row.id, job.id, status, reason, key]);
      return !!result.rowCount;
    };
    // Never re-dispatch a job after a provider call may have happened, even if its process died after storing the result.
    const markers = await pool.query<{reservation_id: string | null; outcome: string | null}>('SELECT reservation_id, outcome FROM job_dispatches WHERE job_id=$1', [job.id]);
    if (markers.rowCount) {
      for (const m of markers.rows) if (m.reservation_id && (!m.outcome || m.outcome === 'uncertain')) await budget.markUncertain(m.reservation_id);
      await close('failed', 'interrupted_needs_review');
      return {status: 'failed'};
    }
    const stale = await pool.query<{id: string}>("SELECT id FROM usage_reservations WHERE job_id=$1 AND state='reserved'", [job.id]);
    for (const r of stale.rows) await budget.release(r.id);
    if (config.RUNTIME_MODE !== 'live' || !config.MODEL_API_KEY) { await close('unavailable', 'provider_unavailable'); return {status: 'unavailable'}; }
    if (await ctx.isCancelled?.()) { await close('unavailable', 'cancelled'); return {status: 'unavailable'}; }
    let media: Awaited<ReturnType<typeof readContent>>;
    try {
      await photoCycle(pool, {ownerId, farmId: row.farm_id, cycleId: row.cycle_id});
      const photo = (await pool.query<{media_id: string}>('SELECT media_id FROM field_photos WHERE id=$1 AND owner_id=$2 AND captured_on=$3', [row.photo_id, ownerId, row.source_date])).rows[0];
      if (!photo) { await close('unavailable', 'photo_changed'); return {status: 'unavailable'}; }
      media = await readContent(pool, storage, ownerId, photo.media_id, 'normalized');
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      await close('unavailable', 'photo_unavailable'); return {status: 'unavailable'};
    }
    const meta = await sharp(media.data).metadata();
    const unit = budget.estimate('meta', config.META_IMAGE_MODEL, {images: 1}).usd ?? 0;
    const estimate = budget.estimate('meta', config.META_IMAGE_MODEL, {images: 2}).usd ?? 0;
    let reservationId: string;
    try { ({reservationId} = await budget.reserve({ownerId, sessionId: payload.sessionId, provider: 'meta', model: config.META_IMAGE_MODEL, estimate, jobId: job.id, requestId: row.id})); }
    catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'budget_exceeded') throw e;
      await close('unavailable', 'budget_exceeded'); return {status: 'unavailable'};
    }
    if (!await claimDispatch(pool, job.id, 'field-photo', reservationId)) {
      await budget.markUncertain(reservationId); await close('failed', 'interrupted_needs_review'); return {status: 'failed'};
    }
    let billed = false, uncertain = true, requestId: string | null = null;
    let key: string | null = null, reason: string | null = null;
    try {
      await pool.query("UPDATE field_photo_predictions SET status='running' WHERE id=$1", [row.id]);
      await ctx.heartbeat(0.2);
      const result = await editImage({baseUrl: config.META_BASE_URL, apiKey: config.MODEL_API_KEY, model: config.META_IMAGE_MODEL,
        prompt: row.prompt, imageDataUrl: `data:image/jpeg;base64,${Buffer.from(media.data).toString('base64')}`, size: `${meta.width}x${meta.height}`,
        ...(deps.fetchImpl ? {fetchImpl: deps.fetchImpl} : {})});
      billed = true; uncertain = false; requestId = result.requestId;
      const qa = await checkPhotoProgress(media.data, result.png, row.guidance);
      if (!qa.passed) reason = qa.reason;
      // Decode and normalize provider output, bounding pixels and stripping metadata before serving it.
      const png = await sharp(result.png, {limitInputPixels: 64_000_000}).resize({width: meta.width!, height: meta.height!, fit: 'fill'}).png().toBuffer();
      key = `field-photos/${row.farm_id}/${row.id}.png`;
      if (!reason) await storage.put({ownerId, key}, png);
      else key = null;
    } catch (e) {
      if (e instanceof MuseImageError) { uncertain = e.outcomeUnknown; requestId = e.opts.requestId ?? null; reason = `provider_${e.kind}`; }
      else reason = 'generation_failed';
    }
    // Settle before publishing ready; a crash must never silently forget a potentially billable call.
    if (billed) await budget.settle(reservationId, unit, requestId, {images: 1}, 'estimated');
    else if (uncertain) await budget.markUncertain(reservationId);
    else await budget.release(reservationId);
    await finishDispatch(pool, job.id, 'field-photo', uncertain ? 'uncertain' : billed ? 'completed' : 'failed', requestId);
    const stillCurrent = (await pool.query('SELECT id FROM field_photos WHERE id=$1 AND captured_on=$2', [row.photo_id, row.source_date])).rowCount;
    if (!stillCurrent) reason = 'photo_changed';
    const ready = !!key && !reason;
    const saved = await close(ready ? 'ready' : 'failed', reason, ready ? key : null);
    if (key && (!saved || !ready)) await storage.delete({ownerId, key});
    await ctx.heartbeat(1);
    return {status: ready && saved ? 'ready' : 'failed', reason};
  };
}
