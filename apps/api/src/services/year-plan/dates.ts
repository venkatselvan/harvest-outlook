/**
 * Calendar arithmetic for the year-plan engine. UTC calendar dates (YYYY-MM-DD) only; no time zones, no clocks.
 * Intervals in the engine are half-open [from, to): `to` is the first day the field is free again.
 */
const DAY = 86_400_000;

export const utcMs = (d: string): number => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
export const toIso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number): string => toIso(utcMs(d) + n * DAY);
/** Whole days from `a` to `b` (positive when b is later). */
export const daysBetween = (a: string, b: string): number => Math.round((utcMs(b) - utcMs(a)) / DAY);
export const monthOf = (d: string): number => Number(d.slice(5, 7));
export const yearOf = (d: string): number => Number(d.slice(0, 4));

export function isCalendarDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(utcMs(s)) && toIso(utcMs(s)) === s;
}

export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Same month and day `n` years later; 29 February becomes 28 February in a non-leap year. */
export function addYears(d: string, n: number): string {
  const y = yearOf(d) + n;
  const m = monthOf(d);
  const day = Math.min(Number(d.slice(8, 10)), daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 'MM-DD' placed in `year`; a day past the month end (02-29 in a common year) is clamped to the month end. */
export function monthDayIn(year: number, md: string): string {
  const m = Number(md.slice(0, 2));
  const day = Math.min(Number(md.slice(3, 5)), daysInMonth(year, m));
  return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ISO 8601 week (same algorithm as plans/adapters/market-outlook.ts isoWeek). */
export function isoWeek(date: string): { year: number; week: number } {
  const t = new Date(utcMs(date));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return { year, week };
}
/** ISO week 53 is pooled with 52, as in services/price-series.ts. */
export const weekBucket = (w: number): number => (w === 53 ? 52 : w);

/** Half-open interval overlap: [aFrom, aTo) and [bFrom, bTo). */
export const overlaps = (aFrom: string, aTo: string, bFrom: string, bTo: string): boolean => aFrom < bTo && bFrom < aTo;

/** Days of [from, to) that fall inside [clipFrom, clipTo). */
export function clippedDays(from: string, to: string, clipFrom: string, clipTo: string): number {
  const a = from > clipFrom ? from : clipFrom;
  const b = to < clipTo ? to : clipTo;
  return a < b ? daysBetween(a, b) : 0;
}

/** Days of [from, to) per calendar month, as [{year, month, days}] in date order. */
export function daysPerMonth(from: string, to: string): { year: number; month: number; days: number }[] {
  const out: { year: number; month: number; days: number }[] = [];
  let cur = from;
  while (cur < to) {
    const y = yearOf(cur);
    const m = monthOf(cur);
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const end = nextMonth < to ? nextMonth : to;
    out.push({ year: y, month: m, days: daysBetween(cur, end) });
    cur = end;
  }
  return out;
}

/** Midpoint date of [a, b] (rounded down). */
export const midpoint = (a: string, b: string): string => addDays(a, Math.floor(daysBetween(a, b) / 2));
