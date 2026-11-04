import type { StageTimeline, YearPlanOccupant, YearPlanReview, YearPlanSlot } from "@harvest/contracts";
import { cropLabel } from "../fields/fieldsModel";
import { stageAt } from "../today/model";
import { MONTH_SHORT, addDaysIso, daysInMonth, longDate, longSpan, parseIso, shortSpan } from "./format";
import { greenManureName, intercropName, isGreenManure, isApplied, occupantName } from "./model";

/**
 * The twelve-month season strip (SEASON_STRIP_COMPARE_SPEC.md part 1): pure labelling rules. The strip summarises data the
 * Plan tab already holds: the growing crop (its stage timeline, else the plan's fixed slot), the saved seasons, and the
 * generated plan's chosen option. It writes no new advice: a month with nothing under it reads "Field rests" and is never
 * given a task. No DOM and no Solid, so node tests import it directly.
 */

export const STRIP_MONTHS = 12;

/** Where a month's label comes from; the chip on the detail card. */
export type StripBasis = "recorded" | "saved" | "ai_plan" | "estimate";
export const STRIP_BASIS_LABEL: Record<StripBasis, string> = {
  recorded: "Recorded",
  saved: "Saved season",
  ai_plan: "AI plan",
  estimate: "Estimate",
};

export type StripWord = "Grow" | "Bulk" | "Harvest" | "Sow" | "Planned" | "Field rests";
export type StripKind = "current" | "saved" | "plan" | "rest";

/** What "Open" does for a month: a crop of the chosen option, a saved season the plan shares, or a saved season only the list knows. */
export type StripTarget =
  | { kind: "slot"; optionId: string; slotId: string }
  | { kind: "occupant"; occupantId: string }
  | { kind: "season"; seasonId: string };

export interface CurrentSpan {
  kind: "current";
  cropName: string;
  from: string;
  to: string;
  /** The estimated harvest window, when known. */
  harvest: { earliest: string; latest: string } | null;
  /** The cycle's calendar stage timeline; its stage names label the months. */
  timeline: StageTimeline | null;
  target: StripTarget | null;
}
export interface SavedSpan {
  kind: "saved";
  cropName: string;
  from: string;
  /** The farmer's planned harvest day, else where the engine holds the field until, else the sowing day. */
  to: string;
  harvestDate: string | null;
  basis: "saved" | "recorded" | "estimate";
  /** An assumed plan ("Assumed from last year's plan") reads as an estimate. */
  assumed: boolean;
  target: StripTarget | null;
}
export interface PlanSpan {
  kind: "plan";
  cropName: string;
  from: string;
  to: string;
  basis: "ai_plan" | "estimate";
  target: StripTarget | null;
}
export type StripSpan = CurrentSpan | SavedSpan | PlanSpan;

export interface StripMonth {
  /** "2026-11" */
  key: string;
  /** "Nov" */
  label: string;
  year: number;
  /** First and last day of the month. */
  from: string;
  to: string;
  kind: StripKind;
  /** The short label under the bar. */
  word: StripWord;
  /** The crop shown, or null for a month that rests. */
  crop: string | null;
  /** The sentence on the detail card, assembled from the calendar's own strings. */
  text: string;
  basis: StripBasis | null;
  target: StripTarget | null;
  /** True when a bar is drawn (the month is covered). */
  covered: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Month arithmetic.

const dayIndex = (iso: string) => {
  const p = parseIso(iso);
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000);
};
const overlapDays = (aFrom: string, aTo: string, bFrom: string, bTo: string): number =>
  Math.max(0, Math.min(dayIndex(aTo), dayIndex(bTo)) - Math.max(dayIndex(aFrom), dayIndex(bFrom)) + 1);
const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** The first day of the month of `iso`. */
export const monthStart = (iso: string) => {
  const p = parseIso(iso);
  return `${monthKey(p.y, p.m)}-01`;
};

/**
 * Where the strip starts. The current horizon starts at the current month ("Nov 2026 to Oct 2027"); a later horizon the pager
 * shows starts where that horizon does, so the strip and the calendar below it read the same twelve months.
 */
export function stripAnchor(todayIso: string, scenario: Pick<YearPlanReview["scenario"], "kind" | "horizon" | "yearIndex"> | undefined): string {
  if (scenario && (scenario.kind === "future" || (scenario.yearIndex ?? 0) > 0)) return monthStart(scenario.horizon.from);
  return monthStart(todayIso);
}

/** "Nov 2026 to Oct 2027" for the strip's heading. */
export function stripRangeText(months: readonly StripMonth[]): string {
  const first = months[0];
  const last = months.at(-1);
  if (!first || !last) return "";
  return `${first.label} ${first.year} to ${last.label} ${last.year}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Stage words.

/**
 * Stage names that describe the crop filling out (a rhizome bulking, grain filling, tuber formation, ripening) read "Bulk";
 * every other growing stage reads "Grow". The names come from the stage timeline, so this only picks the short word.
 */
const BULK_STAGE = /bulk|fill|enlarg|swell|tuberi[sz]|tuber format|rhizome|ripen|matur|boll|pod dev|head dev/i;
export const stageWord = (stageName: string | null | undefined): "Grow" | "Bulk" => (stageName && BULK_STAGE.test(stageName) ? "Bulk" : "Grow");

// ---------------------------------------------------------------------------------------------------------------------
// One month under one span.

interface Described {
  kind: StripKind;
  word: StripWord;
  text: string;
  basis: StripBasis;
}

function describeCurrent(span: CurrentSpan, from: string, to: string, todayIso: string): Described {
  const harvest = span.harvest;
  if (harvest && overlapDays(from, to, harvest.earliest, harvest.latest) > 0)
    return {
      kind: "current",
      word: "Harvest",
      text: `Harvest window · ${span.cropName}, estimated ${longSpan(harvest.earliest, harvest.latest)}`,
      basis: "estimate",
    };
  const timeline = span.timeline;
  if (timeline) {
    // Today inside the month is the honest reference; other months are read at their middle, held inside the cycle.
    const middle = addDaysIso(from, 14);
    const reference = todayIso >= from && todayIso <= to ? todayIso : middle < span.from ? span.from : middle > span.to ? span.to : middle;
    const at = stageAt(timeline, reference);
    if (at.kind === "stage")
      return {
        kind: "current",
        word: stageWord(at.stage.name),
        text: `${stageWord(at.stage.name)} · ${span.cropName} (${at.stage.name})`,
        basis: "estimate",
      };
    if (at.kind === "harvest")
      return { kind: "current", word: "Harvest", text: `Harvest window · ${span.cropName}, estimated ${longSpan(at.from, at.to)}`, basis: "estimate" };
  }
  return { kind: "current", word: "Grow", text: `Grow · ${span.cropName}`, basis: "recorded" };
}

function describeSaved(span: SavedSpan, from: string, to: string): Described {
  const sown = span.from >= from && span.from <= to;
  const harvested = !!span.harvestDate && span.harvestDate >= from && span.harvestDate <= to;
  const planned = span.basis === "recorded" ? "recorded" : "planned";
  const assumed = span.assumed ? " (assumed from last year's plan)" : "";
  const basis: StripBasis = span.basis;
  if (sown) return { kind: "saved", word: "Sow", text: `Sow · ${span.cropName}, ${planned} ${longDate(span.from)}${assumed}`, basis };
  if (harvested)
    return { kind: "saved", word: "Harvest", text: `Harvest · ${span.cropName}, ${planned} ${longDate(span.harvestDate!)}${assumed}`, basis };
  return { kind: "saved", word: "Grow", text: `Grow · ${span.cropName}${assumed}`, basis };
}

const describePlan = (span: PlanSpan): Described => ({
  kind: "plan",
  word: "Planned",
  text: `Planned · ${span.cropName}, ${shortSpan(span.from, span.to)}`,
  basis: span.basis,
});

const RANK: Record<StripSpan["kind"], number> = { current: 0, saved: 1, plan: 2 };

/**
 * The twelve months from `anchorIso`'s month. Each month shows the span with most days in it; a tie goes to the growing
 * crop, then a saved season, then the generated plan. A month no span touches rests.
 */
export function seasonMonths(spans: readonly StripSpan[], anchorIso: string, todayIso: string, months = STRIP_MONTHS): StripMonth[] {
  const origin = parseIso(anchorIso);
  return Array.from({ length: months }, (_, i) => {
    const index = origin.m - 1 + i;
    const year = origin.y + Math.floor(index / 12);
    const month = (index % 12) + 1;
    const from = `${monthKey(year, month)}-01`;
    const to = `${monthKey(year, month)}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
    const best = spans
      .map((span) => ({ span, days: overlapDays(from, to, span.from, span.to) }))
      .filter((c) => c.days > 0)
      .sort((a, b) => b.days - a.days || RANK[a.span.kind] - RANK[b.span.kind])[0]?.span;
    const base = { key: monthKey(year, month), label: MONTH_SHORT[month - 1]!, year, from, to };
    if (!best)
      return {
        ...base,
        kind: "rest" as const,
        word: "Field rests" as const,
        crop: null,
        text: "Field rests · no crop recorded, saved or planned this month",
        basis: null,
        target: null,
        covered: false,
      };
    const d = best.kind === "current" ? describeCurrent(best, from, to, todayIso) : best.kind === "saved" ? describeSaved(best, from, to) : describePlan(best);
    return { ...base, ...d, crop: best.cropName, target: best.target, covered: true };
  });
}

/** Accessible name of a month; starts with the visible text (WCAG 2.5.3). */
export const monthLabel = (m: StripMonth): string =>
  `${m.label} ${m.year}, ${m.word}${m.crop ? `, ${m.crop}` : ""}${m.basis ? `. ${STRIP_BASIS_LABEL[m.basis]}` : ""}`;

/**
 * The strip in words for a screen reader: consecutive months with the same label are one run ("Nov to Jan: Grow Paddy;
 * Feb: Field rests").
 */
export function stripSummary(months: readonly StripMonth[]): string {
  const runs: { from: string; to: string; text: string }[] = [];
  for (const m of months) {
    const text = m.crop ? `${m.word} ${m.crop}` : m.word;
    const last = runs.at(-1);
    if (last && last.text === text) last.to = m.label;
    else runs.push({ from: m.label, to: m.label, text });
  }
  return runs.map((r) => `${r.from === r.to ? r.from : `${r.from} to ${r.to}`}: ${r.text}`).join("; ");
}

/** The month a detail card opens on: the first one. */
export const defaultMonthKey = (months: readonly StripMonth[]) => months[0]?.key ?? "";

/** Radiogroup arrow keys: the key of the month to move to, or null for any other key. */
export function nextMonthKey(months: readonly StripMonth[], currentKey: string, key: string): string | null {
  const at = Math.max(0, months.findIndex((m) => m.key === currentKey));
  const last = months.length - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return months[Math.min(last, at + 1)]?.key ?? null;
    case "ArrowLeft":
    case "ArrowUp":
      return months[Math.max(0, at - 1)]?.key ?? null;
    case "Home":
      return months[0]?.key ?? null;
    case "End":
      return months[last]?.key ?? null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Spans from what the Plan tab holds.

/**
 * The option the strip draws: the applied one when the farmer saved a plan, else "Best overall", else the first option. A
 * plan the farmer saved already lives in the saved seasons, so drawing it again changes nothing.
 */
export function chosenOption(review: Pick<YearPlanReview, "options" | "appliedOptionIds"> | undefined) {
  const options = review?.options ?? [];
  return (
    options.find((o) => isApplied(review!, o.optionId)) ?? options.find((o) => o.label === "Best overall") ?? options[0] ?? null
  );
}

const slotName = (slot: YearPlanSlot) => (isGreenManure(slot) ? `Green manure · ${greenManureName(slot.cropName)}` : intercropName(slot));

/**
 * The growing crop: its stage timeline when the timeline belongs to that crop, with the plan's fixed slot (the same cycle)
 * giving the harvest window; otherwise the fixed slot alone. Null when neither exists. `cropName` is the workspace's name for
 * the cycle's crop, used when only a timeline is there.
 */
export function currentSpan(args: {
  fixedSlot: YearPlanSlot | null;
  timeline: StageTimeline | null;
  cropName: string;
  target: StripTarget | null;
}): CurrentSpan | null {
  const { fixedSlot, timeline } = args;
  const own = timeline && (!fixedSlot || timeline.cropId === fixedSlot.cropId) ? timeline : null;
  if (fixedSlot)
    return {
      kind: "current",
      cropName: fixedSlot.cropName,
      from: fixedSlot.sowing,
      to: fixedSlot.harvest.latest,
      harvest: fixedSlot.harvest,
      timeline: own,
      target: args.target,
    };
  if (!own) return null;
  const to = own.harvest?.latest ?? own.stages.at(-1)?.to ?? null;
  if (!to) return null;
  return { kind: "current", cropName: args.cropName, from: own.anchorDate, to, harvest: own.harvest, timeline: own, target: args.target };
}

export interface SavedSeasonLike {
  id: string;
  cropId: string;
  cropName?: string | undefined;
  plannedSowingDate?: string | undefined;
  plannedHarvestDate?: string | undefined;
  companion?: { cropId: string; cropName?: string | undefined; rowRatio?: string | undefined } | undefined;
}

/**
 * Saved seasons as spans. The Plan tab's review adds what the list does not carry: where the engine holds the field when the
 * farmer gave no harvest date (a season matches its occupant by id). Recorded crops and an assumed plan, which only the review
 * lists, follow. A saved season without a planned sowing date has no month to sit in and is left out.
 */
export function savedSpans(
  seasons: readonly SavedSeasonLike[],
  occupants: readonly YearPlanOccupant[] | undefined,
  cropName: (cropId: string) => string,
): SavedSpan[] {
  const byId = new Map((occupants ?? []).map((o) => [o.id, o]));
  const spans: SavedSpan[] = [];
  for (const season of seasons) {
    if (!season.plannedSowingDate) continue;
    const occupant = byId.get(season.id);
    const harvestDate = season.plannedHarvestDate ?? occupant?.harvestDate ?? null;
    spans.push({
      kind: "saved",
      cropName: occupant ? occupantName(occupant) : cropLabel(season, cropName),
      from: season.plannedSowingDate,
      to: harvestDate ?? occupant?.occupancy.to ?? season.plannedSowingDate,
      harvestDate,
      basis: "saved",
      assumed: false,
      target: occupant ? { kind: "occupant", occupantId: season.id } : { kind: "season", seasonId: season.id },
    });
  }
  const listed = new Set(seasons.map((s) => s.id));
  for (const o of occupants ?? []) {
    if (listed.has(o.id)) continue;
    spans.push({
      kind: "saved",
      cropName: occupantName(o),
      from: o.sowing,
      to: o.harvestDate ?? o.occupancy.to,
      harvestDate: o.harvestDate,
      basis: o.source === "recorded_cycle" ? "recorded" : o.source === "assumed_plan" ? "estimate" : "saved",
      assumed: o.source === "assumed_plan",
      target: { kind: "occupant", occupantId: o.id },
    });
  }
  return spans;
}

/** The chosen option's suggested crops (not the growing one) as spans; "AI plan" when Meta chose the option, else a code estimate. */
export function planSpans(review: Pick<YearPlanReview, "options" | "appliedOptionIds"> | undefined): PlanSpan[] {
  const option = chosenOption(review);
  if (!option) return [];
  return option.slots
    .filter((slot) => !slot.fixed)
    .map((slot) => ({
      kind: "plan" as const,
      cropName: slotName(slot),
      from: slot.sowing,
      to: slot.harvest.latest,
      basis: option.origin === "model" ? ("ai_plan" as const) : ("estimate" as const),
      target: { kind: "slot" as const, optionId: option.optionId, slotId: slot.slotId },
    }));
}

/** The growing crop's slot in the chosen option, as an "Open" target (the sheet opens on it). */
export function fixedTarget(review: Pick<YearPlanReview, "options" | "appliedOptionIds"> | undefined): { slot: YearPlanSlot | null; target: StripTarget | null } {
  const option = chosenOption(review);
  const slot = option?.slots.find((s) => s.fixed) ?? null;
  return { slot, target: option && slot ? { kind: "slot", optionId: option.optionId, slotId: slot.slotId } : null };
}

/**
 * One field's compact strip for "Plans by field": the growing crop (its timeline) and the field's saved seasons from the
 * workspace. The generated plan is not read per field here, so it is not drawn; months with nothing saved rest.
 */
export function fieldStripMonths(args: {
  cycleName: string;
  timeline: StageTimeline | null;
  seasons: readonly SavedSeasonLike[];
  todayIso: string;
  cropName: (cropId: string) => string;
}): StripMonth[] {
  const current = currentSpan({ fixedSlot: null, timeline: args.timeline, cropName: args.cycleName, target: null });
  return seasonMonths([...(current ? [current] : []), ...savedSpans(args.seasons, undefined, args.cropName)], monthStart(args.todayIso), args.todayIso);
}
