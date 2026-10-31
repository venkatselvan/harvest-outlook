import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {StageDefinition} from '@harvest/contracts';
import {pickStageSet} from '../src/plans/catalogue-resolver';
import {getFarmContextHandler} from '../src/agent/tools/handlers';
import {login,setupHarness,farmBody,type Harness,type Client} from './helpers';

let h:Harness,a:Client,b:Client,auth:{ownerId:string;sessionId:string};
beforeAll(async()=>{
 h=await setupHarness();a=await login(h.app);b=await login(h.app);
 const row=(await h.pool.query('SELECT id,owner_id FROM sessions ORDER BY created_at LIMIT 1')).rows[0];auth={ownerId:row.owner_id,sessionId:row.id};
});
afterAll(async()=>h?.close());

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
  const monitor=(await h.pool.query('SELECT enabled,meta_enabled FROM farm_monitors WHERE farm_id=$1',[first.farm.id])).rows[0];expect(monitor).toEqual({enabled:true,meta_enabled:true});
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
