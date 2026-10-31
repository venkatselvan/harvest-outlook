import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GENERAL_ESTABLISHMENT_METHODS, plantCropChoices, plantGroups } from "./cropPool";

const poolJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../data/research/rotation/crop-pool.json", import.meta.url)), "utf8"),
) as { pool: { cropId: string; productIds: string[]; rotationRole: string }[] };

describe("planting dialog crop list", () => {
  it("lists exactly the pool crops from crop-pool.json with their roles and product forms, with no focused data loaded", () => {
    const choices = plantCropChoices({});
    expect(choices.map((c) => c.cropId).sort()).toEqual(poolJson.pool.map((c) => c.cropId).sort());
    for (const entry of poolJson.pool) {
      const choice = choices.find((c) => c.cropId === entry.cropId)!;
      expect(choice.role, entry.cropId).toBe(entry.rotationRole);
      expect(choice.products.map((p) => p.productId), entry.cropId).toEqual(entry.productIds);
      expect(choice.methods).toEqual([...GENERAL_ESTABLISHMENT_METHODS]);
      expect(choice.careSchedule).toBe(false);
    }
    expect(choices.filter((c) => c.legume).map((c) => c.cropId).sort()).toEqual(
      poolJson.pool.filter((c) => c.rotationRole === "nitrogen_fixer").map((c) => c.cropId).sort(),
    );
    const multi = choices.filter((c) => c.products.length > 1).map((c) => c.cropId).sort();
    expect(multi).toEqual(["chilli", "ginger", "turmeric"]);
  });

  it("groups by rotation role with legumes first and drops empty groups", () => {
    const groups = plantGroups(plantCropChoices({}));
    expect(groups.map((g) => g.role)).toEqual(["nitrogen_fixer", "light_feeder", "moderate_feeder", "heavy_feeder"]);
    expect(groups[0]!.crops.map((c) => c.cropId)).toContain("groundnut");
  });

  it("keeps a focused crop's sourced methods and names and adds the pool's extra product forms", () => {
    const [chilli] = plantCropChoices({
      focused: [
        {
          cropId: "chilli",
          displayName: "Green chilli",
          establishmentMethods: ["transplanting"],
          products: [{ productId: "chilli-green", productName: "Green chilli (fresh)" }],
          limitations: ["Source covers Tamil Nadu only."],
        },
      ],
      catalogue: [
        { cropId: "chilli", name: "Chilli", products: [{ productId: "chilli-dry", name: "Chilli (dry red)", productBasis: "dry" }, { productId: "chilli-green", name: "Chilli green", productBasis: "fresh" }] },
      ],
    }).filter((c) => c.cropId === "chilli");
    expect(chilli).toMatchObject({ name: "Green chilli", careSchedule: true, methods: ["transplanting"], role: "moderate_feeder", limitations: ["Source covers Tamil Nadu only."] });
    expect(chilli!.products).toEqual([
      { productId: "chilli-green", name: "Green chilli (fresh)" },
      { productId: "chilli-dry", name: "Chilli (dry red)" },
    ]);
  });

  it("adds crops outside the pool only when they have a care schedule or are already recorded, without duplicating pool crops", () => {
    const choices = plantCropChoices({
      focused: [{ cropId: "wheat", displayName: "Wheat", establishmentMethods: ["direct_sowing"], products: [{ productId: "wheat-grain", productName: "Wheat grain" }], limitations: [] }],
      recorded: [
        { cropId: "banana", cropName: "Banana", productId: "banana-fresh" },
        { cropId: "groundnut", cropName: "Groundnut", productId: "groundnut-pod" },
        { cropId: "banana", cropName: "Banana", productId: "banana-fresh" },
      ],
    });
    expect(choices).toHaveLength(poolJson.pool.length + 2);
    expect(choices.filter((c) => c.cropId === "groundnut")).toHaveLength(1);
    expect(choices.filter((c) => c.role === "other").map((c) => c.cropId).sort()).toEqual(["banana", "wheat"]);
    expect(choices.find((c) => c.cropId === "banana")).toMatchObject({ methods: [...GENERAL_ESTABLISHMENT_METHODS], products: [{ productId: "banana-fresh", name: "banana-fresh" }] });
    expect(plantGroups(choices).at(-1)!.role).toBe("other");
  });
});
