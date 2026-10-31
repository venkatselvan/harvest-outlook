import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema} from './schemas/common';
export interface AiActivityDeps{config:Config;pool:Pool}
export async function aiActivityRoutes(app:FastifyInstance,deps:AiActivityDeps){
 const{config,pool}=deps;app.addHook('onRequest',privateRouteGuard(config,pool));const r=app.withTypeProvider<ZodTypeProvider>();
 r.get('/api/v1/ai/activity',{config:{rateLimit:{max:120,timeWindow:'1 minute'}},schema:{tags:['assistant'],response:{200:envelopeSchema(z.unknown())}}},async req=>{
  const auth=requireAuth(req);const rows=await pool.query<{id:string;provider:string;requested_model:string;model:string|null;purpose:string;started_at:Date}>("SELECT id,provider,requested_model,model,purpose,started_at FROM ai_invocations WHERE owner_id=$1 AND session_id=$2 AND status='running' AND started_at>now()-interval '2 minutes' ORDER BY started_at DESC LIMIT 8",[auth.ownerId,auth.sessionId]);
  return envelope(req.id,config.RUNTIME_MODE,{invocations:rows.rows.map(row=>({id:row.id,provider:row.provider,model:row.model,requestedModel:row.requested_model,purpose:row.purpose,startedAt:row.started_at.toISOString(),status:'running',processing:'standard'}))});
 });
}
