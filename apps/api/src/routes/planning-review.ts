import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {PlanningReview,ApplyPlanningReview,ApplyPlanningReviewResult} from '@harvest/contracts';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema,uuidParam} from './schemas/common';
import {readPlanningReview,ensurePlanningReview,applyPlanningReview,type PlanningDeps} from '../services/planning-review';
export async function planningReviewRoutes(app:FastifyInstance,deps:PlanningDeps){
 app.addHook('onRequest',privateRouteGuard(deps.config,deps.pool));const r=app.withTypeProvider<ZodTypeProvider>();
 r.get('/api/v1/farms/:id/planning-review',{schema:{tags:['farms'],params:uuidParam,response:{200:envelopeSchema(PlanningReview)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await readPlanningReview(deps,requireAuth(req).ownerId,req.params.id)));
 r.post('/api/v1/farms/:id/planning-review',{config:{rateLimit:{max:12,timeWindow:'1 minute'}},schema:{tags:['farms'],params:uuidParam,body:z.object({}).strict(),response:{200:envelopeSchema(PlanningReview)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await ensurePlanningReview(deps,requireAuth(req),req.params.id)));
 r.post('/api/v1/farms/:id/planning-review/apply',{schema:{tags:['farms'],params:uuidParam,body:ApplyPlanningReview,response:{200:envelopeSchema(ApplyPlanningReviewResult)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await applyPlanningReview(deps,requireAuth(req).ownerId,req.params.id,req.body)));
}
