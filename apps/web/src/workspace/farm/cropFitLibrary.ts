import type { Cycle, Rotation, Workspace } from "../state";
import { POOL_CROPS, ROLE_LABEL, isLegume } from "../cropPool";

/**
 * Pure model for the crop library's default view "Crops for your farm" (ROUND3_SPEC.md 5.1): the rotation pool crops,
 * the green manures and any crop recorded on the farm, each with chips from the farm's own records (Growing now, Saved
 * season), the ready year plan (In your year plan) and the ready crop fit review (Crop fit rank n). The chips only
 * join ids; nothing here computes a score.
 */
/** Mirror of the `greenManure` list in data/research/rotation/crop-pool.json (libraryModel test fails if it drifts). */
export const GREEN_MANURES: readonly { cropId: string; name: string }[] = [
  { cropId: "gm-dhaincha", name: "Dhaincha" },
  { cropId: "gm-sunn-hemp", name: "Sunn hemp" },
  { cropId: "gm-cowpea", name: "Cowpea" },
];

export type LibraryGroup = "pool" | "green_manure" | "recorded";
export type LibraryChipKind = "growing" | "saved" | "plan" | "fit" | "recorded";
export interface LibraryChip { kind: LibraryChipKind; text: string }
export interface LibraryRow {
  cropId: string;
  name: string;
  group: LibraryGroup;
  /** One-line description under the name. */
  note: string;
  /** Product ids the pool lists for the crop (first = the product the compare picker toggles). */
  productIds: readonly string[];
  chips: LibraryChip[];
}
export interface LibraryInput {
  cycles?: readonly Pick<Cycle, "cropId" | "cropName" | "stage">[] | undefined;
  rotationPlans?: readonly Pick<Rotation, "cropId" | "cropName" | "year">[] | undefined;
  previousHarvest?: Workspace["previousHarvest"] | undefined;
  /** Crop ids on the ready year plan's suggested slots; undefined while it is not loaded or not ready. */
  planCropIds?: ReadonlySet<string> | undefined;
  /** Best crop fit rank per crop id from a ready review; undefined while it is not loaded or not ready. */
  fitRanks?: ReadonlyMap<string, number> | undefined;
  nameOf?: ((cropId: string) => string) | undefined;
}

const titleCase = (id: string) => id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function farmCropRows(input: LibraryInput): LibraryRow[] {
  const nameOf = input.nameOf ?? titleCase;
  const recordedName = new Map<string, string>();
  const growing = new Set<string>();
  const recorded = new Set<string>();
  const saved = new Map<string, Set<number>>();
  for (const c of input.cycles ?? []) {
    recorded.add(c.cropId);
    if (c.cropName) recordedName.set(c.cropId, c.cropName);
    if (c.stage !== "harvested") growing.add(c.cropId);
  }
  for (const r of input.rotationPlans ?? []) {
    recorded.add(r.cropId);
    if (r.cropName) recordedName.set(r.cropId, r.cropName);
    saved.set(r.cropId, (saved.get(r.cropId) ?? new Set()).add(r.year));
  }
  const prev = input.previousHarvest;
  if (prev?.status === "known") {
    recorded.add(prev.cropId);
    if (prev.cropName) recordedName.set(prev.cropId, prev.cropName);
  }

  const ids: { cropId: string; group: LibraryGroup }[] = [
    ...Object.keys(POOL_CROPS).map((cropId) => ({ cropId, group: "pool" as const })),
    ...GREEN_MANURES.map((g) => ({ cropId: g.cropId, group: "green_manure" as const })),
  ];
  const known = new Set(ids.map((i) => i.cropId));
  for (const cropId of recorded) if (!known.has(cropId)) ids.push({ cropId, group: "recorded" });

  const rows = ids.map(({ cropId, group }): LibraryRow => {
    const chips: LibraryChip[] = [];
    if (growing.has(cropId)) chips.push({ kind: "growing", text: "Growing now" });
    const years = saved.get(cropId);
    if (years) chips.push({ kind: "saved", text: `Saved season ${[...years].sort().join(", ")}` });
    if (input.planCropIds?.has(cropId)) chips.push({ kind: "plan", text: "In your year plan" });
    const rank = input.fitRanks?.get(cropId);
    if (rank !== undefined) chips.push({ kind: "fit", text: `Crop fit rank ${rank}` });
    if (!chips.length && recorded.has(cropId)) chips.push({ kind: "recorded", text: "On your farm record" });
    const gm = GREEN_MANURES.find((g) => g.cropId === cropId);
    return {
      cropId,
      name: gm ? `${gm.name} (green manure)` : recordedName.get(cropId) ?? nameOf(cropId),
      group,
      note: group === "green_manure" ? "Green manure, grown to be ploughed in" : group === "recorded" ? "Recorded on this farm" : isLegume(cropId) ? ROLE_LABEL.nitrogen_fixer : ROLE_LABEL[POOL_CROPS[cropId]!.role],
      productIds: POOL_CROPS[cropId]?.productIds ?? [],
      chips,
    };
  });
  const priority = (r: LibraryRow) => (r.chips.some((c) => c.kind === "growing") ? 0 : r.chips.some((c) => c.kind === "saved" || c.kind === "plan") ? 1 : r.chips.some((c) => c.kind === "fit") ? 2 : r.group === "pool" ? 3 : r.group === "recorded" ? 3 : 4);
  const fit = (r: LibraryRow) => input.fitRanks?.get(r.cropId) ?? 999;
  return rows.sort((a, b) => priority(a) - priority(b) || fit(a) - fit(b) || a.name.localeCompare(b.name));
}
