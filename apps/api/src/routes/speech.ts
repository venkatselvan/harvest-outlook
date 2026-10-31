import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {Budget} from '../services/budget';
import {MetaSpeech,SPEECH_LANGUAGES,MAX_SPEECH_BYTES} from '../speech/meta';
import {envelope} from '../envelope';
import {privateRouteGuard} from '../security/guards';
import {requireAuth} from '../security/session';
import {ApiError} from '../services/errors';
import {envelopeSchema} from './schemas/common';
import {statusOut,transcriptionOut} from './schemas/speech';
import {z} from 'zod';
export interface SpeechRouteDeps{config:Config;pool:Pool;budget:Budget;service?:MetaSpeech;fetchImpl?:typeof fetch}
export async function registerSpeechRoutes(app:FastifyInstance,deps:SpeechRouteDeps){await app.register(speechRoutes,deps)}
async function speechRoutes(app:FastifyInstance,deps:SpeechRouteDeps){
 const {config,pool}=deps,service=deps.service??new MetaSpeech(deps);app.addHook('onRequest',privateRouteGuard(config,pool));const r=app.withTypeProvider<ZodTypeProvider>();
 r.get('/api/v1/speech/status',{schema:{tags:['speech'],response:{200:envelopeSchema(statusOut)}}},async req=>envelope(req.id,config.RUNTIME_MODE,await service.status()));
 // A compatibility endpoint, with no body parsing, provider, synthesis or network fallback.
 r.post('/api/v1/speech/synthesis',{onRequest:async()=>{throw new ApiError(410,'speech_synthesis_not_supported','Speech output is not supported; read the text answer')},schema:{tags:['speech'],description:'Retired synthesis endpoint. Always unavailable.'}},async()=>{throw new ApiError(410,'speech_synthesis_not_supported','Speech output is not supported')});
 r.post('/api/v1/speech/transcriptions',{bodyLimit:MAX_SPEECH_BYTES+65536,config:{rateLimit:{max:20,timeWindow:'1 minute'}},schema:{tags:['speech'],response:{200:envelopeSchema(transcriptionOut)}}},async(req,reply)=>{
  const auth=requireAuth(req),status=await service.status();if(!status.available)throw new ApiError(424,'provider_unavailable','Meta speech recognition is unavailable; type instead',{reason:status.disabledReason});
  if(!req.isMultipart())throw new ApiError(415,'unsupported_media_type','Upload PCM WAV audio as multipart field audio');const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>MAX_SPEECH_BYTES+65536)throw new ApiError(413,'payload_too_large','Audio exceeds the recording limit');
  const fields:Record<string,string>={};let audio:Buffer|null=null;
  for await(const part of req.parts({limits:{fileSize:MAX_SPEECH_BYTES,files:1,fields:3}})){if(part.type==='field'){if(typeof part.value==='string')fields[part.fieldname]=part.value;continue}if(part.fieldname!=='audio')throw new ApiError(400,'audio_required','Multipart field audio is required');audio=await part.toBuffer();if(part.file.truncated)throw new ApiError(413,'payload_too_large','Audio exceeds the recording limit')}
  if(!audio)throw new ApiError(400,'audio_required','Multipart field audio is required');const lang=z.enum(SPEECH_LANGUAGES).safeParse(fields.language);if(!lang.success)throw new ApiError(400,'validation_error','language must be en, ta or hi');let farmId:string|undefined;
  if(fields.farmId){const parsed=z.uuid().safeParse(fields.farmId);if(!parsed.success)throw new ApiError(400,'validation_error','farmId must be a UUID');farmId=parsed.data;const own=await pool.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',[farmId,auth.ownerId]);if(!own.rowCount)throw new ApiError(404,'not_found','Farm not found')}
  const abort=new AbortController();reply.raw.on('close',()=>{if(!reply.raw.writableFinished)abort.abort()});
  const result=await service.transcribe(auth,{audio,language:lang.data,requestId:req.id,...(farmId?{farmId}:{}),signal:abort.signal});return envelope(req.id,config.RUNTIME_MODE,result,['Review and edit the transcript before sending it. No transcription accuracy qualification is claimed.']);
 });
}
