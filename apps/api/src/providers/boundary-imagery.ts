// Retained for the Sentinel-2 NDVI provider; no callers until Stream B.
import sharp from 'sharp';
import type {GeographicBoundary} from '@harvest/contracts';
import {z} from 'zod';
const HOST='https://planetarycomputer.microsoft.com';
const attribution='Contains modified Copernicus Sentinel-2 data; imagery served by Microsoft Planetary Computer (Sentinel data licence).';
const limitations=['Sentinel-2 visible bands have approximately ten metre pixels; small plots and irrigation equipment may be unresolved.','Scene cloud cover is regional; cloud or haze over the selected plot must still be checked.','Visible appearance does not measure soil moisture, irrigation practice, drainage or current crop identity.'];
export async function boundaryImagery(boundary:GeographicBoundary,fetchImpl:typeof fetch=fetch){
 const ring=boundary.coordinates[0]!;const xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]);const cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
 const dx=Math.max(0.004,Math.max(...xs)-Math.min(...xs))*0.7,dy=Math.max(0.004,Math.max(...ys)-Math.min(...ys))*0.7;
 const bbox=[cx-dx,cy-dy,cx+dx,cy+dy];
 const start=new Date(Date.now()-180*86400000).toISOString();const end=new Date().toISOString();
 const params=new URLSearchParams({collections:'sentinel-2-l2a',bbox:bbox.join(','),datetime:`${start}/${end}`,limit:'5',query:JSON.stringify({'eo:cloud_cover':{lt:35}}),sortby:'-datetime'});
 const unavailable=(reason:string)=>({data:null,metadata:{status:'unavailable' as const,source:HOST,attribution,capturedAt:null,imageryDate:null,kind:'none' as const,limitations:[reason,...limitations]},source:null});
 try{
  const search=await fetchImpl(`${HOST}/api/stac/v1/search?${params}`,{signal:AbortSignal.timeout(20000)});if(!search.ok)return unavailable('Public satellite catalogue is unavailable.');
  const parsed=z.object({features:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9_.-]+$/),properties:z.object({datetime:z.iso.datetime(),'eo:cloud_cover':z.number().optional()})})).max(5)}).safeParse(await search.json());
  const item=parsed.success?parsed.data.features[0]:undefined;if(!item)return unavailable('No eligible recent public Sentinel-2 scene was found.');
  const options=new URLSearchParams({collection:'sentinel-2-l2a',item:item.id,assets:'visual',asset_bidx:'visual|1,2,3',nodata:'0',coord_crs:'EPSG:4326',dst_crs:'EPSG:4326'});
  const image=await fetchImpl(`${HOST}/api/data/v1/item/bbox/${bbox.join(',')}/768x768.png?${options}`,{signal:AbortSignal.timeout(25000)});
  if(!image.ok||!image.headers.get('content-type')?.startsWith('image/'))return unavailable('Public satellite crop rendering is unavailable.');
  if(Number(image.headers.get('content-length')??0)>6*1024*1024)return unavailable('Satellite crop exceeded the bounded image size.');
  const bytes=Buffer.from(await image.arrayBuffer());if(bytes.length>6*1024*1024)return unavailable('Satellite crop exceeded the bounded image size.');
  const points=ring.map(p=>`${(p[0]-bbox[0]!)/(bbox[2]!-bbox[0]!)*768},${(bbox[3]!-p[1])/(bbox[3]!-bbox[1]!)*768}`).join(' ');
  const overlay=Buffer.from(`<svg width="768" height="768"><polyline points="${points}" fill="none" stroke="#ff3737" stroke-width="3"/></svg>`);
  const data=await sharp(bytes).resize(768,768,{fit:'fill'}).composite([{input:overlay}]).jpeg({quality:85}).toBuffer();
  const capturedAt=new Date().toISOString();const url=`${HOST}/api/stac/v1/collections/sentinel-2-l2a/items/${item.id}`;
  return{data,metadata:{status:'available' as const,source:url,attribution,capturedAt,imageryDate:item.properties.datetime,kind:'map_snapshot' as const,limitations:[...limitations,`Scene cloud cover: ${item.properties['eo:cloud_cover']??'not reported'} percent; not plot-level quality.`]},source:{id:'satellite-snapshot',title:`Sentinel-2 boundary snapshot (${item.properties.datetime.slice(0,10)})`,url,attribution,retrievedAt:capturedAt,limitations}};
 }catch{return unavailable('Public satellite imagery could not be obtained within the bounded request.');}
}
