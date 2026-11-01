import type { SeasonPreview, StageTimeline } from "@harvest/contracts";

/** Pure helpers for the Planner board and the season preview sheet (ROUND3_SPEC.md sections 2 and 7). */
export interface SeasonLike {
  id: string;
  year: number;
  cropId: string;
  cropName?: string | undefined;
  plannedSowingDate?: string | undefined;
  plannedHarvestDate?: string | undefined;
  kind?: "crop" | "green_manure" | "intercrop" | undefined;
  companion?: { cropId: string; cropName?: string | undefined; rowRatio: string } | undefined;
}

const DAY = 86_400_000;
const parse = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
export const daysBetween = (a: string, b: string) => Math.round((parse(b) - parse(a)) / DAY);
export const addDays = (d: string, n: number) => new Date(parse(d) + n * DAY).toISOString().slice(0, 10);
export const shortDate = (d: string) =>
  new Date(parse(d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const dayMonth = (d: string) => new Date(parse(d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const bySowing = (a: SeasonLike, b: SeasonLike) => (a.plannedSowingDate ?? `${a.year}`).localeCompare(b.plannedSowingDate ?? `${b.year}`);

/** "Finger millet + pigeon pea (4:1)" for an intercrop season; the crop name otherwise. */
export function seasonTitle(p: SeasonLike, cropName: (id: string) => string): string {
  const main = p.cropName ?? cropName(p.cropId);
  if (p.kind === "intercrop" && p.companion) return `${main} + ${lowerFirst(p.companion.cropName ?? cropName(p.companion.cropId))}${ratioStated(p.companion.rowRatio) ? ` (${p.companion.rowRatio})` : ""}`;
  return main;
}
/** Short state label on rows and bars. */
export const kindLabel = (p: Pick<SeasonLike, "kind">) => (p.kind === "green_manure" ? "Green manure" : p.kind === "intercrop" ? "Intercrop" : "Planned");

/** The year of the earliest saved season sown on or after today, else the current year. */
export function defaultYear(plans: readonly SeasonLike[], today: string): number {
  const next = plans.filter((p) => p.plannedSowingDate && p.plannedSowingDate >= today).sort(bySowing)[0];
  return next ? next.year : Number(today.slice(0, 4));
}
/** Saved seasons grouped by year, soonest first. */
export function groupByYear<T extends SeasonLike>(plans: readonly T[]): { year: number; plans: T[] }[] {
  const years = [...new Set(plans.map((p) => p.year))].sort((a, b) => a - b);
  return years.map((year) => ({ year, plans: plans.filter((p) => p.year === year).sort(bySowing) }));
}
/** "2 more in 2027 ›" hints for the other years with saved seasons. */
export function yearHints(plans: readonly SeasonLike[], year: number): { year: number; count: number; later: boolean }[] {
  return groupByYear(plans).filter((g) => g.year !== year).map((g) => ({ year: g.year, count: g.plans.length, later: g.year > year }));
}
/** Seasons whose ids were not in the previous list, soonest first (after an apply). */
export function addedSeasons<T extends SeasonLike>(previousIds: ReadonlySet<string>, plans: readonly T[]): T[] {
  return plans.filter((p) => !previousIds.has(p.id)).sort(bySowing);
}

// ------------------------------------------------------------------ sheet

export interface StripSegment { id: string; name: string; leftPct: number; widthPct: number; basis: string }
/** Stage strip over [first stage start, latest harvest]; today's marker only when today falls inside. */
export function stageStrip(timeline: StageTimeline | null, harvest: SeasonPreview["harvest"], today: string): { segments: StripSegment[]; todayPct: number | null; start: string | null; end: string | null } {
  const stages = timeline?.stages ?? [];
  if (!stages.length) return { segments: [], todayPct: null, start: null, end: null };
  const start = stages[0]!.from;
  const end = [harvest?.latest, stages.at(-1)!.to].filter((d): d is string => !!d).sort().at(-1)!;
  const span = Math.max(1, daysBetween(start, end));
  const pct = (d: string) => Math.min(100, Math.max(0, (daysBetween(start, d) / span) * 100));
  const segments = stages.map((s) => ({ id: s.id, name: s.name, leftPct: round1(pct(s.from)), widthPct: round1(Math.max(1, pct(s.to) - pct(s.from))), basis: s.basis }));
  const inside = today >= start && today <= end;
  return { segments, todayPct: inside ? round1(pct(today)) : null, start, end };
}
const round1 = (x: number) => Math.round(x * 10) / 10;

export interface RainBar { month: string; label: string; rainMm: number | null; heightPct: number; tempText: string | null; days: number }
export function rainBars(months: SeasonPreview["weather"]["months"]): RainBar[] {
  const max = Math.max(1, ...months.map((m) => m.rainMm ?? 0));
  return months.map((m) => ({
    month: m.month, label: m.label.split(" ")[0] ?? m.label, rainMm: m.rainMm, days: m.days,
    heightPct: m.rainMm === null ? 0 : Math.max(2, Math.round((m.rainMm / max) * 100)),
    tempText: m.tMaxC !== null && m.tMinC !== null ? `${Math.round(m.tMaxC)}° / ${Math.round(m.tMinC)}°` : m.tMaxC !== null ? `${Math.round(m.tMaxC)}°` : null,
  }));
}

/** Path values for the sparkline and the index of the week holding the harvest midpoint. */
export function pricePathModel(price: SeasonPreview["price"], harvest: SeasonPreview["harvest"]): { values: (number | null)[]; harvestIndex: number | null; min: number | null; max: number | null } {
  const path = price?.path ?? [];
  const values = path.map((p) => p.p50);
  const finite = values.filter((v): v is number => v !== null);
  let harvestIndex: number | null = null;
  if (harvest && path.length) {
    const mid = addDays(harvest.earliest, Math.floor(daysBetween(harvest.earliest, harvest.latest) / 2));
    path.forEach((p, i) => { if (p.weekStart <= mid) harvestIndex = i; });
  }
  return { values, harvestIndex, min: finite.length ? Math.min(...finite) : null, max: finite.length ? Math.max(...finite) : null };
}

export const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: Math.abs(n) < 100 ? 1 : 0 })}`;
export const inrRange = (r: { low: number; high: number }) => `${inr(r.low)} to ${inr(r.high)}`;
export const kgText = (n: number) => (n >= 1000 ? `${(n / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} t` : `${Math.round(n).toLocaleString("en-IN")} kg`);
export const kgRange = (r: { low: number; high: number }) => `${kgText(r.low)} to ${kgText(r.high)}`;
export const YIELD_BASIS: Record<NonNullable<SeasonPreview["yieldBasis"]>, string> = {
  district: "District yields", state: "State yields", reference: "Reference yield", farmer: "Your yield",
};
export const VERDICT_TONE = { ok: "done", watch: "watch", short: "warning", unknown: "neutral" } as const;
export const VERDICT_TEXT = { ok: "OK", watch: "Watch", short: "Short", unknown: "Not rated" } as const;
export const STEP_KIND = { care: "Care", stage: "Stage", harvest: "Harvest" } as const;
export function dateSpan(from: string, to: string): string {
  if (from === to) return shortDate(from);
  return from.slice(0, 4) === to.slice(0, 4) ? `${dayMonth(from)} to ${shortDate(to)}` : `${shortDate(from)} to ${shortDate(to)}`;
}
/** Header title: "Finger millet + pigeon pea (4:1)" from the preview's companion, else the fallback season title. */
export function previewTitle(p: Pick<SeasonPreview, "cropName" | "kind" | "companion">, fallback?: string): string {
  if (p.kind === "intercrop" && p.companion) return `${p.cropName} + ${lowerFirst(p.companion.cropName)}${ratioStated(p.companion.rowRatio) ? ` (${p.companion.rowRatio})` : ""}`;
  return fallback ?? p.cropName;
}

/** A row ratio the research stated; "not stated" (the engine's placeholder) is left out of labels. */
const ratioStated = (ratio: string | null | undefined) => !!ratio && !/^not stated$/i.test(ratio.trim());
