import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BriefError, buildBrief, GINGER_DESCRIPTORS, loadBriefs, validateBrief, type StageDescriptor } from "../src/visuals/brief";

const CUR = resolve(__dirname, "../../../data/curated");
const stages = JSON.parse(readFileSync(resolve(CUR, "stages/ginger.hassan-kharif.stages.json"), "utf8"));
const evidence = JSON.parse(readFileSync(resolve(CUR, "evidence/ginger.hassan.evidence.json"), "utf8"));
const build = (descriptors: StageDescriptor[] = GINGER_DESCRIPTORS) => buildBrief({ cropId: "ginger", scopeId: "IN-KA-hassan", stages, evidence, descriptors });

describe("visual brief", () => {
  it("covers all five ginger stages, each citing evidence the stage carries, with no digit in any prompt", () => {
    const b = build();
    expect(b.stages.map((s) => s.stageId)).toEqual(stages.map((s: { stageId: string }) => s.stageId));
    for (const s of b.stages) {
      const def = stages.find((d: { stageId: string }) => d.stageId === s.stageId);
      expect(s.evidenceIds.length).toBeGreaterThan(0);
      for (const id of s.evidenceIds) expect(def.evidenceIds).toContain(id);
      expect(s.promptTemplate).not.toMatch(/\d/);
      expect(s.promptTemplate).toContain("Keep the same field, camera angle, lighting and background");
      expect(s.promptTemplate).toMatch(/no text.*no labels.*no prices, dates.*no rain/s);
      expect(s.evidenceExcerpts.every((e) => e.text.length > 0)).toBe(true);
    }
  });

  it("rejects a descriptor with a numeric claim, one citing evidence the stage lacks, and one without evidence", () => {
    const d = GINGER_DESCRIPTORS[0]!;
    expect(() => build([{ ...d, descriptor: "ginger 30 cm tall" }])).toThrow(BriefError);
    expect(() => build([{ ...d, evidenceIds: ["ev.ginger.iisr2025.p25.harvest-indicator-dry"] }])).toThrow(/does not cite/);
    expect(() => build([{ ...d, evidenceIds: [] }])).toThrow(/cites no evidence/);
  });

  it("the committed brief file matches a fresh build and a tampered copy is rejected", async () => {
    const onDisk = JSON.parse(readFileSync(resolve(CUR, "visual-briefs/ginger.hassan.brief.json"), "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(build())));
    const loaded = await loadBriefs();
    expect(loaded.get("ginger")?.briefHash).toBe(onDisk.briefHash);
    const tampered = structuredClone(onDisk);
    tampered.stages[0].promptTemplate += " Show 90 plants.";
    expect(() => validateBrief(tampered)).toThrow(BriefError);
  });
});
