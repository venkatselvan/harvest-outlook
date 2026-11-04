import type { Cycle } from '../state';

export function recordedForField(cycles: readonly Cycle[], fieldId?: string | null): Cycle[] {
  return cycles.filter(c => !fieldId || !c.fieldId || c.fieldId === fieldId);
}
export function cycleInYear(c: Cycle, year: number): boolean {
  const start = c.establishmentDate ?? c.sowingDate;
  const end = c.harvestDate ?? (c.stage === 'harvested' ? start : `${year}-12-31`);
  return start <= `${year}-12-31` && end >= `${year}-01-01`;
}
/** Clip recorded dates to the displayed calendar year; unknown harvest stays visibly open-ended. */
export function recordedBar(c: Cycle, year: number): {left: number; width: number} {
  const begin = Date.parse(`${year}-01-01T00:00:00Z`), end = Date.parse(`${year + 1}-01-01T00:00:00Z`);
  const pct = (date: string) => Math.max(0, Math.min(100, (Date.parse(`${date}T00:00:00Z`) - begin) / (end - begin) * 100));
  const left = pct(c.establishmentDate ?? c.sowingDate);
  const right = c.harvestDate ? pct(c.harvestDate) : 100;
  return {left, width: Math.max(0.5, right - left)};
}
export const recordedStage = (c: Cycle) => ({sowed: 'Sown', growing: 'Growing', flowering: 'Flowering', harvested: 'Harvested'})[c.stage];
