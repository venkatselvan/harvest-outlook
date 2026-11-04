import { describe, expect, it } from "vitest";
import { boundaryDraft, commitBoundaryDraft, undoBoundaryDraft } from "./boundaryEditorModel";

describe("local boundary edit history", () => {
  it("undoes a moved corner without losing the rest of an existing outline", () => {
    const original = [[0, 0], [5, 0], [5, 5], [0, 5]];
    const initial = boundaryDraft(original);
    const moved = commitBoundaryDraft(initial, [[1, 1], ...initial.points.slice(1)]);
    expect(moved.points).toEqual([[1, 1], [5, 0], [5, 5], [0, 5]]);
    expect(undoBoundaryDraft(moved).points).toEqual(original);
    expect(initial.points).toEqual(original);
  });
  it("undoes a misclicked new point, a corrected position, and Clear in order", () => {
    const first = commitBoundaryDraft(boundaryDraft<number>(), [1]);
    const misclick = commitBoundaryDraft(first, [1, 99]);
    const corrected = commitBoundaryDraft(misclick, [1, 2]);
    const cleared = commitBoundaryDraft(corrected, []);
    expect(undoBoundaryDraft(cleared).points).toEqual([1, 2]);
    expect(undoBoundaryDraft(corrected).points).toEqual([1, 99]);
    expect(undoBoundaryDraft(misclick).points).toEqual([1]);
    expect(undoBoundaryDraft(first).points).toEqual([]);
  });
  it("a fresh editing session cannot undo into another boundary", () => {
    const old = commitBoundaryDraft(boundaryDraft(["farm A"]), ["edited A"]);
    const next = boundaryDraft(["field B"]);
    expect(old.history).toHaveLength(1);
    expect(undoBoundaryDraft(next)).toBe(next);
    expect(next.points).toEqual(["field B"]);
  });
});
