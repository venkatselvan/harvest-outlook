import {z} from 'zod';
import type {Pool} from '../db/pool';
import {pgCache} from '../ingest/cache';
import {getJson,type FetchLike} from '../ingest/http';
import {canonicalStateId,normaliseName,resolveDistrict} from '../catalogue/districts';
import {stateNameFor} from '../plans/adapters/market-outlook';

const collection=z.object({type:z.literal('FeatureCollection'),features:z.array(z.object({properties:z.record(z.string(),z.unknown()),geometry:z.object({type:z.enum(['Polygon','MultiPolygon']),coordinates:z.unknown()})})).max(2000)});
type Collection=z.infer<typeof collection>;
const META='https://www.geoboundaries.org/api/current/gbOpen/IND/';
const dateLimit='Boundary reference years are ADM1 2011 and ADM2 2021; simplified boundaries and later administrative changes require confirmation.';
const states=['AN','AP','AR','AS','BR','CH','CT','DN','DD','DL','GA','GJ','HR','HP','JK','JH','KA','KL','LD','MP','MH','MN','ML','MZ','NL','OR','PY','PB','RJ','SK','TN','TG','TR','UP','UT','WB','LA'];
const stateIdFor=(name:string)=>states.map(s=>canonicalStateId(s)).find(s=>s&&normaliseName(stateNameFor(s)??'')===normaliseName(name))??null;
function inRing(point:[number,number],ring:unknown):boolean{
 if(!Array.isArray(ring))return false;let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[i],b=ring[j];if(!Array.isArray(a)||!Array.isArray(b))return false;
  if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
 }return inside;
}
function contains(point:[number,number],geometry:Collection['features'][number]['geometry']):boolean{
 const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
 return Array.isArray(polygons)&&polygons.some(poly=>Array.isArray(poly)&&inRing(point,poly[0])&&!poly.slice(1).some(r=>inRing(point,r)));
}
const nameOf=(f:Collection['features'][number])=>String(f.properties.shapeName??f.properties.name??'').trim();
export async function locateIndia(pool:Pool,point:{lat:number;lon:number},fetchImpl?:FetchLike){
 const cache=pgCache(pool);const sources:{id:string;title:string;url:string;attribution:string;retrievedAt:string;limitations:string[]}[]=[];
 const load=async(level:'ADM1'|'ADM2'):Promise<Collection|null>=>{
  const key=`geoboundaries:IND:${level}:9469f09`;const hit=await cache.get(key);
  if(hit&&hit.expiresAt>new Date()){sources.push((hit.payload as {source:typeof sources[number]}).source);return collection.parse((hit.payload as {data:unknown}).data)}
  const meta=await getJson(`${META}${level}/`,{fetchImpl,timeoutMs:15000,retries:0});if(!meta.ok)return null;
  const parsed=z.object({simplifiedGeometryGeoJSON:z.url(),boundaryLicense:z.string(),boundarySource:z.string(),boundaryYearRepresented:z.string()}).safeParse(meta.json);if(!parsed.success)return null;
  const url=new URL(parsed.data.simplifiedGeometryGeoJSON);
  if(!['github.com','raw.githubusercontent.com'].includes(url.hostname)||!url.pathname.includes('/gbOpen/IND/'))return null;
  const result=await getJson(url.href,{fetchImpl,timeoutMs:20000,retries:0});if(!result.ok)return null;
  const data=collection.safeParse(result.json);if(!data.success)return null;
  const now=new Date();const source={id:`geo-${level.toLowerCase()}`,title:`geoBoundaries India ${level} (${parsed.data.boundaryYearRepresented})`,url:`${META}${level}/`,attribution:`${parsed.data.boundarySource}; ${parsed.data.boundaryLicense}`,retrievedAt:now.toISOString(),limitations:[dateLimit]};
  await cache.put({key,provider:'geoboundaries',fetchedAt:now,expiresAt:new Date(now.getTime()+30*86400000),payload:{data:data.data,source}});sources.push(source);return data.data;
 };
 const [adm1,adm2]=await Promise.all([load('ADM1'),load('ADM2')]);
 const state=adm1?.features.find(f=>contains([point.lon,point.lat],f.geometry));const district=adm2?.features.find(f=>contains([point.lon,point.lat],f.geometry));
 const stateName=state?nameOf(state):null;const stateId=stateName?stateIdFor(stateName):null;const districtName=district?nameOf(district):null;const districtId=districtName&&stateId?resolveDistrict({stateId,districtIdOrName:districtName}).districtId:null;
 return{location:{status:stateId&&districtName?'resolved' as const:stateName||districtName?'partial' as const:'unavailable' as const,countryCode:state||district?'IN':null,stateId,stateName,districtId,districtName,source:sources.length?'geoBoundaries gbOpen (local point-in-polygon)':null,uncertainties:[dateLimit,...(districtName&&!districtId?['District name is outside the current crop registry; retain the public source name and confirm it.']:[])]},sources};
}
