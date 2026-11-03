import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { PlansByField, plansByField } from "./PlansByField";

/**
 * Review fix: a legacy whole-farm cycle (no fieldId, not harvested) occupies every field. A field row must not say
 * "No crop" while that field's own plan shows the cycle growing.
 */
const FIELDS = [
  { id: "a", name: "North strip" },
  { id: "b", name: "South strip" },
];
const name = (id: string) => id.replace(/^\w/, (c) => c.toUpperCase());
const legacy = { id: "old", cropId: "ragi", cropName: "Ragi", sowingDate: "2026-07-01", stage: "growing" };
const own = { id: "own", cropId: "maize", cropName: "Maize", sowingDate: "2026-08-01", stage: "growing", fieldId: "a" };
const html = (rows: ReturnType<typeof plansByField>) => renderToString(() => <PlansByField rows={rows} onOpen={() => undefined} />).replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Plans by field with a legacy whole-farm cycle", () => {
  it("is the current crop of every field without a cycle of its own, labelled (whole farm)", () => {
    const rows = plansByField(FIELDS, [legacy], [], "2026-11-03", name);
    expect(rows.map((r) => [r.crop, r.cropId, r.wholeFarm])).toEqual([
      ["Ragi (whole farm)", "ragi", true],
      ["Ragi (whole farm)", "ragi", true],
    ]);
    expect(html(rows)).toContain("Now: Ragi (whole farm)");
    expect(html(rows)).not.toContain("No crop");
  });
  it("a field's own cycle wins over the whole-farm one, and only that field", () => {
    const rows = plansByField(FIELDS, [legacy, own], [], "2026-11-03", name);
    expect(rows[0]).toMatchObject({ crop: "Maize", cropId: "maize", wholeFarm: false });
    expect(rows[1]).toMatchObject({ crop: "Ragi (whole farm)", wholeFarm: true });
  });
  it("a harvested whole-farm cycle no longer counts, and with no cycle at all the row says No crop", () => {
    expect(plansByField(FIELDS, [{ ...legacy, stage: "harvested" }], [], "2026-11-03", name).map((r) => r.crop)).toEqual(["No crop", "No crop"]);
    expect(plansByField(FIELDS, [], [], "2026-11-03", name)[0]).toMatchObject({ crop: "No crop", cropId: null, wholeFarm: false });
  });
  it("with several unharvested whole-farm cycles the latest one is shown", () => {
    const newer = { ...legacy, id: "newer", cropId: "maize", cropName: "Maize", sowingDate: "2026-09-01" };
    expect(plansByField(FIELDS, [legacy, newer], [], "2026-11-03", name)[0]!.cropId).toBe("maize");
  });
});
