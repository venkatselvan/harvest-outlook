/**
 * Two-year sample track record for the "Load demo" farm (docs/research/DEMO_TRACK_RECORD_SPEC.md sections 1 to 4).
 *
 * Everything here is sample data written by code at demo load. It is not an observation of the ARS Arsikere site or of any
 * farmer. Sale and expense amounts were chosen by the spec to sit inside the stored Karnataka mandi modal prices for the same
 * months; this module copies them unchanged. No model call is made to seed these records.
 *
 * Dates are fixed calendar dates calibrated for a load date from 2026-11-01 to about 2027-01-31. Any record dated after the
 * IST load date is skipped (never written as a future actual); saved seasons are plans and keep their future dates.
 * Seed v6 saves no future seasons: the demo starts with the current crop only, so Plan generation and Crop fit ranking run on the
 * farm's own record. Seed v5 farms lose exactly the three plans it saved (LEGACY_V5_ROTATION_PLANS, removed in demo-farm.ts).
 */
import type {PoolClient} from 'pg';
import {FarmWorkspaceState,type FarmWorkspaceState as WorkspaceState} from '@harvest/contracts';
import type {Config} from '../config';
import {CreateEntryBody,type ACTIVITIES,type QUANTITY_UNITS} from '../journal/types';
import {insertFact as insertJournalFact} from '../journal/repository';
import {careSchedule,completeCareTaskIn} from './command-center';
import {focusedResearch} from './focused-crops';
import {ApiError} from './errors';
import {payloadHash} from './hash';

export const DEMO_SEED_VERSION=6;
export const DEMO_FARM_NAME='Arsikere demo farm';
export const DEMO_LABEL='Demo farm with two years of sample records near the public ARS Arsikere research-site reference';
/** Source text of the farmer-style facts the seed adds (spec section 1). */
export const DEMO_SAMPLE_SOURCE='Demo farm sample record';
/** Names an older seed gave the demo farm; a farmer-chosen name is never replaced. */
export const LEGACY_DEMO_NAMES=['ARS Arsikere demo field','ARS Arsikere reference · illustrative demo','TNAU research site · illustrative demo'] as const;
/** Every seed-owned client entry id (journal entries and care completions) starts with this prefix. */
export const DEMO_CLIENT_PREFIX='demo2y:';

/** The IST calendar date of an instant (the load date the fixture is filtered by). */
export const istDate=(now:Date)=>new Date(now.getTime()+19_800_000).toISOString().slice(0,10);

type Cycle=WorkspaceState['cycles'][number];
type Rotation=WorkspaceState['rotationPlans'][number];
type Known=Extract<WorkspaceState['previousHarvest'],{status:'known'}>;

/** Product names equal the catalogue names (crop_products.name) for these slugs. */
const GINGER={cropId:'ginger',cropName:'Ginger',productId:'ginger-fresh',productName:'Fresh ginger rhizome'} as const;
const MAIZE={cropId:'maize',cropName:'Maize',productId:'maize-grain',productName:'Maize grain'} as const;
const GREEN_GRAM={cropId:'green-gram',cropName:'Green gram',productId:'green-gram-whole',productName:'Green gram whole seed'} as const;

export const DEMO_PREVIOUS_HARVEST:Known={status:'known',cropId:'finger-millet',cropName:'Finger millet',harvestDate:'2023-12-10'};

export const DEMO_CYCLES:readonly Cycle[]=[
 {id:'demo2y:ginger-2024',...GINGER,sowingDate:'2024-05-20',establishmentDate:'2024-05-20',establishmentMethod:'rhizome_planting',stage:'harvested',harvestDate:'2025-01-18',notes:'Rio-de-Janeiro type seed rhizome, green-leaf mulch, borewell irrigation in dry spells.'},
 {id:'demo2y:maize-2025',...MAIZE,sowingDate:'2025-06-08',establishmentDate:'2025-06-08',establishmentMethod:'direct_sowing',stage:'harvested',harvestDate:'2025-10-04',notes:'Hybrid maize after ginger; rainfed with one protective irrigation.'},
 {id:'demo2y:ginger-2026',...GINGER,sowingDate:'2026-05-16',establishmentDate:'2026-05-16',establishmentMethod:'rhizome_planting',stage:'growing',notes:'Own seed rhizome from 2025 plus 700 kg bought; raised beds, mulch, drainage channels.'},
];

/** The three future seasons seed v5 saved. No longer seeded; kept only so a v5 farm can be cleaned of exactly these records. */
export const LEGACY_V5_ROTATION_PLANS:readonly Rotation[]=[
 {id:'demo2y:plan-2027-maize',...MAIZE,year:2027,season:'Kharif',plannedSowingDate:'2027-06-05',plannedHarvestDate:'2027-09-30',kind:'crop',establishmentMethod:'direct_sowing',notes:'Maize after the ginger harvest, as in 2025, so ginger does not follow ginger.'},
 {id:'demo2y:plan-2027-green-gram',...GREEN_GRAM,year:2027,season:'Rabi',plannedSowingDate:'2027-10-15',plannedHarvestDate:'2027-12-30',kind:'crop',establishmentMethod:'direct_sowing',notes:'A short green gram crop after the maize, before the field is prepared for ginger again.'},
 {id:'demo2y:plan-2028-ginger',...GINGER,year:2028,season:'Kharif',plannedSowingDate:'2028-05-15',plannedHarvestDate:'2029-01-15',kind:'crop',establishmentMethod:'rhizome_planting',notes:'Back to ginger after a two-season break, as in 2024 and 2026.'},
];

export interface DemoJournalEntry{
 slug:string;date:string;activity:(typeof ACTIVITIES)[number];note:string;
 quantity?:{value:number;unit:(typeof QUANTITY_UNITS)[number]};
 expense?:{amountInr:string;category:string};
 sale?:{amountInr:string;note:string};
}
const e=(slug:string,date:string,activity:DemoJournalEntry['activity'],note:string,extra:Omit<DemoJournalEntry,'slug'|'date'|'activity'|'note'>={}):DemoJournalEntry=>({slug,date,activity,note,...extra});
const kg=(value:number)=>({value,unit:'kg' as const}),mm=(value:number)=>({value,unit:'mm' as const});
const spend=(amountInr:string,category:string)=>({amountInr,category});

/** Spec section 3, in date order. Client entry id = `demo2y:<slug>`. */
export const DEMO_JOURNAL:readonly DemoJournalEntry[]=[
 // Ginger 2024 (the tail the app saw, from first use in November 2024)
 e('2024-11-06-observation','2024-11-06','observation','Started using the app. Ginger planted 20 May is at rhizome development; leaves still green, no yellowing.'),
 e('2024-11-20-irrigation','2024-11-20','irrigation','Borewell irrigation, no rain for 12 days.',{quantity:mm(25)}),
 e('2024-12-14-observation','2024-12-14','observation','Lower leaves turning yellow in the north beds. Maturation starting.'),
 e('2025-01-04-pest-check','2025-01-04','pest_check','Checked beds for soft rot after the December showers; none found.'),
 e('2025-01-18-harvest','2025-01-18','harvest','Harvest done over three days with 14 workers. Fresh rhizome weighed at the field.',{quantity:kg(11400),expense:spend('18000.00','labour')}),
 e('2025-01-22-sale','2025-01-22','sale','First lot to Hassan APMC.',{quantity:kg(6800),sale:{amountInr:'108800.00',note:'Hassan APMC trader, ₹16/kg'},expense:spend('2600.00','transport')}),
 e('2025-02-08-sale','2025-02-08','sale','Second lot. 900 kg kept as seed rhizome in the shade pit.',{quantity:kg(3700),sale:{amountInr:'55500.00',note:'Village buyer, ₹15/kg'},expense:spend('1500.00','transport')}),
 e('2025-03-02-other','2025-03-02','other','Ploughed after harvest; field left open for the summer.'),
 // Maize 2025
 e('2025-06-08-planting','2025-06-08','planting','Hybrid maize sown with the first good rain.',{quantity:kg(8),expense:spend('2600.00','seed')}),
 e('2025-06-08-expense-manure','2025-06-08','expense','6 t FYM spread before sowing',{expense:spend('14000.00','manure')}),
 e('2025-06-20-fertilizer','2025-06-20','fertilizer','Basal DAP.',{quantity:kg(50),expense:spend('4100.00','fertilizer')}),
 e('2025-07-02-weeding','2025-07-02','weeding','First weeding.',{expense:spend('3000.00','labour')}),
 e('2025-07-10-pest-check','2025-07-10','pest_check','Fall armyworm on a few plants near the bund; hand-picked, will check again.'),
 e('2025-07-18-fertilizer','2025-07-18','fertilizer','Urea top dressing at knee height.',{quantity:kg(40),expense:spend('2200.00','fertilizer')}),
 e('2025-08-01-observation','2025-08-01','observation','Tasselling across the field.'),
 e('2025-08-24-irrigation','2025-08-24','irrigation','One protective irrigation in the dry spell.',{quantity:mm(30)}),
 e('2025-09-20-observation','2025-09-20','observation','Cobs drying; husks turning brown.'),
 e('2025-10-04-harvest','2025-10-04','harvest','Cobs harvested and shelled.',{quantity:kg(4250),expense:spend('6500.00','labour')}),
 e('2025-10-11-sale','2025-10-11','sale','250 kg kept for home use.',{quantity:kg(4000),sale:{amountInr:'78000.00',note:'Hassan APMC, ₹19.50/kg'},expense:spend('1200.00','transport')}),
 // Between seasons (the pump repair sits outside any crop window on purpose)
 e('2025-12-10-expense-repairs','2025-12-10','expense','Borewell pump repaired.',{expense:spend('5500.00','repairs')}),
 e('2026-01-10-other','2026-01-10','other','Rotation on this field so far: ginger in 2024, then maize followed ginger in 2025, and green gram followed the maize, before the field was prepared for ginger again in 2026.'),
 e('2026-02-20-other','2026-02-20','other','Land prepared for ginger: two ploughings, raised beds marked.'),
 // Ginger 2026 (current)
 e('2026-05-16-planting','2026-05-16','planting','Seed rhizome planted on raised beds: 800 kg own seed, 700 kg bought.',{quantity:kg(1500),expense:spend('42000.00','seed')}),
 e('2026-05-16-expense-labour','2026-05-16','expense','Labour for planting the seed rhizome.',{expense:spend('9000.00','labour')}),
 e('2026-05-17-other','2026-05-17','other','Green-leaf mulch spread over the beds.',{expense:spend('6000.00','mulch')}),
 e('2026-06-12-observation','2026-06-12','observation','About 70 percent sprouted.'),
 e('2026-06-28-irrigation','2026-06-28','irrigation','Borewell irrigation, monsoon break.',{quantity:mm(20)}),
 e('2026-07-08-weeding','2026-07-08','weeding','Weeding and first earthing up.',{expense:spend('4200.00','labour')}),
 e('2026-07-20-fertilizer','2026-07-20','fertilizer','First top dressing.',{quantity:kg(60),expense:spend('3800.00','fertilizer')}),
 e('2026-08-14-pest-check','2026-08-14','pest_check','Shoot borer on a few clumps at the east edge; affected shoots removed.'),
 e('2026-08-30-observation','2026-08-30','observation','Clumps thickening; rhizome initiation.'),
 e('2026-09-22-fertilizer','2026-09-22','fertilizer','Second top dressing with earthing up.',{quantity:kg(50),expense:spend('3200.00','fertilizer')}),
 e('2026-10-05-pest-check','2026-10-05','pest_check','Checked for soft rot after the heavy rain; drainage channels cleared. None found.'),
 e('2026-10-18-observation','2026-10-18','observation','Rhizome development going well; leaves healthy.'),
 e('2026-10-27-irrigation','2026-10-27','irrigation','Light irrigation; rain has stopped.',{quantity:mm(20)}),
];

/**
 * Care completions for the current ginger cycle (spec section 3): focused-care action id -> completion date and a short
 * farmer-voice note. Task ids come from `careSchedule`; a date before the item's due window moves to the window start.
 */
export const DEMO_CARE:readonly {cycleId:string;actionId:string;date:string;note:string}[]=[
 {cycleId:'demo2y:ginger-2026',actionId:'ginger-mulch0',date:'2026-05-16',note:'Mulch put on the beds at planting.'},
 {cycleId:'demo2y:ginger-2026',actionId:'ginger-earth45',date:'2026-07-08',note:'Earthed up with the first weeding.'},
 {cycleId:'demo2y:ginger-2026',actionId:'ginger-mulch60',date:'2026-07-18',note:'Mulch renewed after weeding.'},
 {cycleId:'demo2y:ginger-2026',actionId:'ginger-mulch120',date:'2026-09-14',note:'Mulch topped up again.'},
 {cycleId:'demo2y:ginger-2026',actionId:'ginger-earth90',date:'2026-09-22',note:'Earthed up again with the second top dressing.'},
];

/** Recorded (actual) dates of a cycle; one after the load date excludes the cycle. */
const cycleDates=(c:Cycle)=>[c.sowingDate,c.establishmentDate,c.harvestDate].filter((d):d is string=>!!d);

/**
 * Merge by id (spec section 4; cycles only from seed v6, no saved seasons): seed records missing from the workspace are added after the farmer's records; any record
 * with the same id keeps the farmer's version; previousHarvest is set only when it is unknown.
 */
export function mergeTrackRecord(input:WorkspaceState,loadDate:string):WorkspaceState{
 const state=structuredClone(input);
 if(state.previousHarvest.status==='unknown'&&DEMO_PREVIOUS_HARVEST.harvestDate<=loadDate)state.previousHarvest={...DEMO_PREVIOUS_HARVEST};
 const cycleIds=new Set(state.cycles.map(c=>c.id));
 for(const cycle of DEMO_CYCLES)if(!cycleIds.has(cycle.id)&&cycleDates(cycle).every(d=>d<=loadDate))state.cycles.push(structuredClone(cycle));
 return FarmWorkspaceState.parse(state);
}

/**
 * Journal entries written with the same columns and original facts as JournalService.createEntry; the body is validated by
 * the same schema and hashed the same way, so a later replay of the same content through the API matches.
 * Rows are immutable, so an existing client entry id is left as it is (ON CONFLICT DO NOTHING). Returns rows inserted.
 */
export async function seedDemoJournal(c:PoolClient,config:Config,ownerId:string,farmId:string,loadDate:string):Promise<number>{
 let inserted=0;
 for(const entry of DEMO_JOURNAL){
  if(entry.date>loadDate)continue;
  const body=CreateEntryBody.parse({clientEntryId:`${DEMO_CLIENT_PREFIX}${entry.slug}`,farmId,observedOn:entry.date,note:entry.note,language:'en',activity:entry.activity,...(entry.quantity?{quantity:entry.quantity}:{}),...(entry.expense?{expense:entry.expense}:{}),...(entry.sale?{sale:entry.sale}:{})});
  const hash=payloadHash({...body,version:undefined});
  const id=(await c.query<{id:string}>(`INSERT INTO journal_entries (owner_id, farm_id, plan_id, client_entry_id, status, entry_date, observed_at, uploaded_at, text_body, language, media_ids,
     activity, quantity, quantity_unit, expense_inr, expense_category, sale_inr, sale_note, mode, payload_hash, processing_status)
   VALUES ($1,$2,NULL,$3,'final',$4,$5,NULL,$6,$7,'{}'::uuid[],$8,$9,$10,$11,$12,$13,$14,$15,$16,'submitted')
   ON CONFLICT (owner_id, client_entry_id) DO NOTHING RETURNING id`,
   [ownerId,farmId,body.clientEntryId,body.observedOn,`${body.observedOn}T12:00:00+05:30`,body.note??null,body.language??null,body.activity??null,body.quantity?.value??null,body.quantity?.unit??null,body.expense?.amountInr??null,body.expense?.category??null,body.sale?.amountInr??null,body.sale?.note??null,config.RUNTIME_MODE,hash])).rows[0]?.id;
  if(!id)continue;
  inserted++;
  const farmer={ownerId,entryId:id,source:'farmer' as const,evidenceState:'farmer_reported' as const,kind:'original' as const,requiresConfirmation:false};
  if(body.activity)await insertJournalFact(c,{...farmer,field:'activity',value:body.activity,unit:null});
  if(body.quantity)await insertJournalFact(c,{...farmer,field:'quantity',value:body.quantity.value,unit:body.quantity.unit});
  if(body.expense)await insertJournalFact(c,{...farmer,field:'expense_inr',value:body.expense.amountInr,unit:'INR'});
  if(body.sale)await insertJournalFact(c,{...farmer,field:'sale_inr',value:body.sale.amountInr,unit:'INR'});
 }
 return inserted;
}

/**
 * Completes the DEMO_CARE items through the command-center completion path inside the demo transaction. Task ids come from
 * `careSchedule` evaluated for the farm's recorded location at the load date, never hard-coded. Only tasks the schedule
 * actually dates for this field are completed: an item whose source geography does not cover the farm has no due date and
 * no task (the command center shows it as reference guidance), so it is skipped rather than completed against a schedule the
 * farm does not have. Idempotent by client entry id `demo2y:care-<action>`. Returns completions newly written.
 */
export async function seedDemoCare(c:PoolClient,config:Config,ownerId:string,farmId:string,loadDate:string):Promise<number>{
 const farm=(await c.query<{state_code:string|null;district_code:string|null}>('SELECT state_code,district_code FROM farms WHERE id=$1 AND owner_id=$2',[farmId,ownerId])).rows[0];
 const row=(await c.query<{state:unknown}>('SELECT state FROM farm_workspaces WHERE farm_id=$1',[farmId])).rows[0];
 if(!farm||!row)return 0;
 const state=FarmWorkspaceState.parse(row.state);const research=await focusedResearch();let written=0;
 for(const item of DEMO_CARE){
  const cycle=state.cycles.find(x=>x.id===item.cycleId);if(!cycle)continue;
  const tasks=careSchedule(cycle,research.crops.find(x=>x.cropId===cycle.cropId),loadDate,[],{stateId:farm.state_code,districtId:farm.district_code}).careTasks;
  const task=tasks.find(t=>t.actionId===item.actionId);
  if(!task||task.dueFrom>loadDate)continue;
  const completedOn=item.date<task.dueFrom?task.dueFrom:item.date;
  if(completedOn>loadDate||completedOn<cycle.sowingDate)continue;
  try{
   const out=await completeCareTaskIn(c,{config},ownerId,farmId,cycle.id,task.id,{clientEntryId:`${DEMO_CLIENT_PREFIX}care-${item.actionId}`,completedOn,note:item.note},loadDate,research);
   if(!out.alreadyCompleted)written++;
  }catch(err){
   // A completion id already used for different content (for example a farmer-edited cycle) is left as it is.
   if(err instanceof ApiError&&err.statusCode===409)continue;
   throw err;
  }
 }
 return written;
}
