import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {currentMandiQuotes,priorYearMandiQuotes} from '../src/services/market-quotes';
import {loadCatalogueIntoDb} from '../src/catalogue/load';
import {normalizeMandiRecords} from '../src/providers/datagovin/normalize';
import {storeMarketRows} from '../src/ingest/market-store';
import {ensureSource} from '../src/ingest/sources';
import {withoutLegacyDemoRecords} from '../src/services/demo-farm';
import {ToolRegistry} from '../src/agent/tools/registry';
import {farmBody,login,setupHarness,type Harness,type Client} from './helpers';
let h:Harness,a:Client,b:Client,ownerId:string,farmId:string;
beforeAll(async()=>{h=await setupHarness();await loadCatalogueIntoDb(h.pool);a=await login(h.app);b=await login(h.app);const f=(await a.call('POST','/api/v1/farms',{payload:farmBody({location:{stateId:'IN-KA',districtId:'IN-KA-hassan',precision:'district'},facts:{}})})).json().data;farmId=f.id;ownerId=(await h.pool.query('SELECT owner_id FROM farms WHERE id=$1',[farmId])).rows[0].owner_id;vi.stubEnv('DATA_GOV_IN_API_KEY','fixture-key')});
afterAll(async()=>{vi.unstubAllEnvs();await h.close()});
const raw=(commodity='Maize',over:Record<string,unknown>={})=>({state:'Karnataka',district:'Hassan',market:'Hassan APMC',commodity,variety:'Local',grade:'FAQ',arrival_date:'30/10/2026',min_price:'2000',modal_price:'2200',max_price:'2400',...over});
const deps=(fetchImpl?:typeof fetch)=>({pool:h.pool,config:{...h.config,RUNTIME_MODE:'live' as const},fetchImpl,now:()=>new Date('2026-10-30T12:00:00Z')});
const response=(records:Record<string,unknown>[])=>new Response(JSON.stringify({records,total:records.length}),{status:200});
describe('latest dated mandi observations',()=>{
 it('keeps actual same-period prior-year quotes separate from current prices and preserves missing history',async()=>{
  const source=await ensureSource(h.pool,'test-prior-year',{title:'Historical fixture source',publisher:'Fixture',url:'https://example.test/prior-year',licence:'test'});
  await storeMarketRows(h.pool,normalizeMandiRecords([raw('Wheat',{arrival_date:'25/10/2025',market:'Hassan history fixture'})]).rows,{sourceId:source,mode:'live',availableAt:new Date('2026-10-29T12:00:00Z')});
  const result=await priorYearMandiQuotes(deps(),ownerId,farmId,['wheat-grain','potato-fresh'],'2026-10-30');
  expect(result[0]).toMatchObject({basis:'same_calendar_period_previous_year',scope:'district',coverageDays:1,status:'available',period:{from:'2025-10-15',to:'2025-11-14'}});
  expect(result[0]?.observations[0]).toMatchObject({date:'2025-10-25',source:'https://example.test/prior-year',evidenceState:'observed',unitBasis:'agmarknet_convention'});
  expect(result[1]).toMatchObject({status:'unavailable',missingReason:'no_valid_stored_observations_in_prior_year_period',coverageDays:0});
  expect((await priorYearMandiQuotes({...deps(),config:h.config},ownerId,farmId,['wheat-grain'],'2026-10-30'))[0]?.observations).toEqual([]);
 });
 it('hides foreign farms before any public request',async()=>{const f=vi.fn();await expect(currentMandiQuotes(deps(f),ownerId,'00000000-0000-4000-8000-000000000111',{refresh:true,productIds:['maize-grain']})).rejects.toMatchObject({statusCode:404});expect((await b.call('GET',`/api/v1/farms/${farmId}/market-quotes`)).statusCode).toBe(404);expect(f).not.toHaveBeenCalled()});
 it('shows a single exact latest quote without requiring an eight-day historical series and caches concurrent repeats',async()=>{
  const f=vi.fn(async()=>response([raw(),raw('Bengal Gram Dal(Chana Dal)'),raw('Maize',{arrival_date:'31/10/2026'}),raw('Maize',{market:'Bad order fixture',min_price:'3000',modal_price:'2000'})]));
  const [one,two]=await Promise.all([currentMandiQuotes(deps(f),ownerId,farmId,{refresh:true,productIds:['maize-grain']}),currentMandiQuotes(deps(f),ownerId,farmId,{refresh:true,productIds:['maize-grain']})]);
  expect(f).toHaveBeenCalledTimes(1);expect(one.products[0]).toMatchObject({scope:'district',status:'available'});expect(two.products[0]?.quotes).toHaveLength(1);expect(one.products[0]?.quotes[0]).toMatchObject({commodity:'Maize',date:'2026-10-30',unitBasis:'agmarknet_convention',stale:false});expect(Number(one.products[0]?.quotes[0]?.modal)).toBe(2200);expect(Number(one.products[0]?.quotes[0]?.modalInrPerKg)).toBe(22);
 });
 it('resolves requested product UUIDs and preserves split versus whole product identity',async()=>{
  const p=(await h.pool.query("SELECT id FROM crop_products WHERE slug='maize-grain'")).rows[0];const r=await currentMandiQuotes(deps(),ownerId,farmId,{productIds:[p.id]});expect(r.products[0]?.productId).toBe('maize-grain');
  const wrong=normalizeMandiRecords([raw('Red gram split/Arhar dal/Tur dal')]);expect(wrong.rows[0]?.productSlug).toBe('pigeon-pea-split');expect(wrong.rows[0]?.productSlug).not.toBe('pigeon-pea-whole');
 });
 it('does not resurrect an older valid vintage after a newer invalid correction',async()=>{
  const product=(await h.pool.query("SELECT id FROM crop_products WHERE slug='maize-grain'")).rows[0];const before=(await h.pool.query('SELECT * FROM market_observations WHERE product_id=$1 LIMIT 1',[product.id])).rows[0];
  await storeMarketRows(h.pool,normalizeMandiRecords([raw('Maize',{modal_price:'2300'})]).rows,{sourceId:before.source_id,mode:'live',availableAt:new Date(before.available_at.getTime()+1000)});
  const newest=(await h.pool.query('SELECT id FROM market_observations WHERE product_id=$1 ORDER BY available_at DESC LIMIT 1',[product.id])).rows[0];
  await h.pool.query("UPDATE market_observations SET validation_status='unverified_mapping' WHERE id=$1",[newest.id]);
  expect((await currentMandiQuotes(deps(),ownerId,farmId,{productIds:['maize-grain']})).products[0]?.quotes).toEqual([]);
 });
 it('preserves actual source URL and stale date from stored observations',async()=>{
  const id=await ensureSource(h.pool,'test-variety-source',{title:'Variety test source',publisher:'Fixture',url:'https://example.test/historical-variety',licence:'test'});
  await storeMarketRows(h.pool,normalizeMandiRecords([raw('Potato',{arrival_date:'01/10/2026',market:'Older fixture market'})]).rows,{sourceId:id,mode:'live',availableAt:new Date('2026-10-29T12:00:00Z')});
  const r=await currentMandiQuotes(deps(),ownerId,farmId,{productIds:['potato-fresh']});expect(r.products[0]).toMatchObject({status:'stale',scope:'district'});expect(r.products[0]?.quotes[0]?.source).toBe('https://example.test/historical-variety');
 });
 it('stops after429 and surfaces cooldown without repeated provider calls',async()=>{
  await h.pool.query("DELETE FROM provider_cache WHERE key LIKE 'mandi-current:%'");const f=vi.fn(async()=>new Response('{}',{status:429}));const r=await currentMandiQuotes(deps(f),ownerId,farmId,{refresh:true,productIds:['maize-grain','sunflower-seed','potato-fresh']});
  expect(f).toHaveBeenCalledTimes(1);expect(r.providerStatus).toBe('rate_limited');await currentMandiQuotes(deps(f),ownerId,farmId,{refresh:true,productIds:['maize-grain','sunflower-seed']});expect(f).toHaveBeenCalledTimes(1);
 });
 it('uses the latest ready or partial year plan slot products as the watchlist, never a pending, failed or archived plan',async()=>{
  const f=(await a.call('POST','/api/v1/farms',{payload:farmBody({location:{stateId:'IN-KA',districtId:'IN-KA-hassan',precision:'district'},facts:{}})})).json().data;
  const plan=async(status:string,productIds:string[][],archived=false)=>{const result={options:productIds.map((ids,i)=>({optionId:`o${i}`,slots:ids.map((productId,j)=>({slotId:`s${i}${j}`,productId}))}))};
   await h.pool.query('INSERT INTO farm_year_plans(owner_id,farm_id,mode,context_hash,input_versions,input_context,result,status,archived_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)',[ownerId,f.id,deps().config.RUNTIME_MODE,`quotes-${status}-${Math.random()}`,JSON.stringify({farm:1,workspace:1}),'{}',JSON.stringify(result),status,archived?new Date():null]);
   await new Promise(r=>setTimeout(r,5))};
  const basis=async()=>{const r=await currentMandiQuotes(deps(),ownerId,f.id);return{basis:r.selectionBasis,products:r.products.map(p=>p.productId)}};
  expect(await basis()).toEqual({basis:'none',products:[]});
  await plan('pending',[['maize-grain']]);await plan('error',[['wheat-grain']]);await plan('ready',[['potato-fresh']],true);
  expect(await basis()).toEqual({basis:'none',products:[]});
  await plan('ready',[['maize-grain','potato-fresh'],['potato-fresh','wheat-grain']]);
  expect(await basis()).toEqual({basis:'recommendation_watchlist',products:['maize-grain','potato-fresh','wheat-grain']});
  await plan('partial',[['sunflower-seed']]);
  expect(await basis()).toEqual({basis:'recommendation_watchlist',products:['sunflower-seed']});
 });
 it('removes complete known seed records but preserves every edited or extra field',()=>{
  const cycle={id:'demo-cycle',cropId:'ginger',cropName:'Ginger (illustrative crop)',sowingDate:'2026-06-01',stage:'growing' as const,notes:'Illustrative planning record, not an observation of research-station operations.'};
  const state={boundary:null,previousHarvest:{status:'known' as const,cropId:'maize',cropName:'Maize (illustrative previous crop)',harvestDate:'2026-04-20'},cycles:[cycle],rotationPlans:[]};expect(withoutLegacyDemoRecords(state).cycles).toEqual([]);expect(withoutLegacyDemoRecords(state).previousHarvest.status).toBe('unknown');
  for(const patch of [{notes:cycle.notes+' My observation.'},{harvestDate:'2026-10-01'},{rootPlanId:'00000000-0000-4000-8000-000000000222'}])expect(withoutLegacyDemoRecords({...state,cycles:[{...cycle,...patch}]}).cycles).toHaveLength(1);
  const registry=new ToolRegistry({});expect(registry.isAllowed('request_visual_keyframes','live')).toBe(false);
 });
});
