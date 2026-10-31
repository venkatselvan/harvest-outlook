import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import sharp from 'sharp';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {StageDefinition,type BoundaryAssessmentInput} from '@harvest/contracts';
import type {TextModelProvider} from '../src/agent/provider';
import {pickStageSet} from '../src/plans/catalogue-resolver';
import {assessBoundary} from '../src/services/boundary-assessment';
import {Budget} from '../src/services/budget';
import {getFarmContextHandler} from '../src/agent/tools/handlers';
import {login,setupHarness,farmBody,type Harness,type Client} from './helpers';

const input:BoundaryAssessmentInput={boundary:{type:'Polygon',coordinates:[[[76.9349,11.0131],[76.9359,11.0131],[76.9359,11.014],[76.9349,11.014],[76.9349,11.0131]]]}};
const suggestions={irrigation:{value:'supplemental',confidence:'medium',reason:'Regional wells and canal systems coexist with rainfed cultivation; visible managed fields make supplemental watering a possibility.',uncertainties:['Actual field water access is unconfirmed.'],sources:['regional-irrigation','satellite-snapshot']},landCondition:{summary:'The selected outline appears within managed agricultural land; surface colour cannot establish soil moisture or drainage.',confidence:'medium',uncertainties:['This is a visual impression from a dated satellite scene.'],sources:['satellite-snapshot']}};
let h:Harness,a:Client,b:Client,auth:{ownerId:string;sessionId:string};let jpeg:Buffer;
beforeAll(async()=>{
 h=await setupHarness();a=await login(h.app);b=await login(h.app);
 const row=(await h.pool.query('SELECT id,owner_id FROM sessions ORDER BY created_at LIMIT 1')).rows[0];auth={ownerId:row.owner_id,sessionId:row.id};
 jpeg=await sharp({create:{width:768,height:768,channels:3,background:'#47743d'}}).png().toBuffer();
});
afterAll(async()=>h?.close());
function publicFetch(){return vi.fn(async(request:RequestInfo|URL)=>{
 const url=String(request);let data:unknown;
 if(url.includes('geoboundaries.org')){const level=url.includes('ADM1')?'ADM1':'ADM2';data={simplifiedGeometryGeoJSON:`https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/${level}/test.geojson`,boundaryLicense:'Test fixture licence',boundarySource:'Synthetic test geometry',boundaryYearRepresented:level==='ADM1'?'2011':'2021'};}
 else if(url.includes('github.com'))data={type:'FeatureCollection',features:[{properties:{shapeName:url.includes('ADM1')?'Tamil Nadu':'Coimbatore'},geometry:{type:'Polygon',coordinates:[[[75,10],[79,10],[79,13],[75,13],[75,10]]]}}]};
 else if(url.includes('/api/stac/'))data={features:[{id:'SYNTHETIC_TEST_SCENE',properties:{datetime:'2026-05-12T05:06:49.024Z','eo:cloud_cover':15}}]};
 else if(url.includes('/api/data/'))return new Response(new Uint8Array(jpeg),{status:200,headers:{'content-type':'image/png'}});
 else if(url.includes('open-meteo'))data=JSON.parse(readFileSync(new URL('./fixtures/openmeteo/forecast_hassan.json',import.meta.url),'utf8')).body;
 else throw new Error('Unexpected provider request');
 return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 });}
function provider(output:unknown=suggestions){const call=vi.fn(async(_request:Parameters<TextModelProvider['call']>[0])=>({ok:true as const,result:{model:'muse-spark-1.3',provenance:'meta_live' as const,responseId:'fixture-response',requestId:'fixture-request',outputText:JSON.stringify(output),functionCalls:[],usage:{inputTokens:100,outputTokens:100,cachedInputTokens:0},latencyMs:10,retries:0}}));const deleteResponse=vi.fn(async()=>({ok:true,code:null}));return{kind:'meta' as const,provenance:'meta_live' as const,billable:true,call,deleteResponse};}
const deps=(p:TextModelProvider,f=publicFetch())=>({pool:h.pool,storage:h.storage,budget:Budget.fromConfig(h.pool,h.config),config:{...h.config,RUNTIME_MODE:'live' as const,MODEL_API_KEY:'test-fixture-key'},provider:p,fetchImpl:f as typeof fetch});

describe('boundary assessment privacy and source checks',()=>{
 it('does not contact providers or invent model invocation outside live mode',async()=>{
  const p=provider(),f=publicFetch();const result=await assessBoundary({...deps(p,f),config:h.config},auth,input,randomUUID());
  expect(result.status).toBe('unavailable');expect(result.modelInvocation).toBeNull();expect(p.call).not.toHaveBeenCalled();expect(f).not.toHaveBeenCalled();
 });
 it('checks private photo ownership before any external fetch or provider spend',async()=>{
  const p=provider(),f=publicFetch();await expect(assessBoundary(deps(p,f),auth,{...input,mediaId:randomUUID()},randomUUID())).rejects.toMatchObject({statusCode:404});
  expect(f).not.toHaveBeenCalled();expect(p.call).not.toHaveBeenCalled();
 });
 it('grounds provisional irrigation in regional context plus actual supplied snapshot, caps confidence and deletes provider response',async()=>{
  const p=provider(),f=publicFetch();const result=await assessBoundary(deps(p,f),auth,input,randomUUID());
  expect(result.location).toMatchObject({stateId:'IN-TN',districtId:'IN-TN-coimbatore'});
  expect(result.suggestions.irrigation).toMatchObject({value:'supplemental',confidence:'low'});
  expect(result.requiresConfirmation).toBe(true);expect(result.confidenceBasis).toBe('uncalibrated_model_assessment');
  expect(result.imagery).toMatchObject({status:'available',kind:'map_snapshot',imageryDate:'2026-05-12T05:06:49.024Z'});
  expect(p.call.mock.calls[0]![0]).toMatchObject({store:false,model:'muse-spark-1.3'});
  const supplied=p.call.mock.calls[0]![0].input as {content:{text:string}[]}[];
  expect(JSON.parse(supplied[0]!.content[0]!.text).weather.kind).toBe('forecast');
  expect(p.call.mock.calls[0]![0].instructions).toContain('never use it to infer rain or conditions at the satellite capture date');
  expect(p.deleteResponse).toHaveBeenCalledWith('fixture-response');expect(result.modelInvocation).toMatchObject({requestedStorage:false,responseDeleted:true,status:'succeeded',model:'muse-spark-1.3'});
  expect((await a.call('GET',result.imagery.previewUrl!)).statusCode).toBe(200);
  expect((await b.call('GET',result.imagery.previewUrl!)).statusCode).toBe(404);
  const again=await assessBoundary(deps(p,f),auth,input,randomUUID());expect(again.id).toBe(result.id);expect(p.call).toHaveBeenCalledTimes(1);
 });
 it('withholds malformed or fabricated-source suggestions, and still deletes the known response',async()=>{
  const p=provider({...suggestions,irrigation:{...suggestions.irrigation,sources:['invented-source']}});
  const shifted={boundary:{...input.boundary,coordinates:[input.boundary.coordinates[0]!.map(p=>[p[0]+0.01,p[1]] as [number,number])]}};
  const result=await assessBoundary(deps(p),auth,shifted,randomUUID());
  expect(result.status).toBe('partial');expect(result.suggestions.irrigation.value).toBe('unknown');expect(p.deleteResponse).toHaveBeenCalledWith('fixture-response');
  expect(result.modelInvocation?.responseDeleted).toBe(true);
 });
 it('limits oversized assessments before any source request',async()=>{
  const f=publicFetch(),p=provider();const huge={boundary:{type:'Polygon' as const,coordinates:[[[75,10],[78,10],[78,13],[75,13],[75,10]] as [number,number][]]}};
  await expect(assessBoundary(deps(p,f),auth,huge,randomUUID())).rejects.toMatchObject({statusCode:400});expect(f).not.toHaveBeenCalled();
 });
 it('scopes real running invocation metadata by owner and session and hides expired activity',async()=>{
  const own=randomUUID(),foreign=randomUUID(),expired=randomUUID();
  const other=(await h.pool.query('SELECT id,owner_id FROM sessions WHERE id<>$1 LIMIT 1',[auth.sessionId])).rows[0];
  await h.pool.query("INSERT INTO ai_invocations(id,owner_id,session_id,provider,requested_model,purpose,status) VALUES($1,$2,$3,'meta','muse-spark-1.3','boundary_context','running'),($4,$5,$6,'meta','foreign-model','boundary_context','running')",[own,auth.ownerId,auth.sessionId,foreign,other.owner_id,other.id]);
  await h.pool.query("INSERT INTO ai_invocations(id,owner_id,session_id,provider,requested_model,purpose,status,started_at) VALUES($1,$2,$3,'meta','old-model','boundary_context','running',now()-interval '5 minutes')",[expired,auth.ownerId,auth.sessionId]);
  const activity=(await a.call('GET','/api/v1/ai/activity')).json().data.invocations;
  expect(activity.map((x:{id:string})=>x.id)).toEqual([own]);expect(activity[0]).toMatchObject({model:null,requestedModel:'muse-spark-1.3',processing:'standard'});
  await h.pool.query("UPDATE ai_invocations SET status='failed',finished_at=now() WHERE id=ANY($1::uuid[])",[[own,foreign,expired]]);
 });
});

describe('reusable boundary-only public research-site demo',()=>{
 it('creates one farm per owner under concurrent clicks and preserves existing farms',async()=>{
  const existing=(await a.call('POST','/api/v1/farms',{payload:farmBody({name:'Existing private farm',facts:{}})})).json().data;
  const before=(await a.call('GET',`/api/v1/farms/${existing.id}`)).json().data;
  const [one,two]=await Promise.all([a.call('POST','/api/v1/farms/demo',{payload:{}}),a.call('POST','/api/v1/farms/demo',{payload:{}})]);
  expect(one.statusCode).toBe(200);expect(two.statusCode).toBe(200);const first=one.json().data;
  expect(first.farm.id).toBe(two.json().data.farm.id);expect(first.demo.prefilledBoundary).toBe(true);expect(first.farm.facts.demo_prefilled.value).toBe(true);expect(first.farm.facts.demo_illustrative.value).toBe(false);
  expect(first.farm.facts.demo_source.value).toContain('uasmandya.edu.in/ars-arasikere');
  expect(first.farm.location).toMatchObject({stateCode:'IN-KA',districtId:'IN-KA-hassan',lat:13.25,lon:76.25,precision:'approximate'});
  const year=new Date().getUTCMonth()>=5?new Date().getUTCFullYear():new Date().getUTCFullYear()-1;
  const stages=StageDefinition.array().parse(JSON.parse(readFileSync(new URL('../../../data/curated/stages/ginger.hassan-kharif.stages.json',import.meta.url),'utf8')));
  expect(pickStageSet(stages,{stateCode:first.farm.location.stateCode,districtCode:first.farm.location.districtId})?.defs.length).toBeGreaterThan(0);
  expect(first.workspace.cycles).toEqual([]);expect(first.workspace.rotationPlans).toEqual([]);expect(first.workspace.previousHarvest).toEqual({status:'unknown'});
  expect((await getFarmContextHandler({farmId:first.farm.id},{pool:h.pool,ownerId:auth.ownerId,mode:'synthetic',requestId:randomUUID(),agentRunId:randomUUID(),asOf:new Date().toISOString()})).farm.demo).toMatchObject({prefilledBoundary:true});
  const monitor=(await h.pool.query('SELECT enabled,meta_enabled FROM farm_monitors WHERE farm_id=$1',[first.farm.id])).rows[0];expect(monitor).toEqual({enabled:false,meta_enabled:false});
  expect((await a.call('GET',`/api/v1/farms/${existing.id}`)).json().data).toEqual(before);
  const other=(await b.call('POST','/api/v1/farms/demo',{payload:{}})).json().data;expect(other.farm.id).not.toBe(first.farm.id);
  expect((await b.call('GET',`/api/v1/farms/${first.farm.id}/workspace`)).statusCode).toBe(404);
 });
 it('preserves farmer-edited demo records while upgrading the boundary-only marker',async()=>{
  const first=(await a.call('POST','/api/v1/farms/demo',{payload:{}})).json().data;
  const old={boundary:first.workspace.boundary,previousHarvest:{status:'none'},cycles:[{id:'my-cycle',cropId:'maize',sowingDate:'2026-09-30',stage:'growing',notes:'My own edited farming record'}],rotationPlans:[]};
  await h.pool.query("UPDATE farm_facts SET value='3'::jsonb WHERE farm_id=$1 AND fact_key='demo_seed_version' AND superseded_by IS NULL",[first.farm.id]);
  await h.pool.query('UPDATE farm_workspaces SET version=3,state=$2::jsonb WHERE farm_id=$1',[first.farm.id,JSON.stringify(old)]);
  const preserved=(await a.call('POST','/api/v1/farms/demo',{payload:{}})).json().data;
  expect(preserved.workspace.version).toBe(3);expect(preserved.workspace.cycles[0].notes).toBe('My own edited farming record');expect(preserved.workspace.previousHarvest.status).toBe('none');
 });
});
