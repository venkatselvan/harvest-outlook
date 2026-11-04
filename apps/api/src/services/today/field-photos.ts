import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { FIELD_PHOTO_PROMPT_VERSION, FIELD_PHOTO_LIMIT, canRetryFieldPhotoPrediction, type FieldPhotoGuidance, type FieldPhotoGallery, type FieldPhotoPrediction, type SaveFieldPhotos } from '@harvest/contracts';
import type { Config } from '../../config';
import { withTransaction, type Pool } from '../../db/pool';
import { ApiError, notFound } from '../errors';
import { getWorkspace } from '../workspace';
import { getMedia } from '../media';
import { enqueue } from '../jobs';
import { loadPhotoGuidance } from './field-photo-guidance';
import { autoPhotoCoverage, coverageFor, type AutoCoverageOptions } from './photo-coverage';

export const FIELD_PHOTO_JOB = 'today.field-photo';
export const photoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export interface PhotoScope { ownerId: string; farmId: string; cycleId: string }
export const photoPath = (farmId: string, cycleId: string) => `/api/v1/farms/${farmId}/cycles/${encodeURIComponent(cycleId)}/field-photos`;
export interface PhotoRow { id: string; media_id: string; captured_on: string; created_at: Date; journal_entry_id: string | null }
export interface PhotoPredictionRow {
  id: string; owner_id: string; farm_id: string; cycle_id: string; photo_id: string;
  source_date: string; target_date: string; status: FieldPhotoPrediction['status'];
  storage_key: string | null; failure_reason: string | null; job_id: string | null; prompt: string; prompt_version: string; guidance: FieldPhotoGuidance | null; evidence_revision: string; created_at: Date;
}
// Cast dates in SQL to preserve their calendar day independently of the database client's timezone.
export const PHOTO_COLS = 'id, media_id, captured_on::text, created_at, journal_entry_id';
export const PREDICTION_COLS = 'id, owner_id, farm_id, cycle_id, photo_id, source_date::text, target_date::text, status, storage_key, failure_reason, job_id, prompt, prompt_version, guidance, evidence_revision, created_at';
export async function photoCycle(db: Pool | PoolClient, s: PhotoScope, lock = false) {
  if (lock) {
    const found = await db.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE', [s.farmId, s.ownerId]);
    if (!found.rowCount) throw notFound('Farm');
  }
  const workspace = await getWorkspace(db, s.ownerId, s.farmId);
  const cycle = workspace.cycles.find(c => c.id === s.cycleId);
  if (!cycle || (cycle.fieldId && !workspace.fields.some(f => f.id === cycle.fieldId))) throw notFound('Crop cycle');
  return cycle;
}
export function predictionOut(r: PhotoPredictionRow): FieldPhotoPrediction {
  return { id: r.id, photoId: r.photo_id, sourceDate: r.source_date, targetDate: r.target_date, status: r.status,
    failureReason: r.failure_reason, createdAt: r.created_at.toISOString(), evidenceRevision: r.evidence_revision, promptVersion: r.prompt_version, outdated: r.prompt_version !== FIELD_PHOTO_PROMPT_VERSION, guidance: r.guidance, imagePath: r.status === 'ready' ? `${photoPath(r.farm_id, r.cycle_id)}/predictions/${r.id}/image` : null };
}
export async function photoGallery(pool: Pool, s: PhotoScope): Promise<FieldPhotoGallery> {
  await photoCycle(pool, s);
  const photos = await pool.query<PhotoRow>(`SELECT ${PHOTO_COLS} FROM field_photos WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 ORDER BY captured_on, created_at`, [s.ownerId, s.farmId, s.cycleId]);
  const predictions = await pool.query<PhotoPredictionRow>(`SELECT ${PREDICTION_COLS} FROM field_photo_predictions p WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 ORDER BY created_at`, [s.ownerId, s.farmId, s.cycleId]);
  const coverage = await coverageFor(pool, s.ownerId, photos.rows.map(r => r.id));
  const output = (r: PhotoRow) => ({ id: r.id, mediaId: r.media_id, capturedOn: r.captured_on, createdAt: r.created_at.toISOString(), imagePath: `/api/v1/media/${r.media_id}/content?variant=normalized`, journalEntryId: r.journal_entry_id, coverage: coverage.get(r.id) ?? null });
  return {photos: photos.rows.filter(r => !r.journal_entry_id).map(output), observations: photos.rows.filter(r => r.journal_entry_id).map(output), predictions: predictions.rows.map(predictionOut)};
}
export function validatePhotoDate(date: string) {
  if (date > photoToday()) throw new ApiError(400, 'validation_error', 'The photo date cannot be in the future.');
}
/** `coverage` (PHOTO_COVERAGE_SPEC.md): when given, each saved photo is measured automatically (never fails the save). */
export async function saveFieldPhotos(pool: Pool, s: PhotoScope, body: SaveFieldPhotos, coverage?: AutoCoverageOptions) {
  await withTransaction(pool, async db => {
    const cycle = await photoCycle(db, s, true);
    const existing = await db.query<{media_id: string}>('SELECT media_id FROM field_photos WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND journal_entry_id IS NULL', [s.ownerId, s.farmId, s.cycleId]);
    if (new Set([...existing.rows.map(r => r.media_id), ...body.photos.map(p => p.mediaId)]).size > FIELD_PHOTO_LIMIT)
      throw new ApiError(409, 'photo_limit', 'You can save up to 6 photos for this field and crop. Remove a photo before adding another.');
    for (const p of body.photos) {
      validatePhotoDate(p.capturedOn);
      const media = await getMedia(db, s.ownerId, p.mediaId);
      if (!media || media.farmId !== s.farmId) throw notFound('Field photo');
      await db.query(`INSERT INTO field_photos (owner_id, farm_id, cycle_id, field_id, media_id, captured_on) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (farm_id, cycle_id, media_id) DO UPDATE SET captured_on=EXCLUDED.captured_on`, [s.ownerId, s.farmId, s.cycleId, cycle.fieldId ?? null, p.mediaId, p.capturedOn]);
    }
  });
  if (coverage) {
    const saved = await pool.query<{id: string}>('SELECT id FROM field_photos WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND media_id=ANY($4::uuid[])', [s.ownerId, s.farmId, s.cycleId, body.photos.map(p => p.mediaId)]);
    await autoPhotoCoverage(pool, s, saved.rows.map(r => r.id), coverage);
  }
  return photoGallery(pool, s);
}
export async function requestPhotoPrediction(deps: {pool: Pool; config: Config; guidance?: typeof loadPhotoGuidance; revision?: string; auto?: boolean}, s: PhotoScope, photoId: string, targetDate: string, sessionId: string | null) {
  // Build the immutable evidence snapshot before taking a farm write lock: it reads several datasets on the pool.
  const beforeCycle = await photoCycle(deps.pool, s);
  const beforePhoto = (await deps.pool.query<PhotoRow>(`SELECT ${PHOTO_COLS} FROM field_photos WHERE id=$1 AND owner_id=$2 AND farm_id=$3 AND cycle_id=$4`, [photoId, s.ownerId, s.farmId, s.cycleId])).rows[0];
  if (!beforePhoto) throw notFound('Field photo');
  if (targetDate <= beforePhoto.captured_on) throw new ApiError(400, 'validation_error', 'Choose a prediction date after the photo date.');
  const maxTarget = new Date(`${photoToday()}T00:00:00Z`); maxTarget.setUTCDate(maxTarget.getUTCDate() + 120);
  if (targetDate > maxTarget.toISOString().slice(0, 10)) throw new ApiError(400, 'validation_error', 'Choose a date within 120 days of today.');
  const cached = (await deps.pool.query<PhotoPredictionRow>(`SELECT ${PREDICTION_COLS} FROM field_photo_predictions WHERE photo_id=$1 AND source_date=$2 AND target_date=$3 AND prompt_version=$4 AND evidence_revision=$5`, [photoId, beforePhoto.captured_on, targetDate, FIELD_PHOTO_PROMPT_VERSION, deps.revision ?? ''])).rows[0];
  if (cached && (deps.auto || !(['failed', 'unavailable'].includes(cached.status) && canRetryFieldPhotoPrediction(cached.failure_reason)))) return predictionOut(cached);
  if (deps.config.RUNTIME_MODE !== 'live' || !deps.config.MODEL_API_KEY) throw new ApiError(409, 'provider_unavailable', 'AI photo predictions are available when the live image service is configured.');
  const prepared = await (deps.guidance ?? loadPhotoGuidance)(deps.pool, {...s, cycle: beforeCycle, sourceDate: beforePhoto.captured_on, targetDate});
  return withTransaction(deps.pool, async db => {
    const cycle = await photoCycle(db, s, true);
    const source = (await db.query<PhotoRow>(`SELECT ${PHOTO_COLS} FROM field_photos WHERE id=$1 AND owner_id=$2 AND farm_id=$3 AND cycle_id=$4`, [photoId, s.ownerId, s.farmId, s.cycleId])).rows[0];
    if (!source) throw notFound('Field photo');
    if (source.captured_on !== beforePhoto.captured_on || JSON.stringify(cycle) !== JSON.stringify(beforeCycle)) throw new ApiError(409, 'photo_changed', 'The photo or crop dates changed. Refresh before predicting.');
    if (targetDate <= source.captured_on) throw new ApiError(400, 'validation_error', 'Choose a prediction date after the photo date.');
    const max = new Date(`${photoToday()}T00:00:00Z`); max.setUTCDate(max.getUTCDate() + 120);
    if (targetDate > max.toISOString().slice(0, 10)) throw new ApiError(400, 'validation_error', 'Choose a date within 120 days of today.');
    const existing = (await db.query<PhotoPredictionRow>(`SELECT ${PREDICTION_COLS} FROM field_photo_predictions WHERE photo_id=$1 AND source_date=$2 AND target_date=$3 AND prompt_version=$4 AND evidence_revision=$5`, [photoId, source.captured_on, targetDate, FIELD_PHOTO_PROMPT_VERSION, deps.revision ?? ''])).rows[0];
    const retry = !deps.auto && existing && ['failed', 'unavailable'].includes(existing.status) && canRetryFieldPhotoPrediction(existing.failure_reason);
    if (existing && !retry) return predictionOut(existing);
    if (deps.config.RUNTIME_MODE !== 'live' || !deps.config.MODEL_API_KEY) throw new ApiError(409, 'provider_unavailable', 'AI photo predictions are available when the live image service is configured.');
    const count = await db.query<{n: number}>("SELECT count(*)::int AS n FROM jobs WHERE owner_id=$1 AND payload->>'farmId'=$2 AND payload->>'cycleId'=$3 AND type='today.field-photo' AND created_at > now() - interval '1 day'", [s.ownerId, s.farmId, s.cycleId]);
    if (count.rows[0]!.n >= 10) throw new ApiError(409, 'prediction_limit', 'This crop has used its 10 AI photo predictions for today.');
    const {prompt, guidance} = prepared;
    const id = existing?.id ?? randomUUID();
    const {job} = await enqueue(db, FIELD_PHOTO_JOB, {assetId: id, farmId: s.farmId, cycleId: s.cycleId, sessionId}, s.ownerId);
    if (retry) {
      const row = (await db.query<PhotoPredictionRow>(`UPDATE field_photo_predictions SET status='queued', failure_reason=NULL, job_id=$2, prompt=$3, guidance=$4::jsonb WHERE id=$1 RETURNING ${PREDICTION_COLS}`, [id, job.id, prompt, JSON.stringify(guidance)])).rows[0]!;
      return predictionOut(row);
    }
    const row = (await db.query<PhotoPredictionRow>(`INSERT INTO field_photo_predictions (id,owner_id,farm_id,cycle_id,photo_id,source_date,target_date,job_id,prompt,prompt_version,guidance,evidence_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING ${PREDICTION_COLS}`, [id,s.ownerId,s.farmId,s.cycleId,photoId,source.captured_on,targetDate,job.id,prompt,FIELD_PHOTO_PROMPT_VERSION,JSON.stringify(guidance),deps.revision ?? ''])).rows[0]!;
    return predictionOut(row);
  });
}
