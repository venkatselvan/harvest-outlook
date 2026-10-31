import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {GeographicBoundary} from '@harvest/contracts';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {privateRouteGuard} from '../security/guards';
import {envelope} from '../envelope';
import {envelopeSchema} from './schemas/common';
import {boundaryMetrics} from '../services/workspace';
import {locateIndia} from '../providers/geoboundaries';
import {ApiError} from '../services/errors';
export interface BoundaryContextDeps{config:Config;pool:Pool;fetchImpl?:typeof fetch}
export async function boundaryContextRoutes(app:FastifyInstance,deps:BoundaryContextDeps){
 const{config,pool}=deps;app.addHook('onRequest',privateRouteGuard(config,pool));const r=app.withTypeProvider<ZodTypeProvider>();
 r.post('/api/v1/boundary-context',{schema:{tags:['farms'],body:z.object({boundary:GeographicBoundary}).strict(),response:{200:envelopeSchema(z.unknown())}}},async req=>{
  const metrics=boundaryMetrics(req.body.boundary);if(metrics.areaHectares>5000)throw new ApiError(400,'validation_error','Field assessment supports boundaries up to 5000 hectares');
  const centroid={lat:metrics.lat,lon:metrics.lon};const located=config.RUNTIME_MODE==='live'?await locateIndia(pool,centroid,deps.fetchImpl):{location:{status:'unavailable',stateId:null,stateName:null,districtId:null,districtName:null,countryCode:null,source:null,uncertainties:['Live administrative context is unavailable in this mode.']},sources:[]};
  return envelope(req.id,config.RUNTIME_MODE,{...located,areaHectares:metrics.areaHectares,centroid,suggestedName:located.location.districtName?`${located.location.districtName} field`:'My field'});
 });
}
