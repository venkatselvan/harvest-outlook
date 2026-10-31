import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ResearchedCropProfile, PricedCommodity} from '@harvest/contracts';
import type {Pool} from '../db/pool';
import {withTransaction} from '../db/pool';
import {REPO_ROOT} from '../catalogue/files';
import {loadCommodityMap} from '../providers/datagovin/normalize';
import {notFound} from './errors';
interface Inventory{checkedAt:string;resourceId:string;sourceUrl:string;rawRowsFetched:number;distinctPricedCommodities:number;pagination:{paginatedToEnd:boolean;reportedTotalStable:boolean};limitations:string[];entries:{commodityId:string;sourceCommodity:string;validPositivePriceRows:number;modalPriceRows:number;dateRange:{from:string;to:string};states:string[];marketCount:number;examples:Record<string,unknown>[]}[]}
/** Seed audited research records as independent profiles; never fabricate crop requirements for unmatched commodities. */
export async function importCommodityCatalogue(pool:Pool){
 const files=(await readdir(resolve(REPO_ROOT,'data/manifests'))).filter(f=>/^agmarknet-priced-inventory-.*\.json$/.test(f)).sort().reverse();
 let inventory:Inventory|undefined;for(const file of files){const candidate=JSON.parse(await readFile(resolve(REPO_ROOT,'data/manifests',file),'utf8')) as Inventory;if(candidate.pagination.paginatedToEnd&&candidate.pagination.reportedTotalStable){inventory=candidate;break}}
 if(!inventory)throw Error('No complete priced inventory is available; existing public snapshot retained');
 const research=JSON.parse(await readFile(resolve(REPO_ROOT,'data/research/soil-crop/crop-profiles.json'),'utf8')) as {retrievedAt:string;sources:unknown[];profiles:unknown[];commodityIdentities:{sourceCommodity:string;profileKey:string|null;botanicalCandidate:string|null;classification:string;identityNote:string}[];coverage:unknown;soilTypeReferences?:unknown[]};
 const profiles=research.profiles.map(p=>ResearchedCropProfile.parse(p)),profileById=new Map(profiles.map(p=>[p.profileId,p]));const mappings=loadCommodityMap().filter(m=>m.verified&&!m.unresolved);
 const selected=inventory;return withTransaction(pool,async client=>{
  const inventory=selected;
  const snapshotId=`agmarknet-current:${inventory.checkedAt}`;
  await client.query('INSERT INTO commodity_inventory_snapshots(id,source_url,checked_at,complete,metadata) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id) DO UPDATE SET metadata=EXCLUDED.metadata',[snapshotId,inventory.sourceUrl,inventory.checkedAt,inventory.pagination.paginatedToEnd&&inventory.pagination.reportedTotalStable,JSON.stringify({rowCount:inventory.rawRowsFetched,commodityCount:inventory.distinctPricedCommodities,limitations:inventory.limitations,pagination:inventory.pagination,researchCoverage:research.coverage,sources:research.sources,soilTypeReferences:research.soilTypeReferences??[]})]);
  for(const profile of profiles)await client.query('INSERT INTO researched_crop_profiles(profile_id,botanical_name,crop_id,record) VALUES($1,$2,NULL,$3::jsonb) ON CONFLICT(profile_id) DO UPDATE SET botanical_name=EXCLUDED.botanical_name,record=EXCLUDED.record,updated_at=now()',[profile.profileId,profile.botanicalName,JSON.stringify(profile)]);
  let researched=0;
  for(const item of inventory.entries){const identity=research.commodityIdentities.find(i=>i.sourceCommodity===item.sourceCommodity),profile=identity?.profileKey?profileById.get(identity.profileKey):null;
   const mapping=mappings.find(m=>m.sourceCommodity===item.sourceCommodity);const linked=mapping?(await client.query<{crop_id:string;product_id:string}>('SELECT c.slug crop_id,p.slug product_id FROM crop_products p JOIN crop_identities c ON c.id=p.crop_id WHERE p.slug=$1',[mapping.productSlug])).rows[0]:null;
   const nonPlant=identity&&['livestock','fish','aquaculture','animal_product','non_crop','wood','fungi','fungus_group'].includes(identity.classification);const hasEvidence=!!profile?.ecocrop||!!profile?.regionalEvidence.length||!!(profile?.ecocropVariants as unknown[]|undefined)?.length;
   const record=PricedCommodity.parse({commodityId:item.commodityId,sourceCommodity:item.sourceCommodity,grouping:identity?.classification??'unresolved',identityStatus:profile?.identityStatus??'identity_unresolved',identityNote:identity?.identityNote??null,botanicalName:profile?.botanicalName??identity?.botanicalCandidate??null,profileId:profile?.profileId??null,profileStatus:hasEvidence?'researched':nonPlant?'not_applicable':'pending',profileUrl:profile?`/api/v1/commodity-profiles/${encodeURIComponent(profile.profileId)}`:null,cropId:linked?.crop_id??null,productId:linked?.product_id??null,priceCoverage:{validRows:item.validPositivePriceRows,modalRows:item.modalPriceRows,dateRange:item.dateRange,states:item.states,marketCount:item.marketCount,unitStatus:'provider_unit_not_declared',examples:item.examples}});if(hasEvidence)researched++;
   await client.query('INSERT INTO commodity_inventory(commodity_id,snapshot_id,source_commodity,grouping,crop_id,product_id,profile_id,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(commodity_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,source_commodity=EXCLUDED.source_commodity,grouping=EXCLUDED.grouping,crop_id=EXCLUDED.crop_id,product_id=EXCLUDED.product_id,profile_id=EXCLUDED.profile_id,record=EXCLUDED.record',[record.commodityId,snapshotId,record.sourceCommodity,record.grouping,record.cropId,record.productId,record.profileId,JSON.stringify(record)]);
  }
  return{snapshotId,commodities:inventory.entries.length,profiles:profiles.length,commoditiesWithResearchedProfile:researched,sourceCoverage:research.coverage};
 });
}
export async function listCommodityCatalogue(pool:Pool,query:{query:string;grouping:string|undefined;offset:number;limit:number}){
 const snapshot=(await pool.query<{id:string;source_url:string;checked_at:Date;complete:boolean;metadata:any}>('SELECT * FROM commodity_inventory_snapshots ORDER BY checked_at DESC LIMIT 1')).rows[0];
 if(!snapshot)return{snapshot:null,total:0,offset:query.offset,limit:query.limit,items:[]};
 const pattern=`%${query.query.replace(/[\\%_]/g,'\\$&')}%`;
 const values=[snapshot.id,pattern,query.grouping??null];
 const count=(await pool.query<{count:string}>("SELECT count(*) FROM commodity_inventory WHERE snapshot_id=$1 AND (source_commodity ILIKE $2 OR record->>'botanicalName' ILIKE $2) AND ($3::text IS NULL OR grouping=$3)",values)).rows[0]!.count;
 const rows=await pool.query<{record:unknown}>("SELECT record FROM commodity_inventory WHERE snapshot_id=$1 AND (source_commodity ILIKE $2 OR record->>'botanicalName' ILIKE $2) AND ($3::text IS NULL OR grouping=$3) ORDER BY source_commodity,commodity_id LIMIT $4 OFFSET $5",[...values,query.limit,query.offset]);
 return{snapshot:{id:snapshot.id,checkedAt:snapshot.checked_at.toISOString(),complete:snapshot.complete,commodityCount:snapshot.metadata.commodityCount,rowCount:snapshot.metadata.rowCount,sourceUrl:snapshot.source_url,limitations:snapshot.metadata.limitations},total:Number(count),offset:query.offset,limit:query.limit,items:rows.rows.map(r=>PricedCommodity.parse(r.record))};
}
export async function getResearchedProfile(pool:Pool,id:string){const row=(await pool.query<{record:unknown}>('SELECT record FROM researched_crop_profiles WHERE profile_id=$1',[id])).rows[0];if(!row)throw notFound('Crop profile');return ResearchedCropProfile.parse(row.record)}

export async function listSoilTypeReferences(pool:Pool){const row=(await pool.query<{metadata:any}>("SELECT metadata FROM commodity_inventory_snapshots ORDER BY checked_at DESC LIMIT 1")).rows[0];return{references:row?.metadata.soilTypeReferences??[],limitations:["Public soil-type descriptions are not measurements or an assignment of soil type to this farm. Texture, colour, pH and nutrient status are distinct dimensions."]}}
