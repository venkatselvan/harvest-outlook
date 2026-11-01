import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import type { PricedCommodity } from "@harvest/contracts";
import type { CompareItem } from "../../features/comparison/types";
import { POOL_CROPS } from "../cropPool";
import { CropsForYourFarm } from "./CropFitCrops";
import { GREEN_MANURES, farmCropRows } from "./cropFitLibrary";

/**
 * Crop library default view "Crops for your farm" (ROUND3_SPEC.md 5.1): which crops are listed, which chips they carry
 * from the farm's own records, the year plan and crop fit, and what each row does. Fixtures are SYNTHETIC.
 */
const pool = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../data/research/rotation/crop-pool.json", import.meta.url)), "utf8")) as { greenManure: { cropId: string }[] };
const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const row = (rows: ReturnType<typeof farmCropRows>, id: string) => rows.find((r) => r.cropId === id)!;

describe("crops for your farm (model)", () => {
  it("lists the pool crops, the green manures and any crop recorded on the farm, and the green manures match crop-pool.json", () => {
    expect(GREEN_MANURES.map((g) => g.cropId)).toEqual(pool.greenManure.map((g) => g.cropId));
    const rows = farmCropRows({ cycles: [{ cropId: "banana", cropName: "Banana", stage: "growing" }], rotationPlans: [{ cropId: "mango", year: 2027 }], previousHarvest: { status: "known", cropId: "ragi", cropName: "Ragi", harvestDate: "2026-09-01" } });
    expect(rows.map((r) => r.cropId).sort()).toEqual([...Object.keys(POOL_CROPS), ...GREEN_MANURES.map((g) => g.cropId), "banana", "mango", "ragi"].sort());
    expect(row(rows, "banana")).toMatchObject({ group: "recorded", name: "Banana" });
    expect(row(rows, "gm-cowpea")).toMatchObject({ group: "green_manure", name: "Cowpea (green manure)" });
    expect(row(rows, "ragi").chips.map((c) => c.text)).toEqual(["On your farm record"]);
    expect(row(rows, "maize").chips).toEqual([]);
  });
  it("adds Growing now, Saved season, In your year plan and Crop fit rank from the records, plan and review", () => {
    const rows = farmCropRows({
      cycles: [{ cropId: "paddy", stage: "growing" }, { cropId: "maize", stage: "harvested" }],
      rotationPlans: [{ cropId: "pigeon-pea", year: 2027 }, { cropId: "pigeon-pea", year: 2026 }],
      planCropIds: new Set(["pigeon-pea", "sorghum"]),
      fitRanks: new Map([["sorghum", 2], ["pigeon-pea", 1]]),
    });
    expect(row(rows, "paddy").chips.map((c) => c.text)).toEqual(["Growing now"]);
    expect(row(rows, "maize").chips.map((c) => c.text)).toEqual(["On your farm record"]);
    expect(row(rows, "pigeon-pea").chips.map((c) => c.text)).toEqual(["Saved season 2026, 2027", "In your year plan", "Crop fit rank 1"]);
    expect(row(rows, "sorghum").chips.map((c) => c.text)).toEqual(["In your year plan", "Crop fit rank 2"]);
    // Growing first, then crops with a plan or saved season, then crop fit ranks, then the rest.
    expect(rows.slice(0, 3).map((r) => r.cropId)).toEqual(["paddy", "pigeon-pea", "sorghum"]);
  });
  it("leaves the plan and rank chips off while those reviews are not ready", () => {
    const rows = farmCropRows({ planCropIds: undefined, fitRanks: undefined });
    expect(rows.flatMap((r) => r.chips)).toEqual([]);
  });
});

describe("crops for your farm (rendered)", () => {
  const entry = (cropId: string) => ({ cropId, productId: `${cropId}-x`, sourceCommodity: cropId }) as unknown as PricedCommodity;
  it("shows chips, the Profile link only when the inventory has the crop, and a plain row otherwise", () => {
    const rows = farmCropRows({ cycles: [{ cropId: "paddy", stage: "growing" }], fitRanks: new Map([["paddy", 3]]) }).filter((r) => ["paddy", "gm-cowpea"].includes(r.cropId));
    const html = renderToString(() => <CropsForYourFarm rows={rows} entryFor={(r) => (r.cropId === "paddy" ? entry("paddy") : undefined)} onProfile={noop} />);
    const t = text(html);
    expect(t).toContain("Growing now");
    expect(t).toContain("Crop fit rank 3");
    expect(t).toContain("Cowpea (green manure)");
    expect((html.match(/commodity-profile-button/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-label="Open Paddy profile"');
    // The green manure has no inventory entry: a non-interactive row, not a dead button.
    expect((html.match(/<button/g) ?? []).length).toBe(2);
  });
  it("in the Compare browser the row shows the selection and toggles the crop's comparison item", () => {
    const rows = farmCropRows({}).filter((r) => r.cropId === "maize");
    const item = { cropId: "maize", productId: "maize-grain", cropName: "Maize", productName: "Grain" } as unknown as CompareItem;
    const html = renderToString(() => <CropsForYourFarm rows={rows} compareItem={() => item} selected={["maize-grain"]} onToggle={noop} />);
    expect(html).toContain("crop-checkbox");
    expect(html).toContain("commodity-inventory-row selected");
    expect(renderToString(() => <CropsForYourFarm rows={rows} compareItem={() => item} selected={[]} onToggle={noop} />)).not.toContain("commodity-inventory-row selected");
  });
  it("says so when a search matches no crop", () => {
    expect(text(renderToString(() => <CropsForYourFarm rows={[]} />))).toContain("No crop matches this search.");
  });
});
