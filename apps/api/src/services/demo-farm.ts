import {FarmWorkspaceState,type FarmWorkspaceState as WorkspaceState} from '@harvest/contracts';
import type {Pool} from '../db/pool';
import type {PoolClient} from 'pg';
import type {Config} from '../config';
import {withTransaction} from '../db/pool';
import {payloadHash} from './hash';
import {appendFact,getFarm} from './farms';
import {boundaryMetrics,getWorkspace} from './workspace';
import {DEMO_FARM_NAME,DEMO_LABEL,DEMO_SAMPLE_SOURCE,DEMO_SEED_VERSION,LEGACY_DEMO_NAMES,LEGACY_V5_ROTATION_PLANS,istDate,mergeTrackRecord,seedDemoCare,seedDemoJournal} from './demo-track-record';
const SOURCE='https://uasmandya.edu.in/ars-arasikere';
const BOUNDARY_NOTE='Prefilled outline around a coarse public research-site reference; verify the boundary before using it as a field record.';
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

/** Seed v5 saved three future seasons; v6 saves none. Removes exactly those records (matched by id and unedited seed fields) and nothing the farmer added. */
export function withoutV5DemoPlans(input:WorkspaceState):WorkspaceState{
 const state=structuredClone(input);
 state.rotationPlans=state.rotationPlans.filter(r=>{const seeded=LEGACY_V5_ROTATION_PLANS.find(p=>p.id===r.id);return !(seeded&&Object.entries(seeded).every(([k,v])=>payloadHash(v)===payloadHash((r as Record<string,unknown>)[k])))});
 return state;
}

type FactValue=string|number|boolean;
/** Appends a fact only when the current one differs (value, basis or source), so a repeated load writes nothing. Returns whether it wrote. */
async function ensureFact(c:PoolClient,ownerId:string,farmId:string,key:string,value:FactValue,opts:{basis:'derived'|'farmer_reported';source:string;onlyIfAbsent?:boolean}){
 const previous=(await c.query<{id:string;value:unknown;basis:string;source:string|null}>('SELECT id,value,basis,source FROM farm_facts WHERE farm_id=$1 AND owner_id=$2 AND fact_key=$3 AND superseded_by IS NULL FOR UPDATE',[farmId,ownerId,key])).rows[0];
 if(previous&&(opts.onlyIfAbsent||(JSON.stringify(previous.value)===JSON.stringify(value)&&previous.basis===opts.basis&&previous.source===opts.source)))return false;
 await appendFact(c,ownerId,farmId,key,{value,basis:opts.basis,confirmed:false,source:opts.source},previous?.id??null);return true;
}

export interface DemoFarmDeps{pool:Pool;config:Config;now?:(()=>Date)|undefined}

/**
 * Brings an owned demo farm to the two-year track record (spec sections 1 to 4) inside the caller's transaction:
 * legacy clean-up for seed versions 1 to 5 (v5 saved three future seasons that v6 no longer seeds), merge by id, marker facts, rename of a seed-named farm, journal and care seeds.
 * When the workspace changed: version bump, queued year-plan and monitor jobs cancelled, year plans archived (kept for
 * audit, never shown; the Plan tab rebuilds one) and the monitor snapshot cleared.
 */
async function applyTrackRecord(c:PoolClient,deps:DemoFarmDeps,ownerId:string,farmId:string,loadDate:string,marker:number){
 await c.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 FOR UPDATE',[farmId,ownerId]);
 const workspace=(await c.query<{state:unknown}>('SELECT state FROM farm_workspaces WHERE farm_id=$1 FOR UPDATE',[farmId])).rows[0];
 const old=FarmWorkspaceState.parse(workspace?.state??demoState(null));
 const cleaned=withoutV5DemoPlans([1,2,3,4].includes(marker)?withoutLegacyDemoRecords(old):old);
 const next=mergeTrackRecord(cleaned,loadDate);
 if(!workspace)await c.query('INSERT INTO farm_workspaces(farm_id,version,state) VALUES($1,1,$2::jsonb)',[farmId,JSON.stringify(next)]);
 else if(JSON.stringify(old)!==JSON.stringify(next)){
  await c.query('UPDATE farm_workspaces SET state=$2::jsonb,version=version+1 WHERE farm_id=$1',[farmId,JSON.stringify(next)]);
  await c.query("UPDATE jobs SET cancel_requested=true WHERE owner_id=$1 AND payload->>'farmId'=$2 AND type IN ('farm.year-plan','farm.monitor') AND state IN ('queued','running')",[ownerId,farmId]);
  await c.query('UPDATE farm_year_plans SET archived_at=now() WHERE farm_id=$1 AND owner_id=$2 AND archived_at IS NULL',[farmId,ownerId]);
  await c.query("UPDATE farm_monitors SET snapshot=NULL,meta_review=NULL,reviewed_fingerprint=NULL,changes='[]'::jsonb WHERE farm_id=$1",[farmId]);
 }
 const derived={basis:'derived' as const,source:SOURCE};
 let changed=false;
 for(const [key,value] of [['demo_seed_version',DEMO_SEED_VERSION],['demo_prefilled',true],['demo_illustrative',false],['demo_track_record',true],['demo_source',`${DEMO_LABEL}. Public reference: ${SOURCE}`]] as const)changed=await ensureFact(c,ownerId,farmId,key,value,derived)||changed;
 // The profile form's "Rain plus some irrigation"; a value the farmer set stays.
 changed=await ensureFact(c,ownerId,farmId,'irrigation_category','supplemental',{basis:'farmer_reported',source:DEMO_SAMPLE_SOURCE,onlyIfAbsent:true})||changed;
 const renamed=(await c.query('UPDATE farms SET name=$3 WHERE id=$1 AND owner_id=$2 AND name=ANY($4::text[])',[farmId,ownerId,DEMO_FARM_NAME,[...LEGACY_DEMO_NAMES]])).rowCount;
 if(changed||renamed)await c.query('UPDATE farms SET version=version+1 WHERE id=$1 AND owner_id=$2',[farmId,ownerId]);
 await seedDemoJournal(c,deps.config,ownerId,farmId,loadDate);
 await seedDemoCare(c,deps.config,ownerId,farmId,loadDate);
}

export async function demoFarm(deps:DemoFarmDeps,ownerId:string){
 const {pool}=deps;const loadDate=istDate((deps.now??(()=>new Date()))());
 const id=await withTransaction(pool,async c=>{
  await c.query('SELECT id FROM owners WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[ownerId]);
  const existing=(await c.query<{farm_id:string}>('SELECT d.farm_id FROM demo_farms d JOIN farms f ON f.id=d.farm_id WHERE d.owner_id=$1 AND f.deleted_at IS NULL',[ownerId])).rows[0];
  if(existing){
   const marker=(await c.query<{value:unknown}>("SELECT value FROM farm_facts WHERE farm_id=$1 AND fact_key='demo_seed_version' AND superseded_by IS NULL",[existing.farm_id])).rows[0]?.value;
   await applyTrackRecord(c,deps,ownerId,existing.farm_id,loadDate,Number(marker));
   return existing.farm_id;
  }
  const lon=76.25,lat=13.25,d=0.00045;
  const boundary={type:'Polygon' as const,coordinates:[[[lon-d,lat-d],[lon+d,lat-d],[lon+d,lat+d],[lon-d,lat+d],[lon-d,lat-d]] as [number,number][]]};
  const area=boundaryMetrics(boundary).areaHectares;
  const farm=(await c.query<{id:string}>(`INSERT INTO farms(owner_id,name,state_code,district_code,district_name,lat,lon,location_geojson,location_precision,area_hectares)
    VALUES($1,$2,'IN-KA','IN-KA-hassan','Hassan',$3,$4,$5::jsonb,'approximate',$6) RETURNING id`,[ownerId,DEMO_FARM_NAME,lat,lon,JSON.stringify({type:'Point',coordinates:[lon,lat]}),area])).rows[0]!.id;
  await c.query("INSERT INTO farm_facts(owner_id,farm_id,fact_key,value,unit,provenance,basis,confirmed,source) VALUES($1,$2,'area_hectares',$3::jsonb,'ha','default','derived',false,$4)",[ownerId,farm,JSON.stringify(area),SOURCE]);
  // Created with every record at workspace version 1; applyTrackRecord then finds nothing to merge.
  await c.query('INSERT INTO farm_workspaces(farm_id,version,state) VALUES($1,1,$2::jsonb)',[farm,JSON.stringify(mergeTrackRecord(demoState(boundary),loadDate))]);
  await c.query('INSERT INTO farm_monitors(farm_id,enabled,meta_enabled,interval_hours,next_check_at) VALUES($1,true,true,24,now())',[farm]);await c.query('INSERT INTO demo_farms(owner_id,farm_id) VALUES($1,$2)',[ownerId,farm]);
  await applyTrackRecord(c,deps,ownerId,farm,loadDate,DEMO_SEED_VERSION);
  // The farm row was just inserted at version 1; facts added in the same transaction are part of its first version.
  await c.query('UPDATE farms SET version=1 WHERE id=$1',[farm]);
  return farm;
 });
 const farm=(await getFarm(pool,ownerId,id))!;const source=farm.facts.demo_source?.source??SOURCE;
 const workspace=await getWorkspace(pool,ownerId,id);
 const counts=(await pool.query<{journal:number;care:number}>('SELECT (SELECT count(*)::int FROM journal_entries WHERE owner_id=$1 AND farm_id=$2) journal,(SELECT count(*)::int FROM farm_cycle_actions WHERE owner_id=$1 AND farm_id=$2 AND mode=$3) care',[ownerId,id,deps.config.RUNTIME_MODE])).rows[0]!;
 return{farm,workspace,demo:{prefilledBoundary:true as const,label:DEMO_LABEL,source,sources:[source],boundary:BOUNDARY_NOTE,records:{cycles:workspace.cycles.length,seasons:workspace.rotationPlans.length,journalEntries:counts.journal,careActions:counts.care}}};
}
