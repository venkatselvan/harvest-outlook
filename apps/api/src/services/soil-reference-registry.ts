import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {REPO_ROOT} from '../catalogue/files';
import {ApiError} from './errors';
import {sha256Hex} from './hash';
const Reference=z.object({registryId:z.string().optional(),status:z.enum(['active','retired','pending_verification']),title:z.string(),sourceUrl:z.url().nullable(),classifyUploadsAsReference:z.boolean().default(true),localPath:z.string(),sourcePages:z.array(z.number().int().positive()).min(1),fileSha256:z.string().regex(/^[a-f0-9]{64}$/),limitations:z.array(z.string()),extractionScope:z.object({sampleLabel:z.string(),description:z.string(),markerLimit:z.number().int().min(1).max(100)}).strict().optional()}).passthrough();
export type PublicSoilReference=z.infer<typeof Reference>;
const root=resolve(REPO_ROOT,'data/research/soil-crop');
/** Local, reviewed registry only. No user-supplied URL is fetched. Retired hashes stay isolated. */
export async function soilReferenceRegistry(){
 let active:PublicSoilReference|null=null,pending:PublicSoilReference|null=null;try{const record=Reference.parse(JSON.parse(await readFile(resolve(root,'reference-soil-report.json'),'utf8')));if(record.status==='active')active=record;else if(record.status==='pending_verification')pending=record}catch{/* missing/unverified reference is unavailable */}
 const retired:PublicSoilReference[]=JSON.parse(await readFile(resolve(root,'retired-soil-reports.json'),'utf8')).reports.map((r:unknown)=>Reference.parse(r));
 return{active,pending,retired};
}
export async function activeSoilReference(){
 const {active}=await soilReferenceRegistry();if(!active)throw new ApiError(503,'reference_sample_unavailable','A verified agricultural soil reference is not available yet');
 const file=resolve(REPO_ROOT,active.localPath);if(!file.startsWith(REPO_ROOT+'/data/'))throw new ApiError(503,'reference_sample_unavailable','The sample report path is invalid');
 const data=await readFile(file);if(sha256Hex(data)!==active.fileSha256)throw new ApiError(503,'reference_sample_unavailable','The verified sample file does not match its registered hash');
 return{reference:active,data};
}
export const referenceSource=(r:PublicSoilReference)=>({title:r.title,url:r.sourceUrl,pages:r.sourcePages,limitations:r.limitations,...(r.extractionScope?{extractionScope:r.extractionScope}:{})});
