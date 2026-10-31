/** Bounded official current-daily inventory discovery. No request URLs, credentials or private farm context are retained. */
import '../../apps/api/src/env';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchMandiPrices} from '../../apps/api/src/providers/datagovin/client';
import {normalizeMandiRecords} from '../../apps/api/src/providers/datagovin/normalize';
import {loadProviderConfig} from '../../apps/api/src/providers/config';
import {payloadHash} from '../../apps/api/src/services/hash';
const RESOURCE='9ef84268-d588-465a-a308-a864a43d0070';
const startedAt=new Date().toISOString(),date=startedAt.slice(0,10),today=new Date(Date.now()+5.5*3600_000).toISOString().slice(0,10);
const config={...loadProviderConfig(),PROVIDER_MAX_RETRIES:0};
const MAX_PAGES=45,PAGE_SIZE=1000,PAUSE_MS=8000;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=resolve(root,'data/manifests',`agmarknet-priced-inventory-${date}.json`),rawDir=resolve(root,'data/raw/datagovin',`inventory-${date}`);
await mkdir(resolve(root,'data/manifests'),{recursive:true});await mkdir(rawDir,{recursive:true});
const all:Record<string,unknown>[]=[],pageInfo:unknown[]=[],metadataDates=new Set<string>(),fingerprints=new Set<string>();let total:number|null=null,offset=0,reason:string|null=null,providerStatus='not_checked',emptyEnd=false;
async function save(){
 const normalized=normalizeMandiRecords(all,{commodityMap:[]});
 const valid=normalized.rows.filter(r=>r.observedOn<=today&&!r.flags.some(f=>['price_order_violation','conflicting_duplicate'].includes(f)));
 const commodities=new Map<string,typeof valid>();for(const row of valid){const key=row.commodity.trim();const prior=commodities.get(key)??[];prior.push(row);commodities.set(key,prior)}
 const entries=[...commodities].sort(([a],[b])=>a.localeCompare(b)).map(([sourceCommodity,rows])=>({commodityId:`agmarknet:${sourceCommodity.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}:${payloadHash(sourceCommodity).slice(0,8)}`,sourceCommodity,classification:'pending_research',canonicalCropId:null,canonicalProductId:null,validPositivePriceRows:rows.length,modalPriceRows:rows.filter(r=>r.priceModal!==null).length,dateRange:{from:rows.map(r=>r.observedOn).sort()[0],to:rows.map(r=>r.observedOn).sort().at(-1)},states:[...new Set(rows.flatMap(r=>r.state?[r.state]:[]))].sort(),marketCount:new Set(rows.map(r=>r.marketId)).size,examples:rows.slice(0,2).map(r=>({state:r.state,district:r.district,market:r.marketName,variety:r.variety,grade:r.grade,date:r.observedOn,min:r.priceMin,modal:r.priceModal,max:r.priceMax,sourcePriceUnit:'unit not declared in API metadata; AGMARKNET INR/quintal convention remains an assumption'}))}));
 const paginatedToEnd=emptyEnd||(total!==null&&offset>=total);
 const report={resourceId:RESOURCE,sourceUrl:`https://www.data.gov.in/resource/${RESOURCE}`,startedAt,checkedAt:new Date().toISOString(),providerStatus,stopReason:reason,reportedTotal:total,pages:pageInfo,rawRowsFetched:all.length,normalizedUniqueRows:normalized.rows.length,rejectedRows:normalized.rejected.length,duplicateRows:normalized.duplicatesIgnored,conflictingRows:normalized.conflictsFlagged,validPositivePriceRows:valid.length,distinctPricedCommodities:entries.length,sourceUpdatedDates:[...metadataDates],pagination:{pageSize:PAGE_SIZE,maxPages:MAX_PAGES,maxRows:MAX_PAGES*PAGE_SIZE,pauseBetweenRequestsMs:PAUSE_MS,nextOffset:offset,paginatedToEnd,reportedTotalStable:pageInfo.every((p:any)=>p.total===total)},completeness:paginatedToEnd&&!reason?'all rows in the available current resource were paginated; the provider offers no transactionally isolated snapshot':'partial inventory; not an all-commodity claim',limitations:['Current-daily availability is a dated market-reporting snapshot, not every crop ever priced by AGMARKNET.','Exact source commodity identities are preserved; crop, processed-product and non-crop classification awaits primary-source research.','Positive prices require valid dates, non-positive and price-order checks; future-dated and conflicting observations are excluded.','Source field metadata does not declare a price unit. No farm-gate, crop-suitability or forecast claim is made.'],entries};
 await writeFile(output,JSON.stringify(report,null,2)+'\n');return report;
}
for(let page=0;page<MAX_PAGES;page++){
 if(page)await new Promise(resolve=>setTimeout(resolve,PAUSE_MS));
 const response=await fetchMandiPrices({resourceId:RESOURCE,limit:PAGE_SIZE,offset,maxPages:1,maxRecords:PAGE_SIZE},{config});
 if(response.status!=='ok'){providerStatus=response.status==='unavailable'?response.reason:'cancelled';reason=providerStatus;await save();break}
 providerStatus='ok';if(total===null)total=response.total;
 if(response.updatedDate)metadataDates.add(response.updatedDate);
 const fingerprint=payloadHash(response.records);if(fingerprints.has(fingerprint)&&response.records.length){reason='repeated_page_detected';await save();break}fingerprints.add(fingerprint);
 pageInfo.push({page:page+1,offset,count:response.records.length,total:response.total,fetchedAt:response.fetchedAt});
 await writeFile(resolve(rawDir,`page-${String(page+1).padStart(3,'0')}.json`),JSON.stringify({fetchedAt:response.fetchedAt,updatedDate:response.updatedDate,fields:response.fields,records:response.records})+'\n');
 all.push(...response.records);offset+=response.records.length;if(!response.records.length)emptyEnd=true;
 const report=await save();console.log(JSON.stringify({page:page+1,rowsFetched:all.length,total,responseRows:response.records.length,distinctPricedCommodities:report.distinctPricedCommodities,paginatedToEnd:report.pagination.paginatedToEnd}));
 if(emptyEnd||(response.total!==null&&offset>=response.total))break;
 if(page===MAX_PAGES-1){reason='bounded_page_cap';await save()}
}
console.log(JSON.stringify({report:output,providerStatus,stopReason:reason,rowsFetched:all.length,nextOffset:offset,total}));
