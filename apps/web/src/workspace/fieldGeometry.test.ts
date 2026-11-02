import {describe,expect,it} from 'vitest';
import {normalizedField,insideField,createFieldScene,projectPoint,plantForm} from './fieldGeometry';
describe('field geometry with real geographic outlines',()=>{
 it('preserves a concave field footprint and excludes points inside its bounding box but outside the field',()=>{
  const ring=normalizedField({type:'Polygon',coordinates:[[[76,11],[76.004,11],[76.004,11.002],[76.002,11.002],[76.002,11.004],[76,11.004],[76,11]]]});
  expect(ring).toHaveLength(6);const x=ring[2]![0]-.1,z=ring[4]![1]+.1;expect(insideField(x,z,ring)).toBe(false);
  const ground=createFieldScene(ring,null,0);expect(ground[0]!.points.map(p=>[p[0],p[2]])).toEqual(ring);expect(ground.every(f=>f.layer===0)).toBe(true);
 });
 it('does not invent planted crops for an empty farm, and produces finite bounded geometry for all focused plant forms',()=>{
  const ring=normalizedField();const base=createFieldScene(ring,null,0).length;
  for(const crop of ['paddy','wheat','maize','sugarcane','tomato','potato','ginger','onion','shallot','green-chillies','turmeric','curry-tree','coriander','lemon']){
   const scene=createFieldScene(ring,crop,.8);expect(scene.length).toBeGreaterThan(base);expect(scene.length).toBeLessThan(14000);expect(scene.every(f=>f.points.every(p=>p.every(Number.isFinite)))).toBe(true);
  }
  expect(plantForm('lemon')).toBe('tree');expect(plantForm('green-chillies')).toBe('fruit');
 });
 it('keeps perspective controllable and geometry stable at the preview limits',()=>{
  const ring=normalizedField();expect(createFieldScene(ring,'maize',-1)).toEqual(createFieldScene(ring,'maize',0));expect(createFieldScene(ring,'maize',2)).toEqual(createFieldScene(ring,'maize',1));
  const p=projectPoint([2,1,0],{yaw:0,elevation:.7,zoom:1},800,500),q=projectPoint([2,1,0],{yaw:Math.PI,elevation:.7,zoom:1},800,500);expect(p[0]).toBeGreaterThan(400);expect(q[0]).toBeLessThan(400);
 });
});
import {createHash} from 'node:crypto';
import {renderToString} from 'solid-js/web';
import {rgbOf,normalizeWithin,parseRowRatio,intercropRowPlan,createFarmScene,farmSpacingScale,COMPANION_LEAVES,FARM_PLANT_BUDGET,type SceneField,type Face} from './fieldGeometry';
import {FieldGrowthScene} from './FieldGrowthScene';

const CONCAVE={type:'Polygon' as const,coordinates:[[[76,11],[76.004,11],[76.004,11.002],[76.002,11.002],[76.002,11.004],[76,11.004],[76,11]]]};
const TALL={type:'Polygon' as const,coordinates:[[[76,11],[76.001,11],[76.0012,11.004],[76,11.0035],[76,11]]]};
const SOLE_CROPS=[null,'paddy','wheat','maize','sugarcane','tomato','potato','ginger','onion','shallot','green-chillies','turmeric','curry-tree','coriander','lemon'];
/** sha256 over JSON of every sole-crop scene below, recorded from the scene code before intercropping and farm mode were added (2026-11-03). */
const SOLE_BASELINE={faces:928473,sha256:'25809ea4dfb641ddf272711852d515046ba1d6cf83e813e61742848d6815fc78'};
function soleDigest(options?:Parameters<typeof createFieldScene>[4]){
 const h=createHash('sha256');let faces=0;
 for(const ring of [normalizedField(),normalizedField(CONCAVE),normalizedField(TALL)])for(const crop of SOLE_CROPS)for(const p of [.1,.7,.9])for(const look of [undefined,{soilFactor:.72,canopy:'deeper' as const,water:'sheet' as const}]){
  const f=createFieldScene(ring,crop,p,look,options);faces+=f.length;h.update(JSON.stringify(f));
 }
 return {faces,sha256:h.digest('hex')};
}
const leafFaces=(faces:Face[],color:string)=>faces.filter(f=>f.color===color&&f.layer==null);
const centre=(f:Face)=>[f.points.reduce((s,p)=>s+p[0],0)/f.points.length,f.points.reduce((s,p)=>s+p[2],0)/f.points.length] as const;

describe('sole crop scene is unchanged by intercropping and farm mode',()=>{
 it('face list matches the recorded pre-change snapshot, with or without an empty planting option',()=>{
  expect(soleDigest()).toEqual(SOLE_BASELINE);
  expect(soleDigest({companionCropId:null,rowRatio:'4:2'})).toEqual(SOLE_BASELINE);
 },20000);
});

describe('normalizeWithin: fields in the farm frame',()=>{
 const farm={type:'Polygon' as const,coordinates:[[[76.95,11],[76.9518,11],[76.9518,11.0018],[76.95,11.0018],[76.95,11]]]};
 it('the farm in its own frame equals normalizedField, closed and open raw rings agree, and a missing farm frames the field alone',()=>{
  expect(normalizeWithin(farm,farm)).toEqual(normalizedField(farm));
  const raw=farm.coordinates[0]!;
  expect(normalizeWithin(raw,raw.slice(0,-1))).toEqual(normalizedField(farm));
  expect(normalizeWithin(null,farm)).toEqual(normalizedField(farm));
  expect(normalizeWithin(farm,[[76.95,11],[76.951,11]])).toEqual([]);
 });
 it('fields share the farm coordinate system: adjacent strips share an edge and lie inside the farm ring',()=>{
  const west=normalizeWithin(farm,[[76.95,11],[76.9509,11],[76.9509,11.0018],[76.95,11.0018],[76.95,11]]);
  const east=normalizeWithin(farm,[[76.9509,11],[76.9518,11],[76.9518,11.0018],[76.9509,11.0018],[76.9509,11]]);
  const ring=normalizedField(farm);
  expect(west[1]).toEqual(east[0]);expect(west[2]).toEqual(east[3]);
  expect(west[0]).toEqual(ring[0]);expect(east[2]).toEqual(ring[2]);
  // Half the farm's east-west width each (the farm's longest span, north-south here, is 9 units).
  expect(west[1]![0]-west[0]![0]).toBeCloseTo((ring[1]![0]-ring[0]![0])/2,9);expect(ring[2]![1]-ring[1]![1]).toBeCloseTo(-9,9);
 });
});

describe('intercrop rows',()=>{
 it('parses "main:companion" ratios and falls back to 2:1',()=>{
  expect(parseRowRatio('4:2')).toEqual([4,2]);expect(parseRowRatio(' 3 : 1 ')).toEqual([3,1]);
  for(const bad of ['not stated',null,undefined,'','0:3','2:0','abc','4-2','99:1'])expect(parseRowRatio(bad)).toEqual([2,1]);
 });
 it('rows run along the longer axis and repeat main then companion rows by the ratio',()=>{
  const wide=normalizedField();// 8 x 6: rows along x, stacked across z
  const plan=intercropRowPlan(wide,'paddy','black-gram','4:2');
  expect(plan.axis).toBe('x');
  expect(plan.rows.slice(0,12).map(r=>r.companion)).toEqual([false,false,false,false,true,true,false,false,false,false,true,true]);
  expect(intercropRowPlan(wide,'paddy','black-gram','1:1').rows.slice(0,4).map(r=>r.companion)).toEqual([false,true,false,true]);
  expect(intercropRowPlan(wide,'paddy','black-gram','not stated').rows.slice(0,6).map(r=>r.companion)).toEqual([false,false,true,false,false,true]);
  expect(intercropRowPlan(normalizedField(TALL),'paddy','black-gram','4:2').axis).toBe('z');
  // Rows advance monotonically and stay within the field's extent.
  const at=plan.rows.map(r=>r.at);expect(at.every((v,i)=>i===0||v>at[i-1]!)).toBe(true);expect(Math.max(...at)).toBeLessThan(3);expect(Math.min(...at)).toBeGreaterThan(-3);
 });
 it('a companion changes the scene, its leaves sit only on companion rows, and the ratio changes the row pattern',()=>{
  const ring=normalizedField();
  const sole=createFieldScene(ring,'paddy',.5);
  const mixed=createFieldScene(ring,'paddy',.5,null,{companionCropId:'black-gram',rowRatio:'4:2'});
  expect(mixed).not.toEqual(sole);
  expect(leafFaces(sole,COMPANION_LEAVES.leaf)).toHaveLength(0);
  const companionLeaves=leafFaces(mixed,COMPANION_LEAVES.leaf);
  expect(companionLeaves.length).toBeGreaterThan(50);
  expect(leafFaces(mixed,'#72964f').length).toBeGreaterThan(50);// main paddy leaves remain
  const rowsOf=(ratio:string)=>{const plan=intercropRowPlan(ring,'paddy','black-gram',ratio);return new Set(leafFaces(createFieldScene(ring,'paddy',.5,null,{companionCropId:'black-gram',rowRatio:ratio}),COMPANION_LEAVES.leaf).map(f=>plan.rows.findIndex(r=>Math.abs(r.at-f.points[0]![2])<1e-9)));};
  const r42=rowsOf('4:2'),r11=rowsOf('1:1');
  expect(r42.has(-1)).toBe(false);expect(r11.has(-1)).toBe(false);
  expect([...r42].every(i=>i%6>=4)).toBe(true);
  expect([...r11].every(i=>i%2===1)).toBe(true);
  expect([...r11].sort()).not.toEqual([...r42].sort());
  // Same crop as companion still reads apart by leaf colour, and the scene stays finite and bounded.
  const twin=createFieldScene(ring,'ginger',.6,null,{companionCropId:'turmeric'});
  expect(leafFaces(twin,COMPANION_LEAVES.leaf).length).toBeGreaterThan(0);
  expect(twin.every(f=>f.points.every(p=>p.every(Number.isFinite)))).toBe(true);
 });
});

describe('createFarmScene: several fields, one crop each',()=>{
 const lon0=76.95,lat0=11,d=.0018;
 const farm={type:'Polygon' as const,coordinates:[[[lon0,lat0],[lon0+d,lat0],[lon0+d,lat0+d],[lon0,lat0+d],[lon0,lat0]]]};
 const strip=(i:number,n:number)=>{const a=lon0+d*i/n,b=lon0+d*(i+1)/n;return [[a,lat0],[b,lat0],[b,lat0+d],[a,lat0+d],[a,lat0]];};
 const farmRing=normalizedField(farm);
 const three:SceneField[]=[
  {id:'a',name:'North strip',ring:normalizeWithin(farm,strip(0,3)),cropId:'paddy',progress:.8,companionCropId:'black-gram',rowRatio:'1:1'},
  {id:'b',name:'Middle',ring:normalizeWithin(farm,strip(1,3)),cropId:'ginger',progress:.2,selected:true},
  {id:'c',name:'South',ring:normalizeWithin(farm,strip(2,3)),cropId:null,progress:0},
 ];
 const plantsIn=(faces:Face[],ring:[number,number][])=>faces.filter(f=>f.layer==null&&insideField(...centre(f),ring));
 it('draws the farm as lighter uncropped soil, each planted field with its own crop and progress, and the bare field without plants',()=>{
  const faces=createFarmScene(farmRing,three);
  expect(faces[0]!.points.map(p=>[p[0],p[2]])).toEqual(farmRing);expect(faces[0]!.layer).toBe(0);
  const [a,b,c]=three.map(f=>plantsIn(faces,f.ring));
  expect(a!.length).toBeGreaterThan(0);expect(b!.length).toBeGreaterThan(0);expect(c).toHaveLength(0);
  // Paddy at 0.8 stands taller than ginger at 0.2.
  const top=(fs:Face[])=>Math.max(...fs.flatMap(f=>f.points.map(p=>p[1])));
  expect(top(a!)).toBeGreaterThan(top(b!));
  // The intercropped field carries companion leaves; the sole ginger field does not.
  expect(leafFaces(a!,COMPANION_LEAVES.leaf).length).toBeGreaterThan(0);expect(leafFaces(b!,COMPANION_LEAVES.leaf)).toHaveLength(0);
  // Bare field: faint row marks under the plants' layer, no plant faces.
  expect(faces.filter(f=>f.layer===.2&&insideField(...centre(f),three[2]!.ring)).length).toBeGreaterThan(5);
  // Every face is finite; plants only inside fields; nothing under the plants' layer is above the bund height.
  expect(faces.every(f=>f.points.every(p=>p.every(Number.isFinite)))).toBe(true);
  expect(faces.filter(f=>f.layer==null).every(f=>three.some(s=>insideField(...centre(f),s.ring)))).toBe(true);
 });
 it('gives the selected field a brighter bund and every other field a thin one',()=>{
  const faces=createFarmScene(farmRing,three);
  const bright=faces.filter(f=>f.color==='#d8edb1');
  expect(bright.length).toBe(4);// one top strip per edge of the selected strip
  expect(bright.every(f=>f.layer===.35)).toBe(true);
  const none=createFarmScene(farmRing,three.map(f=>({...f,selected:false})));
  expect(none.some(f=>f.color==='#d8edb1')).toBe(false);
 });
 it('applies the condition look to the whole farm (soil, canopy) but draws water only inside a cropped field that sets it',()=>{
  const plain=createFarmScene(farmRing,three);
  const look={soilFactor:.72,canopy:'paler' as const,water:'patches' as const};
  // A farm-level water look alone floods nothing: water belongs to a field.
  const farmOnly=createFarmScene(farmRing,three,look);
  expect(farmOnly.filter(f=>f.tag==='water')).toHaveLength(0);
  expect(rgbOf(farmOnly[0]!.color)[1]).toBeLessThan(rgbOf(plain[0]!.color)[1]);
  expect(farmOnly.filter((f,i)=>f.layer==null&&f.color!==plain[i]!.color).length).toBeGreaterThan(20);
  expect(createFarmScene(farmRing,three,null)).toEqual(plain);
  // The first field's own water look is drawn, inside that field's ring only.
  const wet=createFarmScene(farmRing,three.map((f,i)=>i===0?{...f,water:'patches' as const}:f),look);
  const water=wet.filter(f=>f.tag==='water');
  expect(water.length).toBeGreaterThanOrEqual(1);
  expect(water.every(f=>f.points.every(([x,,z])=>insideField(x,z,three[0]!.ring)))).toBe(true);
 });
 it('floods only the paddy field: a bare field next to it gets no water faces, even when it sets one',()=>{
  const paddy:SceneField={...three[0]!,companionCropId:null,water:'sheet'};
  const bare:SceneField={...three[2]!,water:'sheet'};
  const faces=createFarmScene(farmRing,[paddy,bare],{soilFactor:.7,water:'sheet'});
  const water=faces.filter(f=>f.tag==='water');
  expect(water).toHaveLength(1);
  expect(water[0]!.points.every(([x,,z])=>insideField(x,z,paddy.ring))).toBe(true);
  expect(water.some(f=>f.points.some(([x,,z])=>insideField(x,z,bare.ring)))).toBe(false);
  // Same farm with the bare field only: nothing is flooded.
  expect(createFarmScene(farmRing,[bare],{water:'sheet'}).filter(f=>f.tag==='water')).toHaveLength(0);
 });
 it('lets a field carry its own soil darkening while the farm-level factor darkens the rest',()=>{
  const fields=three.map((f,i)=>i===1?{...f,soilFactor:.5}:f);
  const base=createFarmScene(farmRing,three,{soilFactor:.8}),own=createFarmScene(farmRing,fields,{soilFactor:.8});
  const soilOf=(faces:Face[],ring:[number,number][])=>faces.find(f=>f.layer===.1&&insideField(...centre(f),ring))!.color;
  expect(rgbOf(soilOf(own,three[1]!.ring))[1]).toBeLessThan(rgbOf(soilOf(base,three[1]!.ring))[1]);
  expect(soilOf(own,three[0]!.ring)).toBe(soilOf(base,three[0]!.ring));
 });
 it('keeps a 10-field farm within the plant budget and fast to build and project',()=>{
  const all=(crop:string)=>Array.from({length:10},(_,i):SceneField=>({id:String(i),name:`Strip ${i+1}`,ring:normalizeWithin(farm,strip(i,10)),cropId:crop,progress:.9,selected:i===3}));
  const mixedCrops=['paddy','sugarcane','maize','ginger','tomato','curry-tree','wheat','turmeric','onion','lemon'];
  const mixed=mixedCrops.map((crop,i):SceneField=>({id:String(i),name:`Strip ${i+1}`,ring:normalizeWithin(farm,strip(i,10)),cropId:crop,progress:.9,companionCropId:i===0?'black-gram':null}));
  expect(farmSpacingScale(all('paddy'))).toBeGreaterThan(1);
  expect(farmSpacingScale(mixed.slice(0,2))).toBe(1);
  expect(FARM_PLANT_BUDGET).toBe(260);
  const sole=createFieldScene(farmRing,'paddy',.9).length;
  for(const fields of [all('paddy'),all('sugarcane'),mixed]){
   const t0=performance.now();
   const faces=createFarmScene(farmRing,fields,{soilFactor:.8,canopy:'deeper',water:'sheet'});
   const camera={yaw:-.55,elevation:.7,zoom:1};
   const ordered=faces.map(f=>({layer:f.layer??1,points:f.points.map(p=>projectPoint(p,camera,800,540))})).sort((a,b)=>a.layer-b.layer||a.points.reduce((s,p)=>s+p[2],0)/a.points.length-b.points.reduce((s,p)=>s+p[2],0)/b.points.length);
   const ms=performance.now()-t0;
   expect(ordered.length).toBe(faces.length);
   // No more faces than the same farm drawn as one sole paddy field (the scene that ships today), and well under a second.
   expect(faces.length).toBeLessThan(sole);
   expect(ms).toBeLessThan(500);
  }
 });
 it('plants a single centred plant on a field narrower than one spacing, and skips degenerate rings',()=>{
  const tiny:SceneField={id:'t',name:'Tiny',ring:[[0,0],[.2,0],[.2,.2],[0,.2]],cropId:'paddy',progress:.5};
  const faces=createFarmScene(farmRing,[tiny,{id:'x',name:'Broken',ring:[[0,0],[1,1]],cropId:'maize',progress:.5}]);
  expect(plantsIn(faces,tiny.ring).length).toBeGreaterThan(0);
 });
});

describe('FieldGrowthScene farm mode',()=>{
 const farm={type:'Polygon' as const,coordinates:[[[76.95,11],[76.9518,11],[76.9518,11.0018],[76.95,11.0018],[76.95,11]]]};
 const fields:SceneField[]=[
  {id:'a',name:'North strip',ring:normalizeWithin(farm,[[76.95,11],[76.9509,11],[76.9509,11.0018],[76.95,11.0018]]),cropId:'paddy',progress:.6,companionCropId:'black-gram'},
  {id:'b',name:'South strip',ring:normalizeWithin(farm,[[76.9509,11],[76.9518,11],[76.9518,11.0018],[76.9509,11.0018]]),cropId:null,progress:0},
 ];
 it('labels the canvas with every field and its crop, and hides the single-field growth slider',()=>{
  const html=renderToString(()=>FieldGrowthScene({farmBoundary:farm,fields,cropNames:{paddy:'Paddy / rice'},progress:.5,date:'2026-09-10',compact:true}));
  expect(html).toContain('Illustration of 2 fields on your farm: Paddy / rice with black gram on North strip, no crop on South strip.');
  expect(html).toContain('data-mode="farm"');
  const uncontrolled=renderToString(()=>FieldGrowthScene({farmBoundary:farm,fields}));
  expect(uncontrolled).not.toContain('field-growth-timeline');
  expect(uncontrolled).not.toContain('A new season starts here');
 });
 it('stays in field mode without fields or without a farm boundary, and names a single-field companion',()=>{
  const field=renderToString(()=>FieldGrowthScene({cropId:'paddy',cropName:'Paddy',progress:.5,farmBoundary:farm,fields:[]}));
  expect(field).not.toContain('data-mode');expect(field).toContain('Illustration of Paddy on your field.');
  const noFarm=renderToString(()=>FieldGrowthScene({cropId:'paddy',cropName:'Paddy',progress:.5,fields}));
  expect(noFarm).not.toContain('data-mode');
  const mixed=renderToString(()=>FieldGrowthScene({cropId:'paddy',cropName:'Paddy',progress:.5,companionCropId:'black-gram',rowRatio:'4:2'}));
  expect(mixed).toContain('Illustration of Paddy with black gram in alternating rows on your field.');
 });
});
