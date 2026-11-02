import type { FieldConditionPoint, RainClass } from '@harvest/contracts';
/**
 * Small deterministic 3D scene, rendered locally. Geometry conveys crop form, not sensed health. The condition layers
 * (sky, rain, soil, water, canopy tint) are drawn from one code-computed `FieldConditionPoint` per day (weather records,
 * forecasts, climatology, alerts and the latest satellite reading; TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 10): an
 * illustration of those records, never a camera view or a forecast of the field itself.
 */
export type V3 = [number, number, number];
/** `tag: 'water'` marks the standing-water plane so the painter can clip the shimmer to it. */
export type Face = { points: V3[]; color: string; layer?: number; tag?: 'water'; alpha?: number };
export type FieldBoundary = { type: 'Polygon'; coordinates: number[][][] };
export function normalizedField(boundary?: FieldBoundary | null): [number, number][] {
  const source = boundary?.coordinates[0]?.slice(0, -1);
  if (!source || source.length < 3) return [[-4,-3],[4,-3],[4,3],[-4,3]];
  const lat = source.reduce((s,p)=>s+(p[1]??0),0)/source.length;
  const lon = source.reduce((s,p)=>s+(p[0]??0),0)/source.length;
  const local = source.map(p=>[(p[0]!-lon)*Math.cos(lat*Math.PI/180),-(p[1]!-lat)] as [number,number]);
  const xs=local.map(p=>p[0]), zs=local.map(p=>p[1]);
  const span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...zs)-Math.min(...zs));
  if (!Number.isFinite(span) || span <= 0) return [[-4,-3],[4,-3],[4,3],[-4,3]];
  return local.map(([x,z])=>[x/span*9,z/span*9]);
}
export function insideField(x:number,z:number,ring:[number,number][]):boolean {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[i]!,b=ring[j]!;
    if((a[1]>z)!==(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}
/** Parse '#rrggbb' or 'rgb(r,g,b)' into channels. */
export function rgbOf(color:string):[number,number,number] {
  const m=/^rgb\((\d+),(\d+),(\d+)\)$/.exec(color.replace(/\s/g,''));
  if(m)return [Number(m[1]),Number(m[2]),Number(m[3])];
  const parts=color.replace('#','').match(/.{2}/g)?.map(n=>parseInt(n,16))??[0,0,0];
  return [parts[0]??0,parts[1]??0,parts[2]??0];
}
const channel=(v:number)=>Math.max(0,Math.min(255,Math.round(v)));
function tint(color:string,factor:number):string {
  return `rgb(${rgbOf(color).map(v=>channel(v*factor)).join(',')})`;
}
function polygon(points:V3[],color:string):Face {return {points,color};}
function block(x:number,z:number,y:number,w:number,h:number,d:number,color:string):Face[] {
 const a:V3=[x-w/2,y,z-d/2],b:V3=[x+w/2,y,z-d/2],c:V3=[x+w/2,y,z+d/2],e:V3=[x-w/2,y,z+d/2];
 const up=(p:V3):V3=>[p[0],p[1]+h,p[2]];
 return [polygon([up(a),up(b),up(c),up(e)],tint(color,1.12)),polygon([a,b,up(b),up(a)],tint(color,.83)),polygon([b,c,up(c),up(b)],color),polygon([c,e,up(e),up(c)],tint(color,.94)),polygon([e,a,up(a),up(e)],tint(color,.76))];
}
function crown(x:number,y:number,z:number,r:number,color:string):Face[] {
 const points:V3[]=Array.from({length:6},(_,i)=>[x+Math.cos(i*Math.PI/3)*r,y,z+Math.sin(i*Math.PI/3)*r]);
 return points.flatMap((p,i)=>[polygon([p,points[(i+1)%6]!,[x,y+r*.9,z]],tint(color,.82+i*.055)),polygon([p,[x,y-r*.65,z],points[(i+1)%6]!],tint(color,.65+i*.04))]);
}
export function plantForm(cropId:string):'grain'|'cane'|'root'|'leaf'|'fruit'|'tree' {
 const id=cropId.toLowerCase();
 if(/curry|lemon|lime/.test(id))return 'tree';
 if(/sugar|maize|corn/.test(id))return 'cane';
 if(/paddy|rice|wheat/.test(id))return 'grain';
 if(/tomato|chill|pepper/.test(id))return 'fruit';
 if(/ginger|turmeric|coriander/.test(id))return 'leaf';
 return 'root';
}
export function createFieldScene(ring:[number,number][],cropId:string|null,progress:number,look?:SceneLook|null):Face[] {
 const faces=createBaseScene(ring,cropId,progress);
 if(!look)return faces;
 const soil=look.soilFactor??1,canopy=look.canopy??'none';
 const out=faces.map(face=>face.layer===0&&soil!==1&&face.points.every(p=>p[1]>=-.021)?{...face,color:tint(face.color,soil)}:face.layer!==0&&canopy!=='none'&&greenish(face.color)?{...face,color:canopyColor(face.color,canopy)}:face);
 if(look.water&&look.water!=='none')out.push(...waterFaces(ring,look.water));
 return out;
}
function createBaseScene(ring:[number,number][],cropId:string|null,progress:number):Face[] {
 const faces:Face[]=[];const growing=!!cropId;const t=Math.max(0,Math.min(1,progress));
 faces.push({...polygon(ring.map(([x,z])=>[x,-.02,z]),growing?'#72895c':'#819174'),layer:0});
 for(let i=0;i<ring.length;i++) {
   const a=ring[i]!,b=ring[(i+1)%ring.length]!;
   faces.push(polygon([[a[0],-.02,a[1]],[b[0],-.02,b[1]],[b[0],-.35,b[1]],[a[0],-.35,a[1]]],i%2?'#777768':'#626b58'));
   faces.push(polygon([[a[0],-.35,a[1]],[b[0],-.35,b[1]],[b[0],-.65,b[1]],[a[0],-.65,a[1]]],i%2?'#58604f':'#46513f'));
 }
 faces.forEach(face=>{face.layer=0;});
 if(!cropId)return faces;
 const form=plantForm(cropId),spacing=form==='tree'?1.7:form==='cane'?.67:.48;
 const xs=ring.map(p=>p[0]),zs=ring.map(p=>p[1]);
 let index=0;
 for(let x=Math.min(...xs)+spacing*.65;x<Math.max(...xs)-spacing*.35;x+=spacing)for(let z=Math.min(...zs)+spacing*.65;z<Math.max(...zs)-spacing*.35;z+=spacing){
   if(!insideField(x,z,ring))continue;
   const variation=.88+((index++*17)%19)/100;
   const growth=(.15+t*.85)*variation;
   const leaf=t>.86&&form==='grain'?'#9da554':'#72964f';
   // Row marks are geometric cues, never a planting-distance recommendation.
   faces.push(...block(x,z,0,spacing*.68,.035,spacing*.8,'#667b52').map(face=>({...face,layer:0})));
   if(form==='tree'){
     const h=.55+growth*1.4;faces.push(...block(x,z,.02,.09,h,.09,'#787764'));
     faces.push(...crown(x,h,z,.32+growth*.47,'#4e784b'));
     if(/lemon|lime/.test(cropId)&&t>.7)faces.push(...crown(x+.26,h-.1,z+.25,.065,'#d5da70'));
   }else if(form==='grain'||form==='cane'){
     const h=growth*(form==='cane'?1.7:.83),spread=form==='cane'?.3:.19;
     for(let j=0;j<3;j++){
       const xx=x+(j-1)*.07,zz=z+(j%2)*.06;
       faces.push(...block(xx,zz,.03,.022,h,.022,'#7b9a54'));
       for(let k=0;k<3;k++){
         const angle=j*2.1+k*1.2,dx=Math.cos(angle)*spread,dz=Math.sin(angle)*spread,base=h*(.25+k*.19);
         faces.push(polygon([[xx,base,zz],[xx+dx*.55,base+h*.25,zz+dz*.55],[xx+dx,base+h*.13,zz+dz],[xx+dx*.4,base+h*.12,zz+dz*.4]],leaf));
       }
       if(t>.65&&form==='grain')faces.push(...crown(xx,h+.06,zz,.045,t>.87?'#cad084':'#97b16a'));
     }
   }else if(form==='fruit'){
     const h=.23+growth*.65;faces.push(...block(x,z,.02,.035,h,.035,'#65804e'));
     faces.push(...crown(x,h*.75,z,.12+growth*.19,leaf));
     faces.push(...crown(x+.08,h,z-.08,.1+growth*.1,'#86a968'));
     if(t>.62){const fruit=/tomato/.test(cropId)?'#d27755':'#579657';faces.push(...crown(x+.12,h*.6,z+.16,.052,fruit),...crown(x-.1,h*.68,z+.1,.042,fruit));}
   }else{
     const h=.13+growth*(form==='leaf'?.7:.33);
     for(let j=0;j<5;j++){
       const angle=j*Math.PI*.4,dx=Math.cos(angle)*(.07+growth*.15),dz=Math.sin(angle)*(.07+growth*.15);
       faces.push(polygon([[x,.03,z],[x+dx*.4,h,z+dz*.4],[x+dx,h*.75,z+dz],[x+dx*.5,h*.18,z+dz*.5]],j%2?'#8fb06c':leaf));
     }
   }
 }
 return faces;
}
export interface Camera {yaw:number;elevation:number;zoom:number}
export function projectPoint(point:V3,camera:Camera,width:number,height:number):[number,number,number] {
 const [x,y,z]=point,co=Math.cos(camera.yaw),si=Math.sin(camera.yaw),u=x*co-z*si,v=x*si+z*co;
 const scale=Math.min(width/13.5,height/10.8)*camera.zoom;
 return [width*.5+u*scale,height*.54+(v*Math.sin(camera.elevation)-y*Math.cos(camera.elevation))*scale,v*Math.cos(camera.elevation)+y*Math.sin(camera.elevation)];
}

// ------------------------------------------------------------------ daily condition layers (spec section 10.1 item 5)

/**
 * Rain streak count per IMD daily rainfall class, for a reference 800 x 540 px scene. Display density only: it rises
 * with the class so heavier days read as heavier, and is not a rainfall amount. None and unknown draw no rain.
 */
export const RAIN_STREAKS:Readonly<Record<RainClass,number>>={none:0,unknown:0,very_light:8,light:24,moderate:48,heavy:84,very_heavy:128,extremely_heavy:180};
export function rainStreakCount(rainClass:RainClass|null|undefined):number {return rainClass?RAIN_STREAKS[rainClass]??0:0;}
/** Fall speed (scene heights per second) and streak length (px) per class: heavier rain falls faster in longer streaks. */
const RAIN_MOTION:Readonly<Record<RainClass,{speed:number;length:number;width:number}>>={
 none:{speed:0,length:0,width:0},unknown:{speed:0,length:0,width:0},very_light:{speed:.55,length:7,width:1},light:{speed:.75,length:10,width:1.1},
 moderate:{speed:.95,length:13,width:1.2},heavy:{speed:1.2,length:16,width:1.35},very_heavy:{speed:1.45,length:19,width:1.5},extremely_heavy:{speed:1.7,length:22,width:1.6},
};
export type SkyTone='clear'|'overcast'|'heat'|'none';
export type WaterLook='none'|'patches'|'sheet';
export type CanopyShift='none'|'paler'|'deeper';
export interface SceneLook {soilFactor?:number;canopy?:CanopyShift;water?:WaterLook}
export interface ConditionEvent {alertId:string;type:string;severity:'info'|'watch'|'warning';title:string}
export interface ConditionLayers {
 /** False when the day has no weather record (kind unavailable) or no point exists: no sky tone and no rain. */
 weather:boolean;
 kind:FieldConditionPoint['kind']|null;
 sky:SkyTone;
 rain:{rainClass:RainClass;count:number;dashed:boolean;speed:number;length:number;width:number};
 /** Multiplier on the soil colour: 1 dry, darker when the soil is wet. */
 soil:{factor:number};
 water:{look:WaterLook;color:string;alpha:number;shimmer:boolean};
 canopy:{shift:CanopyShift};
 events:ConditionEvent[];
}
/** Soil colour multipliers: moist soil reads darker; under standing water darker still. */
export const SOIL_FACTOR={dry:1,moist:.8,wet:.72} as const;
const WATER_COLOR='#5f93b8';
/** Opacity of the water plane over the soil: a flooded sheet reads more solid than ponded patches. */
export const WATER_ALPHA={sheet:.62,patches:.55} as const;
const NO_RAIN={rainClass:'none' as RainClass,count:0,dashed:false,speed:0,length:0,width:0};
/**
 * What the illustration and the satellite overlay draw for one day, from the day's condition point and nothing else.
 * Sky: heat haze on heat-stress days (unless the day also has moderate or heavier rain), overcast on rain days, clear
 * otherwise. Rain: streak count by class, dashed for forecast and typical days. Soil darker when moist, ponded or
 * flooded. Water: ponded patches or a flooded sheet (on a day without a weather record only the crop-practice flood is
 * drawn, because it does not depend on weather). Canopy: paler and yellower below typical, deeper green above.
 */
export function conditionLayers(point:FieldConditionPoint|null|undefined):ConditionLayers {
 if(!point)return {weather:false,kind:null,sky:'none',rain:{...NO_RAIN},soil:{factor:1},water:{look:'none',color:WATER_COLOR,alpha:0,shimmer:false},canopy:{shift:'none'},events:[]};
 const weather=point.kind!=='unavailable';
 const rainClass:RainClass=weather?point.rain.class:'unknown';
 const count=weather?rainStreakCount(rainClass):0;
 const strongRain=count>=RAIN_STREAKS.moderate;
 const sky:SkyTone=!weather?'none':point.heat.stress&&!strongRain?'heat':count>0?'overcast':point.rain.class==='unknown'&&point.heat.tMaxC==null?'none':'clear';
 const motion=RAIN_MOTION[rainClass]??RAIN_MOTION.none;
 const state=point.water.state,practice=point.water.basis==='crop_practice';
 const drawWater=weather||practice;
 const look:WaterLook=!drawWater?'none':state==='flooded'?'sheet':state==='ponded'?'patches':'none';
 const soilFactor=!drawWater?1:state==='moist'?SOIL_FACTOR.moist:state==='ponded'||state==='flooded'?SOIL_FACTOR.wet:SOIL_FACTOR.dry;
 const verdict=point.greenness.verdict;
 return {
  weather,kind:point.kind,sky,
  rain:count?{rainClass,count,dashed:point.kind==='forecast'||point.kind==='typical',speed:motion.speed,length:motion.length,width:motion.width}:{...NO_RAIN,rainClass},
  soil:{factor:soilFactor},
  water:{look,color:WATER_COLOR,alpha:look==='sheet'?WATER_ALPHA.sheet:look==='patches'?WATER_ALPHA.patches:0,shimmer:look!=='none'},
  canopy:{shift:verdict==='below_typical'?'paler':verdict==='above_typical'?'deeper':'none'},
  events:point.events.map(event=>({...event})),
 };
}
export const sceneLook=(layers:ConditionLayers):SceneLook=>({soilFactor:layers.soil.factor,canopy:layers.canopy.shift,water:layers.water.look});
/** The scene needs an animation loop only while rain falls or water shimmers, and never under reduced motion. */
export function needsAnimation(layers:ConditionLayers,reducedMotion:boolean):boolean {
 return !reducedMotion&&(layers.rain.count>0||layers.water.shimmer);
}
const PALE='#c8c070',DEEP='#2d6a33';
/** Only leaf-coloured faces (green the strongest channel) take the canopy tint; stems of trees and fruit keep their colour. */
export function greenish(color:string):boolean {const [r,g,b]=rgbOf(color);return g>r&&g>b;}
/** Canopy colour by greenness verdict: below typical mixes 38% toward a pale yellow-green, above typical 30% toward deep green. */
export function canopyColor(color:string,shift:CanopyShift):string {
 if(shift==='none')return color;
 const [r,g,b]=rgbOf(color),[tr,tg,tb]=rgbOf(shift==='paler'?PALE:DEEP),k=shift==='paler'?.38:.3;
 return `rgb(${channel(r+(tr-r)*k)},${channel(g+(tg-g)*k)},${channel(b+(tb-b)*k)})`;
}
/** Low-spot centres for ponded patches, as fractions of the field's bounding box (fixed, so a day always draws the same). */
const PATCH_SPOTS:readonly [number,number,number][]=[[.27,.3,.15],[.68,.62,.18],[.4,.76,.12],[.8,.22,.11],[.55,.42,.09]];
function waterFaces(ring:[number,number][],look:WaterLook):Face[] {
 const xs=ring.map(p=>p[0]),zs=ring.map(p=>p[1]);
 const minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs),span=Math.max(maxX-minX,maxZ-minZ);
 const y=.012;
 if(look==='sheet'){
  // A continuous sheet over the soil, inset slightly from the bund (the field edge); plants stand in it.
  const cx=xs.reduce((s,v)=>s+v,0)/xs.length,cz=zs.reduce((s,v)=>s+v,0)/zs.length;
  return [{points:ring.map(([x,z])=>[cx+(x-cx)*.97,y,cz+(z-cz)*.97] as V3),color:WATER_COLOR,layer:.5,tag:'water',alpha:WATER_ALPHA.sheet}];
 }
 const faces:Face[]=[];
 for(const [fx,fz,fr] of PATCH_SPOTS){
  const cx=minX+(maxX-minX)*fx,cz=minZ+(maxZ-minZ)*fz;
  if(!insideField(cx,cz,ring))continue;
  const r=span*fr,points:V3[]=[];
  for(let i=0;i<12;i++){
   const a=i/12*Math.PI*2,wobble=1+.16*Math.sin(i*2.3+fx*9);
   let k=1,x=cx+Math.cos(a)*r*wobble,z=cz+Math.sin(a)*r*.72*wobble;
   // Pull a vertex back toward the centre until it lies inside the field, so no water is drawn outside the boundary.
   while(k>.05&&!insideField(x,z,ring)){k-=.1;x=cx+Math.cos(a)*r*wobble*k;z=cz+Math.sin(a)*r*.72*wobble*k;}
   points.push([x,y,z]);
  }
  faces.push({points,color:WATER_COLOR,layer:.5,tag:'water',alpha:WATER_ALPHA.patches});
 }
 return faces;
}
/** Deterministic streak positions (0..1 across and down the scene) for a count; the same day always draws the same rain. */
export function rainStreaks(count:number):{x:number;y:number;len:number}[] {
 const out:{x:number;y:number;len:number}[]=[];
 for(let i=0;i<count;i++){
  const h1=Math.sin(i*127.1+311.7)*43758.5453,h2=Math.sin(i*269.5+183.3)*43758.5453,h3=Math.sin(i*419.2+371.9)*43758.5453;
  out.push({x:h1-Math.floor(h1),y:h2-Math.floor(h2),len:.7+.6*(h3-Math.floor(h3))});
 }
 return out;
}
/** Streaks drawn for a canvas size: the class count is for an 800 x 540 scene, scaled by area within 0.45x to 1.5x. */
export function scaledRainCount(count:number,width:number,height:number):number {
 return Math.round(count*Math.max(.45,Math.min(1.5,width*height/(800*540))));
}

// ------------------------------------------------------------------ painter (Canvas 2D, no framework)

export interface PaintedLayers {under:HTMLCanvasElement;over:HTMLCanvasElement;water:[number,number][][]}
/**
 * Paint the static part of the scene into two layers: `under` (shadow, soil, row marks, water plane) and `over` (plants
 * and the boundary line), so a rain or shimmer frame only composites them instead of re-projecting every face.
 */
export function paintStatic(target:PaintedLayers,faces:Face[],ring:[number,number][],camera:Camera,width:number,height:number,ratio:number):PaintedLayers {
 const {under,over}=target;
 for(const c of [under,over]){c.width=Math.round(width*ratio);c.height=Math.round(height*ratio);}
 const u=under.getContext('2d'),o=over.getContext('2d');
 if(!u||!o)return target;
 for(const ctx of [u,o]){ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);}
 const project=(p:V3)=>projectPoint(p,camera,width,height);
 const shadow=ring.map(([x,z])=>project([x+.4,-.69,z+.35]));
 u.save();u.filter='blur(16px)';u.fillStyle='rgba(26,48,28,.2)';path(u,shadow);u.fill();u.restore();
 const ordered=faces.map(face=>({face,layer:face.layer??1,points:face.points.map(project)})).sort((a,b)=>a.layer-b.layer||a.points.reduce((s,p)=>s+p[2],0)/a.points.length-b.points.reduce((s,p)=>s+p[2],0)/b.points.length);
 const water:[number,number][][]=[];
 for(const item of ordered){
  const ctx=item.layer<1?u:o;
  if(item.face.tag==='water'){ctx.save();ctx.globalAlpha=item.face.alpha??WATER_ALPHA.sheet;ctx.fillStyle=item.face.color;path(ctx,item.points);ctx.fill();ctx.globalAlpha=.35;ctx.strokeStyle='#d9ecf7';ctx.lineWidth=1;ctx.stroke();ctx.restore();water.push(item.points.map(p=>[p[0],p[1]]));continue;}
  ctx.fillStyle=item.face.color;path(ctx,item.points);ctx.fill();
 }
 const outline=ring.map(([x,z])=>project([x,.045,z]));o.strokeStyle='#d8edb1';o.lineWidth=1.7;path(o,outline);o.stroke();
 return {under,over,water};
}
function path(ctx:CanvasRenderingContext2D,points:readonly (readonly number[])[]){ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p[0]!,p[1]!):ctx.moveTo(p[0]!,p[1]!));ctx.closePath();}
/**
 * One frame: the static layers, a soft shimmer clipped to the water (only when `motion`), then rain. `t` is seconds
 * since the loop started; with `motion` false the rain is drawn at t = 0 (static) and nothing shimmers.
 */
export function paintFrame(ctx:CanvasRenderingContext2D,layers:PaintedLayers,conditions:ConditionLayers,width:number,height:number,ratio:number,t:number,motion:boolean,dark:boolean){
 ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
 ctx.drawImage(layers.under,0,0);
 ctx.setTransform(ratio,0,0,ratio,0,0);
 if(motion&&conditions.water.shimmer&&layers.water.length){
  ctx.save();ctx.beginPath();
  for(const poly of layers.water){poly.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();}
  ctx.clip();ctx.lineCap='round';
  for(let i=0;i<22;i++){
   const h=Math.sin(i*91.7)*1e4,fx=h-Math.floor(h),fy=(i*.618)%1,phase=t*1.3+i*.9;
   ctx.globalAlpha=.12+.14*(.5+.5*Math.sin(phase));ctx.strokeStyle='#eef7fc';ctx.lineWidth=1.4;
   const x=fx*width+Math.sin(phase*.6)*6,y=height*.25+fy*height*.6;
   ctx.beginPath();ctx.moveTo(x-9,y);ctx.lineTo(x+9,y);ctx.stroke();
  }
  ctx.restore();
 }
 ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(layers.over,0,0);ctx.setTransform(ratio,0,0,ratio,0,0);
 const rain=conditions.rain;
 if(rain.count>0){
  const n=scaledRainCount(rain.count,width,height),streaks=rainStreaks(n);
  ctx.save();ctx.lineCap='round';ctx.lineWidth=rain.width;
  ctx.strokeStyle=dark?'rgba(214,230,246,.62)':'rgba(46,82,120,.5)';
  if(rain.dashed)ctx.setLineDash([3,4]);
  for(const s of streaks){
   const len=rain.length*s.len,travel=(s.y+t*rain.speed)%1,y=travel*(height+len)-len,x=s.x*width;
   ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-len*.22,y+len);ctx.stroke();
  }
  ctx.restore();
 }
}
