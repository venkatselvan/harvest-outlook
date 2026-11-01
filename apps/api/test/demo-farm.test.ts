import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {FarmWorkspaceState} from '@harvest/contracts';
import {getFarmContextHandler} from '../src/agent/tools/handlers';
import {demoFarm} from '../src/services/demo-farm';
import {DEMO_CARE,DEMO_JOURNAL,DEMO_LABEL,istDate} from '../src/services/demo-track-record';
import {careSchedule} from '../src/services/command-center';
import {focusedResearch} from '../src/services/focused-crops';
import {login,setupHarness,farmBody,type Harness,type Client} from './helpers';

let h:Harness;
beforeAll(async()=>{
 h=await setupHarness();
 // The catalogue rows the workspace PUT checks the seed products against (names equal the dev catalogue).
 for(const [crop,slug,name] of [['ginger','ginger-fresh','Fresh ginger rhizome'],['maize','maize-grain','Maize grain'],['green-gram','green-gram-whole','Green gram whole seed']]){
  await h.pool.query('INSERT INTO crop_identities (slug) VALUES ($1) ON CONFLICT DO NOTHING',[crop]);
  await h.pool.query('INSERT INTO crop_products (crop_id, slug, name) SELECT id,$2,$3 FROM crop_identities WHERE slug=$1',[crop,slug,name]);
 }
});
afterAll(async()=>h?.close());

const load=async(client:Client)=>{const res=await client.call('POST','/api/v1/farms/demo',{payload:{}});expect(res.statusCode,res.body).toBe(200);return res.json().data};
const ownerOf=async(farmId:string)=>(await h.pool.query<{owner_id:string}>('SELECT owner_id FROM farms WHERE id=$1',[farmId])).rows[0]!.owner_id;
const journal=async(client:Client,farmId:string)=>{const res=await client.call('GET',`/api/v1/farms/${farmId}/journal`);expect(res.statusCode).toBe(200);return res.json().data.entries as any[]};
const factCount=async(farmId:string)=>Number((await h.pool.query('SELECT count(*) FROM farm_facts WHERE farm_id=$1',[farmId])).rows[0].count);
const today=()=>istDate(new Date());
const expectedJournal=(loadDate:string)=>DEMO_JOURNAL.filter(e=>e.date<=loadDate);

describe('demo farm with a two-year sample track record',()=>{
 it('first load: one farm per owner, the track record, the journal timeline and the assistant context',async()=>{
  const a=await login(h.app);
  const existing=(await a.call('POST','/api/v1/farms',{payload:farmBody({name:'Existing private farm',facts:{}})})).json().data;
  const before=(await a.call('GET',`/api/v1/farms/${existing.id}`)).json().data;
  const [one,two]=await Promise.all([a.call('POST','/api/v1/farms/demo',{payload:{}}),a.call('POST','/api/v1/farms/demo',{payload:{}})]);
  expect(one.statusCode).toBe(200);expect(two.statusCode).toBe(200);
  const first=one.json().data;expect(first.farm.id).toBe(two.json().data.farm.id);
  expect(first.farm.name).toBe('Arsikere demo farm');
  expect(first.farm.location).toMatchObject({stateCode:'IN-KA',districtId:'IN-KA-hassan',lat:13.25,lon:76.25,precision:'approximate'});
  const facts=first.farm.facts;
  expect(facts.demo_seed_version.value).toBe(5);expect(facts.demo_prefilled.value).toBe(true);expect(facts.demo_illustrative.value).toBe(false);expect(facts.demo_track_record.value).toBe(true);
  expect(facts.demo_source.value).toContain('uasmandya.edu.in/ars-arasikere');expect(facts.area_hectares.value).toBeGreaterThan(0.9);
  expect(facts.irrigation_category).toMatchObject({value:'supplemental',basis:'farmer_reported',confirmed:false,source:'Demo farm sample record'});
  expect(first.demo).toMatchObject({prefilledBoundary:true,label:DEMO_LABEL,source:'https://uasmandya.edu.in/ars-arasikere',boundary:expect.stringContaining('Prefilled outline')});
  expect(DEMO_LABEL).toBe('Demo farm with two years of sample records near the public ARS Arsikere research-site reference');

  // Workspace: three cycles (the growing ginger carries its product), three saved seasons, a known previous harvest.
  const ws=first.workspace;expect(FarmWorkspaceState.parse({boundary:ws.boundary,previousHarvest:ws.previousHarvest,cycles:ws.cycles,rotationPlans:ws.rotationPlans})).toBeTruthy();
  expect(ws.version).toBe(1);
  expect(ws.previousHarvest).toEqual({status:'known',cropId:'finger-millet',cropName:'Finger millet',harvestDate:'2023-12-10'});
  expect(ws.cycles.map((c:any)=>c.id)).toEqual(['demo2y:ginger-2024','demo2y:maize-2025','demo2y:ginger-2026']);
  const growing=ws.cycles.filter((c:any)=>c.stage!=='harvested');expect(growing).toHaveLength(1);
  expect(growing[0]).toMatchObject({id:'demo2y:ginger-2026',cropId:'ginger',productId:'ginger-fresh',productName:'Fresh ginger rhizome',sowingDate:'2026-05-16',establishmentDate:'2026-05-16',establishmentMethod:'rhizome_planting',stage:'growing'});
  expect(ws.cycles[0]).toMatchObject({stage:'harvested',harvestDate:'2025-01-18',productId:'ginger-fresh'});expect(ws.cycles[1]).toMatchObject({cropId:'maize',productId:'maize-grain',productName:'Maize grain',establishmentMethod:'direct_sowing',stage:'harvested',harvestDate:'2025-10-04'});
  expect(ws.rotationPlans.map((r:any)=>[r.id,r.year,r.season,r.productId,r.plannedSowingDate,r.plannedHarvestDate,r.kind,r.establishmentMethod])).toEqual([
   ['demo2y:plan-2027-maize',2027,'Kharif','maize-grain','2027-06-05','2027-09-30','crop','direct_sowing'],
   ['demo2y:plan-2027-green-gram',2027,'Rabi','green-gram-whole','2027-10-15','2027-12-30','crop','direct_sowing'],
   ['demo2y:plan-2028-ginger',2028,'Kharif','ginger-fresh','2028-05-15','2029-01-15','crop','rhizome_planting']]);
  expect(JSON.stringify(ws)).not.toMatch(/illustrative/i);

  // Journal timeline: every spec entry up to the load date, amounts as two-decimal strings, farmer original facts.
  const loadDate=today();const expected=expectedJournal(loadDate);
  const entries=await journal(a,first.farm.id);
  const seeded=entries.filter(e=>e.clientEntryId.startsWith('demo2y:')&&!e.clientEntryId.startsWith('demo2y:care-'));
  expect(seeded).toHaveLength(expected.length);
  for(const want of expected){
   const got=entries.find(e=>e.clientEntryId===`demo2y:${want.slug}`);expect(got,want.slug).toBeTruthy();
   expect(got).toMatchObject({observedOn:want.date,observedAt:new Date(`${want.date}T12:00:00+05:30`).toISOString(),activity:want.activity,note:want.note,language:'en',status:'final',processingStatus:'submitted',mediaIds:[],planId:null,analysis:null});
   expect(got.quantity).toEqual(want.quantity??null);
   expect(got.expense).toEqual(want.expense??null);
   expect(got.sale).toEqual(want.sale??null);
   expect(got.facts.filter((f:any)=>f.kind==='original').map((f:any)=>f.field).sort()).toEqual(['activity',...(want.quantity?['quantity']:[]),...(want.expense?['expense_inr']:[]),...(want.sale?['sale_inr']:[])].sort());
  }
  const sale=entries.find(e=>e.clientEntryId==='demo2y:2025-01-22-sale');expect(sale.sale).toEqual({amountInr:'108800.00',note:'Hassan APMC trader, ₹16/kg'});expect(sale.expense).toEqual({amountInr:'2600.00',category:'transport'});
  expect(entries.find(e=>e.clientEntryId==='demo2y:2025-12-10-expense-repairs').expense).toEqual({amountInr:'5500.00',category:'repairs'});
  expect(entries.every(e=>e.observedOn<=loadDate)).toBe(true);

  // Care: the ginger care schedule in the focused catalogue is sourced for IN-TN only, so for this Karnataka field the
  // schedule dates no task (the command center shows reference guidance) and the seed completes none.
  const research=await focusedResearch();
  const dated=careSchedule(growing[0],research.crops.find(c=>c.cropId==='ginger'),loadDate,[],{stateId:'IN-KA',districtId:'IN-KA-hassan'}).careTasks;
  expect(dated).toHaveLength(0);
  expect(first.demo.records).toEqual({cycles:3,seasons:3,journalEntries:expected.length,careActions:0});

  const ownerId=await ownerOf(first.farm.id);
  const ctx=(await getFarmContextHandler({farmId:first.farm.id},{pool:h.pool,ownerId,mode:'synthetic',requestId:randomUUID(),agentRunId:randomUUID(),asOf:new Date().toISOString()})).farm;
  expect(ctx.demo).toMatchObject({prefilledBoundary:true});expect((ctx.demo as {source:string}).source).toContain(DEMO_LABEL);
  expect((await h.pool.query('SELECT enabled,meta_enabled,interval_hours FROM farm_monitors WHERE farm_id=$1',[first.farm.id])).rows[0]).toEqual({enabled:true,meta_enabled:true,interval_hours:24});
  // The year plan for the current horizon was started through the normal path (not forced; one pending review).
  expect(Number((await h.pool.query("SELECT count(*) FROM farm_year_plans WHERE farm_id=$1 AND archived_at IS NULL",[first.farm.id])).rows[0].count)).toBe(1);
  expect((await a.call('GET',`/api/v1/farms/${existing.id}`)).json().data).toEqual(before);

  // Another owner gets their own demo farm and cannot read this one.
  const b=await login(h.app);const other=await load(b);expect(other.farm.id).not.toBe(first.farm.id);
  expect(other.demo.records).toEqual(first.demo.records);
  expect((await b.call('GET',`/api/v1/farms/${first.farm.id}/workspace`)).statusCode).toBe(404);
  expect((await b.call('GET',`/api/v1/farms/${first.farm.id}/journal`)).statusCode).toBe(404);
  expect((await b.call('GET',`/api/v1/farms/${first.farm.id}`)).statusCode).toBe(404);
 });

 it('repeated load: nothing is duplicated and farmer-added or edited records stay',async()=>{
  const a=await login(h.app);const first=await load(a);const id=first.farm.id;
  const facts=await factCount(id),farmVersion=(await h.pool.query('SELECT version FROM farms WHERE id=$1',[id])).rows[0].version;
  const again=await load(a);
  expect(again.demo.records).toEqual(first.demo.records);expect(again.workspace.version).toBe(first.workspace.version);
  expect(again.workspace.cycles).toEqual(first.workspace.cycles);expect(again.workspace.rotationPlans).toEqual(first.workspace.rotationPlans);
  expect(await factCount(id)).toBe(facts);expect((await h.pool.query('SELECT version FROM farms WHERE id=$1',[id])).rows[0].version).toBe(farmVersion);
  expect((await journal(a,id)).length).toBe(first.demo.records.journalEntries);

  // The farmer adds a cycle and a season, edits a seed cycle's notes, removes a seed season, records a journal entry and renames the farm.
  const ws=(await a.call('GET',`/api/v1/farms/${id}/workspace`)).json().data;
  const mine={id:'my-cycle',cropId:'green-gram',cropName:'Green gram',sowingDate:'2026-10-20',stage:'sowed',notes:'My own record'};
  const cycles=[...ws.cycles.map((c:any)=>c.id==='demo2y:maize-2025'?{...c,notes:'My corrected maize note'}:c),mine];
  const rotationPlans=[...ws.rotationPlans.filter((r:any)=>r.id!=='demo2y:plan-2028-ginger'),{id:'my-season',year:2027,season:'Summer',cropId:'maize',plannedSowingDate:'2027-02-01'}];
  const put=await a.call('PUT',`/api/v1/farms/${id}/workspace`,{payload:{expectedVersion:ws.version,boundary:ws.boundary,previousHarvest:{status:'none'},cycles,rotationPlans}});expect(put.statusCode).toBe(200);
  const own=await a.call('POST','/api/v1/journal',{payload:{clientEntryId:`mine-${randomUUID()}`,farmId:id,observedOn:today(),note:'My own note',activity:'observation'},headers:{'idempotency-key':randomUUID()}});expect(own.statusCode).toBe(201);
  await h.pool.query("UPDATE farms SET name='My home field' WHERE id=$1",[id]);
  const yearPlans=(await h.pool.query('SELECT id FROM farm_year_plans WHERE farm_id=$1 AND archived_at IS NULL',[id])).rows.map(r=>r.id);

  const merged=await load(a);
  expect(merged.farm.name).toBe('My home field');
  expect(merged.workspace.previousHarvest).toEqual({status:'none'});
  expect(merged.workspace.cycles.find((c:any)=>c.id==='my-cycle')).toMatchObject({notes:'My own record'});
  expect(merged.workspace.cycles.find((c:any)=>c.id==='demo2y:maize-2025').notes).toBe('My corrected maize note');
  expect(merged.workspace.cycles.filter((c:any)=>c.id.startsWith('demo2y:'))).toHaveLength(3);
  expect(merged.workspace.rotationPlans.map((r:any)=>r.id).sort()).toEqual(['demo2y:plan-2027-green-gram','demo2y:plan-2027-maize','demo2y:plan-2028-ginger','my-season']);
  expect(merged.workspace.version).toBe(put.json().data.version+1);
  expect(merged.demo.records).toEqual({cycles:4,seasons:4,journalEntries:first.demo.records.journalEntries+1,careActions:0});
  // The workspace changed, so the year plans built on the old one are archived (the load then starts a fresh one).
  if(yearPlans.length)expect((await h.pool.query('SELECT bool_and(archived_at IS NOT NULL) ok FROM farm_year_plans WHERE id=ANY($1::uuid[])',[yearPlans])).rows[0].ok).toBe(true);
  expect((await journal(a,id)).find(e=>e.note==='My own note')).toBeTruthy();

  const third=await load(a);expect(third.workspace.version).toBe(merged.workspace.version);expect(third.demo.records).toEqual(merged.demo.records);
 });

 it('legacy upgrade: a seed-version-3 farm loses the old sample records and gets the track record',async()=>{
  const a=await login(h.app);const first=await load(a);const id=first.farm.id;
  const y=Number(today().slice(0,4));
  const legacy={boundary:first.workspace.boundary,previousHarvest:{status:'known',cropId:'maize',cropName:'Maize (illustrative previous crop)',harvestDate:`${y}-04-20`},
   cycles:[{id:'demo-cycle',cropId:'ginger',cropName:'Ginger (illustrative crop)',sowingDate:`${y}-06-01`,stage:'growing',notes:'Illustrative planning record, not an observation of research-station operations.'},{id:'farmer-cycle',cropId:'maize',sowingDate:`${y}-07-01`,stage:'growing',notes:'Farmer record kept through the upgrade'}],
   rotationPlans:[{id:'demo-rotation',cropId:'maize',cropName:'Maize (illustrative next season)',year:y+1,season:'Kharif',plannedSowingDate:`${y+1}-06-01`,notes:'Illustrative maize scenario; the June window assumes irrigation can be confirmed. No rotation score or current research activity is implied.'}]};
  // Back to what a version-3 seed left: legacy workspace, old name, older marker facts, no journal or care records.
  const c=await h.pool.connect();
  try{await c.query('BEGIN');await c.query("SET LOCAL harvest.allow_journal_delete='on'");await c.query('DELETE FROM farm_cycle_actions WHERE farm_id=$1',[id]);await c.query('DELETE FROM journal_entries WHERE farm_id=$1',[id]);
   await c.query("DELETE FROM farm_facts WHERE farm_id=$1 AND fact_key IN ('demo_track_record','irrigation_category')",[id]);
   await c.query("UPDATE farm_facts SET value='3'::jsonb WHERE farm_id=$1 AND fact_key='demo_seed_version' AND superseded_by IS NULL",[id]);
   await c.query('UPDATE farm_workspaces SET version=3,state=$2::jsonb WHERE farm_id=$1',[id,JSON.stringify(legacy)]);
   await c.query("UPDATE farms SET name='ARS Arsikere demo field' WHERE id=$1",[id]);await c.query('COMMIT');}
  finally{c.release()}
  expect((await journal(a,id)).length).toBe(0);

  const up=await load(a);
  expect(up.farm.name).toBe('Arsikere demo farm');expect(up.farm.facts.demo_seed_version.value).toBe(5);expect(up.farm.facts.demo_track_record.value).toBe(true);
  expect(up.farm.facts.irrigation_category.value).toBe('supplemental');
  expect(up.workspace.version).toBe(4);
  expect(up.workspace.previousHarvest).toEqual({status:'known',cropId:'finger-millet',cropName:'Finger millet',harvestDate:'2023-12-10'});
  expect(up.workspace.cycles.map((x:any)=>x.id)).toEqual(['farmer-cycle','demo2y:ginger-2024','demo2y:maize-2025','demo2y:ginger-2026']);
  expect(up.workspace.rotationPlans.map((x:any)=>x.id)).toEqual(['demo2y:plan-2027-maize','demo2y:plan-2027-green-gram','demo2y:plan-2028-ginger']);
  expect(JSON.stringify(up.workspace)).not.toMatch(/illustrative/i);
  expect(up.demo.records.journalEntries).toBe(expectedJournal(today()).length);
  expect((await journal(a,id)).length).toBe(expectedJournal(today()).length);
 });

 it('an injected load date skips every record dated after it',async()=>{
  for(const [instant,loadDate,cycles] of [['2026-06-01T00:00:00Z','2026-06-01',3],['2026-05-10T12:00:00Z','2026-05-10',2]] as const){
   const a=await login(h.app);const seedFarm=await load(a);const ownerId=await ownerOf(seedFarm.farm.id);
   // A fresh owner: remove the farm the route created so the service creates it at the injected date.
   await h.pool.query('DELETE FROM farms WHERE id=$1',[seedFarm.farm.id]);
   const out=await demoFarm({pool:h.pool,config:h.config,now:()=>new Date(instant)},ownerId);
   expect(istDate(new Date(instant))).toBe(loadDate);
   expect(out.workspace.cycles).toHaveLength(cycles);
   for(const c of out.workspace.cycles)for(const d of [c.sowingDate,c.establishmentDate,c.harvestDate])if(d)expect(d<=loadDate).toBe(true);
   expect(out.workspace.cycles.filter(c=>c.stage==='harvested'&&c.harvestDate!>loadDate)).toHaveLength(0);
   expect(out.workspace.rotationPlans).toHaveLength(3);
   const rows=(await h.pool.query<{d:string}>("SELECT entry_date::text d FROM journal_entries WHERE farm_id=$1",[out.farm.id])).rows;
   expect(rows.length).toBe(expectedJournal(loadDate).length);expect(rows.every(r=>r.d<=loadDate)).toBe(true);
   expect(out.demo.records.journalEntries).toBe(rows.length);
  }
 });

 it('care completions go through the command-center path with computed task ids where the schedule dates tasks',async()=>{
  const a=await login(h.app);const first=await load(a);const id=first.farm.id;const ownerId=await ownerOf(id);
  // Test-only device: the ginger care schedule is sourced for IN-TN, so the stored location is moved there to exercise the path.
  await h.pool.query("UPDATE farms SET state_code='IN-TN',district_code=NULL WHERE id=$1",[id]);
  const out=await load(a);
  expect(out.demo.records.careActions).toBe(5);
  const cycle=out.workspace.cycles.find((c:any)=>c.id==='demo2y:ginger-2026');const research=await focusedResearch();
  const tasks=careSchedule(cycle,research.crops.find(c=>c.cropId==='ginger'),today(),[],{stateId:'IN-TN',districtId:null}).careTasks;
  const rows=(await h.pool.query('SELECT action_key,client_entry_id,completed_on::text completed_on,journal_entry_id FROM farm_cycle_actions WHERE farm_id=$1 AND owner_id=$2 ORDER BY completed_on',[id,ownerId])).rows;
  expect(rows.map(r=>[r.client_entry_id,r.completed_on])).toEqual([...DEMO_CARE].sort((x,y)=>x.date.localeCompare(y.date)).map(c=>[`demo2y:care-${c.actionId}`,c.date]));
  for(const r of rows){const actionId=r.client_entry_id.slice('demo2y:care-'.length);expect(r.action_key).toBe(tasks.find(t=>t.actionId===actionId)!.id);expect(r.completed_on>=tasks.find(t=>t.actionId===actionId)!.dueFrom).toBe(true)}
  const entries=await journal(a,id);
  for(const r of rows){const e=entries.find(x=>x.id===r.journal_entry_id);expect(e).toMatchObject({clientEntryId:r.client_entry_id,observedOn:r.completed_on,activity:'other'});expect(e.note).toContain(`completed on ${r.completed_on}.`)}
  expect(entries.length).toBe(first.demo.records.journalEntries+5);
  const again=await load(a);expect(again.demo.records).toEqual(out.demo.records);
 });
});
