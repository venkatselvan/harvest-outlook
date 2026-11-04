import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {setupHarness,login,farmBody,testConfig,type Harness,type Client} from './helpers';
import {fakePlanetary} from './fixtures/sentinel2/fake-provider';
import {enqueueDueSatelliteRefreshes,satelliteDay} from '../src/services/satellite-schedule';
import {createSatelliteRefreshHandler} from '../src/worker/handlers/satellite';
import {ndviSeries} from '../src/services/today/ndvi';
let h:Harness,client:Client;
beforeAll(async()=>{h=await setupHarness();client=await login(h.app)});
afterAll(async()=>h?.close());
const boundary={type:'Polygon',coordinates:[[[76.2495,13.2495],[76.2505,13.2495],[76.2505,13.2505],[76.2495,13.2505],[76.2495,13.2495]]]};
async function farm(withField = false){
 const id=(await client.call('POST','/api/v1/farms',{payload:farmBody({facts:{}})})).json().data.id;
 const response=await client.call('PUT',`/api/v1/farms/${id}/workspace`,{payload:{expectedVersion:0,boundary,previousHarvest:{status:'unknown'},cycles:[],rotationPlans:[],fields:withField ? [{id:randomUUID(),name:"North field",boundary}] : []}});
 expect(response.statusCode).toBe(200);
 return (await h.pool.query<{id:string;owner_id:string}>('SELECT id,owner_id FROM farms WHERE id=$1',[id])).rows[0]!;
}
describe('daily satellite refresh',()=>{
 it('queues farms without a crop once per IST day, independently of disabled monitoring, and avoids duplicate workers',async()=>{
  const f=await farm();await h.pool.query('UPDATE farm_monitors SET enabled=false WHERE farm_id=$1',[f.id]);
  expect(await enqueueDueSatelliteRefreshes(h.pool,'synthetic',new Date('2026-11-04T10:00:00Z'))).toBe(0);
  await Promise.all([enqueueDueSatelliteRefreshes(h.pool,'live',new Date('2026-11-04T10:00:00Z')),enqueueDueSatelliteRefreshes(h.pool,'live',new Date('2026-11-04T10:00:00Z'))]);
  expect((await h.pool.query("SELECT id FROM jobs WHERE type='satellite.refresh' AND payload->>'farmId'=$1",[f.id])).rowCount).toBe(1);
  await enqueueDueSatelliteRefreshes(h.pool,'live',new Date('2026-11-04T18:30:00Z'));
  expect((await h.pool.query("SELECT id FROM jobs WHERE type='satellite.refresh' AND payload->>'farmId'=$1",[f.id])).rowCount).toBe(2);
 });
 it('bypasses an empty cached catalogue, fetches newly published imagery and warms both image sizes',async()=>{
  const f=await farm(true),config=testConfig({RUNTIME_MODE:'live'});
  const to=satelliteDay(new Date()),from=new Date(Date.parse(`${to}T00:00:00Z`)-30*86400_000).toISOString().slice(0,10);
  const empty=fakePlanetary([]);
  await ndviSeries({config,pool:h.pool,fetchImpl:empty.fetchImpl},f.owner_id,f.id,{from,to});
  const date=new Date(Date.parse(`${to}T00:00:00Z`)-86400_000).toISOString().slice(0,10);
  const provider=fakePlanetary([{id:'S2A_DAILY_TEST',datetime:`${date}T05:22:31Z`,field:{ndvi:0.6}}]);
  const handler=createSatelliteRefreshHandler({config,pool:h.pool,storage:h.storage,fetchImpl:provider.fetchImpl});
  await handler({id:randomUUID(),owner_id:f.owner_id,type:'satellite.refresh',attempt:1,max_attempts:3,payload:{farmId:f.id,day:to}},{pool:h.pool,heartbeat:async()=>{},isCancelled:async()=>false});
  expect(provider.calls.some(c=>c.path.endsWith('/search'))).toBe(true);
  const rows=(await h.pool.query('SELECT usable,image_keys FROM ndvi_scene_stats WHERE farm_id=$1',[f.id])).rows;
  expect(rows).toHaveLength(1);expect(rows[0].usable).toBe(true);expect(Object.keys(rows[0].image_keys)).toHaveLength(3);
  await handler({id:randomUUID(),owner_id:f.owner_id,type:'satellite.refresh',attempt:2,max_attempts:3,payload:{farmId:f.id,day:to}},{pool:h.pool,heartbeat:async()=>{},isCancelled:async()=>false});
  expect(provider.calls.filter(c=>c.path.endsWith('feature.npy'))).toHaveLength(2);
 });
});
