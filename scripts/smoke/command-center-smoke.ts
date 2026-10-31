/** Explicit local API smoke: dedicated guest/farm, actual sourced care, no Meta dispatch. */
import '../../apps/api/src/env';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadConfig} from '../../apps/api/src/config';
import {createPool} from '../../apps/api/src/db/pool';
import {payloadHash} from '../../apps/api/src/services/hash';
import {REPO_ROOT} from '../../apps/api/src/catalogue/files';
import {FarmCommandCenter} from '@harvest/contracts';
const config=loadConfig(),pool=createPool(config.DATABASE_URL),base='http://127.0.0.1:8787',origin=config.ALLOWED_ORIGINS[0]!;
const baseline=async()=>payloadHash((await pool.query(`SELECT jsonb_build_object('farm',to_jsonb(f),'workspace',(SELECT to_jsonb(w) FROM farm_workspaces w WHERE w.farm_id=f.id),'plans',(SELECT count(*) FROM plans p WHERE p.farm_id=f.id),'journal',(SELECT count(*) FROM journal_entries j WHERE j.farm_id=f.id),'soilSamples',(SELECT count(*) FROM soil_samples s WHERE s.farm_id=f.id)) data FROM farms f WHERE f.name='Riverside Farm' AND f.deleted_at IS NULL ORDER BY f.id`)).rows);
let cookie='',csrf='',farmId:string|null=null,revoked=false,deleted=false;const summary:Record<string,unknown>={checkedAt:new Date().toISOString(),purpose:'Isolated actual API crop establishment and care persistence; no model invocation',mode:config.RUNTIME_MODE};
async function call(method:string,path:string,payload?:unknown){const response=await fetch(base+path,{method,headers:{origin,...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(payload!==undefined?{'content-type':'application/json'}:{})},...(payload!==undefined?{body:JSON.stringify(payload)}:{})});const data=await response.json() as any;if(!response.ok)throw Error(`${method} ${path}: HTTP ${response.status}, ${data.error?.code??'request_failed'}`);return{response,data:data.data}}
const before=await baseline();
try{
 const session=await call('POST','/api/v1/session');cookie=session.response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');csrf=session.data.csrfToken;
 const created=await call('POST','/api/v1/farms',{name:`QA sourced care ${randomUUID()}`,location:{stateId:'IN-TN',districtId:'IN-TN-coimbatore',precision:'district'},areaHectares:0.1,facts:{}});farmId=created.data.id;
 const date=new Date(Date.now()+19800000).toISOString().slice(0,10),body={clientEntryId:randomUUID(),cropId:'paddy',productId:'paddy-grain',establishmentMethod:'sri_transplanting',establishmentDate:date,expectedWorkspaceVersion:0,notes:'Isolated API acceptance test; this farm is removed after validation.'};
 const planted=await call('POST',`/api/v1/farms/${farmId}/cycles`,body),retry=await call('POST',`/api/v1/farms/${farmId}/cycles`,body);if(planted.data.cycle.id!==retry.data.cycle.id||!retry.data.alreadyRecorded)throw Error('Crop replay failed');
 const view=FarmCommandCenter.parse((await call('GET',`/api/v1/farms/${farmId}/command-center`)).data),cycle=view.currentCycles[0]!,task=cycle.careTasks.find(t=>t.actionId==='paddy-sri-water');if(!task||task.dueFrom!==date)throw Error('Source SRI establishment-water action unavailable');
 const taskUrl=`/api/v1/farms/${farmId}/cycles/${cycle.cycle.id}/care/${task.id}/complete`,complete={clientEntryId:randomUUID(),completedOn:date,note:'Acceptance test acknowledgement'};
 const done=await call('POST',taskUrl,complete),again=await call('POST',taskUrl,{...complete,clientEntryId:randomUUID()});if(done.data.journalEntryId!==again.data.journalEntryId)throw Error('Completion replay failed');
 const reloaded=FarmCommandCenter.parse((await call('GET',`/api/v1/farms/${farmId}/command-center`)).data),journal=(await call('GET',`/api/v1/farms/${farmId}/journal`)).data;
 if(reloaded.currentCycles[0]?.careTasks.find(t=>t.id===task.id)?.status!=='completed')throw Error('Completion did not persist');
 const owner=(await pool.query('SELECT owner_id FROM farms WHERE id=$1',[farmId])).rows[0]!.owner_id;
 const counts=(await pool.query(`SELECT (SELECT count(*) FROM journal_entries WHERE farm_id=$1)::int journal_entries,(SELECT count(*) FROM farm_cycle_actions WHERE farm_id=$1)::int recorded_actions,(SELECT count(*) FROM ai_invocations WHERE owner_id=$2)::int model_invocations`,[farmId,owner])).rows[0];
 if(counts.journal_entries!==2||counts.recorded_actions!==2||counts.model_invocations!==0)throw Error('Unexpected write or model invocation count');
 Object.assign(summary,{passed:true,focusedCrops:view.focusedCrops.length,sourceCount:view.sources.length,careTasks:cycle.careTasks.length,stageGuidance:cycle.stageGuidance?.length??0,establishmentMethod:cycle.cycle.establishmentMethod,sourceAction:task.actionId,sourceRefs:task.sourceRefs,geographyIds:task.geographyIds,replayVerified:true,reloadVerified:true,counts,journalReadable:!!journal});
}finally{
 try{if(farmId){await call('DELETE',`/api/v1/farms/${farmId}`);deleted=true}}finally{if(cookie){await call('DELETE','/api/v1/session');revoked=true}summary.cleanup={testFarmDeleted:deleted,testSessionRevoked:revoked};summary.unrelatedRiversideUnchanged=(await baseline())===before;await pool.end();await mkdir(resolve(REPO_ROOT,'evals/results/live-smoke'),{recursive:true});await writeFile(resolve(REPO_ROOT,'evals/results/live-smoke/command-center-2026-10-31.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));}
}
