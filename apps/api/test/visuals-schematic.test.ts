import { describe, expect, it } from "vitest";
import { SCHEMATIC } from "../src/visuals/schematic";
import { SCHEMATIC_LABEL as WEB_SCHEMATIC, ILLUSTRATIVE_LABEL as WEB_ILLUSTRATIVE, QA_FLAG_LABEL as WEB_QA } from "../../web/src/features/season-scene/labels";
import { schematicParams } from "../../web/src/features/season-scene/schematic";
import { ILLUSTRATIVE_LABEL, QA_FLAG_LABEL, SCHEMATIC_LABEL } from "../src/visuals/labels";

describe("server and web visual contracts stay in step", () => {
  it("labels are identical so the API-provided label and the on-canvas label never disagree", () => {
    expect([WEB_SCHEMATIC, WEB_ILLUSTRATIVE, WEB_QA]).toEqual([SCHEMATIC_LABEL, ILLUSTRATIVE_LABEL, QA_FLAG_LABEL]);
    expect(SCHEMATIC.label).toBe(SCHEMATIC_LABEL);
  });
  it("schematic stem counts match the web renderer for every stage of a five-stage plan", () => {
    for (let i = 0; i < 5; i++) expect(SCHEMATIC.stemsForStage(i, 5)).toBe(schematicParams(i, 5).stems);
  });
});
