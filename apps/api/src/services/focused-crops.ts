import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {CareSourceRef} from '@harvest/contracts';
import {REPO_ROOT} from '../catalogue/files';
const strings=z.array(z.string());
const Source=z.object({id:z.string(),url:z.url(),publisher:z.string(),title:z.string(),retrievedAt:z.string(),geography:z.unknown()}).passthrough();
const Care=z.object({id:z.string(),title:z.string(),action:z.string(),anchor:z.enum(['sowing','transplanting','planting','observed_stage']),startDay:z.number().int().min(0),endDay:z.number().int().min(0),repeatEveryDays:z.number().int().positive().nullable(),stage:z.string().nullable(),conditions:strings,sourceRefs:z.array(CareSourceRef).min(1),establishmentMethods:strings.optional(),productIds:strings.optional(),geographyIds:strings.default([])}).passthrough();
const Duration=z.object({minDays:z.number().nullable(),maxDays:z.number().nullable(),anchor:z.string(),conditions:strings,sourceRefs:z.array(CareSourceRef),kind:z.enum(['crop_completion','first_harvest']).optional()}).passthrough();
const Crop=z.object({cropId:z.string(),displayName:z.string(),botanicalName:z.string(),aliases:strings,productionType:z.enum(['annual','long_duration','perennial']),establishmentMethods:strings,duration:Duration.nullable(),durationVariants:z.array(Duration.safeExtend({productIds:strings.optional(),productId:z.string().optional()})).optional(),plantingWindows:z.array(z.object({season:z.string(),fromMonth:z.number().int().min(1).max(12),toMonth:z.number().int().min(1).max(12),fromDay:z.number().int().min(1).max(31).optional(),toDay:z.number().int().min(1).max(31).optional(),geographyIds:strings,irrigation:z.string(),establishmentMethods:strings,anchor:z.string().optional(),sourceRefs:z.array(CareSourceRef),conditions:strings.optional()}).passthrough()).optional(),soilEnvironment:z.array(z.object({parameter:z.string(),value:z.unknown(),unit:z.string().nullable(),conditions:strings,sourceRefs:z.array(CareSourceRef)}).passthrough()),care:z.array(Care),sequenceConstraints:z.unknown(),limitations:strings}).passthrough();
export const FocusedResearch=z.object({schemaVersion:z.union([z.string(),z.number()]),sources:z.array(Source),crops:z.array(Crop)}).passthrough();
export type FocusedResearch=z.infer<typeof FocusedResearch>;
export type FocusedCareCrop=FocusedResearch['crops'][number];
export const establishmentAnchor=(method:string|undefined)=>['transplanting','sri_transplanting'].includes(method??'')?'transplanting':['direct_sowing','sowing','nursery_sowing'].includes(method??'')?'sowing':['planting','seedling_planting','rhizome_planting','sett_planting','tuber_planting','bulb_planting'].includes(method??'')?'planting':null;
export async function focusedResearch():Promise<FocusedResearch>{return FocusedResearch.parse(JSON.parse(await readFile(resolve(REPO_ROOT,'data/research/soil-crop/focused-crop-care.json'),'utf8')))}

/** Add focused crop/product identities without deleting or qualifying the broader historical catalogue. */
export async function seedFocusedCrops(pool:import('../db/pool').Pool){
 const {withTransaction}=await import('../db/pool');const {CropIdentity,CropProduct}=await import('@harvest/contracts');
 const research=await focusedResearch();
 const extraProducts:Record<string,{id:string;name:string;basis:'other'|'bulb'|'fresh'|'seed'|'fruit'}[]>={
  sugarcane:[{id:'sugarcane-cane',name:'Sugarcane whole cane',basis:'other'}],shallot:[{id:'shallot-bulb',name:'Shallot bulbs (small onion)',basis:'bulb'}],
  'curry-leaf':[{id:'curry-leaf-fresh',name:'Curry leaves (fresh)',basis:'fresh'}],coriander:[{id:'coriander-leaf',name:'Coriander leaves (fresh)',basis:'fresh'},{id:'coriander-seed',name:'Coriander seed',basis:'seed'}],lemon:[{id:'lemon-fruit',name:'Lemon fruit (Citrus limon)',basis:'fruit'}],
 };
 return withTransaction(pool,async c=>{
  let identitiesAdded=0,productsAdded=0;
  for(const crop of research.crops){
   const extras=extraProducts[crop.cropId];if(!extras)continue;
   const identity=CropIdentity.parse({schemaVersion:'1.0',id:crop.cropId,botanicalName:crop.botanicalName,commonNames:[{text:crop.displayName,language:'en',kind:'common',sourceIds:crop.care.flatMap(a=>a.sourceRefs.map(r=>r.sourceId)).slice(0,4)}],aliases:crop.aliases.map(text=>({text,language:'en',kind:'common',sourceIds:[]})),varieties:[],productIds:extras.map(p=>p.id),sourceMappings:[],mode:'live'});
   const inserted=await c.query(`INSERT INTO crop_identities(slug,scientific_name,names,category,record,source_id,validation_status) VALUES($1,$2,$3::jsonb,'focused_crops',$4::jsonb,'focused-care-v1','pending') ON CONFLICT(slug) DO NOTHING`,[crop.cropId,crop.botanicalName,JSON.stringify({en:[{text:crop.displayName,kind:'common'}]}),JSON.stringify(identity)]);identitiesAdded+=inserted.rowCount??0;
   const id=(await c.query<{id:string}>('SELECT id FROM crop_identities WHERE slug=$1',[crop.cropId])).rows[0]!.id;
   for(const p of extras){const record=CropProduct.parse({schemaVersion:'1.0',id:p.id,cropId:crop.cropId,name:p.name,productBasis:p.basis,grade:null,aliases:[],massUnit:'kg',priceUnit:'INR/kg',sourceMappings:[],mode:'live'});const added=await c.query(`INSERT INTO crop_products(crop_id,slug,name,form,unit,record,source_id,validation_status) VALUES($1,$2,$3,$4,'kg',$5::jsonb,'focused-care-v1','pending') ON CONFLICT(slug) DO NOTHING`,[id,p.id,p.name,p.basis,JSON.stringify(record)]);productsAdded+=added.rowCount??0;}
  }
  return{crops:research.crops.length,identitiesAdded,productsAdded};
 });
}
