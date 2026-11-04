import { seasonMilestones } from '@harvest/contracts';
import type { Config } from '../../config';
import {withTransaction, type Pool} from '../../db/pool';
import { getFarm } from '../farms';
import { getWorkspace } from '../workspace';
import { payloadHash } from '../hash';
import { enqueue } from '../jobs';
import { notFound } from '../errors';
import { stageTimeline } from './stage-timeline';
import { futureLookField } from './future-look';
import { photoToday, type PhotoScope } from './field-photos';
import { autoPhotoCoverage, type AutoCoverageOptions } from './photo-coverage';
export const SEASON_PREDICTIONS_JOB = 'today.season-predictions';
export type SeasonPredictionDeps = {pool: Pool; config: Pick<Config, 'RUNTIME_MODE' | 'MODEL_API_KEY'>};

/** Reads only owner/field-scoped evidence. The hash changes for new images, crop dates, or recorded journal facts. */
export async function seasonEvidence(pool: Pool, s: PhotoScope) {
  const farm = await getFarm(pool, s.ownerId, s.farmId);
  if (!farm) throw notFound('Farm');
  const workspace = await getWorkspace(pool, s.ownerId, s.farmId);
  const cycle = workspace.cycles.find(c => c.id === s.cycleId);
  if (!cycle) throw notFound('Crop cycle');
  const photos = (await pool.query<{id:string; captured_on:string}>(
    'SELECT id, captured_on::text FROM field_photos WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 ORDER BY captured_on DESC, created_at DESC, id', [s.ownerId,s.farmId,s.cycleId])).rows;
  const journals = (await pool.query<{id:string; entry_date:string; activity:string|null; version:number}>(
    'SELECT id, entry_date::text, activity, version FROM journal_entries WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 ORDER BY entry_date, id', [s.ownerId,s.farmId,s.cycleId])).rows;
  const field = await futureLookField(pool, s.ownerId, s.farmId, cycle.fieldId);
  const satellite = 'reason' in field ? null : (await pool.query<{item_id:string; date:string}>(
    'SELECT item_id, acquired_at::date::text AS date FROM ndvi_scene_stats WHERE owner_id=$1 AND farm_id=$2 AND polygon_hash=$3 AND usable ORDER BY acquired_at DESC, item_id DESC LIMIT 1', [s.ownerId,s.farmId,field.hash])).rows[0] ?? null;
  const timeline = stageTimeline({cropId:cycle.cropId, productId:cycle.productId ?? null, establishmentMethod:cycle.establishmentMethod ?? null, anchorDate:cycle.establishmentDate ?? cycle.sowingDate, stateId:farm.location.stateCode, districtId:farm.location.districtId});
  const milestones = seasonMilestones(timeline, cycle.harvestDate);
  const revision = payloadHash({version:'season-v1', cycle, photos, satellite, journals, polygon: 'reason' in field ? null : field.hash});
  return {cycle, photos, satellite, journals, milestones, revision};
}

/** A durable, idempotent orchestration job. Provider calls remain in the normal budgeted image workers. */
export async function queueSeasonPredictions(deps: SeasonPredictionDeps, s: PhotoScope, sessionId: string | null = null) {
  if (deps.config.RUNTIME_MODE !== 'live' || !deps.config.MODEL_API_KEY) return null;
  const evidence = await seasonEvidence(deps.pool, s);
  if (!evidence.photos.length && !evidence.satellite) return null;
  // A daily retry lets distant milestones enter the 120-day horizon and budget-limited requests resume.
  const key = `season:${s.farmId}:${s.cycleId}:${evidence.revision}:${photoToday()}`;
  return withTransaction(deps.pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[key]);
    const existing = (await db.query<{id:string}>('SELECT id FROM jobs WHERE owner_id=$1 AND idempotency_key=$2', [s.ownerId,key])).rows[0];
    if (existing) return existing.id;
    const {job} = await enqueue(db, SEASON_PREDICTIONS_JOB, {farmId:s.farmId, cycleId:s.cycleId, revision:evidence.revision, sessionId}, s.ownerId, key);
    return job.id;
  });
}

/** Link a dated journal observation only to an explicit or unambiguous crop cycle. Originals remain in the journal. */
export async function linkJournalPhotos(pool: Pool, ownerId: string, entryId: string, coverage?: AutoCoverageOptions) {
  const entry = (await pool.query<{farm_id:string; cycle_id:string|null; entry_date:string; media_ids:string[]}>(
    'SELECT farm_id, cycle_id, entry_date::text, media_ids FROM journal_entries WHERE id=$1 AND owner_id=$2', [entryId,ownerId])).rows[0];
  if (!entry?.cycle_id) return null;
  const workspace = await getWorkspace(pool, ownerId, entry.farm_id);
  const cycle = workspace.cycles.find(c => c.id === entry.cycle_id);
  if (!cycle) return null;
  for (const mediaId of entry.media_ids) await pool.query(
    `INSERT INTO field_photos(owner_id,farm_id,cycle_id,field_id,media_id,captured_on,journal_entry_id)
     SELECT $1,$2,$3,$4,id,$6::date,$7 FROM media_objects WHERE id=$5 AND owner_id=$1 AND (farm_id=$2 OR farm_id IS NULL)
     ON CONFLICT (farm_id,cycle_id,media_id) DO NOTHING`, [ownerId,entry.farm_id,cycle.id,cycle.fieldId ?? null,mediaId,entry.entry_date,entryId]);
  const scope = {ownerId, farmId:entry.farm_id, cycleId:cycle.id};
  // PHOTO_COVERAGE_SPEC.md: measure the observation photos linked to this entry (automatic, never fails the link).
  if (coverage) {
    const linked = await pool.query<{id:string}>('SELECT id FROM field_photos WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3 AND journal_entry_id=$4', [ownerId,entry.farm_id,cycle.id,entryId]);
    await autoPhotoCoverage(pool, scope, linked.rows.map(r => r.id), coverage);
  }
  return scope;
}
