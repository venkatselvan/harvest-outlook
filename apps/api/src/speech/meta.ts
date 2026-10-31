import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {Budget} from '../services/budget';
import {ApiError} from '../services/errors';
import {trackMetaInvocation,withModelActivity} from '../services/model-activity';
export const SPEECH_LANGUAGES=['en','ta','hi'] as const;
const languageNames={en:'English',ta:'Tamil',hi:'Hindi'} as const;
export const MAX_SPEECH_BYTES=3_000_000;
/** Validate actual PCM bytes, not MIME/filename or a forged duration header. Strip metadata chunks. */
export function validateMetaWav(data:Buffer,maxSeconds=60){
 const bad=()=>new ApiError(422,'unsupported_audio_format','Convert audio to mono 16-bit PCM WAV at 16000 or 24000 Hz');
 if(data.length>MAX_SPEECH_BYTES)throw new ApiError(413,'payload_too_large','Audio exceeds the recording limit');
 if(data.length<44||data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE'||data.readUInt32LE(4)!==data.length-8)throw bad();
 let format:Buffer|null=null,pcm:Buffer|null=null,offset=12;
 while(offset+8<=data.length){const kind=data.toString('ascii',offset,offset+4),length=data.readUInt32LE(offset+4),end=offset+8+length;if(end>data.length)throw bad();if(kind==='fmt '){if(format)throw bad();format=data.subarray(offset+8,end)}if(kind==='data'){if(pcm)throw bad();pcm=data.subarray(offset+8,end)}offset=end+(length%2)}
 if(offset!==data.length||!format||format.length<16||!pcm||!pcm.length||pcm.length%2)throw bad();
 const rate=format.readUInt32LE(4);if(format.readUInt16LE(0)!==1||format.readUInt16LE(2)!==1||![16000,24000].includes(rate)||format.readUInt16LE(14)!==16||format.readUInt16LE(12)!==2||format.readUInt32LE(8)!==rate*2)throw bad();
 const seconds=pcm.length/(rate*2);if(seconds<.1)throw new ApiError(422,'audio_too_short','Record at least a tenth of a second');if(seconds>Math.min(maxSeconds,60))throw new ApiError(413,'audio_too_long','Recording exceeds sixty seconds');
 const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
 return{data:Buffer.concat([header,pcm]),seconds,sampleRate:rate};
}
export interface MetaSpeechDeps{config:Config;pool:Pool;budget:Budget;fetchImpl?:typeof fetch;now?:()=>number}
const responseSchema=z.object({sessionId:z.string().max(200),transcript:z.string().max(20000),audioDurationMs:z.number().finite().nonnegative().max(61000),turns:z.array(z.unknown()),model:z.string().optional()});
export class MetaSpeech{
 private cached:{available:boolean;reason:string|null;until:number}|null=null;
 constructor(private deps:MetaSpeechDeps){}
 private now(){return this.deps.now?.()??Date.now()}
 async status(){const {config}=this.deps;let available=false,reason:string|null=null;
  if(config.RUNTIME_MODE!=='live')reason='live_speech_only';else if(!config.MODEL_API_KEY)reason='meta_key_missing';else{
   if(!this.cached||this.cached.until<=this.now()){try{const response=await(this.deps.fetchImpl??fetch)(config.META_BASE_URL.replace(/\/$/,'')+'/models',{headers:{authorization:`Bearer ${config.MODEL_API_KEY}`},signal:AbortSignal.timeout(8000)});const body=response.ok?await response.json() as {data?:{id?:string}[]}:null;const found=!!body?.data?.some(m=>m.id===config.META_STT_MODEL);this.cached={available:found,reason:found?null:response.status===401||response.status===403?'meta_stt_access_denied':response.ok?'meta_stt_model_unavailable':'meta_model_inventory_unavailable',until:this.now()+(found?300000:30000)}}catch{this.cached={available:false,reason:'meta_model_inventory_unavailable',until:this.now()+30000}}}
   available=this.cached.available;reason=this.cached.reason;
  }
  return{available,live:available,provider:available?'meta' as const:null,model:config.META_STT_MODEL,languages:[...SPEECH_LANGUAGES],maxSeconds:Math.min(config.MAX_VOICE_SECONDS,60),maxBytes:MAX_SPEECH_BYTES,qualified:false as const,ttsVoiceConfigured:false as const,synthesisAvailable:false as const,disabledReason:reason,privacy:{processing:'standard' as const,appStoresAudio:false as const,appStoresTranscript:false as const,responseDeletionAvailable:false as const}};
 }
 async transcribe(auth:{ownerId:string;sessionId:string},input:{audio:Buffer;language:typeof SPEECH_LANGUAGES[number];requestId:string;farmId?:string;signal?:AbortSignal}){
  const status=await this.status();if(!status.available)throw new ApiError(424,'provider_unavailable','Meta speech recognition is unavailable; type instead',{reason:status.disabledReason});
  const {config,pool,budget}=this.deps,wav=validateMetaWav(input.audio,config.MAX_VOICE_SECONDS);
  const correlation=randomUUID(),form=new FormData();form.append('request',new Blob([JSON.stringify({mode:'PUSH_TO_TALK',model:config.META_STT_MODEL,audioEncoding:'WAV',languageBias:[languageNames[input.language]]})],{type:'application/json'}),'request.json');form.append('audio',new Blob([new Uint8Array(wav.data)],{type:'audio/wav'}),'recording.wav');
  const estimate=budget.estimate('meta',config.META_STT_MODEL,{seconds:Math.ceil(wav.seconds)}).usd;if(estimate===null||!Number.isFinite(estimate))throw new ApiError(500,'unpriced_model','Speech requires an explicit numeric duration price');const reservation=(await budget.reserve({ownerId:auth.ownerId,sessionId:auth.sessionId,provider:'meta',model:config.META_STT_MODEL,estimate,requestId:input.requestId})).reservationId;
  let dispatched=false,handled=false;
  try{
   const stillAuthorized=(await pool.query('SELECT s.id FROM sessions s WHERE s.id=$1 AND s.owner_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM farms f WHERE f.id=$3 AND f.owner_id=s.owner_id AND f.deleted_at IS NULL))',[auth.sessionId,auth.ownerId,input.farmId??null])).rowCount;if(!stillAuthorized||input.signal?.aborted){await budget.release(reservation);handled=true;throw new ApiError(401,'session_expired','The requesting session or farm is no longer available')}
   const result=await withModelActivity({pool,ownerId:auth.ownerId,sessionId:auth.sessionId,mode:config.RUNTIME_MODE,purpose:'speech_transcription'},()=>trackMetaInvocation(config.META_STT_MODEL,async()=>{
    dispatched=true;const response=await(this.deps.fetchImpl??fetch)(config.META_BASE_URL.replace(/\/$/,'')+'/asr/transcribe?sessionId='+correlation,{method:'POST',headers:{authorization:`Bearer ${config.MODEL_API_KEY}`,accept:'application/json'},body:form,signal:input.signal?AbortSignal.any([input.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
    if(!response.ok){if(response.status<500){await budget.release(reservation);handled=true}if([401,403].includes(response.status))this.cached={available:false,reason:'meta_stt_access_denied',until:this.now()+60000};throw new ApiError(response.status===429?429:424,response.status===429?'provider_rate_limited':'provider_unavailable','Meta speech recognition failed; type instead',{httpStatus:response.status})}
    const parsed=responseSchema.safeParse(await response.json());if(!parsed.success)throw new ApiError(424,'provider_bad_response','Meta returned an invalid transcription response');return parsed.data;
   },r=>r.model??null));
   const seconds=Math.floor(result.audioDurationMs/1000);await budget.settle(reservation,budget.estimate('meta',config.META_STT_MODEL,{seconds}).usd!,result.sessionId,{seconds});handled=true;
   return{transcript:result.transcript,detectedLanguage:null,languageProbability:null,languageMismatch:false as const,provider:{name:'meta' as const,requestedModel:config.META_STT_MODEL,model:result.model??null,requestId:result.sessionId},usageSeconds:result.audioDurationMs/1000,synthetic:false as const};
  }catch(error){if(!handled){if(dispatched)await budget.markUncertain(reservation).catch(()=>undefined);else await budget.release(reservation).catch(()=>undefined)}if(error instanceof ApiError)throw error;throw new ApiError(424,'provider_unavailable','Meta speech recognition did not complete; type instead')}
 }
}
