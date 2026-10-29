import { describe, expect, it } from "vitest";
import { computeStageBlend, dapBetween, type StageWindow } from "./blend";

// Windows in days after planting. SYNTHETIC numbers chosen to exercise boundaries; not agronomic values.
const W: StageWindow[] = [
  { stageId: "a", startDap: 0, endDap: 90 },
  { stageId: "b", startDap: 90, endDap: 135 },
  { stageId: "c", startDap: 135, endDap: 180 },
  { stageId: "d", startDap: 180, endDap: 210 },
  { stageId: "e", startDap: 210, endDap: 210 }, // point-like final stage
];

describe("computeStageBlend", () => {
  it("shows only the base photo before the first stage, and nothing without windows", () => {
    expect(computeStageBlend(-5, W)).toEqual({ fromStageId: null, toStageId: "a", t: 0 });
    expect(computeStageBlend(0, [])).toEqual({ fromStageId: null, toStageId: null, t: 0 });
    expect(computeStageBlend(Number.NaN, W).fromStageId).toBeNull();
  });

  it("is a pure stage inside a window away from boundaries", () => {
    expect(computeStageBlend(0, W)).toEqual({ fromStageId: "a", toStageId: "a", t: 0 });
    expect(computeStageBlend(50, W)).toEqual({ fromStageId: "a", toStageId: "a", t: 0 });
    expect(computeStageBlend(110, W)).toEqual({ fromStageId: "b", toStageId: "b", t: 0 });
  });

  it("cross-fades across a boundary: starts at 0, is 0.5 on the boundary, and is complete after the span", () => {
    expect(computeStageBlend(82.9, W)).toEqual({ fromStageId: "a", toStageId: "a", t: 0 });
    expect(computeStageBlend(83, W)).toEqual({ fromStageId: "a", toStageId: "b", t: 0 });
    expect(computeStageBlend(90, W)).toEqual({ fromStageId: "a", toStageId: "b", t: 0.5 });
    expect(computeStageBlend(96.99, W).t).toBeGreaterThan(0.99);
    expect(computeStageBlend(97, W)).toEqual({ fromStageId: "b", toStageId: "b", t: 0 });
  });

  it("is monotonic and bounded across the whole season with no gaps in coverage", () => {
    let prevIndex = -1;
    for (let d = -3; d <= 260; d += 0.5) {
      const r = computeStageBlend(d, W);
      expect(r.t).toBeGreaterThanOrEqual(0);
      expect(r.t).toBeLessThanOrEqual(1);
      if (r.fromStageId && r.toStageId) {
        const i = "abcde".indexOf(r.toStageId);
        expect(i).toBeGreaterThanOrEqual(prevIndex);
        prevIndex = i;
      }
    }
    expect(computeStageBlend(260, W)).toEqual({ fromStageId: "e", toStageId: "e", t: 0 });
  });

  it("shortens the fade for short stages so it never reaches into a third stage", () => {
    const short: StageWindow[] = [
      { stageId: "x", startDap: 0, endDap: 4 },
      { stageId: "y", startDap: 4, endDap: 8 },
      { stageId: "z", startDap: 8, endDap: 100 },
    ];
    expect(computeStageBlend(2, short)).toEqual({ fromStageId: "x", toStageId: "y", t: 0 }); // half-span = 2
    expect(computeStageBlend(4, short).t).toBe(0.5);
    expect(computeStageBlend(6, short)).toEqual({ fromStageId: "y", toStageId: "z", t: 0 });
  });

  it("switches instantly when both adjacent stages have zero length", () => {
    const zero: StageWindow[] = [
      { stageId: "p", startDap: 0, endDap: 0 },
      { stageId: "q", startDap: 0, endDap: 0 },
    ];
    expect(computeStageBlend(0, zero)).toEqual({ fromStageId: "q", toStageId: "q", t: 0 });
  });

  it("splits a gap between windows at its midpoint and ignores input order", () => {
    const gap: StageWindow[] = [
      { stageId: "g2", startDap: 60, endDap: 100 },
      { stageId: "g1", startDap: 0, endDap: 40 },
    ];
    expect(computeStageBlend(50, gap).t).toBe(0.5);
    expect(computeStageBlend(50, gap).fromStageId).toBe("g1");
    expect(computeStageBlend(30, gap)).toEqual({ fromStageId: "g1", toStageId: "g1", t: 0 });
  });

  it("dapBetween counts whole days across month ends and leap years", () => {
    expect(dapBetween("2026-05-15", "2026-05-15")).toBe(0);
    expect(dapBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(dapBetween("2026-05-15", "2026-08-13")).toBe(90);
    expect(dapBetween("2026-05-15", "2026-05-10")).toBe(-5);
  });
});
