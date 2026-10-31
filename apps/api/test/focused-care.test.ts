import {beforeAll,describe,expect,it} from 'vitest';
import {focusedResearch,establishmentAnchor,type FocusedResearch} from '../src/services/focused-crops';
import {careSchedule,measuredSoilFit} from '../src/services/command-center';
import {planningMeasuredPh} from '../src/services/planning-review';
import type {FarmSoilMarkers,SoilMarkerDraft} from '@harvest/contracts';
const localCareSchedule=(cycle:Parameters<typeof careSchedule>[0],crop:Parameters<typeof careSchedule>[1],asOf:string)=>careSchedule(cycle,crop,asOf,[],{stateId:'IN-TN',districtId:'IN-TN-coimbatore'});
let research:FocusedResearch;
beforeAll(async()=>{research=await focusedResearch()});
const cycle=(cropId:string,method:string,productId:string)=>({id:'source-test-cycle',cropId,sowingDate:'2026-10-31',establishmentDate:'2026-10-31',establishmentMethod:method,productId,stage:'sowed' as const});
describe('focused primary-source care applicability',()=>{
 it('preserves fourteen distinct identities and resolves every care source and establishment method',()=>{
  expect(new Set(research.crops.map(c=>c.cropId)).size).toBe(14);expect(research.crops.find(c=>c.cropId==='lemon')?.botanicalName).toContain('limon');
  const sourceIds=new Set(research.sources.map(s=>s.id));for(const crop of research.crops){for(const method of crop.establishmentMethods)expect(establishmentAnchor(method),`${crop.cropId}/${method}`).not.toBeNull();for(const item of crop.care){expect(item.startDay).toBeLessThanOrEqual(item.endDay);for(const ref of item.sourceRefs)expect(sourceIds.has(ref.sourceId)).toBe(true)}}
 });
 it('gives direct-sown versus transplanted paddy distinct automatically dated sourced actions',()=>{
  const crop=research.crops.find(c=>c.cropId==='paddy')!;
  const direct=localCareSchedule(cycle('paddy','direct_sowing','paddy-grain'),crop,'2026-10-31').careTasks;
  const transplanted=localCareSchedule(cycle('paddy','transplanting','paddy-grain'),crop,'2026-10-31').careTasks;
  expect(direct.length).toBeGreaterThan(0);expect(transplanted.length).toBeGreaterThan(0);expect(direct.map(t=>t.actionId)).not.toEqual(transplanted.map(t=>t.actionId));
  expect(transplanted.some(t=>t.dueFrom==='2026-11-15')).toBe(true);expect(transplanted.every(t=>t.completedOn===null&&t.evidenceState==='source_schedule')).toBe(true);
 });
 it('supports explicit tuber, bulb and SRI methods rather than silently dropping their care',()=>{
  for(const [cropId,method,product]of [['potato','tuber_planting','potato-fresh'],['shallot','bulb_planting','shallot-bulb'],['paddy','sri_transplanting','paddy-grain']])expect(localCareSchedule(cycle(cropId!,method!,product!),research.crops.find(c=>c.cropId===cropId),'2026-10-31').careTasks.length,cropId).toBeGreaterThan(0);
 });
 it('never schedules leaf-harvest guidance for coriander seed or dates an observed-stage action',()=>{
  const crop=research.crops.find(c=>c.cropId==='coriander')!;
  const seed=localCareSchedule(cycle('coriander','direct_sowing','coriander-seed'),crop,'2026-10-31'),leaf=localCareSchedule(cycle('coriander','direct_sowing','coriander-leaf'),crop,'2026-10-31');
  expect(seed.careTasks.some(t=>t.actionId==='coriander-leaf-harvest')).toBe(false);expect(leaf.careTasks.some(t=>t.actionId==='coriander-leaf-harvest')).toBe(true);
  expect(seed.careTasks.some(t=>t.anchor==='observed_stage')).toBe(false);
 });
 it('keeps salt-extract pH incompatible with an unspecified-method source range',()=>{
  const marker:SoilMarkerDraft={id:'m',parameter:'ph',rawLabel:'pH in KCl',rawValue:'6.2',rawUnit:'pH',numericValue:6.2,qualifier:'exact',range:null,analyteForm:null,method:'KCl extract',extractant:'KCl',soilWaterRatio:'1:2.5',temperatureC:null,matrix:'soil',massBasis:null,reportedRating:null,evidence:{page:1,quote:'pH in KCl 6.2',nativeTextCheck:'matched'},extractionConfidence:'high',warnings:[]};
  const markers:FarmSoilMarkers={farmId:'00000000-0000-4000-8000-000000000111',samples:[{id:'00000000-0000-4000-8000-000000000112',reportId:'00000000-0000-4000-8000-000000000113',sourceSampleId:'s',sampleLabel:null,laboratory:null,collectionDate:null,reportDate:null,depth:null,confirmedAt:'2026-10-31T00:00:00Z',markers:[{...marker,reviewStatus:'confirmed',confirmedAt:'2026-10-31T00:00:00Z',canonical:{value:6.2,unit:'pH',conversion:null,missingReason:null}}]}],limitations:[]};
  expect(measuredSoilFit(markers,research.crops.find(c=>c.cropId==='ginger')!).status).toBe('insufficient_compatible_measurements');
  expect(planningMeasuredPh(markers)).toBeUndefined();
  const compatible=structuredClone(markers);compatible.samples[0]!.markers[0]!.method='Water suspension';compatible.samples[0]!.markers[0]!.extractant='Water';
  expect(measuredSoilFit(compatible,research.crops.find(c=>c.cropId==='ginger')!).status).toBe('within_published_ph_range');
  expect(planningMeasuredPh(compatible)).toBe(6.2);
  compatible.samples[0]!.markers[0]!.warnings=['Verify this result and sample assignment against the original page before confirming.'];
  expect(planningMeasuredPh(compatible)).toBe(6.2);expect(measuredSoilFit(compatible,research.crops.find(c=>c.cropId==='ginger')!).status).toBe('within_published_ph_range');
  compatible.samples[0]!.markers[0]!.warnings.push('Repeated extraction disagrees: verify the original.');expect(planningMeasuredPh(compatible)).toBeUndefined();
  compatible.samples[0]!.markers[0]!.warnings=[];
  const other=structuredClone(compatible.samples[0]!);other.id='00000000-0000-4000-8000-000000000114';other.markers[0]!.canonical.value=7.9;
  expect(planningMeasuredPh({...compatible,samples:[...compatible.samples,other]})).toBeUndefined();
 });
});
