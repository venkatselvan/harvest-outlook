import type { CropSummary } from "../features/comparison/types";

/**
 * The rotation crop pool shared by the Year plan editor and the planting dialog. One mirror of
 * data/research/rotation/crop-pool.json (orchestrator decision 2026-11-01); `cropPool.test.ts` and
 * `year/year-plan.test.tsx` fail if it drifts from the JSON. Proposed contract change: expose the pool and each crop's
 * rotation role from the API so the server is the single source.
 */
export type RotationRole = "nitrogen_fixer" | "light_feeder" | "moderate_feeder" | "heavy_feeder";

export const POOL_CROPS: Readonly<Record<string, { role: RotationRole; productIds: readonly string[] }>> = {
  paddy: { role: "moderate_feeder", productIds: ["paddy-grain"] },
  maize: { role: "heavy_feeder", productIds: ["maize-grain"] },
  "finger-millet": { role: "light_feeder", productIds: ["finger-millet-grain"] },
  sorghum: { role: "moderate_feeder", productIds: ["sorghum-grain"] },
  groundnut: { role: "nitrogen_fixer", productIds: ["groundnut-pod"] },
  soybean: { role: "nitrogen_fixer", productIds: ["soybean-seed"] },
  chickpea: { role: "nitrogen_fixer", productIds: ["chickpea-whole"] },
  "green-gram": { role: "nitrogen_fixer", productIds: ["green-gram-whole"] },
  "black-gram": { role: "nitrogen_fixer", productIds: ["black-gram-whole"] },
  "pigeon-pea": { role: "nitrogen_fixer", productIds: ["pigeon-pea-whole"] },
  sesame: { role: "light_feeder", productIds: ["sesame-seed"] },
  sunflower: { role: "heavy_feeder", productIds: ["sunflower-seed"] },
  cotton: { role: "heavy_feeder", productIds: ["cotton-kapas"] },
  potato: { role: "heavy_feeder", productIds: ["potato-fresh"] },
  onion: { role: "moderate_feeder", productIds: ["onion-bulb"] },
  tomato: { role: "heavy_feeder", productIds: ["tomato-fresh"] },
  chilli: { role: "moderate_feeder", productIds: ["chilli-green", "chilli-dry"] },
  ginger: { role: "moderate_feeder", productIds: ["ginger-fresh", "ginger-dry"] },
  turmeric: { role: "heavy_feeder", productIds: ["turmeric-fresh", "turmeric-dry"] },
};

export type RoleGroup = RotationRole | "other";
export const ROLE_ORDER: readonly RoleGroup[] = ["nitrogen_fixer", "light_feeder", "moderate_feeder", "heavy_feeder", "other"];
export const ROLE_LABEL: Record<RoleGroup, string> = {
  nitrogen_fixer: "Legumes, add nitrogen",
  light_feeder: "Light feeders",
  moderate_feeder: "Moderate feeders",
  heavy_feeder: "Heavy feeders",
  other: "Other crops in this plan",
};
export const isLegume = (cropId: string) => POOL_CROPS[cropId]?.role === "nitrogen_fixer";

/** Methods offered for crops without a reviewed care schedule; the API accepts the same three (GENERAL_ESTABLISHMENT_METHODS). */
export const GENERAL_ESTABLISHMENT_METHODS: readonly string[] = ["direct_sowing", "transplanting", "planting"];

/** One crop in the planting dialog. `careSchedule` is true only when the crop has a reviewed focused care schedule. */
export interface PlantChoice {
  cropId: string;
  name: string;
  role: RoleGroup;
  legume: boolean;
  careSchedule: boolean;
  methods: string[];
  products: { productId: string; name: string }[];
  /** Source-coverage notes from the focused catalogue; empty for crops without a reviewed care schedule. */
  limitations: string[];
}

interface FocusedLike {
  cropId: string;
  displayName: string;
  establishmentMethods: readonly string[];
  products: readonly { productId: string; productName: string }[];
  limitations: readonly string[];
}
interface RecordedLike {
  cropId: string;
  cropName?: string | null | undefined;
  productId?: string | null | undefined;
}

const titleCase = (id: string) => id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/**
 * Crops the farmer can record as planted: every rotation-pool crop, each crop that has a reviewed care schedule but
 * sits outside the pool, and any crop already recorded on the farm. Pool crops list every harvest form in the pool
 * table plus any extra form the focused catalogue names, so multi-product crops (chilli, ginger, turmeric) offer the
 * product choice. Establishment methods come from the focused care catalogue when the crop has one, otherwise the
 * general list. Names come from the focused catalogue, then the crop catalogue, then the id.
 */
export function plantCropChoices(input: {
  focused?: readonly FocusedLike[] | undefined;
  catalogue?: readonly CropSummary[] | undefined;
  recorded?: readonly RecordedLike[] | undefined;
}): PlantChoice[] {
  const focused = new Map((input.focused ?? []).map((c) => [c.cropId, c]));
  const catalogue = new Map((input.catalogue ?? []).map((c) => [c.cropId, c]));
  const recorded = new Map<string, RecordedLike>();
  for (const entry of input.recorded ?? []) if (!recorded.has(entry.cropId)) recorded.set(entry.cropId, entry);

  const build = (cropId: string, poolProducts: readonly string[]): PlantChoice => {
    const care = focused.get(cropId);
    const listed = catalogue.get(cropId);
    const note = recorded.get(cropId);
    const names = new Map<string, string>();
    for (const p of listed?.products ?? []) names.set(p.productId, p.name);
    for (const p of care?.products ?? []) names.set(p.productId, p.productName);
    const ids = [...poolProducts, ...(care?.products ?? []).map((p) => p.productId), ...(listed && !poolProducts.length && !care ? listed.products.map((p) => p.productId) : [])];
    if (note?.productId) ids.push(note.productId);
    const role = POOL_CROPS[cropId]?.role ?? "other";
    return {
      cropId,
      name: care?.displayName ?? listed?.name ?? note?.cropName ?? titleCase(cropId),
      role,
      legume: role === "nitrogen_fixer",
      careSchedule: !!care,
      methods: care ? [...care.establishmentMethods] : [...GENERAL_ESTABLISHMENT_METHODS],
      limitations: care ? [...care.limitations] : [],
      products: [...new Set(ids)].map((productId) => ({ productId, name: names.get(productId) ?? productId })),
    };
  };

  const choices = new Map<string, PlantChoice>();
  for (const [cropId, pool] of Object.entries(POOL_CROPS)) choices.set(cropId, build(cropId, pool.productIds));
  for (const cropId of [...focused.keys(), ...recorded.keys()]) if (!choices.has(cropId)) choices.set(cropId, build(cropId, []));
  return [...choices.values()].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
}

/** The dialog's groups in rotation-role order; empty groups are dropped. */
export function plantGroups(choices: readonly PlantChoice[]): { role: RoleGroup; crops: PlantChoice[] }[] {
  return ROLE_ORDER.map((role) => ({ role, crops: choices.filter((c) => c.role === role) })).filter((g) => g.crops.length);
}
