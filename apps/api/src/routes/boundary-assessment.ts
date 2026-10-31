import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {BoundaryAssessment,BoundaryAssessmentInput,GeographicBoundary} from '@harvest/contracts';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema,uuidParam} from './schemas/common';
import {assessBoundary,type BoundaryAssessmentDeps} from '../services/boundary-assessment';
import {parseIdempotencyKey,runIdempotent} from '../services/idempotency';
import {boundaryMetrics} from '../services/workspace';
import {locateIndia} from '../providers/geoboundaries';
import {demoFarm} from '../services/demo-farm';
import {ApiError,notFound} from '../services/errors';
export async function boundaryAssessmentRoutes(app:FastifyInstance,deps:BoundaryAssessmentDeps){
 const{config,pool}=deps;app.addHook('onRequest',privateRouteGuard(config,pool));const r=app.withTypeProvider<ZodTypeProvider>();
 r.post('/api/v1/boundary-context',{schema:{tags:['farms'],body:z.object({boundary:GeographicBoundary}).strict(),response:{200:envelopeSchema(z.unknown())}}},async req=>{
  const metrics=boundaryMetrics(req.body.boundary);if(metrics.areaHectares>5000)throw new ApiError(400,'validation_error','Field assessment supports boundaries up to 5000 hectares');
  const centroid={lat:metrics.lat,lon:metrics.lon};const located=config.RUNTIME_MODE==='live'?await locateIndia(pool,centroid,deps.fetchImpl):{location:{status:'unavailable',stateId:null,stateName:null,districtId:null,districtName:null,countryCode:null,source:null,uncertainties:['Live administrative context is unavailable in this mode.']},sources:[]};
  return envelope(req.id,config.RUNTIME_MODE,{...located,areaHectares:metrics.areaHectares,centroid,suggestedName:located.location.districtName?`${located.location.districtName} field`:'My field'});
 });
 r.post('/api/v1/boundary-assessments',{config:{rateLimit:{max:6,timeWindow:'1 minute'}},schema:{tags:['farms'],body:BoundaryAssessmentInput,response:{200:envelopeSchema(BoundaryAssessment)}}},async(req,reply)=>{
  const auth=requireAuth(req);const out=await runIdempotent(pool,{ownerId:auth.ownerId,key:parseIdempotencyKey(req.headers['idempotency-key']),route:'POST /api/v1/boundary-assessments',hashInput:req.body},async()=>({status:200,body:envelope(req.id,config.RUNTIME_MODE,await assessBoundary(deps,auth,req.body,req.id))}));
  if(out.replay)reply.header('idempotent-replay','true');return reply.code(200).send(out.body as never);
 });
 r.get('/api/v1/ai/activity',{config:{rateLimit:{max:120,timeWindow:'1 minute'}},schema:{tags:['assistant'],response:{200:envelopeSchema(z.unknown())}}},async req=>{
  const auth=requireAuth(req);const rows=await pool.query<{id:string;provider:string;requested_model:string;model:string|null;purpose:string;started_at:Date}>("SELECT id,provider,requested_model,model,purpose,started_at FROM ai_invocations WHERE owner_id=$1 AND session_id=$2 AND status='running' AND started_at>now()-interval '2 minutes' ORDER BY started_at DESC LIMIT 8",[auth.ownerId,auth.sessionId]);
  return envelope(req.id,config.RUNTIME_MODE,{invocations:rows.rows.map(row=>({id:row.id,provider:row.provider,model:row.model,requestedModel:row.requested_model,purpose:row.purpose,startedAt:row.started_at.toISOString(),status:'running',processing:'standard'}))});
 });
 r.get('/api/v1/boundary-assessments/:id/image',{schema:{tags:['farms'],params:uuidParam}},async(req,reply)=>{
  const ownerId=requireAuth(req).ownerId;const row=(await pool.query<{image_key:string|null}>('SELECT image_key FROM boundary_assessments WHERE id=$1 AND owner_id=$2',[req.params.id,ownerId])).rows[0];
  if(!row?.image_key)throw notFound('Assessment image');
  const data=await deps.storage.get({ownerId,key:row.image_key}).catch(()=>null);if(!data)throw notFound('Assessment image');
  reply.header('cache-control','private, max-age=120');return reply.type('image/jpeg').send(Buffer.from(data));
 });
 r.post('/api/v1/farms/demo',{schema:{tags:['farms'],body:z.object({}).strict(),response:{200:envelopeSchema(z.unknown())}}},async req=>envelope(req.id,config.RUNTIME_MODE,await demoFarm(pool,requireAuth(req).ownerId)));
}
