import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {SoilReport,ReviewSoilReport,ConfirmSoilReport,FarmSoilMarkers} from '@harvest/contracts';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {envelope} from '../envelope';
import {envelopeSchema,uuidParam} from './schemas/common';
import {retrySoilReport,createSoilReport,listSoilReports,readSoilReport,getSoilReport,reviewSoilReport,confirmSoilReport,farmSoilMarkers,type SoilDeps} from '../services/soil-reports';
import {getFarm} from '../services/farms';
import {ApiError,notFound} from '../services/errors';
import {activeSoilReference,referenceSource} from '../services/soil-reference-registry';
export async function soilReportRoutes(app:FastifyInstance,deps:SoilDeps){
 app.addHook('onRequest',privateRouteGuard(deps.config,deps.pool));const r=app.withTypeProvider<ZodTypeProvider>();
 r.post('/api/v1/farms/:id/soil-reports',{config:{rateLimit:{max:5,timeWindow:'1 minute'}},schema:{tags:['soil'],params:uuidParam,response:{201:envelopeSchema(SoilReport)}}},async(req,reply)=>{
  const auth=requireAuth(req);if(!await getFarm(deps.pool,auth.ownerId,req.params.id))throw notFound('Farm');if(!req.isMultipart())throw new ApiError(415,'unsupported_media_type','Upload one soil report as multipart field file');
  const part=await req.file({limits:{fileSize:10*1024*1024,files:1}});if(!part||part.fieldname!=='file')throw new ApiError(400,'file_required','Multipart field file is required');const data=await part.toBuffer();if(part.file.truncated)throw new ApiError(413,'report_too_large','Soil reports are limited to ten megabytes');
  return reply.code(201).send(envelope(req.id,deps.config.RUNTIME_MODE,await createSoilReport(deps,auth,req.params.id,data,part.filename)));
 });
 r.post('/api/v1/farms/:id/soil-reports/sample',{schema:{tags:['soil'],params:uuidParam,body:z.object({}).strict(),response:{201:envelopeSchema(SoilReport)}}},async(req,reply)=>{
  const auth=requireAuth(req);if(!await getFarm(deps.pool,auth.ownerId,req.params.id))throw notFound('Farm');
  const {reference,data}=await activeSoilReference();
  return reply.code(201).send(envelope(req.id,deps.config.RUNTIME_MODE,await createSoilReport(deps,auth,req.params.id,data,'Agricultural soil reference.pdf',referenceSource(reference))));
 });
 r.get('/api/v1/farms/:id/soil-reports',{schema:{tags:['soil'],params:uuidParam,response:{200:envelopeSchema(z.object({reports:z.array(SoilReport)}))}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await listSoilReports(deps,requireAuth(req).ownerId,req.params.id)));
 r.get('/api/v1/soil-reports/:id',{config:{rateLimit:{max:120,timeWindow:'1 minute'}},schema:{tags:['soil'],params:uuidParam,response:{200:envelopeSchema(SoilReport)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await readSoilReport(deps,requireAuth(req).ownerId,req.params.id)));
 r.patch('/api/v1/soil-reports/:id',{schema:{tags:['soil'],params:uuidParam,body:ReviewSoilReport,response:{200:envelopeSchema(SoilReport)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await reviewSoilReport(deps,requireAuth(req).ownerId,req.params.id,req.body)));
 r.post('/api/v1/soil-reports/:id/confirm',{schema:{tags:['soil'],params:uuidParam,body:ConfirmSoilReport,response:{200:envelopeSchema(SoilReport)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await confirmSoilReport(deps,requireAuth(req).ownerId,req.params.id,req.body)));
 r.post('/api/v1/soil-reports/:id/retry',{config:{rateLimit:{max:3,timeWindow:'1 minute'}},schema:{tags:['soil'],params:uuidParam,body:z.object({expectedVersion:z.number().int()}).strict(),response:{200:envelopeSchema(SoilReport)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await retrySoilReport(deps,requireAuth(req),req.params.id,req.body.expectedVersion)));
 r.get('/api/v1/farms/:id/soil-markers',{schema:{tags:['soil'],params:uuidParam,response:{200:envelopeSchema(FarmSoilMarkers)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await farmSoilMarkers(deps,requireAuth(req).ownerId,req.params.id)));
 r.get('/api/v1/soil-reports/:id/original',{schema:{tags:['soil'],params:uuidParam}},async(req,reply)=>{const auth=requireAuth(req),row=await getSoilReport(deps,auth.ownerId,req.params.id);reply.header('cache-control','private, no-store').header('content-disposition','attachment; filename="soil-report"');return reply.type(row.content_type).send(Buffer.from(await deps.storage.get({ownerId:auth.ownerId,key:row.original_key})))});
 r.get('/api/v1/soil-reports/:id/pages/:page',{schema:{tags:['soil'],params:z.object({id:z.uuid(),page:z.coerce.number().int().min(1).max(8)})}},async(req,reply)=>{const auth=requireAuth(req),row=await getSoilReport(deps,auth.ownerId,req.params.id),page=row.pages.find(p=>p.page===req.params.page);if(!page)throw notFound('Report page');reply.header('cache-control','private, max-age=120');return reply.type('image/jpeg').send(Buffer.from(await deps.storage.get({ownerId:auth.ownerId,key:page.key})))});
}
