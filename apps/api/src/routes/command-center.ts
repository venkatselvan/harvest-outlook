import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {FarmCommandCenter,PlantCrop,PlantCropResult,CompleteCareTask,CompleteCareTaskResult} from '@harvest/contracts';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema,uuidParam} from './schemas/common';
import {farmCommandCenter,plantCrop,completeCareTask,type CommandDeps} from '../services/command-center';
export async function commandCenterRoutes(app:FastifyInstance,deps:CommandDeps){
 app.addHook('onRequest',privateRouteGuard(deps.config,deps.pool));const r=app.withTypeProvider<ZodTypeProvider>();
 r.get('/api/v1/farms/:id/command-center',{schema:{tags:['farms'],params:uuidParam,response:{200:envelopeSchema(FarmCommandCenter)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await farmCommandCenter(deps,requireAuth(req).ownerId,req.params.id)));
 r.post('/api/v1/farms/:id/cycles',{schema:{tags:['farms'],params:uuidParam,body:PlantCrop,response:{201:envelopeSchema(PlantCropResult)}}},async(req,reply)=>reply.code(201).send(envelope(req.id,deps.config.RUNTIME_MODE,await plantCrop(deps,requireAuth(req).ownerId,req.params.id,req.body))));
 r.post('/api/v1/farms/:id/cycles/:cycleId/care/:taskId/complete',{schema:{tags:['farms'],params:z.object({id:z.uuid(),cycleId:z.string().min(1).max(120),taskId:z.string().min(1).max(120)}),body:CompleteCareTask,response:{200:envelopeSchema(CompleteCareTaskResult)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await completeCareTask(deps,requireAuth(req).ownerId,req.params.id,req.params.cycleId,req.params.taskId,req.body)));
}
