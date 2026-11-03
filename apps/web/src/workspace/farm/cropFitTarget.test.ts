import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHOOSE_FIELD_TO_RANK, cropFitTarget } from "./cropFitTarget";

/**
 * Review fix: the crop catalogue's chips never ask for a whole-farm crop fit or year plan on a farm with fields (each can
 * enqueue a Meta job and the server answers a farm-wide request with field_required or a farm-wide review).
 */
const cycle = (id: string, fieldId: string | undefined, stage = "growing") => ({ id, cropId: "maize", sowingDate: "2026-07-01", stage, ...(fieldId ? { fieldId } : {}) });
const ws = (fields: string[], cycles: ReturnType<typeof cycle>[], farmId = "farm") => ({ farmId, fields: fields.map((id) => ({ id })), cycles });

describe("cropFitTarget", () => {
  it("waits until the farm's own workspace is known (whether it has fields is not known before)", () => {
    expect(cropFitTarget(undefined, undefined, null)).toEqual({ status: "wait" });
    expect(cropFitTarget("farm", undefined, null)).toEqual({ status: "wait" });
    expect(cropFitTarget("farm", ws(["a"], [], "other-farm"), null)).toEqual({ status: "wait" });
  });
  it("a farm without fields ranks the whole farm", () => {
    expect(cropFitTarget("farm", ws([], []), null)).toEqual({ status: "rank", fieldId: null });
    expect(cropFitTarget("farm", { farmId: "farm", cycles: [] }, "ignored")).toEqual({ status: "rank", fieldId: null });
  });
  it("uses the selected field when the farm has it", () => {
    expect(cropFitTarget("farm", ws(["a", "b"], [cycle("c", "a")]), "b")).toEqual({ status: "rank", fieldId: "b" });
  });
  it("without a usable selection takes the first field with a current crop", () => {
    const w = ws(["a", "b", "c"], [cycle("x", "b"), cycle("y", "c"), cycle("old", "a", "harvested")]);
    expect(cropFitTarget("farm", w, null)).toEqual({ status: "rank", fieldId: "b" });
    expect(cropFitTarget("farm", w, "gone")).toEqual({ status: "rank", fieldId: "b" });
  });
  it("a legacy whole-farm cycle counts as a current crop of the first field", () => {
    expect(cropFitTarget("farm", ws(["a", "b"], [cycle("old", undefined)]), null)).toEqual({ status: "rank", fieldId: "a" });
  });
  it("a farm with fields and no field to choose skips the call: choose", () => {
    expect(cropFitTarget("farm", ws(["a", "b"], []), null)).toEqual({ status: "choose" });
    expect(cropFitTarget("farm", ws(["a"], [cycle("old", "a", "harvested")]), undefined)).toEqual({ status: "choose" });
  });
  it("the catalogue only requests through the target: both calls carry its field, and the skip line is the agreed text", () => {
    const source = readFileSync(new URL("../CommodityCatalogue.tsx", import.meta.url), "utf8");
    expect(source).toContain("{ signal: lazy.signal, fieldId: field || null }");
    expect(source).toMatch(/loadCropFit\(farmId, null, \{ signal: lazy\.signal, fieldId \}\)/);
    expect(source).toMatch(/pollCropFit\(farmId, null, review, \{ signal: lazy\.signal, maxPolls: 20, fieldId \}\)/);
    expect(source).toContain("createResource(\n    rankKey,");
    expect(CHOOSE_FIELD_TO_RANK).toBe("Choose a field to rank crops");
  });
});
