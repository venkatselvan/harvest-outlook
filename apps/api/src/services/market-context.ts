/** Public FAO market context, separate from local mandi quotes and any harvest-price forecast. */
export const FAO_MARKET_URL='https://www.fao.org/worldfoodsituation/foodpricesindex/en/';
export interface MarketContext {
 status:'available'|'stale'|'unavailable';fetchedAt:string|null;publishedAt:string|null;period:string|null;
 source:{name:string;url:string};indices:{category:'cereals'|'sugar';label:string;cropIds:string[];points:number;unit:'index_2014_2016_100';monthOnMonthPct:number|null}[];
 topics:{label:string;cropIds:string[]}[];limitations:string[];
}
const source={name:'FAO Food Price Index · monthly market bulletin',url:FAO_MARKET_URL};
const limits=['Global export-price indices are not Indian mandi prices or a harvest-price forecast.','News topics identify reported market exposure, not measured causation or a predicted change in farm profit.','Only cereals and sugar are covered here; local vegetable and spice news requires additional verified sources.'];
const plain=(s:string)=>s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
const monthNames=['january','february','march','april','may','june','july','august','september','october','november','december'];
export function parseFaoBulletin(html:string,now=new Date()):MarketContext {
 const text=plain(html),date=text.match(/Release date:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
 if(!date)throw new Error('FAO release date missing');const publishedAt=`${date[3]}-${date[2]}-${date[1]}`;
 const parsed=Date.parse(publishedAt+'T00:00:00Z');if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==publishedAt||parsed>now.getTime()+86400000)throw new Error('FAO release date invalid');
 const overall=plain(html.match(/<span\b[^>]*id=["']ffpi-index["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]??'');
 const periodMatch=overall.match(/\bin\s+([a-z]+)\s+(\d{4})/i);const month=periodMatch?monthNames.indexOf(periodMatch[1]!.toLowerCase()):-1;
 const period=month>=0?`${periodMatch![2]}-${String(month+1).padStart(2,'0')}`:null;
 const indices:MarketContext['indices']=[];
 for(const item of [{category:'cereals' as const,id:'cereal-index',label:'Global cereals',cropIds:['paddy','wheat','maize']},{category:'sugar' as const,id:'sugar-index',label:'Global sugar',cropIds:['sugarcane']}]){
  const segment=plain(html.match(new RegExp(`<span\\b[^>]*id=["']${item.id}["'][^>]*>([\\s\\S]*?)<\\/span>`,'i'))?.[1]??'');
  const points=segment.match(/averaged\s+(\d+(?:\.\d+)?)\s+points/i);if(!points)continue;
  // First explicitly directional percentage belongs to the month-on-month statement in this named index span.
  const change=segment.match(/\b(up|down)\s+\d+(?:\.\d+)?\s+points\s*\((\d+(?:\.\d+)?)\s*percent\)/i);
  indices.push({category:item.category,label:item.label,cropIds:item.cropIds,points:Number(points[1]),unit:'index_2014_2016_100',monthOnMonthPct:change?Number(change[2])*(change[1]!.toLowerCase()==='down'?-1:1):null});
 }
 if(!indices.length)throw new Error('FAO named index values missing');
 const topics:MarketContext['topics']=[];
 // Use the report body, never navigation or unrelated page metadata, to identify topics.
 const bulletin=text.slice(text.indexOf('»')>=0?text.indexOf('»'):text.indexOf('The FAO Cereal Price Index'));
 for(const topic of [{pattern:/Black Sea|shipping|freight/i,label:'Trade routes and freight',cropIds:['wheat','maize','paddy']},{pattern:/biofuel|ethanol/i,label:'Fuel and feedstock demand',cropIds:['maize','sugarcane']},{pattern:/lower sugar production|sugar supplies|sugarbeet|harvest progress in Brazil/i,label:'Sugar supply and harvest conditions',cropIds:['sugarcane']},{pattern:/rainfall|dry weather|El Niño/i,label:'Weather in producing regions',cropIds:['wheat','maize','paddy','sugarcane']}])if(topic.pattern.test(bulletin))topics.push({label:topic.label,cropIds:topic.cropIds});
 return{status:now.getTime()-parsed>50*86400000?'stale':'available',fetchedAt:now.toISOString(),publishedAt,period,source,indices,topics,limitations:[...limits]};
}
export function createMarketContextLoader(fetchImpl:typeof fetch=fetch,clock:()=>Date=()=>new Date()){
 let cached:MarketContext|null=null,until=0,inflight:Promise<MarketContext>|null=null;
 return async function load():Promise<MarketContext>{
  if(cached&&clock().getTime()<until)return cached;if(inflight)return inflight;
  inflight=(async()=>{try{
   const response=await fetchImpl(FAO_MARKET_URL,{headers:{accept:'text/html'},signal:AbortSignal.timeout(12000),redirect:'error'});
   if(!response.ok||!response.body)throw new Error('FAO unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1_000_000){await reader.cancel();throw new Error('FAO response too large')}chunks.push(value)}
   cached=parseFaoBulletin(Buffer.concat(chunks).toString('utf8'),clock());until=clock().getTime()+6*3600000;
  }catch{
   cached=cached&&cached.indices.length?{...cached,status:'stale',limitations:[...limits,'The latest source refresh failed; these are previously retrieved observations.']}:{status:'unavailable',fetchedAt:null,publishedAt:null,period:null,source,indices:[],topics:[],limitations:[...limits,'The official bulletin could not be retrieved or its format was not recognized.']};until=clock().getTime()+60000;
  }return cached;})().finally(()=>{inflight=null});return inflight;
 };
}
export const loadMarketContext=createMarketContextLoader();
