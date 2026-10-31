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
export interface DemoFarmDeps{config:Config;pool:Pool}
export async function demoFarmRoutes(app:FastifyInstance,deps:DemoFarmDeps){
 const{config,pool}=deps;app.addHook('onRequest',privateRouteGuard(config,pool));const r=app.withTypeProvider<ZodTypeProvider>();
 r.post('/api/v1/farms/demo',{schema:{tags:['farms'],body:z.object({}).strict(),response:{200:envelopeSchema(z.unknown())}}},async req=>envelope(req.id,config.RUNTIME_MODE,await demoFarm(pool,requireAuth(req).ownerId)));
}
