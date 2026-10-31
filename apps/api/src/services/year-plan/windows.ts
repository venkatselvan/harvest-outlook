import type { ScopedWindow } from './data';
import { monthDayIn, yearOf } from './dates';
import { ASSUMPTIONS } from './scoring';
import type { DateRange, IrrigationClass, PlacedWindow } from './types';

/** Usable scoped windows placed on the calendar for every year that touches `range` (windows may wrap the year end). */
export function placeWindows(scoped: readonly ScopedWindow[], range: DateRange): PlacedWindow[] {
  const out: PlacedWindow[] = [];
  for (const w of scoped) {
    if (!w.usable || !w.season || w.scope === 'region') continue;
    for (let year = yearOf(range.from) - 1; year <= yearOf(range.to); year++) {
      const from = monthDayIn(year, w.row.from);
      const to = monthDayIn(w.row.to < w.row.from ? year + 1 : year, w.row.to);
      if (to < range.from || from >= range.to) continue;
      out.push({ from, to, season: w.season, scope: w.scope, provisional: w.provisional, condition: w.row.condition, source: w.row.source ?? null, sourceDistrict: w.neighbour ?? w.row.sourceDistrict ?? null, note: w.row.note ?? null });
    }
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || windowFitOf(b) - windowFitOf(a) || (a.source ?? '').localeCompare(b.source ?? ''));
}

/** Spec 5.1 window fit: district 1, state only 0.8, provisional 0.5, outside 0. */
export function windowFitOf(w: PlacedWindow | null): number {
  const f = ASSUMPTIONS.windowFit.value;
  if (!w) return f.outside;
  if (w.provisional) return f.provisional;
  return w.scope === 'district' ? f.district : f.state;
}

/**
 * Whether a window's water condition fits the field. Rainfed fields cannot use irrigated windows; supplemental or
 * unrecorded irrigation makes irrigated windows conditional. Rice-fallow relay windows are not modelled.
 */
export function irrigationCompat(condition: string, irrigation: IrrigationClass | null): { ok: boolean; conditional: boolean; note: string | null } {
  const c = condition.toLowerCase();
  if (c.includes('rice_fallow')) return { ok: false, conditional: false, note: 'Rice-fallow relay sowing is not modelled.' };
  if (c !== 'irrigated') return { ok: true, conditional: false, note: null };
  if (irrigation === 'none') return { ok: false, conditional: false, note: 'Irrigated window on a rainfed field.' };
  if (irrigation === 'assured') return { ok: true, conditional: false, note: null };
  return { ok: true, conditional: true, note: irrigation === 'protective' ? 'The window assumes full irrigation; the field has supplemental irrigation only.' : 'The window assumes irrigation; the field irrigation is not recorded.' };
}

/** Best compatible window containing `date` (highest fit, unconditional first), or null. */
export function windowForDate(date: string, placed: readonly PlacedWindow[], irrigation: IrrigationClass | null): { window: PlacedWindow; conditional: boolean; note: string | null } | null {
  const hits = placed.filter((w) => w.from <= date && date <= w.to).map((w) => ({ window: w, compat: irrigationCompat(w.condition, irrigation) })).filter((h) => h.compat.ok);
  hits.sort((a, b) => windowFitOf(b.window) - windowFitOf(a.window) || Number(a.compat.conditional) - Number(b.compat.conditional));
  const best = hits[0];
  return best ? { window: best.window, conditional: best.compat.conditional, note: best.compat.note } : null;
}
