import type { CropFitCandidate, YearPlanOccupant } from "@harvest/contracts";
import type { Cycle, Rotation } from "../state";
import { seasonRealisation } from "../evara/seasons";
import { addDaysIso } from "../year/format";
import { SWAP_MISSING, swapSavedSeason } from "../year/model";

/**
 * "Replace with <crop>" on a crop fit candidate ranked with the planned, unsown seasons set aside (EVARA_ACTIONS_SPEC.md
 * 1.2). The write is the year plan's own saved-season swap (`swapSavedSeason`): the planned season keeps its id and takes
 * the candidate's crop and dates, checked first with the rule the server's apply uses. Pure: the caller passes the
 * workspace's saved seasons and the save, refresh and reload functions.
 */

/** The land preparation gap the engine adds after a harvest (ASSUMPTIONS.landPrepGapDays). */
const LAND_PREP_GAP_DAYS = 10;

/**
 * A minimal year-plan occupant for a saved season on the workspace, for when the review carries none (crop fit reviews do
 * not). Null when the season has no planned sowing date: it cannot be placed on the calendar, so it cannot be swapped.
 * The occupancy runs to the planned harvest plus the land preparation gap, or to the sowing day when no harvest is planned
 * (it then never blocks another crop in the pre-save check; the server's apply still has the last word).
 */
export function occupantFromRotation(plan: Rotation): YearPlanOccupant | null {
  const sowing = plan.plannedSowingDate;
  if (!sowing) return null;
  const harvest = plan.plannedHarvestDate ?? null;
  return {
    id: plan.id,
    source: "saved_season",
    cropId: plan.cropId,
    productId: plan.productId ?? null,
    cropName: plan.cropName ?? plan.cropId,
    productName: plan.productName ?? null,
    kind: plan.kind ?? "crop",
    companion: plan.companion
      ? { systemId: plan.companion.systemId ?? null, cropId: plan.companion.cropId, cropName: plan.companion.cropName ?? plan.companion.cropId, rowRatio: plan.companion.rowRatio }
      : null,
    establishmentMethod: plan.establishmentMethod ?? null,
    sowing,
    harvestDate: harvest,
    occupancy: { from: sowing, to: harvest ? addDaysIso(harvest, LAND_PREP_GAP_DAYS) : sowing },
    occupancyBasis: "planned",
    note: null,
    realisation: "planned",
  };
}

export type ResolvedReplacement = { ok: true; occupant: YearPlanOccupant; occupied: YearPlanOccupant[] } | { ok: false; message: string };

export const REPLACE_NOT_PLANNED = "This crop does not replace a planned season.";
export const REPLACE_NOW_SOWN = "That planned season has been sown since this ranking was made, so it cannot be replaced.";
export const REPLACE_NO_DATE = "The planned season has no sowing date, so it cannot be replaced from here. Change it in Saved seasons.";

/**
 * The planned season a candidate replaces and the other saved seasons it must not overlap. `occupants` are the year plan's
 * occupants when the caller has them (the saved season is then taken from there by id); otherwise the minimal occupant is
 * built from the workspace's saved season with that id. The first of `candidate.replaces` is the season swapped; when the
 * candidate overlaps a second planned season, the swap's overlap check refuses it and names that season. `fieldId` limits
 * the other seasons to the field's own (a season without a field is whole-farm and counts).
 */
export function resolveReplacement(args: {
  candidate: Pick<CropFitCandidate, "replaces">;
  rotationPlans: readonly Rotation[];
  occupants?: readonly YearPlanOccupant[] | undefined;
  fieldId?: string | null | undefined;
}): ResolvedReplacement {
  const target = args.candidate.replaces?.[0];
  if (!target) return { ok: false, message: REPLACE_NOT_PLANNED };
  const plan = args.rotationPlans.find((r) => r.id === target.rotationPlanId);
  if (!plan) return { ok: false, message: SWAP_MISSING };
  const given = args.occupants?.find((o) => o.id === target.rotationPlanId);
  const occupant = given ?? occupantFromRotation(plan);
  if (!occupant) return { ok: false, message: REPLACE_NO_DATE };
  const occupied = args.occupants
    ? [...args.occupants]
    : args.rotationPlans
        .filter((r) => !args.fieldId || !r.fieldId || r.fieldId === args.fieldId)
        .flatMap((r) => (r.id === plan.id ? [occupant] : (occupantFromRotation(r) ?? [])));
  return { ok: true, occupant, occupied };
}

export type ReplaceOutcome = { kind: "replaced"; from: string; to: string } | { kind: "unchanged" } | { kind: "refused" | "failed" | "missing"; message: string };

/**
 * Resolve, swap, then (only when saved) refresh the workspace and reload the review. A refusal or failure touches
 * nothing; the message is for the farmer. `refresh` and `reload` are called in that order and awaited.
 */
export async function replacePlannedSeason(args: {
  candidate: CropFitCandidate;
  rotationPlans: readonly Rotation[];
  /** The workspace's recorded cycles as they are now: the season is checked against them at write time, not when the ranking was made. */
  cycles: readonly Cycle[];
  occupants?: readonly YearPlanOccupant[] | undefined;
  fieldId?: string | null | undefined;
  todayIso: string;
  save: (patch: { rotationPlans: Rotation[] }) => Promise<unknown>;
  refresh: () => Promise<unknown> | unknown;
  reload: () => Promise<unknown> | unknown;
}): Promise<ReplaceOutcome> {
  const resolved = resolveReplacement(args);
  if (!resolved.ok) return { kind: "refused", message: resolved.message };
  // Re-judged here, against the cycles the workspace holds now: a season the farmer has since sown is never replaced.
  const plan = args.rotationPlans.find((r) => r.id === resolved.occupant.id);
  const realisation = plan ? seasonRealisation(plan, args.cycles, plan.fieldId ?? args.fieldId, args.todayIso) : "planned";
  if (realisation === "sown") return { kind: "refused", message: REPLACE_NOW_SOWN };
  const occupant = { ...resolved.occupant, realisation };
  const result = await swapSavedSeason({
    occupant,
    candidate: args.candidate,
    rotationPlans: args.rotationPlans,
    todayIso: args.todayIso,
    // The growing crop is not known here; the ranking itself keeps every sown cycle occupied, and the server's apply checks it again.
    fixedSlot: null,
    occupied: resolved.occupied.map((o) => (o.id === occupant.id ? occupant : o)),
    save: args.save,
  });
  if (result.kind !== "saved") return result;
  await args.refresh();
  await args.reload();
  return { kind: "replaced", from: result.from, to: result.to };
}
