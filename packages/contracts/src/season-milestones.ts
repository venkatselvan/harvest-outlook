import type { StageTimeline } from './year-plan';
export interface SeasonMilestone { id: string; name: string; date: string }
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/** Approximate calendar milestones, shared by the timeline and automatic image requests. */
export function seasonMilestones(timeline: StageTimeline | null | undefined, harvestDate?: string | null): SeasonMilestone[] {
  if (!timeline) return [];
  const harvest = harvestDate ?? (timeline.harvest ? shift(timeline.harvest.earliest, Math.round((Date.parse(timeline.harvest.latest) - Date.parse(timeline.harvest.earliest)) / 172800000)) : null);
  const points: SeasonMilestone[] = [
    {id: 'after-sowing', name: /transplant/.test(timeline.establishmentMethod ?? '') ? 'Day after transplanting' : 'Day after sowing', date: shift(timeline.anchorDate, 1)},
    ...timeline.stages.slice(1).filter(s => !harvest || s.from < harvest).map(s => ({id: s.id, name: s.name, date: s.from})),
    ...(harvest ? [{id: 'before-harvest', name: harvestDate ? 'Day before recorded harvest' : 'Day before estimated harvest', date: shift(harvest, -1)}, {id: 'harvest', name: harvestDate ? 'Recorded harvest' : 'Estimated harvest', date: harvest}] : []),
  ];
  // Merge coincident milestones so a date is rendered/generated once, retaining both labels.
  const byDate = new Map<string, SeasonMilestone>();
  for (const p of points.filter(p => p.date > timeline.anchorDate).sort((a,b) => a.date.localeCompare(b.date))) {
    const prior = byDate.get(p.date);
    byDate.set(p.date, prior ? {...prior, name: `${prior.name} · ${p.name}`} : p);
  }
  return [...byDate.values()];
}
