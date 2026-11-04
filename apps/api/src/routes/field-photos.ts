import { queueSeasonPredictions, seasonEvidence } from '../services/today/season-predictions';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { FieldPhotoCoverage, FieldPhotoGallery, FieldPhotoPrediction, SaveFieldPhotos } from '@harvest/contracts';
import type { Config } from '../config';
import { withTransaction, type Pool } from '../db/pool';
import type { StorageAdapter } from '../storage/types';
import { envelope } from '../envelope';
import { privateRouteGuard } from '../security/guards';
import { requireAuth } from '../security/session';
import { notFound } from '../services/errors';
import { photoCycle, photoGallery, requestPhotoPrediction, saveFieldPhotos, type PhotoScope } from '../services/today/field-photos';
import { requestPhotoCoverage } from '../services/today/photo-coverage';
import { envelopeSchema } from './schemas/common';

export async function fieldPhotoRoutes(app: FastifyInstance, deps: {config: Config; pool: Pool; storage: StorageAdapter}) {
  const {config, pool, storage} = deps;
  app.addHook('onRequest', privateRouteGuard(config, pool));
  const r = app.withTypeProvider<ZodTypeProvider>();
  const path = '/api/v1/farms/:id/cycles/:cycleId/field-photos';
  const params = z.object({id: z.uuid(), cycleId: z.string().min(1).max(120)});
  const scope = (ownerId: string, p: z.infer<typeof params>): PhotoScope => ({ownerId, farmId: p.id, cycleId: p.cycleId});
  r.get(path, {schema: {params, response: {200: envelopeSchema(FieldPhotoGallery)}}}, async req => envelope(req.id, config.RUNTIME_MODE, await photoGallery(pool, scope(requireAuth(req).ownerId, req.params))));
  r.post(path, {schema: {params, body: SaveFieldPhotos, response: {200: envelopeSchema(FieldPhotoGallery)}}}, async req => {
    const auth = requireAuth(req), s = scope(auth.ownerId, req.params);
    const gallery = await saveFieldPhotos(pool, s, req.body, {config, sessionId: auth.sessionId, onError: error => req.log.warn({error}, 'Photo coverage request deferred')});
    await queueSeasonPredictions(deps, s, auth.sessionId).catch(error => req.log.warn({error}, 'Milestone scheduling deferred'));
    return envelope(req.id, config.RUNTIME_MODE, gallery);
  });
  r.get('/api/v1/farms/:id/cycles/:cycleId/season-predictions', {schema:{params}}, async req => {
    const s = scope(requireAuth(req).ownerId, req.params);
    await photoCycle(pool,s);
    const row = (await pool.query<{state:string; result:{results?:{id?:string;kind:string;status:string;reason?:string|undefined}[]}|null}>("SELECT state,result FROM jobs WHERE owner_id=$1 AND payload->>'farmId'=$2 AND payload->>'cycleId'=$3 AND type='today.season-predictions' ORDER BY created_at DESC LIMIT 1", [s.ownerId,s.farmId,s.cycleId])).rows[0];
    const pending = (await pool.query<{n:number}>(`SELECT count(*)::int AS n FROM jobs j JOIN (
      SELECT job_id FROM field_photo_predictions WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3
      UNION ALL SELECT job_id FROM future_look_assets WHERE owner_id=$1 AND farm_id=$2 AND cycle_id=$3
    ) a ON a.job_id=j.id WHERE j.state IN ('queued','running')`, [s.ownerId,s.farmId,s.cycleId])).rows[0]!.n;
    if (row?.result?.results) {
      const ids = row.result.results.flatMap(r => r.id && /^[0-9a-f-]{36}$/i.test(r.id) ? [r.id] : []);
      if (ids.length) {
        const states = (await pool.query<{id:string;status:string;failure_reason:string|null}>(`SELECT id,status,failure_reason FROM field_photo_predictions WHERE owner_id=$1 AND id=ANY($2::uuid[])
          UNION ALL SELECT id,status,failure_reason FROM future_look_assets WHERE owner_id=$1 AND id=ANY($2::uuid[])`,[s.ownerId,ids])).rows;
        row.result.results = row.result.results.map(r => {const state=states.find(a=>a.id===r.id); return state ? {...r,status:state.status,reason:state.failure_reason ?? undefined} : r;});
      }
    }
    return envelope(req.id,config.RUNTIME_MODE,{state:row?.state ?? 'idle',result:row?.result ?? null,pending});
  });
  r.delete(`${path}/:photoId`, {schema: {params: params.extend({photoId: z.uuid()}), response: {200: envelopeSchema(FieldPhotoGallery)}}}, async req => {
    const s = scope(requireAuth(req).ownerId, req.params);
    const keys = await withTransaction(pool, async db => {
      await photoCycle(db, s, true);
      const keys = await db.query<{storage_key: string}>('SELECT storage_key FROM field_photo_predictions WHERE photo_id=$1 AND owner_id=$2 AND farm_id=$3 AND cycle_id=$4 AND storage_key IS NOT NULL', [req.params.photoId, s.ownerId, s.farmId, s.cycleId]);
      const deleted = await db.query('DELETE FROM field_photos WHERE id=$1 AND owner_id=$2 AND farm_id=$3 AND cycle_id=$4', [req.params.photoId, s.ownerId, s.farmId, s.cycleId]);
      if (!deleted.rowCount) throw notFound('Field photo');
      return keys.rows;
    });
    for (const row of keys) await storage.delete({ownerId: s.ownerId, key: row.storage_key}).catch(error => req.log.warn({error}, 'Could not remove field photo prediction object'));
    return envelope(req.id, config.RUNTIME_MODE, await photoGallery(pool, s));
  });
  r.post(`${path}/:photoId/predict`, {config: {rateLimit: {max: 6, timeWindow: '1 minute'}}, schema: {params: params.extend({photoId: z.uuid()}), body: z.object({targetDate: z.iso.date()}).strict(), response: {202: envelopeSchema(FieldPhotoPrediction)}}}, async (req, reply) => {
    const {ownerId, sessionId} = requireAuth(req);
    return reply.code(202).send(envelope(req.id, config.RUNTIME_MODE, await requestPhotoPrediction({...deps, revision:(await seasonEvidence(pool,scope(ownerId,req.params))).revision}, scope(ownerId, req.params), req.params.photoId, req.body.targetDate, sessionId)));
  });
  // PHOTO_COVERAGE_SPEC.md: explicit request or retry of the crop / weed-like / standing-water measurement for one photo.
  r.post(`${path}/:photoId/coverage`, {config: {rateLimit: {max: 6, timeWindow: '1 minute'}}, schema: {params: params.extend({photoId: z.uuid()}), response: {202: envelopeSchema(FieldPhotoCoverage)}}}, async (req, reply) => {
    const {ownerId, sessionId} = requireAuth(req);
    return reply.code(202).send(envelope(req.id, config.RUNTIME_MODE, await requestPhotoCoverage({pool, config}, scope(ownerId, req.params), req.params.photoId, sessionId)));
  });
  r.get(`${path}/predictions/:assetId/image`, {schema: {params: params.extend({assetId: z.uuid()})}}, async (req, reply) => {
    const s = scope(requireAuth(req).ownerId, req.params);
    await photoCycle(pool, s);
    const row = (await pool.query<{storage_key: string}>(`SELECT p.storage_key FROM field_photo_predictions p JOIN field_photos f ON f.id=p.photo_id WHERE p.id=$1 AND p.owner_id=$2 AND p.farm_id=$3 AND p.cycle_id=$4 AND p.status='ready'`, [req.params.assetId, s.ownerId, s.farmId, s.cycleId])).rows[0];
    if (!row) throw notFound('Prediction');
    const bytes = await storage.get({ownerId: s.ownerId, key: row.storage_key});
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').type('image/png').send(bytes);
  });
}
