import {createEffect,createMemo,createSignal,onCleanup,onMount,Show} from 'solid-js';
import {createFieldScene,normalizedField,projectPoint,type Camera,type FieldBoundary} from './fieldGeometry';
import './field-growth.css';
export interface FieldGrowthSceneProps {
 cropId?:string|null;cropName?:string|null;stage?:string|null;boundary?:FieldBoundary|null;
 /** Controlled mode: when a parent passes progress (0..1) the internal growth slider is removed and the parent's slider drives the scene. */
 progress?:number|null;
 /** Calendar date (YYYY-MM-DD) the parent's slider points at; named in the canvas label in controlled mode. */
 date?:string|null;
 /** Hide the heading and use small orbit controls, for a parent that draws its own overlays (the Today hero). */
 compact?:boolean;
 plantingDate?:string|null;harvestDate?:string|null;onPlant?:()=>void;
}
const dayValue=(date:string|null|undefined)=>date&&/^\d{4}-\d{2}-\d{2}$/.test(date)?Date.parse(date+'T00:00:00Z'):NaN;
export function FieldGrowthScene(props:FieldGrowthSceneProps){
 let canvas!:HTMLCanvasElement,frame=0,observer:ResizeObserver|undefined,disposed=false;
 const [ready,setReady]=createSignal(false),[camera,setCamera]=createSignal<Camera>({yaw:-.55,elevation:.7,zoom:1});
 const [preview,setPreview]=createSignal<number|null>(null),[size,setSize]=createSignal({width:800,height:540});
 const controlled=()=>props.progress!=null&&Number.isFinite(props.progress);
 const recordedProgress=()=>controlled()?Math.max(0,Math.min(1,props.progress!)):props.stage==='harvested'?1:props.stage==='flowering'?.7:props.stage==='growing'?.4:0;
 const progress=()=>controlled()?recordedProgress():preview()??recordedProgress();
 const controlledDate=()=>{const day=dayValue(props.date);return Number.isFinite(day)?new Date(day).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):null;};
 const canvasLabel=()=>controlled()?`Illustration of ${props.cropName??'the crop'} on your field${controlledDate()?` on ${controlledDate()}`:''}. Schematic, not a field observation. Drag to orbit. Arrow keys rotate, plus and minus zoom, Home resets.`:'3D field model. Drag to orbit. Arrow keys rotate, plus and minus zoom, Home resets.';
 const ring=createMemo(()=>normalizedField(props.boundary));
 const faces=createMemo(()=>createFieldScene(ring(),props.cropId??null,progress()));
 const dateLabel=()=>{const from=dayValue(props.plantingDate),to=dayValue(props.harvestDate);if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)return null;return new Date(from+(to-from)*progress()).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});};
 const growthLabel=()=>progress()<.15?'Establishment':progress()<.6?'Vegetative growth':progress()<.85?'Maturing':'Harvest window';
 function render(){
  frame=0;if(disposed||!canvas)return;const ctx=canvas.getContext('2d');if(!ctx)return;
  const {width,height}=size(),ratio=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
  const view=camera(),project=(p:Parameters<typeof projectPoint>[0])=>projectPoint(p,view,width,height);
  const shadow=ring().map(([x,z])=>project([x+.4,-.69,z+.35]));
  ctx.save();ctx.filter='blur(16px)';ctx.fillStyle='rgba(26,48,28,.2)';ctx.beginPath();shadow.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fill();ctx.restore();
  const ordered=faces().map(face=>({color:face.color,layer:face.layer??1,points:face.points.map(project)})).sort((a,b)=>a.layer-b.layer||a.points.reduce((s,p)=>s+p[2],0)/a.points.length-b.points.reduce((s,p)=>s+p[2],0)/b.points.length);
  for(const face of ordered){ctx.fillStyle=face.color;ctx.beginPath();face.points.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fill();}
  const outline=ring().map(([x,z])=>project([x,.045,z]));ctx.strokeStyle='#d8edb1';ctx.lineWidth=1.7;ctx.beginPath();outline.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.stroke();
 }
 const queue=()=>{if(ready()&&!frame)frame=requestAnimationFrame(render);};
 createEffect(()=>{faces();camera();size();ready();queue();});
 createEffect(()=>{props.cropId;props.plantingDate;props.boundary;setPreview(null);});
 onMount(()=>{setReady(true);observer=new ResizeObserver(entries=>{const r=entries[0]?.contentRect;if(r)setSize({width:Math.max(1,r.width),height:Math.max(1,r.height)});});observer.observe(canvas);queue();});
 onCleanup(()=>{disposed=true;observer?.disconnect();cancelAnimationFrame(frame);});
 let drag:{id:number;x:number;y:number;yaw:number;elevation:number}|null=null;
 const reset=()=>setCamera({yaw:-.55,elevation:.7,zoom:1});
 const key=(e:KeyboardEvent)=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','Home'].includes(e.key))return;e.preventDefault();if(e.key==='Home')reset();else setCamera(c=>({...c,yaw:c.yaw+(e.key==='ArrowLeft'?-.15:e.key==='ArrowRight'?.15:0),elevation:Math.max(.25,Math.min(1.35,c.elevation+(e.key==='ArrowUp'?.08:e.key==='ArrowDown'?-.08:0))),zoom:Math.max(.65,Math.min(1.5,c.zoom+(e.key==='+'?.1:e.key==='-'?-.1:0)))}));};
 return <section class="field-growth" classList={{'is-compact':!!props.compact,'is-controlled':controlled()}} aria-label="Interactive crop growth model">
  <Show when={!props.compact}><div class="field-growth-heading"><span class="field-growth-kicker">FIELD STUDIO</span><strong>{props.cropName??'Your field, in perspective'}</strong><span>{props.cropId?'Growth model':props.boundary?'Mapped boundary':'Field model · boundary needed'}</span></div></Show>
  <canvas ref={canvas} class="field-growth-canvas" tabIndex={0} aria-label={canvasLabel()} onKeyDown={key}
   onPointerDown={e=>{if(e.button!==0)return;canvas.setPointerCapture(e.pointerId);drag={id:e.pointerId,x:e.clientX,y:e.clientY,yaw:camera().yaw,elevation:camera().elevation};}}
   onPointerMove={e=>{if(drag?.id===e.pointerId)setCamera(c=>({...c,yaw:drag!.yaw+(e.clientX-drag!.x)*.008,elevation:Math.max(.25,Math.min(1.35,drag!.elevation+(e.clientY-drag!.y)*.006))}));}}
   onPointerUp={()=>{drag=null;}} onPointerCancel={()=>{drag=null;}} onLostPointerCapture={()=>{drag=null;}}>
   A model of the selected field boundary. Crop geometry is a schematic representation of growth, not a field observation.
  </canvas>
  <div class="field-growth-orbit" role="group" aria-label="Field view controls"><button type="button" aria-label="Rotate field left" onClick={()=>setCamera(c=>({...c,yaw:c.yaw-.3}))}>↶</button><button type="button" aria-label="Rotate field right" onClick={()=>setCamera(c=>({...c,yaw:c.yaw+.3}))}>↷</button><button type="button" aria-label="Zoom field out" onClick={()=>setCamera(c=>({...c,zoom:Math.max(.65,c.zoom-.1)}))}>−</button><button type="button" aria-label="Zoom field in" onClick={()=>setCamera(c=>({...c,zoom:Math.min(1.5,c.zoom+.1)}))}>+</button><button type="button" aria-label="Reset field view" onClick={reset}>Reset</button></div>
  <Show when={props.cropId||controlled()} fallback={<div class="field-growth-empty"><strong>A new season starts here.</strong><span>Record what you planted to build its care calendar.</span><Show when={props.onPlant}><button type="button" onClick={()=>props.onPlant?.()}>＋ Plant a crop</button></Show></div>}>
   <Show when={!controlled()}><div class="field-growth-timeline"><div><span>{preview()===null?'Recorded season':'Growth preview'}</span><strong>{dateLabel()??(preview()===null?props.stage?.replace(/_/g,' ')??'Establishment':growthLabel())}</strong><Show when={preview()!==null}><button type="button" onClick={()=>setPreview(null)}>Back to today</button></Show></div><label for="field-growth-time">Explore growth</label><input id="field-growth-time" type="range" min="0" max="100" step="1" value={Math.round(progress()*100)} aria-valuetext={dateLabel()??growthLabel()} onInput={e=>setPreview(Number(e.currentTarget.value)/100)}/><div class="field-growth-ends"><span>Establishment</span><span>Growth</span><span>Harvest</span></div></div></Show>
  </Show>
  <p class="field-growth-footnote">{props.compact?'Schematic plants and soil, not field measurements':`Drag to orbit · Schematic plants and soil, not field measurements${props.boundary?' · Your saved boundary':''}`}</p>
 </section>;
}
