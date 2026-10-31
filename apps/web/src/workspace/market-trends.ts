export interface TrackedSeason {
  cropId: string;
  productId?: string | undefined;
}

/** Most products charted for one farm; a farm with many recorded crops still gets a short, readable list. */
export const MAX_TREND_PRODUCTS = 6;
/** Products charted when the farm has no crop on record: the ones the current mandi quotes cover. */
export const QUOTED_TREND_PRODUCTS = 3;

/**
 * Products to chart on the Market tab. The farm's own crops come first (current cycles, then saved seasons); a crop
 * recorded without a product form stands for every product form the catalogue lists for it. With no crop on record the
 * products behind the current mandi quotes are used instead. Duplicates are removed, order is kept.
 */
export function trendProductIds(input: {
  cycles: readonly TrackedSeason[];
  savedSeasons: readonly TrackedSeason[];
  catalogue: readonly { cropId: string; products: readonly { productId: string }[] }[] | undefined;
  quotedProductIds: readonly string[];
  limit?: number;
}): string[] {
  const own = [...input.cycles, ...input.savedSeasons].flatMap((season) =>
    season.productId
      ? [season.productId]
      : (input.catalogue?.find((crop) => crop.cropId === season.cropId)?.products.map((p) => p.productId) ?? []),
  );
  const chosen = own.length ? own : input.quotedProductIds.slice(0, QUOTED_TREND_PRODUCTS);
  return [...new Set(chosen)].slice(0, input.limit ?? MAX_TREND_PRODUCTS);
}
