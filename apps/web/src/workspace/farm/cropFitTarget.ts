import { currentCycleOf, wholeFarmCycleOf, type FieldCycleLike } from "../fields/fieldsModel";

/**
 * Which review the crop catalogue's "Crops for your farm" chips may ask for (FIELDS_MULTICROP_SOIL_SPEC.md 12.3, 12.6).
 * On a farm with fields the crop fit and the year plan are per field, and each request can enqueue a Meta job, so the
 * catalogue never asks for a whole-farm one: it uses the selected field, else the first field with a current crop, and
 * when there is none it asks for nothing and says so.
 */
export type CropFitTarget =
  | { status: "wait" }
  | { status: "choose" }
  | { status: "rank"; fieldId: string | null };

export interface TargetWorkspace {
  farmId: string;
  fields?: readonly { id: string }[] | undefined;
  cycles: readonly FieldCycleLike[];
}

export const CHOOSE_FIELD_TO_RANK = "Choose a field to rank crops";

export function cropFitTarget(farmId: string | undefined, workspace: TargetWorkspace | undefined, selectedFieldId: string | null | undefined): CropFitTarget {
  if (!farmId) return { status: "wait" };
  // Whether the farm has fields is not known until its own workspace is loaded.
  if (!workspace || workspace.farmId !== farmId) return { status: "wait" };
  const fields = workspace.fields ?? [];
  if (fields.length === 0) return { status: "rank", fieldId: null };
  if (selectedFieldId && fields.some((f) => f.id === selectedFieldId)) return { status: "rank", fieldId: selectedFieldId };
  // A legacy whole-farm cycle occupies every field, so it makes the first field a field with a current crop.
  const withCrop = fields.find((f) => currentCycleOf(f.id, workspace.cycles) ?? wholeFarmCycleOf(workspace.cycles));
  return withCrop ? { status: "rank", fieldId: withCrop.id } : { status: "choose" };
}
