import { describe, expect, it } from "vitest";
import { MAX_TREND_PRODUCTS, trendProductIds } from "./market-trends";

const catalogue = [
  { cropId: "ginger", products: [{ productId: "ginger-fresh" }, { productId: "ginger-dry" }] },
  { cropId: "maize", products: [{ productId: "maize-grain" }] },
];

describe("trendProductIds", () => {
  it("puts current cycles before saved seasons and removes duplicates", () => {
    expect(
      trendProductIds({
        cycles: [{ cropId: "maize", productId: "maize-grain" }],
        savedSeasons: [
          { cropId: "ginger", productId: "ginger-fresh" },
          { cropId: "maize", productId: "maize-grain" },
        ],
        catalogue,
        quotedProductIds: ["wheat-grain"],
      }),
    ).toEqual(["maize-grain", "ginger-fresh"]);
  });
  it("expands a crop saved without a product form to the catalogue's product forms, never guessing one", () => {
    expect(
      trendProductIds({ cycles: [{ cropId: "ginger" }], savedSeasons: [], catalogue, quotedProductIds: [] }),
    ).toEqual(["ginger-fresh", "ginger-dry"]);
    expect(
      trendProductIds({ cycles: [{ cropId: "ginger" }], savedSeasons: [], catalogue: undefined, quotedProductIds: ["maize-grain"] }),
    ).toEqual(["maize-grain"]);
  });
  it("falls back to the first three quoted products only when the farm has no crop on record, and caps a long list", () => {
    expect(
      trendProductIds({ cycles: [], savedSeasons: [], catalogue, quotedProductIds: ["a", "b", "c", "d"] }),
    ).toEqual(["a", "b", "c"]);
    const many = Array.from({ length: 10 }, (_, i) => ({ cropId: `c${i}`, productId: `p${i}` }));
    expect(trendProductIds({ cycles: many, savedSeasons: [], catalogue, quotedProductIds: [] })).toHaveLength(
      MAX_TREND_PRODUCTS,
    );
  });
});
