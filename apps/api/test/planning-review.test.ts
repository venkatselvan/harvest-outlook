import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {PlanningReview} from '@harvest/contracts';
import {loadCatalogueIntoDb} from '../src/catalogue/load';
import {Budget} from '../src/services/budget';
import {ensurePlanningReview,readPlanningReview,generatePlanningReview,planningContext,applyPlanningReview,type PlanningDeps} from '../src/services/planning-review';
import {getWorkspace,putWorkspace} from '../src/services/workspace';
import {patchFarm} from '../src/services/farms';
import {farmBody,login,setupHarness,type Harness,type Client} from './helpers';
let h:Harness,a:Client,b:Client;
beforeAll(async()=>{h=await setupHarness();await loadCatalogueIntoDb(h.pool);a=await login(h.app);b=await login(h.app)});
afterAll(async()=>h.close());
const deps=(over:Partial<PlanningDeps>={}):PlanningDeps=>({pool:h.pool,config:h.config,budget:Budget.fromConfig(h.pool,h.config),...over});
async function farm(client=a,district='IN-KA-hassan',state='IN-KA'){
 const f=(await client.call('POST','/api/v1/farms',{payload:farmBody({name:`Planning QA ${randomUUID()}`,location:{stateId:state,districtId:district,precision:'district'},facts:{}})})).json().data;
 const session=(await h.pool.query<{owner_id:string;id:string}>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1',[f.id])).rows[0]!;
 return{f,auth:{ownerId:session.owner_id,sessionId:session.id}};
}
async function generate(d:PlanningDeps,auth:{ownerId:string;sessionId:string},id:string){const review=await ensurePlanningReview(d,auth,id);await generatePlanningReview(d,review.reviewId!,auth.ownerId);return readPlanningReview(d,auth.ownerId,id)}

describe('persisted owner-scoped automatic planning review',()=>{
 it('authenticates every route and hides foreign farms before queueing',async()=>{
  const{f}=await farm();const before=(await h.pool.query('SELECT count(*) FROM farm_planning_reviews')).rows[0].count;
  expect((await b.call('GET',`/api/v1/farms/${f.id}/planning-review`)).statusCode).toBe(404);
  expect((await b.call('POST',`/api/v1/farms/${f.id}/planning-review`,{payload:{}})).statusCode).toBe(404);
  expect((await b.call('POST',`/api/v1/farms/${f.id}/planning-review/apply`,{payload:{reviewId:randomUUID(),proposalIds:['candidate-1'],expectedWorkspaceVersion:0}})).statusCode).toBe(404);
  expect((await h.pool.query('SELECT count(*) FROM farm_planning_reviews')).rows[0].count).toBe(before);
 });
 it('deduplicates concurrent repeated visits and isolates runtime modes',async()=>{
  const{f,auth}=await farm();const d=deps();const [one,two]=await Promise.all([ensurePlanningReview(d,auth,f.id),ensurePlanningReview(d,auth,f.id)]);
  expect(one.reviewId).toBe(two.reviewId);expect(one.jobId).toBe(two.jobId);expect(one.status).toBe('pending');
  expect(Number((await h.pool.query('SELECT count(*) FROM jobs WHERE id=$1',[one.jobId])).rows[0].count)).toBe(1);
  const live=await readPlanningReview(deps({config:{...h.config,RUNTIME_MODE:'live'}}),auth.ownerId,f.id);expect(live.reviewId).toBeNull();expect(live.modelInvocation).toBeNull();
 });
 it('uses district week windows and separate variety duration evidence; never fabricates village observations',async()=>{
  const{f,auth}=await farm();const context=await planningContext(deps(),auth.ownerId,f.id);
  const maize=context.candidates.find(c=>c.cropId==='maize'&&c.season==='kharif'&&c.sowing.endsWith('05-22'))!;
  expect(maize).toBeDefined();expect(maize.harvest?.earliest).toBe('2027-09-09');expect(maize.harvest?.latest).toBe('2027-09-19');
  expect(maize.evidenceRefs).toEqual(['planning.hassan.crida2011.p9.windows','planning.maize.nah2049.duration']);
  const result=await generate(deps(),auth,f.id);expect(result.localContext.location).toMatchObject({village:null,villageBasis:'unavailable',granularity:'district'});
  expect(result.comparisonShortlist.some(c=>c.cropId==='maize')).toBe(true);expect(new Set(result.comparisonShortlist.map(c=>c.cropId)).size).toBe(result.comparisonShortlist.length);
  expect(result.localContext.weather.kind).toBe('forecast');expect(result.modelInvocation).toBeNull();expect(PlanningReview.safeParse(result).success).toBe(true);
 });
 it('keeps traceable pending Tamil Nadu source contexts provisional, and refreshes daily/material changes',async()=>{
  const{f,auth}=await farm(a,'IN-TN-coimbatore','IN-TN');const one=await planningContext(deps(),auth.ownerId,f.id);
  expect(one.candidates.length).toBeGreaterThan(0);expect(one.candidates.every(c=>c.conditional)).toBe(true);expect(one.evidence.some(e=>e.reviewStatus==='pending')).toBe(true);
  const tomorrow=deps({now:()=>new Date(Date.now()+86400_000)});expect((await planningContext(tomorrow,auth.ownerId,f.id)).hash).not.toBe(one.hash);
  await patchFarm(h.pool,auth.ownerId,f.id,{facts:{irrigation_category:{value:'rainfed',basis:'farmer_reported',confirmed:true}}});expect((await planningContext(deps(),auth.ownerId,f.id)).hash).not.toBe(one.hash);
 });
 it('uses a free remainder of a source window and keeps conflicting alternatives comparison-only',async()=>{
  const{f,auth}=await farm();await putWorkspace(h.pool,auth.ownerId,f.id,{expectedVersion:0,boundary:null,previousHarvest:{status:'none'},cycles:[],rotationPlans:[{id:'own-season',year:2027,season:'Existing',cropId:'maize',plannedSowingDate:'2027-04-01',plannedHarvestDate:'2027-05-25'}]});
  const context=await planningContext(deps(),auth.ownerId,f.id);const maize=context.candidates.find(c=>c.cropId==='maize'&&c.season==='kharif'&&c.sowing==='2027-05-26');expect(maize?.availability).toBe('free_window');
  await putWorkspace(h.pool,auth.ownerId,f.id,{expectedVersion:1,boundary:null,previousHarvest:{status:'none'},cycles:[{id:'ongoing',cropId:'unknown-crop',sowingDate:'2026-09-01',stage:'growing'}],rotationPlans:[]});
  const result=await generate(deps(),auth,f.id);expect(result.rotationDraft).toHaveLength(0);expect(result.comparisonShortlist.length).toBeGreaterThan(0);expect(result.comparisonShortlist.every(c=>c.availability==='unknown_current_harvest')).toBe(true);
 });
 it('appends only explicit proposals, preserves existing records, and reuses the accepted cache without another job',async()=>{
  const{f,auth}=await farm();const d=deps();const review=await generate(d,auth,f.id);expect(review.rotationDraft.length).toBeGreaterThan(0);
  const before=await getWorkspace(h.pool,auth.ownerId,f.id);expect(before.rotationPlans).toEqual([]);
  const selected=review.rotationDraft[0]!;const applied=await applyPlanningReview(d,auth.ownerId,f.id,{reviewId:review.reviewId!,proposalIds:[selected.id],expectedWorkspaceVersion:before.version});
  expect(applied.workspace.previousHarvest).toEqual(before.previousHarvest);expect(applied.workspace.cycles).toEqual(before.cycles);expect(applied.workspace.rotationPlans).toHaveLength(1);expect(applied.review.appliedProposalIds).toContain(selected.id);
  const again=await ensurePlanningReview(d,auth,f.id);expect(again.reviewId).toBe(review.reviewId);expect(again.jobId).toBe(review.jobId);expect(again.stale).toBe(false);
  expect((await applyPlanningReview(d,auth.ownerId,f.id,{reviewId:review.reviewId!,proposalIds:[selected.id],expectedWorkspaceVersion:before.version})).workspace.rotationPlans).toHaveLength(1);
 });
 it('rejects stale facts and guards farm-version changes under the workspace transaction lock',async()=>{
  const{f,auth}=await farm();const d=deps();const review=await generate(d,auth,f.id);const p=review.rotationDraft[0]!;
  await patchFarm(h.pool,auth.ownerId,f.id,{facts:{irrigation_category:{value:'irrigated',basis:'farmer_reported',confirmed:true}}});
  await expect(applyPlanningReview(d,auth.ownerId,f.id,{reviewId:review.reviewId!,proposalIds:[p.id],expectedWorkspaceVersion:0})).rejects.toMatchObject({statusCode:409,code:'review_context_changed'});
  const oldVersion=f.version;await expect(putWorkspace(h.pool,auth.ownerId,f.id,{expectedVersion:0,boundary:null,previousHarvest:{status:'none'},cycles:[],rotationPlans:[]},{farmVersion:oldVersion})).rejects.toMatchObject({code:'review_context_changed'});
 });
 it('uses actual transport model metadata, constrained reason codes and server-owned dates',async()=>{
  const{f,auth}=await farm();let selectedId='';let requests=0;
  const before=await planningContext(deps({config:{...h.config,RUNTIME_MODE:'live'}}),auth.ownerId,f.id);
  const report=(await h.pool.query(`INSERT INTO soil_reports(owner_id,farm_id,kind,mode,status,filename,content_type,byte_size,sha256,original_key) VALUES($1,$2,'field_report','live','confirmed','Fixture field report.pdf','application/pdf',100,$3,'fixture-only') RETURNING id`,[auth.ownerId,f.id,'f'.repeat(64)])).rows[0];
  const sample=(await h.pool.query(`INSERT INTO soil_samples(owner_id,farm_id,report_id,source_sample_id,review_revision,collection_date) VALUES($1,$2,$3,'fixture-sample',1,'2026-10-01') RETURNING id`,[auth.ownerId,f.id,report.id])).rows[0];
  await h.pool.query(`INSERT INTO soil_markers(sample_id,source_marker_id,parameter,raw_label,raw_value,raw_unit,numeric_value,qualifier,method,extractant,soil_water_ratio,matrix,evidence_page,evidence_quote,native_text_check,extraction_confidence,warnings,canonical_value,canonical_unit) VALUES($1,'fixture-ph','ph','pH','6.4','pH',6.4,'exact','Water suspension','Water','1:2.5','soil',1,'Fixture pH 6.4','matched','high','[]',6.4,'pH')`,[sample.id]);
  expect((await planningContext(deps({config:{...h.config,RUNTIME_MODE:'live'}}),auth.ownerId,f.id)).hash).not.toBe(before.hash);
  const fetchImpl=vi.fn(async(request:RequestInfo|URL,init?:RequestInit)=>{
   const url=String(request);if(!url.startsWith('https://fixture.invalid'))throw Error('Public context unavailable in this fixture');
   if(init?.method==='DELETE')return new Response(JSON.stringify({id:'planning-fixture-response',deleted:true}),{status:200});
   requests++;const body=JSON.parse(String(init?.body));const input=JSON.parse(body.input);const candidate=input.candidates.find((c:{cropId:string})=>c.cropId==='maize');selectedId=candidate.id;
   expect(body.store).toBe(false);expect(input.localContext.weather.kind).toBe('forecast');
   expect(input.facts.confirmedSoil.samples[0]).toMatchObject({reportId:report.id,collectionDate:'2026-10-01',markers:[{parameter:'ph',value:6.4,method:'Water suspension',soilWaterRatio:'1:2.5'}]});
   return new Response(JSON.stringify({id:'planning-fixture-response',model:'fixture-received-model',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summaryCode:'conditional_options',choices:[{candidateId:candidate.id,reasonCodes:['source_window','water_confirmation','history_repetition','cultivar_confirmation']}]})}]}],usage:{input_tokens:100,output_tokens:100}}),{status:200});
  });
  const d=deps({config:{...h.config,RUNTIME_MODE:'live',MODEL_API_KEY:'fixture-key',META_BASE_URL:'https://fixture.invalid'},fetchImpl});
  const context=await planningContext(d,auth.ownerId,f.id);const result=await generate(d,auth,f.id);
  expect(requests).toBe(1);expect(result.comparisonShortlist[0]?.candidateId).toBe(selectedId);expect(result.modelInvocation).toMatchObject({model:'fixture-received-model',provider:'meta',responseDeleted:true,status:'succeeded'});
  expect(result.comparisonShortlist[0]?.reason).not.toContain('repeats');
  expect(result.rotationDraft[0]?.plannedSowingDate).toBe(context.candidates.find(c=>c.id===selectedId)?.sowing);
  const stored=(await h.pool.query('SELECT owner_id,session_id FROM ai_invocations WHERE id=$1',[result.modelInvocation!.id])).rows[0];expect(stored).toEqual({owner_id:auth.ownerId,session_id:auth.sessionId});
 });

 it('rejects invented Meta fields/claims and preserves deterministic source options with response deletion',async()=>{
  const{f,auth}=await farm();const p={kind:'meta' as const,provenance:'meta_live' as const,billable:false,call:vi.fn(async()=>({ok:true as const,result:{provenance:'meta_live' as const,model:'fixture-model',responseId:'test-private-response',requestId:'test-request',outputText:JSON.stringify({summaryCode:'conditional_options',summary:'Nitrogen improves yield',choices:[{candidateId:'candidate-1',reasonCodes:['nitrogen_boost']}]}),functionCalls:[],usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0},latencyMs:0,retries:0}})),deleteResponse:vi.fn(async()=>({ok:true,code:null}))};
  const fetchImpl=vi.fn(async()=>{throw Error('Public provider unavailable in test')});const d=deps({config:{...h.config,RUNTIME_MODE:'live',MODEL_API_KEY:'fixture-key'},provider:p,fetchImpl});
  const result=await generate(d,auth,f.id);expect(p.call).toHaveBeenCalledTimes(1);expect(p.deleteResponse).toHaveBeenCalledWith('test-private-response');expect(result.retryAfter).not.toBeNull();expect(result.summary).not.toContain('Nitrogen');expect(result.comparisonShortlist.length).toBeGreaterThan(0);
  expect((await ensurePlanningReview(d,auth,f.id)).reviewId).toBe(result.reviewId);expect(p.call).toHaveBeenCalledTimes(1);
 });
});
