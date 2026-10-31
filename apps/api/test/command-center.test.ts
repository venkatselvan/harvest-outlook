import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {FarmCommandCenter,type FarmSoilMarkers} from '@harvest/contracts';
import {FocusedResearch} from '../src/services/focused-crops';
const research=vi.hoisted(()=>({schemaVersion:1,sources:[{id:'fixture-source',url:'https://example.test/care',publisher:'Test fixture',title:'Explicit test timing, not agronomic guidance',retrievedAt:'2026-10-31',geography:['test']}],crops:[{cropId:'paddy',displayName:'Rice',botanicalName:'Oryza sativa',aliases:[],productionType:'annual',establishmentMethods:['direct_sowing','transplanting'],duration:{minDays:100,maxDays:120,anchor:'transplanting',conditions:['Fixture only'],sourceRefs:[{sourceId:'fixture-source',locator:'test'}]},soilEnvironment:[{parameter:'ph',value:{min:5.5,max:7.5},unit:'pH',conditions:['Source method not specified'],sourceRefs:[{sourceId:'fixture-source',locator:'test'}]}],care:[{id:'weed',title:'Check weeds',action:'Record the actual weed check',anchor:'transplanting',geographyIds:['IN'],startDay:15,endDay:20,repeatEveryDays:null,stage:null,conditions:['Fixture only'],sourceRefs:[{sourceId:'fixture-source',locator:'test'}]},{id:'sown-check',title:'Check emergence',action:'Record emergence check',anchor:'sowing',geographyIds:['IN'],startDay:5,endDay:7,repeatEveryDays:null,stage:null,conditions:[],sourceRefs:[{sourceId:'fixture-source',locator:'test'}]}],sequenceConstraints:[],limitations:['Fixture only']}]}));
vi.mock('../src/services/focused-crops',async importOriginal=>({...await importOriginal<typeof import('../src/services/focused-crops')>(),focusedResearch:async()=>FocusedResearch.parse(research)}));
import {careSchedule,measuredSoilFit} from '../src/services/command-center';
import {loadCatalogueIntoDb} from '../src/catalogue/load';
import {farmBody,login,setupHarness,type Harness,type Client} from './helpers';
const localCareSchedule=(cycle:Parameters<typeof careSchedule>[0],crop:Parameters<typeof careSchedule>[1],asOf:string)=>careSchedule(cycle,crop,asOf,[],{stateId:'IN-TN',districtId:'IN-TN-coimbatore'});
let h:Harness,a:Client,b:Client,farmId:string;
beforeAll(async()=>{h=await setupHarness();await loadCatalogueIntoDb(h.pool);a=await login(h.app);b=await login(h.app);farmId=(await a.call('POST','/api/v1/farms',{payload:farmBody({facts:{}})})).json().data.id});
afterAll(async()=>h?.close());
const base={clientEntryId:'plant-first',cropId:'paddy',productId:'paddy-grain',establishmentMethod:'transplanting',establishmentDate:'2026-10-01',expectedWorkspaceVersion:0};
describe('farm command center and explicit crop care',()=>{
 it('dates only matching explicit anchors and never infers a legacy transplantation date',()=>{
  const crop=FocusedResearch.parse(research).crops[0]!,cycle={id:'cycle',cropId:'paddy',sowingDate:'2026-10-01',stage:'growing' as const};
  expect(localCareSchedule(cycle,crop,'2026-10-15').careTasks).toEqual([]);
  const planted={...cycle,establishmentDate:'2026-10-01',establishmentMethod:'transplanting'};const schedule=localCareSchedule(planted,crop,'2026-10-16');
  expect(schedule.careTasks).toHaveLength(1);expect(schedule.careTasks[0]).toMatchObject({dueFrom:'2026-10-16',dueTo:'2026-10-21',status:'due',evidenceState:'source_schedule'});
  expect(localCareSchedule({...planted,establishmentMethod:'direct_sowing'},crop,'2026-10-16').careTasks[0]?.actionId).toBe('sown-check');
 });
 it('keeps missing or incompatible soil results unknown rather than assigning suitability',()=>{
  const crop=FocusedResearch.parse(research).crops[0]!,markers:FarmSoilMarkers={farmId:randomUUID(),samples:[],limitations:[]};
  expect(measuredSoilFit(markers,crop).status).toBe('needs_soil_report');
  expect(measuredSoilFit({...markers,samples:[{id:randomUUID(),reportId:randomUUID(),sourceSampleId:'sample',sampleLabel:null,laboratory:null,collectionDate:null,reportDate:null,depth:null,confirmedAt:new Date().toISOString(),markers:[]}]},crop).status).toBe('insufficient_compatible_measurements');
 });
 it('hides foreign farms and validates actual dates/product/method before writing',async()=>{
  expect((await b.call('GET',`/api/v1/farms/${farmId}/command-center`)).statusCode).toBe(404);
  expect((await b.call('POST',`/api/v1/farms/${farmId}/cycles`,{payload:base})).statusCode).toBe(404);
  for(const patch of [{establishmentDate:'2099-01-01'},{establishmentMethod:'guessed'},{productId:'ginger-fresh'}])expect((await a.call('POST',`/api/v1/farms/${farmId}/cycles`,{payload:{...base,...patch}})).statusCode).toBe(400);
  expect((await h.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count).toBe('0');
 });
 it('atomically establishes a cycle and farmer journal event, replaying concurrent retries once',async()=>{
  const results=await Promise.all([a.call('POST',`/api/v1/farms/${farmId}/cycles`,{payload:base}),a.call('POST',`/api/v1/farms/${farmId}/cycles`,{payload:base})]);
  expect(results.map(r=>r.statusCode)).toEqual([201,201]);expect(results[0]!.json().data.cycle.id).toBe(results[1]!.json().data.cycle.id);
  expect((await h.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count).toBe('1');
  expect((await a.call('POST',`/api/v1/farms/${farmId}/cycles`,{payload:{...base,establishmentDate:'2026-10-02'}})).statusCode).toBe(409);
 });
 it('returns a read-only scoped overview, then completes an action once and persists after reload',async()=>{
  const first=await a.call('GET',`/api/v1/farms/${farmId}/command-center`);expect(first.statusCode,first.body).toBe(200);const data=FarmCommandCenter.parse(first.json().data);const active=data.currentCycles[0]!,task=active.careTasks[0]!;
  expect(data.soil.markers.samples).toEqual([]);expect(data.soil.fit[0]?.status).toBe('needs_soil_report');expect(data.weather.kind).toBe('forecast');
  expect((await h.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count).toBe('1');
  const url=`/api/v1/farms/${farmId}/cycles/${active.cycle.id}/care/${task.id}/complete`,payload={clientEntryId:'done-task',completedOn:'2026-10-20',note:'I checked the field'};
  expect((await b.call('POST',url,{payload})).statusCode).toBe(404);
  expect((await a.call('POST',url,{payload:{...payload,completedOn:'2026-09-01'}})).statusCode).toBe(400);
  const [one,two]=await Promise.all([a.call('POST',url,{payload}),a.call('POST',url,{payload:{...payload,clientEntryId:'double-tap'}})]);expect(one.statusCode,one.body).toBe(200);expect(two.statusCode,two.body).toBe(200);expect(one.json().data.journalEntryId).toBe(two.json().data.journalEntryId);
  expect((await h.pool.query('SELECT count(*) FROM journal_entries')).rows[0].count).toBe('2');
  const again=await a.call('GET',`/api/v1/farms/${farmId}/command-center`);expect(again.json().data.currentCycles[0].careTasks[0]).toMatchObject({status:'completed',completedOn:'2026-10-20'});
  const other=(await a.call('POST','/api/v1/farms',{payload:farmBody({facts:{}})})).json().data;expect((await a.call('GET',`/api/v1/farms/${other.id}/command-center`)).json().data.currentCycles).toEqual([]);
 });
});
