import type { FieldPhotoGallery, NdviSeries, SceneRef } from '@harvest/contracts';
import { dayNumber, fractionOf, sceneMarks, type SceneMark, type SliderModel } from './model';

/** Keep actual acquisition/capture dates and generated target dates, including historical AI evidence. */
export function timelineMediaMarks(scenes: readonly SceneRef[], model: SliderModel, ndvi?: NdviSeries | null, gallery?: FieldPhotoGallery | null): SceneMark[] {
  const marks = new Map(sceneMarks(scenes, model).map(mark => [`${mark.kind}|${mark.date}`, mark]));
  const add = (date: string, kind: SceneMark['kind'], note?: string) => {
    if (!Number.isFinite(dayNumber(date)) || date < model.from || date > model.to) return;
    const key = `${kind}|${date}`;
    if (!marks.has(key)) marks.set(key, {date,kind,fraction:fractionOf(model,date),...(note ? {note} : {})});
  };
  for (const reading of ndvi?.readings ?? []) add(reading.date,'observed',reading.usable ? undefined : 'Fetched; failed clear-pixel or image-quality checks');
  for (const photo of [...(gallery?.photos ?? []),...(gallery?.observations ?? [])]) add(photo.capturedOn,'photo');
  for (const prediction of gallery?.predictions ?? []) if (prediction.status === 'ready' && prediction.imagePath) add(prediction.targetDate,'predicted');
  return [...marks.values()].sort((a,b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}
export type MediaKind = 'observed' | 'predicted' | 'photo';
export const mediaKind = (mark: SceneMark): MediaKind => mark.kind === 'illustration' ? 'predicted' : mark.kind;
export interface MediaCluster { marks: SceneMark[]; kinds: MediaKind[]; left: number; width: number; dates: number }
/** One compact row. Merge overlapping groups, retaining every type and selectable date. */
export function mediaClusters(marks: readonly SceneMark[], trackWidth: number): MediaCluster[] {
  const unique = new Map(marks.map(mark => [`${mediaKind(mark)}|${mark.date}`, mark]));
  const layout = (items: SceneMark[]): MediaCluster => {
    const kinds = (['observed','predicted','photo'] as const).filter(kind => items.some(mark => mediaKind(mark) === kind));
    const dates = new Set(items.map(mark => mark.date)).size;
    const width = kinds.length * 20 + 8 + (dates > 1 ? 12 : 0);
    const center = (items[0]!.fraction + items.at(-1)!.fraction) / 2 * trackWidth;
    return {marks:items,kinds,dates,width,left:Math.max(0,Math.min(trackWidth-width,center-width/2))};
  };
  const groups: MediaCluster[] = [];
  for (const mark of [...unique.values()].sort((a,b) => a.fraction-b.fraction)) {
    let next = layout([mark]);
    // A merge can widen the pill towards the previous group, so check again.
    while (groups.length && groups.at(-1)!.left + groups.at(-1)!.width + 6 > next.left) {
      next = layout([...groups.pop()!.marks,...next.marks]);
    }
    groups.push(next);
  }
  return groups;
}
