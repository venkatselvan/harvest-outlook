/** Small deterministic 3D scene, rendered locally. Geometry conveys crop form, not sensed health. */
export type V3 = [number, number, number];
export type Face = { points: V3[]; color: string; layer?: number };
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
function tint(hex:string,factor:number):string {
  const parts=hex.replace('#','').match(/.{2}/g)!.map(n=>Math.max(0,Math.min(255,Math.round(parseInt(n,16)*factor))));
  return `rgb(${parts.join(',')})`;
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
export function createFieldScene(ring:[number,number][],cropId:string|null,progress:number):Face[] {
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
