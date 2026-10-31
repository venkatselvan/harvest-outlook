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
