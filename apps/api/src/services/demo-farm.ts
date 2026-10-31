import {FarmWorkspaceState,type FarmWorkspaceState as WorkspaceState} from '@harvest/contracts';
import type {Pool} from '../db/pool';
import type {PoolClient} from 'pg';
import {withTransaction} from '../db/pool';
import {payloadHash} from './hash';
import {appendFact,getFarm} from './farms';
import {boundaryMetrics,getWorkspace} from './workspace';
const SOURCE='https://uasmandya.edu.in/ars-arasikere';
const LABEL='Demo field with a prefilled boundary near the public ARS Arsikere research-site reference';
export function demoState(boundary:unknown){return FarmWorkspaceState.parse({boundary,previousHarvest:{status:'unknown'},cycles:[],rotationPlans:[]})}
/** Remove only exact legacy seed records. Farmer edits and separately added records remain intact. */
export function withoutLegacyDemoRecords(input:WorkspaceState):WorkspaceState{
 const state=structuredClone(input);const same=(a:unknown,b:unknown)=>payloadHash(a)===payloadHash(b);
 const years=new Set([...state.cycles.map(c=>c.sowingDate.slice(0,4)),...state.rotationPlans.map(r=>String(r.id==='demo-rotation'?r.year-1:r.year)),...(state.previousHarvest.status==='known'?[state.previousHarvest.harvestDate.slice(0,4)]:[])]);
 const expectedCycles:unknown[]=[],expectedRotations:unknown[]=[],expectedHistory:unknown[]=[];
 for(const year of years){const y=Number(year);if(!Number.isInteger(y))continue;
  expectedHistory.push({status:'known',cropId:'maize',cropName:'Maize (illustrative previous crop)',harvestDate:`${y}-04-20`});
  for(const site of ['TNAU','research-station'])expectedCycles.push({id:'demo-cycle',cropId:'ginger',cropName:'Ginger (illustrative crop)',sowingDate:`${y}-06-01`,stage:'growing',notes:`Illustrative planning record, not an observation of ${site} operations.`});
  for(const productName of ['Fresh ginger','Fresh ginger rhizome'])for(const old of [true,false])expectedRotations.push({id:'demo-ginger-scenario',cropId:'ginger',cropName:'Ginger (illustrative season)',productId:'ginger-fresh',productName,year:y,season:'Illustrative ginger season',plannedSowingDate:`${y}-06-01`,plannedHarvestDate:old?`${y+1}-02-01`:`${y+1}-01-15`,notes:old?'Illustrative June sowing and late harvest scenario within broad TNAU ginger windows; timing is not a biological forecast.':'Illustrative June sowing and January harvest scenario within the curated Hassan calendar-day window; timing is not a biological forecast.'});
  expectedRotations.push({id:'demo-rotation',cropId:'maize',cropName:'Maize (illustrative next season)',year:y+1,season:'Kharif',plannedSowingDate:`${y+1}-06-01`,notes:'Illustrative maize scenario; the June window assumes irrigation can be confirmed. No rotation score or current research activity is implied.'});
 }
 if(expectedHistory.some(e=>same(e,state.previousHarvest)))state.previousHarvest={status:'unknown'};
 state.cycles=state.cycles.filter(c=>!expectedCycles.some(e=>same(e,c)));
 state.rotationPlans=state.rotationPlans.filter(r=>!expectedRotations.some(e=>same(e,r)));
 return state;
}

async function setFact(c:PoolClient,ownerId:string,farmId:string,key:string,value:string|number|boolean){const previous=(await c.query<{id:string}>('SELECT id FROM farm_facts WHERE farm_id=$1 AND owner_id=$2 AND fact_key=$3 AND superseded_by IS NULL FOR UPDATE',[farmId,ownerId,key])).rows[0];await appendFact(c,ownerId,farmId,key,{value,basis:'derived',confirmed:false,source:SOURCE},previous?.id??null)}
export async function demoFarm(pool:Pool,ownerId:string){
 const id=await withTransaction(pool,async c=>{
  await c.query('SELECT id FROM owners WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[ownerId]);
  const existing=(await c.query<{farm_id:string}>('SELECT d.farm_id FROM demo_farms d JOIN farms f ON f.id=d.farm_id WHERE d.owner_id=$1 AND f.deleted_at IS NULL',[ownerId])).rows[0];
  if(existing){
   const marker=(await c.query<{value:unknown}>("SELECT value FROM farm_facts WHERE farm_id=$1 AND fact_key='demo_seed_version' AND superseded_by IS NULL",[existing.farm_id])).rows[0]?.value;
   if([1,2,3].includes(Number(marker))){
    await c.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 FOR UPDATE',[existing.farm_id,ownerId]);
    const workspace=(await c.query<{state:unknown}>('SELECT state FROM farm_workspaces WHERE farm_id=$1 FOR UPDATE',[existing.farm_id])).rows[0];
    if(workspace){const old=FarmWorkspaceState.parse(workspace.state),next=withoutLegacyDemoRecords(old);if(JSON.stringify(old)!==JSON.stringify(next)){
      await c.query('UPDATE farm_workspaces SET state=$2::jsonb,version=version+1 WHERE farm_id=$1',[existing.farm_id,JSON.stringify(next)]);
      await c.query("UPDATE jobs SET cancel_requested=true WHERE owner_id=$1 AND payload->>'farmId'=$2 AND type IN ('farm.planning-review','farm.monitor') AND state IN ('queued','running')",[ownerId,existing.farm_id]);
      await c.query('UPDATE farm_planning_reviews SET archived_at=now() WHERE farm_id=$1 AND owner_id=$2 AND archived_at IS NULL',[existing.farm_id,ownerId]);
      await c.query("UPDATE farm_monitors SET snapshot=NULL,meta_review=NULL,reviewed_fingerprint=NULL,changes='[]'::jsonb WHERE farm_id=$1",[existing.farm_id]);
    }}
    await setFact(c,ownerId,existing.farm_id,'demo_seed_version',4);await setFact(c,ownerId,existing.farm_id,'demo_prefilled',true);await setFact(c,ownerId,existing.farm_id,'demo_illustrative',false);await setFact(c,ownerId,existing.farm_id,'demo_source',`${LABEL}. Public reference: ${SOURCE}`);
    await c.query("UPDATE farms SET name='ARS Arsikere demo field',version=version+1 WHERE id=$1 AND owner_id=$2 AND name IN ('ARS Arsikere reference · illustrative demo','TNAU research site · illustrative demo')",[existing.farm_id,ownerId]);
   }
   return existing.farm_id;
  }
  const lon=76.25,lat=13.25,d=0.00045;
  const boundary={type:'Polygon' as const,coordinates:[[[lon-d,lat-d],[lon+d,lat-d],[lon+d,lat+d],[lon-d,lat+d],[lon-d,lat-d]] as [number,number][]]};
  const area=boundaryMetrics(boundary).areaHectares;
  const farm=(await c.query<{id:string}>(`INSERT INTO farms(owner_id,name,state_code,district_code,district_name,lat,lon,location_geojson,location_precision,area_hectares)
    VALUES($1,'ARS Arsikere demo field','IN-KA','IN-KA-hassan','Hassan',$2,$3,$4::jsonb,'approximate',$5) RETURNING id`,[ownerId,lat,lon,JSON.stringify({type:'Point',coordinates:[lon,lat]}),area])).rows[0]!.id;
  for(const [key,value] of [['demo_prefilled',true],['demo_illustrative',false],['demo_source',`${LABEL}. Public reference: ${SOURCE}`],['demo_seed_version',4],['area_hectares',area]] as const){await c.query("INSERT INTO farm_facts(owner_id,farm_id,fact_key,value,unit,provenance,basis,confirmed,source) VALUES($1,$2,$3,$4::jsonb,$5,'default','derived',false,$6)",[ownerId,farm,key,JSON.stringify(value),key==='area_hectares'?'ha':null,SOURCE]);}
  await c.query('INSERT INTO farm_workspaces(farm_id,version,state) VALUES($1,1,$2::jsonb)',[farm,JSON.stringify(demoState(boundary))]);await c.query('INSERT INTO farm_monitors(farm_id,enabled,meta_enabled,interval_hours,next_check_at) VALUES($1,true,true,24,now())',[farm]);await c.query('INSERT INTO demo_farms(owner_id,farm_id) VALUES($1,$2)',[ownerId,farm]);return farm;
 });
 const farm=(await getFarm(pool,ownerId,id))!;const source=farm.facts.demo_source?.source??SOURCE;
 return{farm,workspace:await getWorkspace(pool,ownerId,id),demo:{prefilledBoundary:true as const,label:String(farm.facts.demo_source?.value??LABEL),source,sources:[source],boundary:'Prefilled outline around a coarse public research-site reference; verify the boundary before using it as a field record.'}};
}
