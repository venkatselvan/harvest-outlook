import type { SeasonPreview } from "@harvest/contracts";
import { swapSavedSeason, SWAP_CONFLICT, SWAP_MISSING } from "../year/model";
import { finishSeasonSave, type EvaraContext, type PlanCropRequest, type SeasonSaved } from "./actions";
import { kitLabels, labelDate } from "./labels";
import {
  addRefusal,
  appendSeason,
  cropOccupancy,
  cycleBlocker,
  dropEmptyProduct,
  fieldSeasons,
  growingCycles,
  isReplaceable,
  newRotationPlan,
  occupantFromPlan,
  otherOccupants,
  overlapping,
  seasonOfPlan,
  swapCandidate,
  type FieldSeason,
  type GrowingCycle,
  type Releases,
} from "./seasons";

/**
 * The decisions and writes of the Plan-this-crop sheet (docs/research/EVARA_ACTIONS_SPEC.md 2.8), without any view so tests
 * call them directly. `planCropModel` is read-only; `addPlannedSeason` and `replacePlannedSeason` are the only writes and run
 * only when the farmer taps the confirm button.
 */

export type PlanCropChoice =
  /** The crop can be added as a new planned season. */
  | { kind: "add" }
  /** One button per replaceable season the crop would collide with. */
  | { kind: "replace"; seasons: FieldSeason[] }
  /** Nothing can be saved; `message` says why. */
  | { kind: "none"; message: string };

export interface PlanCropModel {
  sowing: string;
  harvestLatest: string | null;
  occupancy: { from: string; to: string } | null;
  choice: PlanCropChoice;
}

type ModelCtx = Pick<EvaraContext, "fieldId" | "language" | "today" | "rotationPlans" | "cycles" | "cropName">;

/** The crop standing in the field (any unharvested cycle of it) that this crop cannot be placed beside, with the reason for the farmer; null when the field is free by then. */
export function growingRefusal(args: { ctx: ModelCtx; occupancy: { from: string; to: string } | null; sowing: string; releases?: Releases | undefined }): { message: string; growing: GrowingCycle } | null {
  const { ctx, occupancy, sowing, releases } = args;
  const t = kitLabels(ctx.language).sheet;
  const growing = growingCycles({ cycles: ctx.cycles() ?? [], fieldId: ctx.fieldId, releases, cropName: ctx.cropName });
  const hit = cycleBlocker(growing, occupancy, sowing);
  if (!hit) return null;
  const message = hit.occupancy
    ? t.blocked(hit.cropName, labelDate(hit.occupancy.from, ctx.language), labelDate(hit.occupancy.to, ctx.language))
    : t.growingUnknown(hit.cropName, labelDate(sowing, ctx.language));
  return { message, growing: hit };
}

/**
 * What the sheet offers for this crop at this sowing date on the viewed field. Pure. `releases` are the release dates of the
 * cycles standing in the field (see `releaseOfTimeline`); a growing crop with no known release date refuses the add or the
 * replace, because the field may not be free.
 */
export function planCropModel(args: {
  request: PlanCropRequest;
  preview: Pick<SeasonPreview, "sowing" | "harvest">;
  ctx: ModelCtx;
  releases?: Releases | undefined;
}): PlanCropModel {
  const { request, preview, ctx, releases } = args;
  const t = kitLabels(ctx.language).sheet;
  const sowing = preview.sowing;
  const harvestLatest = preview.harvest?.latest ?? null;
  const occupancy = cropOccupancy(sowing, preview.harvest);
  const base = { sowing, harvestLatest, occupancy };
  const plans = ctx.rotationPlans();
  if (!plans) return { ...base, choice: { kind: "none", message: t.notReady } };
  const todayIso = ctx.today();
  const seasons = fieldSeasons({ rotationPlans: plans, cycles: ctx.cycles() ?? [], fieldId: ctx.fieldId, todayIso });

  if (request.mode === "replace") {
    const plan = plans.find((p) => p.id === request.rotationPlanId);
    const target = plan ? seasonOfPlan(plan, ctx.cycles() ?? [], ctx.fieldId, todayIso) : null;
    if (!target) return { ...base, choice: { kind: "none", message: t.missingOccupant } };
    if (!isReplaceable(target)) return { ...base, choice: { kind: "none", message: t.notReplaceable } };
    const standing = growingRefusal({ ctx, occupancy, sowing, releases });
    if (standing) return { ...base, choice: { kind: "none", message: standing.message } };
    return { ...base, choice: { kind: "replace", seasons: [target] } };
  }

  const { replaceable, blocking } = overlapping(seasons, occupancy);
  const refusal = addRefusal({ sowing, todayIso, blocking });
  if (refusal?.kind === "past") return { ...base, choice: { kind: "none", message: t.pastSowing(labelDate(refusal.sowing, ctx.language)) } };
  if (refusal?.kind === "blocked") {
    const s = refusal.season;
    return { ...base, choice: { kind: "none", message: t.blocked(s.plan.cropName ?? ctx.cropName(s.plan.cropId), labelDate(s.occupancy.from, ctx.language), labelDate(s.occupancy.to, ctx.language)) } };
  }
  const standing = growingRefusal({ ctx, occupancy, sowing, releases });
  if (standing) return { ...base, choice: { kind: "none", message: standing.message } };
  return { ...base, choice: replaceable.length ? { kind: "replace", seasons: replaceable.slice(0, 3) } : { kind: "add" } };
}

export type PlanCropOutcome =
  | { kind: "saved"; saved: SeasonSaved }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string; conflict: boolean };

const isConflict = (error: unknown) => {
  const e = error as { status?: unknown; code?: unknown };
  return e?.status === 409 || e?.code === "version_conflict";
};

function failure(error: unknown, language: EvaraContext["language"]): PlanCropOutcome {
  const t = kitLabels(language).sheet;
  if (isConflict(error)) return { kind: "failed", message: t.conflict, conflict: true };
  const message = (error as { message?: unknown })?.message;
  return { kind: "failed", message: typeof message === "string" && message ? message : t.saveFailed, conflict: false };
}

/** "Add as planned season": append a RotationPlan to the saved seasons through the workspace PUT. The id is passed in so a retry stays idempotent. */
export async function addPlannedSeason(args: {
  ctx: EvaraContext;
  request: PlanCropRequest;
  preview: SeasonPreview;
  id: string;
  releases?: Releases | undefined;
}): Promise<PlanCropOutcome> {
  const { ctx, request, preview, id, releases } = args;
  const t = kitLabels(ctx.language).sheet;
  const model = planCropModel({ request, preview, ctx, releases });
  if (model.choice.kind === "none") return { kind: "refused", message: model.choice.message };
  if (model.choice.kind !== "add") return { kind: "refused", message: t.overlapNote };
  const plans = ctx.rotationPlans();
  if (!plans) return { kind: "refused", message: t.notReady };
  const productId = preview.productId ?? request.productId ?? ctx.productIdFor(preview.cropId);
  const plan = newRotationPlan({
    id,
    cropId: preview.cropId,
    cropName: preview.cropName,
    productId,
    productName: preview.productName,
    sowing: model.sowing,
    harvestLatest: model.harvestLatest,
    fieldId: ctx.fieldId,
    notes: `Added from Evara on ${labelDate(ctx.today())}. Dates are calculated references, not predictions.`,
  });
  try {
    await ctx.save({ rotationPlans: appendSeason(plans, plan) });
  } catch (error) {
    return failure(error, ctx.language);
  }
  const saved: SeasonSaved = { kind: "added", cropName: preview.cropName, sowing: model.sowing };
  await finishSeasonSave(ctx, saved);
  return { kind: "saved", saved };
}

/** "Replace <crop> (planned <date>)": the swap write of the Plan tab (`swapSavedSeason`) with the occupant built from the workspace's own rotation plan. */
export async function replacePlannedSeason(args: {
  ctx: EvaraContext;
  request: PlanCropRequest;
  preview: SeasonPreview;
  rotationPlanId: string;
  releases?: Releases | undefined;
}): Promise<PlanCropOutcome> {
  const { ctx, request, preview, rotationPlanId, releases } = args;
  const t = kitLabels(ctx.language).sheet;
  const plans = ctx.rotationPlans();
  if (!plans) return { kind: "refused", message: t.notReady };
  const plan = plans.find((p) => p.id === rotationPlanId);
  if (!plan || !plan.plannedSowingDate) return { kind: "refused", message: t.missingOccupant };
  const todayIso = ctx.today();
  const seasons = fieldSeasons({ rotationPlans: plans, cycles: ctx.cycles() ?? [], fieldId: plan.fieldId ?? ctx.fieldId, todayIso });
  const target = seasonOfPlan(plan, ctx.cycles() ?? [], ctx.fieldId, todayIso);
  const realisation = target?.realisation ?? "sown";
  if (realisation === "sown") return { kind: "refused", message: t.notReplaceable };
  const occupant = occupantFromPlan(plan, realisation);
  const candidate = swapCandidate(preview, request.productId ?? ctx.productIdFor(preview.cropId));
  // The crop standing in the field holds it until its release date; with no known release date the replace is refused.
  const standing = growingRefusal({ ctx, occupancy: cropOccupancy(preview.sowing, preview.harvest), sowing: preview.sowing, releases });
  if (standing) return { kind: "refused", message: standing.message };
  const growing = growingCycles({ cycles: ctx.cycles() ?? [], fieldId: ctx.fieldId, releases, cropName: ctx.cropName }).filter((g) => g.occupancy);
  const holder = growing.sort((a, b) => b.occupancy!.to.localeCompare(a.occupancy!.to))[0];
  const result = await swapSavedSeason({
    occupant,
    candidate,
    rotationPlans: plans,
    todayIso,
    fixedSlot: holder ? { cropName: holder.cropName, occupancy: holder.occupancy! } : null,
    occupied: otherOccupants(seasons, rotationPlanId),
    save: (patch) => ctx.save({ rotationPlans: dropEmptyProduct(patch.rotationPlans) }),
  });
  switch (result.kind) {
    case "unchanged":
      return { kind: "refused", message: t.unchanged };
    case "missing":
      return { kind: "refused", message: result.message === SWAP_MISSING ? t.missingOccupant : result.message };
    case "refused":
      return { kind: "refused", message: result.message };
    case "failed":
      return result.message === SWAP_CONFLICT ? { kind: "failed", message: t.conflict, conflict: true } : { kind: "failed", message: result.message, conflict: false };
    case "saved": {
      const saved: SeasonSaved = { kind: "replaced", cropName: result.to, fromCropName: result.from, sowing: candidate.sowing };
      await finishSeasonSave(ctx, saved);
      return { kind: "saved", saved };
    }
  }
}
