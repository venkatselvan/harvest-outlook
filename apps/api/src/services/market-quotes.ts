import type {CurrentMandiQuote,CurrentMandiQuotes} from '@harvest/contracts';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import {withTransaction} from '../db/pool';
import {getFarm} from './farms';
import {getWorkspace} from './workspace';
import {workspaceMarketProducts} from './monitoring';
import {notFound} from './errors';
import {payloadHash} from './hash';
import {pgCache} from '../ingest/cache';
import {fetchMandiPrices,type MandiResult} from '../providers/datagovin/client';
import {loadCommodityMap,normalizeMandiRecords} from '../providers/datagovin/normalize';
import {loadProviderConfig} from '../providers/config';
import {storeMarketRows} from '../ingest/market-store';
import {ensureSource,MANDI_RESOURCES} from '../ingest/sources';
import {stateNameFor} from '../plans/adapters/market-outlook';
import {sharedMarketQuery} from '../ingest/scope';
export interface QuoteDeps{pool:Pool;config:Config;fetchImpl?:typeof fetch|undefined;now?:()=>Date}
const RESOURCE='9ef84268-d588-465a-a308-a864a43d0070';
const SOURCE=`https://www.data.gov.in/resource/${RESOURCE}`;
const norm=(s:unknown)=>String(s??'').toLowerCase().replace(/[^a-z0-9]/g,'');
const nowDate=(deps:QuoteDeps)=>(deps.now??(()=>new Date()))();
const today=(deps:QuoteDeps)=>new Date(nowDate(deps).getTime()+5.5*3600_000).toISOString().slice(0,10);
const badFlags=['conflicting_duplicate','price_order_violation','commodity_unmapped','commodity_mapping_unverified','unresolved_product'];
interface Stored{product_id:string;commodity:string;observed_on:Date|string;market_id:string;market_name:string;state_name:string|null;district_name:string|null;variety:string|null;grade:string|null;price_min:string|null;price_modal:string|null;price_max:string|null;price_modal_inr_per_kg:string|null;available_at:Date;flags:string[];unit:string;source_url:string;validation_status:string}
async function productsFor(deps:QuoteDeps,ownerId:string,farmId:string,requested?:string[]){
 if(requested?.length){const rows=await deps.pool.query<{id:string;slug:string}>('SELECT id,slug FROM crop_products WHERE slug=ANY($1::text[]) OR id::text=ANY($1::text[])',[requested.slice(0,8)]);return {basis:'requested_products' as const,products:[...new Set(requested.map(id=>rows.rows.find(p=>p.slug===id||p.id===id)?.slug??id))].filter(id=>rows.rows.some(p=>p.slug===id)).slice(0,8)}}
 const workspace=await getWorkspace(deps.pool,ownerId,farmId);const tracked=await workspaceMarketProducts(deps.pool,workspace);
 if(tracked.length)return{basis:'tracked_products' as const,products:tracked.slice(0,8)};
 // Watchlist when nothing is tracked: the crops the latest ready or partial year plan of the current horizon proposes (every
 // slot of every option). Later plan years (horizon_from set, ROUND3_SPEC 1) are left out: their crops are a year or more away.
 const plan=(await deps.pool.query<{result:{options?:{slots?:{productId?:string}[]}[]}}>("SELECT result FROM farm_year_plans WHERE farm_id=$1 AND owner_id=$2 AND mode=$3 AND archived_at IS NULL AND horizon_from IS NULL AND status IN ('ready','partial') ORDER BY created_at DESC LIMIT 1",[farmId,ownerId,deps.config.RUNTIME_MODE])).rows[0];
 const planned=(plan?.result.options??[]).flatMap(o=>o.slots??[]).map(s=>s.productId).filter((id):id is string=>typeof id==='string'&&id.length>0);
 const products=[...new Set(planned)].slice(0,8);return{basis:products.length?'recommendation_watchlist' as const:'none' as const,products};
}
async function storedQuotes(deps:QuoteDeps,products:string[]):Promise<Stored[]>{
 if(deps.config.RUNTIME_MODE!=='live'||!products.length)return [];
 // Shared (ingest/scope.ts market memo, exact key): every demo visitor asks for the same products on the same day. A
 // refresh above stores rows through storeMarketRows, which clears the memo first.
 const params=[products,today(deps),badFlags];
 return sharedMarketQuery(deps.pool,'storedQuotes',params,async()=>(await deps.pool.query<Stored>(`SELECT * FROM (SELECT DISTINCT ON(m.product_id,m.market_id,m.observed_on,m.source_id,m.variety_key,m.grade_key)
   p.slug product_id,COALESCE(m.raw->>'commodity',m.raw->>'Commodity') commodity,m.observed_on::text observed_on,m.market_id,m.market_name,m.state_name,m.district_name,m.variety,m.grade,m.price_min,m.price_modal,m.price_max,m.price_modal_inr_per_kg,m.available_at,m.flags,m.unit,m.validation_status,s.url source_url
   FROM market_observations m JOIN crop_products p ON p.id=m.product_id JOIN source_documents s ON s.id=m.source_id WHERE p.slug=ANY($1::text[]) AND m.mode='live' AND NOT m.is_synthetic AND m.available_at IS NOT NULL AND m.observed_on<=$2::date
   ORDER BY m.product_id,m.market_id,m.observed_on,m.source_id,m.variety_key,m.grade_key,m.available_at DESC NULLS LAST,m.vintage_seq DESC) q
   WHERE validation_status='valid' AND (price_modal IS NULL OR price_modal>0) AND (price_min IS NULL OR price_min>0) AND (price_max IS NULL OR price_max>0) AND NOT flags ?| $3::text[] ORDER BY observed_on DESC,available_at DESC LIMIT 2000`,params)).rows);
}
/** Separate latest observations from the eight-trading-day historical-reference qualification. */
export async function currentMandiQuotes(deps:QuoteDeps,ownerId:string,farmId:string,options:{refresh?:boolean;productIds?:string[]}={}):Promise<CurrentMandiQuotes>{
 const farm=await getFarm(deps.pool,ownerId,farmId);if(!farm)throw notFound('Farm');
 const selection=await productsFor(deps,ownerId,farmId,options.productIds);const productIds=selection.products;const checkedAt=nowDate(deps).toISOString();
 const config=loadProviderConfig();const state=stateNameFor(farm.location.stateCode),district=farm.location.districtName;
 const mappings=loadCommodityMap().filter(m=>m.verified&&!m.unresolved);const statuses=new Map<string,{providerStatus:string;missingReason:string|null}>();let requests=0;const maxRequests=6;
 let stoppedReason:string|null=null;
 const cache=pgCache(deps.pool);const cooldown=await cache.get('mandi-current:cooldown');if(cooldown&&cooldown.expiresAt>nowDate(deps))stoppedReason='rate_limited';
 if(options.refresh&&deps.config.RUNTIME_MODE==='live'&&config.DATA_GOV_IN_API_KEY){
  const source=MANDI_RESOURCES[RESOURCE]!;const sourceId=await ensureSource(deps.pool,source.manifestId,{title:source.title,publisher:'Government of India / AGMARKNET',url:SOURCE,licence:'GODL-India'});
  const foundProducts=new Set<string>();
  const scopes=[...(state&&district?[{scope:'district',filters:{state,district}}]:[]),...(state?[{scope:'state',filters:{state}}]:[]),{scope:'national',filters:{}}];
  // Fair pass over all ranked products at each scope before spending requests on broader fallback.
  for(const scope of scopes){
   for(const productId of productIds){
    if(foundProducts.has(productId))continue;
    const mapping=mappings.find(m=>m.productSlug===productId);if(!mapping){statuses.set(productId,{providerStatus:'not_checked',missingReason:'no_verified_commodity_mapping'});continue}
    const key=`mandi-current:${payloadHash({commodity:mapping.sourceCommodity,filters:scope.filters,version:3})}`;
    let result:MandiResult|undefined;
    await withTransaction(deps.pool,async client=>{
     await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);const localCache=pgCache(client as unknown as Pool);const existing=await localCache.get(key);
     if(existing&&existing.expiresAt>nowDate(deps)){result=existing.payload as MandiResult;return}
     if(stoppedReason){statuses.set(productId,{providerStatus:stoppedReason,missingReason:stoppedReason});return}
     if(requests>=maxRequests){statuses.set(productId,{providerStatus:'not_checked',missingReason:'bounded_refresh_budget_exhausted'});return}
     // A shared provider lock paces concurrent tabs and re-checks cooldown before every real request.
     await client.query("SELECT pg_advisory_xact_lock(hashtext('mandi-current-provider'))");
     const stop=await localCache.get('mandi-current:cooldown');if(stop&&stop.expiresAt>nowDate(deps)){stoppedReason='rate_limited';statuses.set(productId,{providerStatus:'rate_limited',missingReason:'rate_limited'});return}
     const last=await localCache.get('mandi-current:last-request');if(last){const gap=1000-(nowDate(deps).getTime()-last.fetchedAt.getTime());if(gap>0)await new Promise(resolve=>setTimeout(resolve,Math.min(1000,gap)))}
     requests++;
     result=await fetchMandiPrices({resourceId:RESOURCE,filters:{...scope.filters,commodity:mapping.requestCommodity??mapping.sourceCommodity},limit:250,maxPages:1,maxRecords:250},{config:{...config,PROVIDER_MAX_RETRIES:0},fetchImpl:deps.fetchImpl,now:()=>nowDate(deps)});
     await localCache.put({key:'mandi-current:last-request',provider:'data.gov.in-current',fetchedAt:nowDate(deps),expiresAt:new Date(nowDate(deps).getTime()+60000),payload:{}});
     await localCache.put({key,provider:'data.gov.in-current',fetchedAt:nowDate(deps),expiresAt:new Date(nowDate(deps).getTime()+(result.status==='ok'?5*60_000:60_000)),payload:result});
     if(result.status==='unavailable'&&result.reason==='rate_limited')await localCache.put({key:'mandi-current:cooldown',provider:'data.gov.in-current',fetchedAt:nowDate(deps),expiresAt:new Date(nowDate(deps).getTime()+60_000),payload:{reason:'rate_limited'}});
    });
    if(!result)continue;
    if(result.status==='unavailable'){statuses.set(productId,{providerStatus:result.reason,missingReason:result.reason});if(result.reason==='rate_limited')stoppedReason='rate_limited';continue}
    if(result.status!=='ok'){statuses.set(productId,{providerStatus:'cancelled',missingReason:'cancelled'});continue}
    const exact=result.records.filter(r=>norm(r.commodity)===norm(mapping.sourceCommodity)&&(!('state' in scope.filters)||norm(r.state)===norm(scope.filters.state))&&(!('district' in scope.filters)||norm(r.district)===norm(scope.filters.district)));
    const valid=normalizeMandiRecords(exact).rows.filter(r=>r.productSlug===productId&&r.mappingVerified&&r.observedOn<=today(deps)&&!r.flags.some(f=>badFlags.includes(f)));
    if(valid.length){await storeMarketRows(deps.pool,valid,{sourceId,mode:'live',availableAt:new Date(result.fetchedAt)});foundProducts.add(productId);statuses.set(productId,{providerStatus:'ok',missingReason:null})}
    else statuses.set(productId,{providerStatus:'ok',missingReason:result.truncated?'no_exact_quote_in_bounded_response':'no_matching_current_quote'});
   }
  }
 }

 const stored=await storedQuotes(deps,productIds);
 const products:CurrentMandiQuotes['products']=productIds.map(productId=>{
  const mapped=mappings.some(m=>m.productSlug===productId);const rows=stored.filter(r=>r.product_id===productId&&mappings.some(m=>m.productSlug===productId&&norm(m.sourceCommodity)===norm(r.commodity)));
  const local=rows.filter(r=>state&&district&&norm(r.state_name)===norm(state)&&norm(r.district_name)===norm(district));const regional=rows.filter(r=>state&&norm(r.state_name)===norm(state));
  const selected=local.length?local:regional.length?regional:rows;const scope=local.length?'district':regional.length?'state':rows.length?'national':'unavailable';
  const quotes:CurrentMandiQuote[]=selected.slice(0,3).map(r=>{const date=typeof r.observed_on==='string'?r.observed_on.slice(0,10):r.observed_on.toISOString().slice(0,10);return{productId,commodity:r.commodity,date,marketId:r.market_id,marketName:r.market_name,state:r.state_name,district:r.district_name,variety:r.variety,grade:r.grade,min:r.price_min,modal:r.price_modal,max:r.price_max,unit:'INR/quintal',unitBasis:r.flags.includes('source_unit_assumed_inr_per_quintal')?'agmarknet_convention':'provider_declared',modalInrPerKg:r.price_modal_inr_per_kg,evidenceState:'observed',source:r.source_url,fetchedAt:r.available_at.toISOString(),stale:Date.parse(date+'T00:00:00Z')<Date.parse(today(deps)+'T00:00:00Z')-7*86400_000,flags:r.flags}});
  const status=statuses.get(productId);const providerStatus=deps.config.RUNTIME_MODE!=='live'?'disabled_mode':!config.DATA_GOV_IN_API_KEY?'api_key_missing':status?.providerStatus??stoppedReason??'not_checked';
  return{productId,status:quotes.length?(quotes.every(q=>q.stale)?'stale':'available'):'unavailable',missingReason:quotes.length?null:!mapped?'no_verified_commodity_mapping':providerStatus==='not_checked'?(options.refresh?'bounded_refresh_budget_exhausted':'not_refreshed'):status?.missingReason??providerStatus,providerStatus,scope,fallbackReason:scope==='state'?'No district quote available in checked data; showing a reported market in the same state.':scope==='national'?'No district or state quote available in checked data; showing a broader reported market with its actual location.':null,quotes};
 });
 const available=products.filter(p=>p.quotes.length);const providerStatus=stoppedReason??([...statuses.values()].find(s=>!['ok','not_checked'].includes(s.providerStatus))?.providerStatus)??(deps.config.RUNTIME_MODE!=='live'?'disabled_mode':!config.DATA_GOV_IN_API_KEY?'api_key_missing':requests||available.length?'ok':'not_checked');
 return{checkedAt,selectionBasis:selection.basis,providerStatus,missingReason:available.length?null:!productIds.length?'no_selected_or_recommended_products':products[0]?.missingReason??'no_matching_current_quote',status:available.length===products.length&&available.length?'available':available.length?'partial':'unavailable',requestLimit:maxRequests,requestsMade:requests,products,limitations:['Latest reported wholesale observations; not a price forecast, farm-gate offer, or guaranteed sale price.','Source price fields use the stated AGMARKNET INR/quintal convention where provider metadata does not declare a unit. Conversion to INR/kg divides by one hundred.','Single dated quotes do not satisfy the separate eight-trading-day historical-summary threshold.','Provider requests are bounded and cached; rate limits and partial product coverage remain explicit.']};
}

/** Read-only prior-year observations. No history is fabricated or fetched from the current-daily endpoint. */
export async function priorYearMandiQuotes(deps:QuoteDeps,ownerId:string,farmId:string,productIds:string[],targetDate:string,targetBasis:'harvest_scenario'|'planned_harvest'|'as_of_date'='as_of_date'):Promise<import('@harvest/contracts').PriorYearMarket[]>{
 const farm=await getFarm(deps.pool,ownerId,farmId);if(!farm)throw notFound('Farm');
 const center=new Date(targetDate+'T00:00:00Z');center.setUTCFullYear(center.getUTCFullYear()-1);
 const from=new Date(center.getTime()-15*86400000).toISOString().slice(0,10),to=new Date(center.getTime()+15*86400000).toISOString().slice(0,10);
 const mappings=loadCommodityMap().filter(m=>m.verified&&!m.unresolved),state=stateNameFor(farm.location.stateCode),district=farm.location.districtName;
 const products=[...new Set(productIds)].slice(0,8);
 const stored=deps.config.RUNTIME_MODE==='live'&&products.length?(await deps.pool.query<Stored>(`SELECT * FROM(SELECT DISTINCT ON(m.product_id,m.market_id,m.observed_on,m.source_id,m.variety_key,m.grade_key)
 p.slug product_id,COALESCE(m.raw->>'commodity',m.raw->>'Commodity') commodity,m.observed_on::text observed_on,m.market_id,m.market_name,m.state_name,m.district_name,m.variety,m.grade,m.price_min,m.price_modal,m.price_max,m.price_modal_inr_per_kg,m.available_at,m.flags,m.unit,m.validation_status,s.url source_url
 FROM market_observations m JOIN crop_products p ON p.id=m.product_id JOIN source_documents s ON s.id=m.source_id WHERE p.slug=ANY($1::text[]) AND m.mode='live' AND NOT m.is_synthetic AND m.available_at<=$4 AND m.observed_on BETWEEN $2::date AND $3::date AND m.observed_on<=$6::date
 ORDER BY m.product_id,m.market_id,m.observed_on,m.source_id,m.variety_key,m.grade_key,m.available_at DESC NULLS LAST,m.vintage_seq DESC) q
 WHERE validation_status='valid' AND price_modal>0 AND (price_min IS NULL OR price_min>0) AND(price_max IS NULL OR price_max>0) AND NOT flags ?| $5::text[] ORDER BY observed_on DESC,available_at DESC LIMIT 2000`,[products,from,to,nowDate(deps),badFlags,today(deps)])).rows:[];
 return products.map(productId=>{
  const rows=stored.filter(r=>r.product_id===productId&&mappings.some(m=>m.productSlug===productId&&norm(m.sourceCommodity)===norm(r.commodity)));
  const local=rows.filter(r=>state&&district&&norm(r.state_name)===norm(state)&&norm(r.district_name)===norm(district)),regional=rows.filter(r=>state&&norm(r.state_name)===norm(state));
  const selected=local.length?local:regional.length?regional:rows;
  const observations:CurrentMandiQuote[]=selected.slice(0,20).map(r=>({productId,commodity:r.commodity,date:String(r.observed_on).slice(0,10),marketId:r.market_id,marketName:r.market_name,state:r.state_name,district:r.district_name,variety:r.variety,grade:r.grade,min:r.price_min,modal:r.price_modal,max:r.price_max,unit:'INR/quintal',unitBasis:r.flags.includes('source_unit_assumed_inr_per_quintal')?'agmarknet_convention':'provider_declared',modalInrPerKg:r.price_modal_inr_per_kg,evidenceState:'observed',source:r.source_url,fetchedAt:r.available_at.toISOString(),stale:true,flags:r.flags}));
  return{productId,period:{from,to},targetDate,targetBasis,basis:'same_calendar_period_previous_year',status:observations.length?'available':'unavailable',missingReason:observations.length?null:deps.config.RUNTIME_MODE!=='live'?'historical_live_observations_unavailable_in_mode':!mappings.some(m=>m.productSlug===productId)?'no_verified_commodity_mapping':'no_valid_stored_observations_in_prior_year_period',scope:local.length?'district':regional.length?'state':rows.length?'national':'unavailable',observations,coverageDays:new Set(selected.map(r=>String(r.observed_on).slice(0,10))).size,limitations:[...(targetBasis==='as_of_date'?['A sourced harvest date is unavailable; this comparison uses the current calendar date, not an assumed harvest date.']:[]),'Actual stored observations within fifteen days either side of the same calendar date last year; not a harvest price forecast.','Historical records are incomplete; current-daily API cannot reconstruct missing last-year prices.','Market, variety, grade and source unit convention remain attached. Broader locations are not local offers.']};
 });
}
