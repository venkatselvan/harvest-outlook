import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import sharp from 'sharp';
import {seasonMilestones, type StageTimeline} from '@harvest/contracts';
import {setupHarness,login,farmBody,upload,testConfig,type Harness,type Client} from './helpers';
import {queueSeasonPredictions,seasonEvidence,linkJournalPhotos} from '../src/services/today/season-predictions';
import {photoGallery,requestPhotoPrediction,saveFieldPhotos} from '../src/services/today/field-photos';
import {createSeasonPredictionsHandler} from '../src/worker/handlers/season-predictions';
import {Budget} from '../src/services/budget';
let h:Harness,owner:Client;
beforeAll(async()=>{h=await setupHarness();owner=await login(h.app);});
afterAll(async()=>h?.close());
const live=testConfig({RUNTIME_MODE:'live',MODEL_API_KEY:'test-only-no-provider-call'});
const deps=()=>({pool:h.pool,config:live});
async function setup(multiple=false){
 const farmId=(await owner.call('POST','/api/v1/farms',{payload:farmBody()})).json().data.id;
 const cycles=[{id:'rice',cropId:'paddy',sowingDate:'2026-10-01',stage:'growing'},...(multiple?[{id:'maize',cropId:'maize',sowingDate:'2026-10-01',stage:'growing'}]:[])];
 expect((await owner.call('PUT',`/api/v1/farms/${farmId}/workspace`,{payload:{expectedVersion:0,boundary:null,previousHarvest:{status:'unknown'},cycles,rotationPlans:[]}})).statusCode).toBe(200);
 const ownerId=(await h.pool.query('SELECT owner_id FROM farms WHERE id=$1',[farmId])).rows[0].owner_id;
 const bytes=await sharp({create:{width:80,height:60,channels:3,background:'#487142'}}).jpeg().toBuffer();
 const media=(await upload(owner,bytes,{farmId})).json().data;
 return {scope:{ownerId,farmId,cycleId:'rice'},media,bytes};
}
describe('season milestone refresh',()=>{
 it('marks day after sowing, all stage boundaries and the day before the harvest midpoint without duplicate dates',()=>{
  const timeline={anchorDate:'2026-10-01',stages:[{id:'initial',name:'Initial',from:'2026-10-01',to:'2026-10-10'},{id:'grow',name:'Growing',from:'2026-10-10',to:'2027-01-01'}],harvest:{earliest:'2027-01-01',latest:'2027-01-11'}} as StageTimeline;
  expect(seasonMilestones(timeline).map(p=>p.date)).toEqual(['2026-10-02','2026-10-10','2027-01-05','2027-01-06']);
  expect(seasonMilestones(timeline,'2027-01-03').at(-2)?.date).toBe('2027-01-02');
  expect(seasonMilestones({...timeline,harvest:{earliest:'2026-10-11',latest:'2026-10-11'}}).filter(p=>p.date==='2026-10-10')).toHaveLength(1);
 });
 it('deduplicates automatic work, never queues in synthetic mode, and schedules exact dates from earlier photos',async()=>{
  const {scope,media}=await setup();
  await saveFieldPhotos(h.pool,scope,{photos:[{mediaId:media.id,capturedOn:'2026-10-01'}]});
  expect(await queueSeasonPredictions({pool:h.pool,config:testConfig()},scope)).toBeNull();
  const id=await queueSeasonPredictions(deps(),scope);
  expect(await queueSeasonPredictions(deps(),scope)).toBe(id);
  const job=(await h.pool.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
  const handler=createSeasonPredictionsHandler({...deps(),storage:h.storage,budget:Budget.fromConfig(h.pool,live)});
  await handler(job,{heartbeat:async()=>{},isCancelled:async()=>false} as never);
  const first=await photoGallery(h.pool,scope);
  expect(first.predictions.some(p=>p.targetDate==='2026-10-02')).toBe(true);
  const ev=await seasonEvidence(h.pool,scope);
  expect(first.predictions.map(p=>p.targetDate)).toContain(ev.milestones.find(m=>m.id==='before-harvest')!.date);
  await handler(job,{heartbeat:async()=>{}} as never);
  expect((await photoGallery(h.pool,scope)).predictions).toHaveLength(first.predictions.length);
 });
 it('a scoped journal photo becomes actual evidence, keeps old expectations, and refreshes later targets from the new photo',async()=>{
  const {scope,media,bytes}=await setup(true);
  const original=await saveFieldPhotos(h.pool,scope,{photos:[{mediaId:media.id,capturedOn:'2026-10-01'}]});
  const firstRevision=(await seasonEvidence(h.pool,scope)).revision;
  const expected=await requestPhotoPrediction({...deps(),revision:firstRevision},scope,original.photos[0]!.id,'2026-11-01',null);
  const nextMedia=(await upload(owner,bytes,{farmId:scope.farmId})).json().data;
  const saved=await owner.call('POST','/api/v1/journal',{payload:{clientEntryId:'journal-update-123',farmId:scope.farmId,cycleId:'rice',observedOn:'2026-11-01',mediaIds:[nextMedia.id],activity:'observation',note:'Actual crop today'}});
  expect(saved.statusCode,saved.body).toBe(201);
  const entryId=saved.json().data.entry.id;
  await linkJournalPhotos(h.pool,scope.ownerId,entryId); // repeated sync is harmless
  const gallery=await photoGallery(h.pool,scope);
  expect(gallery.photos).toHaveLength(1);
  expect(gallery.observations).toHaveLength(1);
  expect(gallery.predictions.some(p=>p.id===expected.id)).toBe(true);
  const updated=await seasonEvidence(h.pool,scope);
  expect(updated.revision).not.toBe(firstRevision);
  expect(updated.photos[0]!.captured_on).toBe('2026-11-01');
  expect((await photoGallery(h.pool,{...scope,cycleId:'maize'})).observations).toHaveLength(0);
  const id=await queueSeasonPredictions(deps(),scope);
  const job=(await h.pool.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
  await createSeasonPredictionsHandler({...deps(),storage:h.storage,budget:Budget.fromConfig(h.pool,live)})(job,{heartbeat:async()=>{}} as never);
  expect((await photoGallery(h.pool,scope)).predictions.some(p=>p.sourceDate==='2026-11-01' && p.evidenceRevision===updated.revision)).toBe(true);
 });
 it('does not assign a farm-wide journal photo to an arbitrary crop',async()=>{
  const {scope,media}=await setup(true);
  const response=await owner.call('POST','/api/v1/journal',{payload:{clientEntryId:'journal-ambiguous-123',farmId:scope.farmId,observedOn:'2026-11-01',mediaIds:[media.id]}});
  expect(response.statusCode,response.body).toBe(201);
  expect((await photoGallery(h.pool,scope)).observations).toHaveLength(0);
  expect((await owner.call('POST','/api/v1/journal',{payload:{clientEntryId:'journal-foreign-123',farmId:scope.farmId,cycleId:'foreign',observedOn:'2026-11-01',mediaIds:[]}})).statusCode).toBe(404);
 });
});
