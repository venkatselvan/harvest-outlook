import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema} from './schemas/common';
import {demoFarm} from '../services/demo-farm';
import {ensureYearPlan,type YearPlanDeps} from '../services/year-plan/service';
/** `yearPlan`: when given, the year plan for the current horizon is started (not forced) after the demo farm is assembled. */
export interface DemoFarmDeps{config:Config;pool:Pool;yearPlan?:YearPlanDeps|undefined;now?:(()=>Date)|undefined}
export async function demoFarmRoutes(app:FastifyInstance,deps:DemoFarmDeps){
 const{config,pool}=deps;app.addHook('onRequest',privateRouteGuard(config,pool));const r=app.withTypeProvider<ZodTypeProvider>();
 r.post('/api/v1/farms/demo',{schema:{tags:['farms'],body:z.object({}).strict(),response:{200:envelopeSchema(z.unknown())}}},async req=>{
  const auth=requireAuth(req);const out=await demoFarm({config,pool,now:deps.now},auth.ownerId);
  // Same path as any farm (no seed-time model call); a failure to start it is logged and never fails the demo load.
  if(deps.yearPlan)await ensureYearPlan(deps.yearPlan,auth,out.farm.id).catch(err=>req.log.warn({code:'demo_year_plan_unavailable',err:err instanceof Error?err.message:String(err)},'Demo farm loaded; year plan not started'));
  return envelope(req.id,config.RUNTIME_MODE,out);
 });
}
