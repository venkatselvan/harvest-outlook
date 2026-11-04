import type { CropFitCandidate, SeasonPreview, StageTimeline, YearPlanOccupant } from "@harvest/contracts";
import type { Cycle, Rotation } from "../state";
import { seasonLabelForSowing } from "../year/model";
import { seasonsForField } from "../year/PlanCalendar";

/**
 * Pure helpers of the Plan-this-crop sheet (docs/research/EVARA_ACTIONS_SPEC.md 1.1 and 2.8): which saved seasons of a field
 * are replaceable, what the new crop occupies, the saved season an "add" appends, and the occupant a swap needs. No network,
 * no state: the sheet and the tests call these with plain values.
 */

/** A saved season counts as sown when a recorded cycle of the same crop on the field (or a farm-wide one) began within this many days of the plan. */
export const REALISATION_WINDOW_DAYS = 45;

const dayNumber = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000;

export type Realisation = "planned" | "overdue" | "sown";

/** The cycles that can realise a season of this field: its own and the legacy farm-wide ones. */
export const cyclesOfField = (cycles: readonly Cycle[], fieldId: string | null | undefined) =>
  fieldId ? cycles.filter((c) => !c.fieldId || c.fieldId === fieldId) : [...cycles];

/** `sown`: a recorded cycle of the same crop on the field began within 45 days of the plan; else `planned` (today or later) or `overdue`. */
export function seasonRealisation(plan: Pick<Rotation, "cropId" | "plannedSowingDate">, cycles: readonly Cycle[], fieldId: string | null | undefined, todayIso: string): Realisation {
  if (!plan.plannedSowingDate) return "sown";
  const planned = dayNumber(plan.plannedSowingDate);
  const sown = cyclesOfField(cycles, fieldId).some((c) => c.cropId === plan.cropId && Math.abs(dayNumber(c.sowingDate) - planned) <= REALISATION_WINDOW_DAYS);
  if (sown) return "sown";
  return plan.plannedSowingDate >= todayIso ? "planned" : "overdue";
}

export interface Occupancy {
  from: string;
  to: string;
}
/** The engine's overlap rule: half-open, a season may begin the day another is released. */
export const occupanciesOverlap = (a: Occupancy, b: Occupancy) => a.from < b.to && b.from < a.to;

/**
 * What a saved season occupies: sowing to its planned harvest. A season with no planned harvest date has no known end, so it
 * counts as the single day of its sowing (it can only collide with a crop that is sown across that day).
 */
export function planOccupancy(plan: Pick<Rotation, "plannedSowingDate" | "plannedHarvestDate">): Occupancy | null {
  if (!plan.plannedSowingDate) return null;
  const end = plan.plannedHarvestDate && plan.plannedHarvestDate > plan.plannedSowingDate ? plan.plannedHarvestDate : nextDay(plan.plannedSowingDate);
  return { from: plan.plannedSowingDate, to: end };
}
function nextDay(iso: string): string {
  return new Date((dayNumber(iso) + 1) * 86_400_000).toISOString().slice(0, 10);
}

/** What the new crop occupies: sowing to the latest harvest of its window. Null when no harvest window is sourced (overlap cannot be judged). */
export function cropOccupancy(sowing: string, harvest: { latest: string } | null | undefined): Occupancy | null {
  return harvest && harvest.latest > sowing ? { from: sowing, to: harvest.latest } : null;
}

/** The saved seasons of the viewed field (its own and whole-farm ones) with their realisation. */
export interface FieldSeason {
  plan: Rotation;
  realisation: Realisation;
  occupancy: Occupancy;
}
export function fieldSeasons(args: { rotationPlans: readonly Rotation[]; cycles: readonly Cycle[]; fieldId: string | null | undefined; todayIso: string }): FieldSeason[] {
  return seasonsForField(args.rotationPlans, args.fieldId).flatMap((plan) => {
    const occupancy = planOccupancy(plan);
    return occupancy ? [{ plan, realisation: seasonRealisation(plan, args.cycles, args.fieldId, args.todayIso), occupancy }] : [];
  });
}

/** One saved season with its realisation, judged against the cycles of `fieldId` (the plan's own field when it has one); null when it has no planned sowing date. */
export function seasonOfPlan(plan: Rotation, cycles: readonly Cycle[], fieldId: string | null | undefined, todayIso: string): FieldSeason | null {
  const occupancy = planOccupancy(plan);
  return occupancy ? { plan, occupancy, realisation: seasonRealisation(plan, cycles, plan.fieldId ?? fieldId, todayIso) } : null;
}

/** Replaceable = planned or overdue (never one a recorded cycle realises). */
export const isReplaceable = (season: Pick<FieldSeason, "realisation">) => season.realisation !== "sown";

export interface OverlapResult {
  /** Replaceable seasons whose occupancy overlaps the new crop's. */
  replaceable: FieldSeason[];
  /** Seasons that overlap but a recorded cycle realises; the crop cannot be added next to them. */
  blocking: FieldSeason[];
}
export function overlapping(seasons: readonly FieldSeason[], taken: Occupancy | null): OverlapResult {
  if (!taken) return { replaceable: [], blocking: [] };
  const hits = seasons.filter((s) => occupanciesOverlap(taken, s.occupancy));
  return { replaceable: hits.filter(isReplaceable), blocking: hits.filter((s) => !isReplaceable(s)) };
}

export type AddRefusal = { kind: "past"; sowing: string } | { kind: "blocked"; season: FieldSeason };

/** The refusal for an add the farmer cannot save, or null: sowing date passed, or a sown season holds the field then. */
export function addRefusal(args: { sowing: string; todayIso: string; blocking: readonly FieldSeason[] }): AddRefusal | null {
  if (args.sowing < args.todayIso) return { kind: "past", sowing: args.sowing };
  const hit = args.blocking[0];
  return hit ? { kind: "blocked", season: hit } : null;
}

/** A swap writes `productId: ""` when neither the preview nor the catalogue names a product; the saved season carries no empty product. */
export const dropEmptyProduct = (plans: readonly Rotation[]): Rotation[] =>
  plans.map((p) => {
    if (p.productId !== "") return p;
    const { productId: _id, productName: _name, ...rest } = p;
    return rest;
  });

/**
 * The saved season an "add" appends: a RotationPlan as the Planner builds it (id, year = the sowing year, season label,
 * crop and product names, planned dates, field). The id is passed in so a retry after a lost response reuses it and the
 * save stays idempotent.
 */
export function newRotationPlan(args: {
  id: string;
  cropId: string;
  cropName: string;
  productId: string | null;
  productName: string | null;
  sowing: string;
  harvestLatest: string | null;
  fieldId: string | null | undefined;
  notes?: string;
}): Rotation {
  return {
    id: args.id,
    year: Number(args.sowing.slice(0, 4)),
    season: seasonLabelForSowing(args.sowing),
    cropId: args.cropId,
    cropName: args.cropName,
    ...(args.productId ? { productId: args.productId } : {}),
    ...(args.productId && args.productName ? { productName: args.productName } : {}),
    plannedSowingDate: args.sowing,
    ...(args.harvestLatest && args.harvestLatest > args.sowing ? { plannedHarvestDate: args.harvestLatest } : {}),
    ...(args.notes ? { notes: args.notes } : {}),
    ...(args.fieldId ? { fieldId: args.fieldId } : {}),
  };
}

/** The saved-season list after an add: the new season appended, any earlier copy of the same id (a retried save) dropped. */
export const appendSeason = (plans: readonly Rotation[], next: Rotation): Rotation[] => [...plans.filter((p) => p.id !== next.id), next];

/** The occupant `swapSavedSeason` needs, built from the workspace's own rotation plan (the plan is the source of truth). */
export function occupantFromPlan(plan: Rotation, realisation: Realisation): YearPlanOccupant {
  const occupancy = planOccupancy(plan) ?? { from: plan.plannedSowingDate ?? "1970-01-01", to: plan.plannedSowingDate ?? "1970-01-02" };
  return {
    id: plan.id,
    source: "saved_season",
    cropId: plan.cropId,
    productId: plan.productId ?? null,
    cropName: plan.cropName ?? plan.cropId.replace(/[-_]+/g, " "),
    productName: plan.productName ?? null,
    kind: plan.kind ?? "crop",
    companion: plan.companion
      ? { systemId: plan.companion.systemId ?? null, cropId: plan.companion.cropId, cropName: plan.companion.cropName ?? plan.companion.cropId, rowRatio: plan.companion.rowRatio }
      : null,
    establishmentMethod: plan.establishmentMethod ?? null,
    sowing: plan.plannedSowingDate ?? occupancy.from,
    harvestDate: plan.plannedHarvestDate ?? null,
    occupancy,
    occupancyBasis: "planned",
    note: plan.notes ? plan.notes.slice(0, 400) : null,
    realisation,
  };
}

/** Every other saved season of the field as an occupant, for the swap's overlap check. */
export const otherOccupants = (seasons: readonly FieldSeason[], exceptId: string): YearPlanOccupant[] =>
  seasons.filter((s) => s.plan.id !== exceptId).map((s) => occupantFromPlan(s.plan, s.realisation));

/**
 * The candidate `swapSavedSeason` and `replacementRotationPlan` read, built from the season preview (the preview already
 * carries the crop, product, sowing and harvest window the saved season will get). Only the fields those two functions
 * use are filled; the rest of a crop fit candidate (scores, prices) does not exist for a preview, so the object is not a
 * complete CropFitCandidate and must go nowhere else.
 */
export function swapCandidate(preview: Pick<SeasonPreview, "cropId" | "cropName" | "productId" | "productName" | "establishmentMethod" | "sowing" | "harvest">, fallbackProductId: string | null): CropFitCandidate {
  const partial = {
    cropId: preview.cropId,
    cropName: preview.cropName,
    productId: preview.productId ?? fallbackProductId ?? "",
    productName: preview.productName ?? preview.cropName,
    establishmentMethod: preview.establishmentMethod,
    kind: "crop" as const,
    companion: null,
    sowing: preview.sowing,
    harvest: preview.harvest ?? { earliest: preview.sowing, latest: preview.sowing },
    occupancy: cropOccupancy(preview.sowing, preview.harvest) ?? undefined,
  };
  return partial as unknown as CropFitCandidate;
}

// ---------------------------------------------------------------------------------------------------------------------
// The crop standing in the field (review of the Evara actions round, finding 1): every unharvested cycle of the viewed field
// (and every legacy farm-wide one) holds the field until its release date, whether or not a saved season mirrors it.

/** Release dates by cycle id, read from the cycle's stage timeline. `null` = looked up and not known; a missing key = not looked up. */
export type Releases = Readonly<Record<string, string | null | undefined>>;

/** When a timeline says the crop leaves the field: the end of its harvest window, else the end of its last stage. */
export function releaseOfTimeline(timeline: Pick<StageTimeline, "harvest" | "stages"> | null | undefined): string | null {
  if (!timeline) return null;
  return timeline.harvest?.latest ?? timeline.stages[timeline.stages.length - 1]?.to ?? null;
}

export interface GrowingCycle {
  cycle: Cycle;
  cropName: string;
  /** The date the field is free again; null when no release date can be established. */
  release: string | null;
  occupancy: Occupancy | null;
}

/** The unharvested cycles of the field with their release date (`releases[cycle.id]`, else a harvest date the cycle itself records, never one made up). */
export function growingCycles(args: {
  cycles: readonly Cycle[];
  fieldId: string | null | undefined;
  releases?: Releases | undefined;
  cropName: (cropId: string) => string;
}): GrowingCycle[] {
  return cyclesOfField(args.cycles, args.fieldId)
    .filter((c) => c.stage !== "harvested")
    .map((cycle) => {
      const found = args.releases?.[cycle.id] ?? cycle.harvestDate ?? null;
      const release = found && found > cycle.sowingDate ? found : null;
      return { cycle, cropName: cycle.cropName ?? args.cropName(cycle.cropId), release, occupancy: release ? { from: cycle.sowingDate, to: release } : null };
    });
}

/** A growing crop a new season cannot be placed beside: its release date is unknown, or the new crop's occupancy overlaps it. */
export function cycleBlocker(growing: readonly GrowingCycle[], taken: Occupancy | null, sowing: string): GrowingCycle | null {
  const day: Occupancy = taken ?? { from: sowing, to: nextDay(sowing) };
  return growing.find((g) => !g.occupancy || occupanciesOverlap(day, g.occupancy)) ?? null;
}
