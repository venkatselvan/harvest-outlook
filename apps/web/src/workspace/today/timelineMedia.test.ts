import {describe,expect,it} from 'vitest';
import {FieldPhotoGallery} from '@harvest/contracts';
import {todayPredictedFixture,PREDICTED_DATES} from './fixtures';
import {sliderModel,type SceneMark} from './model';
import {timelineMediaMarks,mediaClusters} from './timelineMedia';
const photoId='44444444-4444-4444-8444-444444444444';
const photo={id:photoId,mediaId:photoId,capturedOn:'2026-10-27',createdAt:'2026-11-04T10:00:00Z',imagePath:'/api/v1/media/photo/content'};
const prediction={id:photoId,photoId,sourceDate:'2026-10-27',targetDate:'2026-11-05',status:'ready',imagePath:'/api/v1/media/prediction/content',failureReason:null};
describe('timeline media',()=>{
 it('keeps camera capture dates, generated target dates, and old AI evidence alongside satellite images',()=>{
  const view=todayPredictedFixture(),model=sliderModel(view)!;
  const gallery=FieldPhotoGallery.parse({photos:[photo],observations:[photo],predictions:[prediction,{...prediction,targetDate:'2026-11-06',status:'queued',imagePath:null}]});
  const marks=timelineMediaMarks(view.scenes,model,view.ndvi,gallery);
  expect(marks.filter(m=>m.kind==='photo').map(m=>m.date)).toEqual(['2026-10-27']);
  expect(marks.filter(m=>m.date==='2026-10-27').map(m=>m.kind)).toContain('observed');
  expect(marks.some(m=>m.kind==='predicted' && m.date===PREDICTED_DATES.superseded)).toBe(true);
  expect(marks.some(m=>m.kind==='predicted' && m.date==='2026-11-05')).toBe(true);
  expect(marks.some(m=>m.kind==='predicted' && m.date==='2026-11-06')).toBe(false);
 });
 it('marks a fetched but rejected satellite pass and ignores photos outside the season',()=>{
  const view=todayPredictedFixture(),model=sliderModel(view)!;
  const last=view.ndvi!.latestUsable!;
  view.ndvi!.readings.push({...last,date:'2026-10-29',usable:false,field:{...last.field,usable:false,rejection:'implausible_band_values'}});
  const marks=timelineMediaMarks(view.scenes,model,view.ndvi,FieldPhotoGallery.parse({photos:[{...photo,capturedOn:'2025-01-01'}],predictions:[]}));
  expect(marks.find(m=>m.kind==='observed' && m.date==='2026-10-29')?.note).toContain('quality checks');
  expect(marks.some(m=>m.kind==='photo')).toBe(false);
 });
 it('groups nearby dates in one row while retaining all media types',()=>{
  const marks:SceneMark[]=[{kind:'photo',date:'2026-11-01',fraction:0.1},{kind:'photo',date:'2026-11-02',fraction:0.14},{kind:'observed',date:'2026-11-01',fraction:0.1},{kind:'predicted',date:'2026-11-02',fraction:0.14}];
  const narrow=mediaClusters(marks,300);
  expect(narrow).toHaveLength(1);
  expect(narrow[0]!.kinds).toEqual(['observed','predicted','photo']);
  expect(narrow[0]!.marks).toHaveLength(4);
  expect(narrow[0]!.dates).toBe(2);
  expect(mediaClusters(marks,2000)).toHaveLength(2);
 });
 it('keeps groups within both edges without overlap at phone and desktop widths',()=>{
  const marks:SceneMark[]=Array.from({length:40},(_,i)=>({date:`2026-11-${i+1}`,kind:(['observed','predicted','photo'] as const)[i%3]!,fraction:i/39}));
  for(const width of [240,390,1440]) {
   const groups=mediaClusters(marks,width);
   expect(groups.flatMap(group=>group.marks)).toHaveLength(marks.length);
   for(const [i,group] of groups.entries()) {
    expect(group.left).toBeGreaterThanOrEqual(0);
    expect(group.left+group.width).toBeLessThanOrEqual(width);
    if(i) expect(group.left).toBeGreaterThanOrEqual(groups[i-1]!.left+groups[i-1]!.width+6);
   }
  }
 });
});
