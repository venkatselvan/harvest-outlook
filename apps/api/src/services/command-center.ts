import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {FarmWorkspaceState,type FarmWorkspace,type CropCycle,type CareTask,type FarmCommandCenter,type FarmSoilMarkers,type SoilCropFit,type PlantCrop,type CompleteCareTask} from '@harvest/contracts';
import {withTransaction,type Pool} from '../db/pool';
import type {Config} from '../config';
import {insertFact} from '../journal/repository';
import {createWeatherSource} from '../plans/adapters/weather-source';
import {getFarm} from './farms';
import {fieldOf,getWorkspace} from './workspace';
import {focusedResearch,establishmentAnchor,type FocusedResearch,type FocusedCareCrop} from './focused-crops';
import {farmSoilMarkers} from './soil-reports';
import {hasUnresolvedSoilWarnings} from './soil-normalization';
import {currentMandiQuotes,priorYearMandiQuotes} from './market-quotes';
import {loadCommodityMap} from '../providers/datagovin/normalize';
import {ApiError,notFound} from './errors';
import {payloadHash} from './hash';
/** Reads only the database, configuration, an optional fetch seam and an optional clock (the planning review was retired 2026-11-01; the year plan has its own endpoint). */
export interface CommandDeps{pool:Pool;config:Config;fetchImpl?:typeof fetch|undefined;now?:()=>Date}
const today=(now=new Date())=>new Date(now.getTime()+19800000).toISOString().slice(0,10);
export const addCareDays=(date:string,days:number)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
/** Methods offered for catalogue crops that have no reviewed focused care schedule; focused crops keep their own sourced method list. */
export const GENERAL_ESTABLISHMENT_METHODS=['direct_sowing','transplanting','planting'] as const;
type Cycle=ReturnType<typeof FarmWorkspaceState.parse>['cycles'][number];
type Completion={action_key:string;completed_on:string;journal_entry_id:string;cycle_id:string};
/** Dates are source schedules, never observed crop stages or inferred completion. */
export function careSchedule(cycle:Cycle,crop:FocusedCareCrop|undefined,asOf:string,completed:Completion[]=[],location?:{stateId:string|null;districtId:string|null}):{careTasks:CareTask[];limitations:string[];referenceGuidance?:{actionId:string;title:string;action:string;conditions:string[];sourceRefs:{sourceId:string;locator:string}[];geographyIds:string[];reason:string}[]}{
 if(!crop)return{careTasks:[],limitations:['This crop has no reviewed care schedule in the focused catalogue.']};
 if(cycle.stage==='harvested')return{careTasks:[],limitations:['This crop cycle is harvested; no pending care actions are inferred.']};
 const anchor=establishmentAnchor(cycle.establishmentMethod);const anchorDate=cycle.establishmentDate??cycle.sowingDate;
 if(!anchor)return{careTasks:[],limitations:['Record the establishment method before dating care actions. A legacy sowing date does not establish a transplanting date.']};
 const tasks:CareTask[]=[];const limits=[...crop.limitations];const referenceGuidance:NonNullable<ReturnType<typeof careSchedule>['referenceGuidance']>=[];
 for(const item of crop.care){
  if(item.productIds?.length&&(!cycle.productId||!item.productIds.includes(cycle.productId)))continue;
  if(item.establishmentMethods?.length&&!item.establishmentMethods.includes(cycle.establishmentMethod!))continue;
  if(item.anchor!=='observed_stage'&&item.anchor!==anchor)continue;
  const geoMatches=!!location&&item.geographyIds.some(id=>[location.stateId,location.districtId,'IN'].includes(id));
  if(!geoMatches){referenceGuidance.push({actionId:item.id,title:item.title,action:item.action,conditions:item.conditions,sourceRefs:item.sourceRefs,geographyIds:item.geographyIds,reason:location?.stateId?'This source region does not match the field; local review is required. No due date was inferred.':'Field location or source applicability is unconfirmed; no due date was inferred.'});continue}
  if(item.anchor==='observed_stage'){limits.push(`${item.title}: requires an observed stage; no calendar date was inferred.`);continue}
  if(item.anchor!==anchor||(item.establishmentMethods?.length&&!item.establishmentMethods.includes(cycle.establishmentMethod!)))continue;
  if(item.endDay<item.startDay)continue;
  // Recurrence stays within the source's explicit end window; it is not extended across the season.
  const step=item.repeatEveryDays;const occurrences=step?Math.min(60,Math.floor((item.endDay-item.startDay)/step)+1):1;
  for(let n=0;n<occurrences;n++){
   const start=item.startDay+(step?n*step:0),end=step?Math.min(item.endDay,start+step-1):item.endDay;
   const dueFrom=addCareDays(anchorDate,start),dueTo=addCareDays(anchorDate,end);
   const id=`care-${payloadHash({cycle:cycle.id,action:item.id,anchorDate,method:cycle.establishmentMethod,start,end}).slice(0,28)}`;
   const done=completed.find(c=>c.cycle_id===cycle.id&&c.action_key===id);
   tasks.push({id,actionId:item.id,cycleId:cycle.id,cropId:cycle.cropId,title:item.title,action:item.action,anchor:item.anchor,geographyIds:item.geographyIds,dueFrom,dueTo,conditions:item.conditions,sourceRefs:item.sourceRefs,status:done?'completed':dueTo<asOf?'overdue':dueFrom>asOf?'upcoming':'due',completedOn:done?.completed_on??null,journalEntryId:done?.journal_entry_id??null,evidenceState:'source_schedule'});
  }
 }
 if(!tasks.length)limits.push('No source-timed action matches this recorded establishment method. Follow the cited local guidance and record observations.');
 return{careTasks:tasks.sort((a,b)=>a.dueFrom.localeCompare(b.dueFrom)),referenceGuidance,limitations:[...new Set(limits)]};
}
function phRange(value:unknown):{min:number;max:number}|null{
 const v=Array.isArray(value)?{min:value[0],max:value[1]}:value as {min?:unknown;max?:unknown}|null;
 return v&&typeof v.min==='number'&&typeof v.max==='number'&&v.min>=0&&v.max<=14&&v.min<=v.max?{min:v.min,max:v.max}:null;
}
export function measuredSoilFit(markers:FarmSoilMarkers,crop:FocusedCareCrop):SoilCropFit{
 const checks:SoilCropFit['checks']=[];
 // Sample and method provenance stays attached. Generic pH envelopes alone do not establish full suitability.
 for(const requirement of crop.soilEnvironment.filter(r=>['ph','soil_ph'].includes(r.parameter.toLowerCase()))){
  const range=phRange(requirement.value);if(!range)continue;
  for(const sample of markers.samples)for(const marker of sample.markers){
   if(marker.parameter!=='ph'||marker.reviewStatus!=='confirmed'||marker.matrix!=='soil'||marker.qualifier!=='exact'||marker.canonical.value===null||marker.canonical.unit!=='pH')continue;
   if(/cacl[₂2]?|kcl|calcium\s+chloride|potassium\s+chloride/i.test(`${marker.method??''} ${marker.extractant??''}`))continue;
   if(hasUnresolvedSoilWarnings(marker)||marker.extractionConfidence==='low'||marker.extractionConfidence==='unreadable')continue;
   checks.push({parameter:'ph',sampleId:sample.id,reportId:sample.reportId,collectionDate:sample.collectionDate,measuredValue:marker.canonical.value,unit:'pH',method:marker.method,sourceRange:range,result:marker.canonical.value>=range.min&&marker.canonical.value<=range.max?'within':'outside',sourceRefs:requirement.sourceRefs,conditions:requirement.conditions});
  }
 }
 const outside=checks.some(c=>c.result==='outside');
 return{cropId:crop.cropId,status:!markers.samples.length?'needs_soil_report':!checks.length?'insufficient_compatible_measurements':outside?'outside_published_ph_range':'within_published_ph_range',summary:!markers.samples.length?'Confirm a soil report from this field before assessing measured soil fit.':!checks.length?'No compatible, unambiguous confirmed measurement can be compared with a numeric source requirement.':outside?'At least one confirmed sample is outside a published pH range. This is a pH check, not an overall suitability verdict.':'Confirmed sample pH lies within the cited range. Water, drainage, cultivar and other soil requirements remain unresolved.',checks,requirements:crop.soilEnvironment,limitations:['Public reference reports and unconfirmed extractions are excluded.','Different samples, dates and methods are not averaged. Published pH ranges may use unspecified methods; compare with local laboratory advice.','Nutrient sufficiency, amendment quantities, yield and profit cannot be derived from this pH check. No universal nutrient thresholds are applied.']};
}
async function actionReplay(deps:CommandDeps,ownerId:string,farmId:string,key:string){return(await deps.pool.query('SELECT a.*,a.completed_on::text completed_on FROM farm_cycle_actions a JOIN farms f ON f.id=a.farm_id WHERE a.owner_id=$1 AND a.farm_id=$2 AND a.client_entry_id=$3 AND a.mode=$4 AND f.deleted_at IS NULL',[ownerId,farmId,key,deps.config.RUNTIME_MODE])).rows[0]}
async function journalAction(c:PoolClient,deps:Pick<CommandDeps,'config'>,ownerId:string,farmId:string,cycleId:string,key:string,clientId:string,date:string,text:string,hash:string,snapshot:unknown){
 const existing=(await c.query('SELECT id FROM journal_entries WHERE owner_id=$1 AND client_entry_id=$2',[ownerId,clientId])).rows[0];
 if(existing)throw new ApiError(409,'idempotency_conflict','This client entry identifier already belongs to a different journal event');
 const entryId=randomUUID();
 await c.query(`INSERT INTO journal_entries(id,owner_id,farm_id,client_entry_id,status,entry_date,observed_at,text_body,language,activity,mode,payload_hash,processing_status) VALUES($1,$2,$3,$4,'final',$5::date,($5||'T12:00:00+05:30')::timestamptz,$6,'en',$7,$8,$9,'submitted')`,[entryId,ownerId,farmId,clientId,date,text,key==='establishment'?'planting':'other',deps.config.RUNTIME_MODE,hash]);
 for(const[field,value]of [['activity',key==='establishment'?'planting':'other'],['cycle_id',cycleId],['care_action_id',key]])await insertFact(c,{ownerId,entryId,field:field!,value:value!,unit:null,kind:'original',source:'farmer',evidenceState:'farmer_reported',requiresConfirmation:false});
 await c.query('INSERT INTO farm_cycle_actions(owner_id,farm_id,cycle_id,action_key,client_entry_id,payload_hash,journal_entry_id,completed_on,mode,source_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',[ownerId,farmId,cycleId,key,clientId,hash,entryId,date,deps.config.RUNTIME_MODE,JSON.stringify(snapshot)]);
 return entryId;
}
export async function plantCrop(deps:CommandDeps,ownerId:string,farmId:string,body:PlantCrop){
 const now=today((deps.now??(()=>new Date()))());if(body.establishmentDate>now)throw new ApiError(400,'validation_error','Record actual establishment only after it occurs; future crops belong in the year plan');
 const research=await focusedResearch(),focused=research.crops.find(c=>c.cropId===body.cropId);
 // A crop with a reviewed care schedule keeps its sourced methods; any other catalogue crop is recorded without care dates.
 const identity=(await deps.pool.query<{name:string|null}>(`SELECT names->'en'->0->>'text' AS name FROM crop_identities WHERE slug=$1`,[body.cropId])).rows[0];
 const methods:readonly string[]=focused?focused.establishmentMethods:identity?GENERAL_ESTABLISHMENT_METHODS:[];
 if(!methods.includes(body.establishmentMethod))throw new ApiError(400,'validation_error','Choose a crop from the catalogue and a supported establishment method');
 const cropName=focused?.displayName??identity?.name??body.cropId;
 const hash=payloadHash({farmId,...body,expectedWorkspaceVersion:undefined});
 return withTransaction(deps.pool,async c=>{
  const owned=(await c.query('SELECT id FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',[farmId,ownerId])).rows[0];if(!owned)throw notFound('Farm');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${ownerId}:${body.clientEntryId}`]);
  const old=(await c.query('SELECT *,completed_on::text completed_on FROM farm_cycle_actions WHERE owner_id=$1 AND client_entry_id=$2 FOR UPDATE',[ownerId,body.clientEntryId])).rows[0];
  const row=(await c.query('SELECT state,version,updated_at FROM farm_workspaces WHERE farm_id=$1',[farmId])).rows[0];const state=FarmWorkspaceState.parse(row?.state??{boundary:null,previousHarvest:{status:'unknown'},cycles:[],rotationPlans:[]});
  if(old){if(old.farm_id!==farmId||old.payload_hash!==hash||old.mode!==deps.config.RUNTIME_MODE)throw new ApiError(409,'idempotency_conflict','This crop request identifier was already used for different data');const cycle=state.cycles.find(c=>c.id===old.cycle_id);if(!cycle)throw new ApiError(409,'version_conflict','The recorded cycle was removed; reload before recording a new crop');return{cycle,workspace:{...state,farmId,version:row.version,updatedAt:row.updated_at.toISOString()},journalEntryId:old.journal_entry_id,alreadyRecorded:true}}
  if(body.expectedWorkspaceVersion!==(row?.version??0))throw new ApiError(409,'version_conflict','Farm tracking changed; reload before planting');
  const catalogue=(await c.query<{slug:string;name:string}>('SELECT p.slug,p.name FROM crop_products p JOIN crop_identities c ON c.id=p.crop_id WHERE c.slug=$1 AND ($2::text IS NULL OR p.slug=$2 OR p.id::text=$2) ORDER BY p.slug',[body.cropId,body.productId??null])).rows;
  // An explicit product may be any catalogue harvest form of the crop; without one, a focused crop defaults to its market-mapped forms.
  const products=body.productId?catalogue:catalogue.filter(p=>!focused||!Array.isArray(focused.marketProductIds)||(focused.marketProductIds as string[]).includes(p.slug));if(!products.length)throw new ApiError(400,'validation_error','Selected product does not belong to this crop');
  if(!body.productId&&products.length>1)throw new ApiError(400,'validation_error','Select the intended harvested product');const product=products[0]!;
  // Fields (2026-11-03, FIELDS_MULTICROP_SOIL_SPEC.md 3.2): a farm with fields needs the field; an unknown field is a 404.
  if(state.fields.length&&body.fieldId===undefined)throw new ApiError(400,'field_required','Choose the field this crop is planted on');
  const field=body.fieldId!==undefined?fieldOf(state,body.fieldId):null;
  const companion=body.companion?await companionOf(c,body.companion,body.cropId,research.crops):undefined;
  const cycle={id:randomUUID(),cropId:body.cropId,cropName,productId:product.slug,productName:product.name,sowingDate:body.establishmentDate,establishmentDate:body.establishmentDate,establishmentMethod:body.establishmentMethod,stage:'sowed' as const,...(body.notes?{notes:body.notes}:{}),...(field?{fieldId:field.id}:{}),...(companion?{companion}:{})};
  const updated=FarmWorkspaceState.parse({...state,cycles:[...state.cycles,cycle]});
  const saved=(await c.query('INSERT INTO farm_workspaces(farm_id,version,state) VALUES($1,$2,$3::jsonb) ON CONFLICT(farm_id) DO UPDATE SET version=EXCLUDED.version,state=EXCLUDED.state RETURNING version,updated_at',[farmId,(row?.version??0)+1,JSON.stringify(updated)])).rows[0]!;
  // Names the companion and the field when present ("Rice (with Black gram) on North strip: transplanting recorded on ..."); unchanged otherwise.
  const where=`${companion?` (with ${companion.cropName})`:''}${field?` on ${field.name}`:''}`;
  const journalEntryId=await journalAction(c,deps,ownerId,farmId,cycle.id,'establishment',body.clientEntryId,body.establishmentDate,`${cropName}${where}: ${body.establishmentMethod} recorded on ${body.establishmentDate}.${body.notes?' '+body.notes:''}`,hash,{cycle});
  return{cycle,workspace:{...updated,farmId,version:saved.version,updatedAt:saved.updated_at.toISOString()},journalEntryId,alreadyRecorded:false};
 });
}
/**
 * The companion of an intercrop cycle with names from the catalogue (focused crop name, else the crop identity's English
 * name); an explicit product must belong to the companion crop. rowRatio defaults to "not stated" (nothing is inferred).
 */
async function companionOf(c:PoolClient,input:NonNullable<PlantCrop['companion']>,mainCropId:string,crops:readonly FocusedCareCrop[]){
 if(input.cropId===mainCropId)throw new ApiError(400,'validation_error','The companion crop must differ from the main crop');
 const focused=crops.find(x=>x.cropId===input.cropId);
 const identity=(await c.query<{name:string|null}>(`SELECT names->'en'->0->>'text' AS name FROM crop_identities WHERE slug=$1`,[input.cropId])).rows[0];
 if(!focused&&!identity)throw new ApiError(400,'validation_error','Choose a companion crop from the catalogue');
 let product:{slug:string;name:string}|undefined;
 if(input.productId){product=(await c.query<{slug:string;name:string}>('SELECT p.slug,p.name FROM crop_products p JOIN crop_identities c ON c.id=p.crop_id WHERE c.slug=$1 AND (p.slug=$2 OR p.id::text=$2)',[input.cropId,input.productId])).rows[0];if(!product)throw new ApiError(400,'validation_error','Selected companion product does not belong to the companion crop');}
 return{cropId:input.cropId,cropName:(focused?.displayName??identity?.name??input.cropId).slice(0,120),...(product?{productId:product.slug,productName:product.name.slice(0,120)}:{}),rowRatio:input.rowRatio??'not stated'};
}
export async function completeCareTask(deps:CommandDeps,ownerId:string,farmId:string,cycleId:string,taskId:string,body:CompleteCareTask){
 const now=today((deps.now??(()=>new Date()))());if(body.completedOn>now)throw new ApiError(400,'validation_error','Completion cannot be in the future');const research=await focusedResearch();
 return withTransaction(deps.pool,c=>completeCareTaskIn(c,deps,ownerId,farmId,cycleId,taskId,body,now,research));
}
/**
 * The completion path inside a caller's transaction (the demo seed completes care through it). `now` is the IST date the
 * schedule is evaluated at; the caller has already refused a completion after it.
 */
export async function completeCareTaskIn(c:PoolClient,deps:Pick<CommandDeps,'config'>,ownerId:string,farmId:string,cycleId:string,taskId:string,body:CompleteCareTask,now:string,research:FocusedResearch){
  const farm=(await c.query('SELECT id,state_code,district_code FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',[farmId,ownerId])).rows[0];if(!farm)throw notFound('Farm');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${ownerId}:${body.clientEntryId}`]);
  const stateRow=(await c.query('SELECT state FROM farm_workspaces WHERE farm_id=$1',[farmId])).rows[0];const state=FarmWorkspaceState.parse(stateRow?.state),cycle=state.cycles.find(c=>c.id===cycleId);if(!cycle)throw notFound('Crop cycle');
  if(body.completedOn<cycle.sowingDate)throw new ApiError(400,'validation_error','Care completion cannot precede crop establishment');
  const hash=payloadHash({farmId,cycleId,taskId,...body});
  const replay=(await c.query('SELECT *,completed_on::text completed_on FROM farm_cycle_actions WHERE owner_id=$1 AND client_entry_id=$2',[ownerId,body.clientEntryId])).rows[0];
  if(replay){if(replay.farm_id!==farmId||replay.payload_hash!==hash||replay.mode!==deps.config.RUNTIME_MODE)throw new ApiError(409,'idempotency_conflict','This completion identifier belongs to different data');return{journalEntryId:replay.journal_entry_id,completedOn:replay.completed_on,alreadyCompleted:true}}
  const done=(await c.query('SELECT *,completed_on::text completed_on FROM farm_cycle_actions WHERE farm_id=$1 AND cycle_id=$2 AND action_key=$3 AND mode=$4',[farmId,cycleId,taskId,deps.config.RUNTIME_MODE])).rows[0];if(done)return{journalEntryId:done.journal_entry_id,completedOn:done.completed_on,alreadyCompleted:true};
  const task=careSchedule(cycle,research.crops.find(c=>c.cropId===cycle.cropId),now,[],{stateId:farm.state_code,districtId:farm.district_code}).careTasks.find(t=>t.id===taskId);if(!task)throw notFound('Care action');
  const journalEntryId=await journalAction(c,deps,ownerId,farmId,cycleId,task.id,body.clientEntryId,body.completedOn,`${task.title}: completed on ${body.completedOn}.${body.note?' '+body.note:''}`,hash,{task});
  return{journalEntryId,completedOn:body.completedOn,alreadyCompleted:false};
}
export async function farmCommandCenter(deps:CommandDeps,ownerId:string,farmId:string):Promise<FarmCommandCenter>{
 const farm=await getFarm(deps.pool,ownerId,farmId);if(!farm)throw notFound('Farm');
 const asOf=(deps.now??(()=>new Date()))().toISOString(),date=today(new Date(asOf));const workspace=await getWorkspace(deps.pool,ownerId,farmId);
 const [research,markers,quotes,completed]=await Promise.all([focusedResearch(),farmSoilMarkers(deps,ownerId,farmId),currentMandiQuotes(deps,ownerId,farmId),deps.pool.query<Completion>('SELECT cycle_id,action_key,completed_on::text completed_on,journal_entry_id FROM farm_cycle_actions WHERE owner_id=$1 AND farm_id=$2 AND mode=$3',[ownerId,farmId,deps.config.RUNTIME_MODE])]);
 const products=(await deps.pool.query<{crop_id:string;slug:string;name:string}>('SELECT c.slug crop_id,p.slug,p.name FROM crop_products p JOIN crop_identities c ON c.id=p.crop_id WHERE c.slug=ANY($1::text[]) ORDER BY p.slug',[research.crops.map(c=>c.cropId)])).rows;
 const map=loadCommodityMap().filter(m=>m.verified&&!m.unresolved);
 const focusedCrops=research.crops.map(c=>({cropId:c.cropId,displayName:c.displayName,botanicalName:c.botanicalName,productionType:c.productionType,establishmentMethods:c.establishmentMethods,products:products.filter(p=>p.crop_id===c.cropId&&(!Array.isArray(c.marketProductIds)||(c.marketProductIds as string[]).includes(p.slug))).map(p=>({productId:p.slug,productName:p.name,sourceCommodities:map.filter(m=>m.productSlug===p.slug).map(m=>m.sourceCommodity),mappingStatus:map.some(m=>m.productSlug===p.slug)?'verified' as const:'unavailable' as const})),soilEffects:Array.isArray(c.soilEffects)?c.soilEffects:[],endUses:Array.isArray(c.endUses)?c.endUses:[],sequenceConstraints:Array.isArray(c.sequenceConstraints)?c.sequenceConstraints:[],limitations:c.limitations}));
 const point=farm.location.lat!==null&&farm.location.lon!==null?{lat:farm.location.lat,lon:farm.location.lon}:null;
 const forecast=deps.config.RUNTIME_MODE==='live'?await createWeatherSource({pool:deps.pool,mode:'live',autoIngest:false}).getForecast({farmId,districtId:farm.location.districtId,stateId:farm.location.stateCode,point},{issuedAtOrBefore:asOf}):null;
 const days=forecast?.days.filter(d=>d.date>=date)??[];
 // Products: the current quote selection; when it is empty, the products of the growing crops and saved seasons. Target dates come only from recorded crops and saved seasons.
 const tracked=[...new Set([...workspace.cycles.filter(c=>c.stage!=='harvested'),...workspace.rotationPlans].flatMap(r=>r.productId?[r.productId]:[]))].slice(0,8);
 const marketProducts=quotes.products.length?quotes.products.map(p=>p.productId):tracked;
 const priorYearMarkets=(await Promise.all(marketProducts.map(async productId=>{const p={productId};
  const cycle=workspace.cycles.find(c=>c.stage!=='harvested'&&c.productId===p.productId),crop=research.crops.find(c=>c.cropId===cycle?.cropId);
  const duration=crop?.durationVariants?.find(d=>d.productId===p.productId||d.productIds?.includes(p.productId))??crop?.duration;
  const sourceMatches=duration?.sourceRefs.some(ref=>{const src=research.sources.find(s=>s.id===ref.sourceId);return farm.location.stateCode==='IN-TN'&&typeof src?.geography==='string'&&/Tamil Nadu/i.test(src.geography)});
  const harvest=cycle&&duration?.kind==='crop_completion'&&duration.anchor===establishmentAnchor(cycle.establishmentMethod)&&duration.maxDays!==null&&sourceMatches?addCareDays(cycle.establishmentDate??cycle.sowingDate,duration.maxDays):null;
  const plan=workspace.rotationPlans.find(r=>r.productId===p.productId&&r.plannedHarvestDate&&r.plannedHarvestDate>=date);
  const target=harvest&&harvest>=date?harvest:plan?.plannedHarvestDate??date;
  return priorYearMandiQuotes(deps,ownerId,farmId,[p.productId],target,harvest&&harvest>=date?'harvest_scenario':plan?.plannedHarvestDate?'planned_harvest':'as_of_date');
 }))).flat();

 return{farmId,asOf,workspace,focusedCrops,sources:research.sources,currentCycles:workspace.cycles.filter(c=>c.stage!=='harvested').map(c=>({cycle:c,...careSchedule(c,research.crops.find(p=>p.cropId===c.cropId),date,completed.rows,{stateId:farm.location.stateCode,districtId:farm.location.districtId}),stageGuidance:(research.crops.find(p=>p.cropId===c.cropId)?.care??[]).filter(a=>a.anchor==='observed_stage'&&(!a.productIds?.length||!!c.productId&&a.productIds.includes(c.productId))&&(!a.establishmentMethods?.length||!!c.establishmentMethod&&a.establishmentMethods.includes(c.establishmentMethod))).map(a=>({actionId:a.id,title:a.title,action:a.action,stage:a.stage,conditions:a.conditions,sourceRefs:a.sourceRefs,geographyIds:a.geographyIds,applicability:a.geographyIds.some(id=>[farm.location.stateCode,farm.location.districtId,'IN'].includes(id))?'matched' as const:farm.location.stateCode?'outside_source_region' as const:'location_unknown' as const,requiresObservation:true as const}))})),soil:{markers,fit:research.crops.map(c=>measuredSoilFit(markers,c))},weather:{kind:'forecast',status:!days.length?'unavailable':Date.parse(asOf)-Date.parse(forecast!.issuedAt)>6*3600000?'stale':'fresh',reason:!days.length?'no_current_stored_forecast':null,issuedAt:forecast?.issuedAt??null,source:'https://open-meteo.com/',days:days.map(d=>({date:d.date,rainMm:d.rainMm,tMinC:d.tMinC,tMaxC:d.tMaxC,et0Mm:d.et0Mm,gustMaxKmh:d.agro?.gustMaxKmh??null,rhMeanPct:d.agro?.rhMeanPct??null,soilMoisture0to7:d.agro?.soilMoisture0to7??null}))},currentQuotes:quotes,priorYearMarkets,limitations:['Care dates are published timing relative to the recorded establishment method, not observed growth or automatic completion. Source conditions and geography require local confirmation.','Crop sequences remain drafts until explicitly applied. Missing soil, water or cultivar inputs prevent a strong suitability claim.','Historical prices are actual stored observations where available; no fabricated harvest price, margin, yield or profit forecast.']};
}
