import type { YearPlanReview } from "@harvest/contracts";

export interface SavedSeason {
  cropId: string;
  productId?: string | undefined;
}

/**
 * Crop products the compare drawer selects before the farmer chooses any: first the crops the current year plan
 * proposes (option order, then slot order; the field's current, fixed crop is skipped), then the farmer's saved
 * seasons. One product per crop, at most `limit`. A year plan that is still pending, unavailable or failed has no
 * options to offer, so only the saved seasons count. `cropIds` narrows the result to a crop collection.
 */
export function preselectProducts(input: {
  yearPlan: Pick<YearPlanReview, "status" | "options"> | undefined;
  savedSeasons: readonly SavedSeason[];
  cropIds?: readonly string[] | undefined;
  limit?: number;
}): string[] {
  const limit = input.limit ?? 3;
  const usable = input.yearPlan && ["ready", "partial"].includes(input.yearPlan.status);
  const candidates: SavedSeason[] = [
    ...(usable ? input.yearPlan!.options.flatMap((o) => o.slots.filter((s) => !s.fixed)) : []),
    ...input.savedSeasons,
  ];
  const crops = new Set<string>();
  const products: string[] = [];
  for (const c of candidates) {
    if (!c.productId || crops.has(c.cropId)) continue;
    if (input.cropIds && !input.cropIds.includes(c.cropId)) continue;
    crops.add(c.cropId);
    products.push(c.productId);
    if (products.length === limit) break;
  }
  return products;
}
