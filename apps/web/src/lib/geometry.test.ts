import { describe, expect, it } from "vitest";
import {
  addCentrePoint, addPoint, clientToNormalized, containBox, cornersRectangle, MAX_POINTS, moveHandle, normalizedToClient, polygonArea,
  sameAspect, selfIntersects, snapToDevice, validatePolygon, type MoveKey, type Pt, type Rect, type Size,
} from "./geometry";

const PORTRAIT: Size = { w: 1200, h: 1600 };
const LANDSCAPE: Size = { w: 1600, h: 1200 };

describe("containBox letterboxing", () => {
  it("pillarboxes a portrait image in a landscape stage and letterboxes landscape in portrait", () => {
    expect(containBox({ w: 400, h: 200 }, PORTRAIT)).toEqual({ x: 125, y: 0, w: 150, h: 200 });
    expect(containBox({ w: 200, h: 400 }, LANDSCAPE)).toEqual({ x: 0, y: 125, w: 200, h: 150 });
  });
  it("fills the stage when aspects match", () => {
    expect(containBox({ w: 360, h: 270 }, LANDSCAPE)).toEqual({ x: 0, y: 0, w: 360, h: 270 });
  });
  it("is empty for degenerate sizes", () => {
    expect(containBox({ w: 0, h: 100 }, LANDSCAPE).w).toBe(0);
  });
});

describe("client <-> normalized", () => {
  const stages: Rect[] = [
    { left: 10, top: 20, width: 360, height: 270 },
    { left: 0, top: 80.5, width: 360, height: 420 }, // portrait stage, landscape image: letterbox bars
    { left: 33.25, top: 5, width: 500, height: 300 }, // landscape stage, portrait image: side bars
  ];
  it("round-trips for portrait and landscape images in every stage shape", () => {
    for (const image of [PORTRAIT, LANDSCAPE]) {
      for (const stage of stages) {
        for (const p of [[0, 0], [1, 1], [0.5, 0.5], [0.123456, 0.87654], [1, 0]] as Pt[]) {
          const c = normalizedToClient(p, stage, image);
          const back = clientToNormalized(c, stage, image)!;
          expect(back[0]).toBeCloseTo(p[0], 9);
          expect(back[1]).toBeCloseTo(p[1], 9);
        }
      }
    }
  });
  it("maps the image corners to the content box, not to the stage corners, when letterboxed", () => {
    const stage: Rect = { left: 0, top: 0, width: 400, height: 200 };
    expect(normalizedToClient([0, 0], stage, PORTRAIT)).toEqual([125, 0]);
    expect(normalizedToClient([1, 1], stage, PORTRAIT)).toEqual([275, 200]);
    expect(clientToNormalized([200, 100], stage, PORTRAIT)).toEqual([0.5, 0.5]);
  });
  it("returns null for taps in the letterbox bars unless clamping", () => {
    const stage: Rect = { left: 0, top: 0, width: 400, height: 200 };
    expect(clientToNormalized([50, 100], stage, PORTRAIT)).toBeNull();
    expect(clientToNormalized([50, 100], stage, PORTRAIT, true)).toEqual([0, 0.5]);
  });
  it("keeps a stored polygon aligned across a resize (rotation) of the stage", () => {
    const poly: Pt[] = [[0.2, 0.3], [0.8, 0.3], [0.8, 0.9], [0.2, 0.9]];
    const before = poly.map((p) => normalizedToClient(p, { left: 0, top: 0, width: 360, height: 480 }, PORTRAIT));
    const after = poly.map((p) => normalizedToClient(p, { left: 0, top: 0, width: 720, height: 360 }, PORTRAIT));
    // same relative position inside the content box in both layouts
    const b1 = containBox({ w: 360, h: 480 }, PORTRAIT);
    const b2 = containBox({ w: 720, h: 360 }, PORTRAIT);
    before.forEach((c, i) => expect([(c[0] - b1.x) / b1.w, (c[1] - b1.y) / b1.h]).toEqual(poly[i]!.map((v) => expect.closeTo(v, 9))));
    after.forEach((c, i) => expect([(c[0] - b2.x) / b2.w, (c[1] - b2.y) / b2.h]).toEqual(poly[i]!.map((v) => expect.closeTo(v, 9))));
  });
  it("device pixel ratio does not change the mapping; snapping stays within half a device pixel", () => {
    const stage: Rect = { left: 0, top: 0, width: 360.4, height: 270.3 };
    const p: Pt = [0.333333, 0.777777];
    const css = normalizedToClient(p, stage, LANDSCAPE);
    for (const dpr of [1, 1.5, 2, 3]) {
      const snapped = css.map((v) => snapToDevice(v, dpr));
      snapped.forEach((v, i) => expect(Math.abs(v - css[i]!)).toBeLessThanOrEqual(0.5 / dpr + 1e-9));
      const back = clientToNormalized(snapped as Pt, stage, LANDSCAPE)!;
      expect(Math.abs(back[0] - p[0])).toBeLessThan(0.5 / dpr / 360);
    }
  });
  it("detects an image whose aspect does not match the stored dimensions", () => {
    expect(sameAspect({ w: 1600, h: 1200 }, { w: 1200, h: 1600 })).toBe(false);
    expect(sameAspect({ w: 1600, h: 1200 }, { w: 1599, h: 1200 })).toBe(true);
  });
});

describe("polygon validation", () => {
  const sq: Pt[] = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
  it("accepts a square and the four-corners rectangle", () => {
    expect(validatePolygon(sq)).toEqual({ ok: true, problems: [] });
    expect(validatePolygon(cornersRectangle()).ok).toBe(true);
    expect(polygonArea(sq)).toBeCloseTo(0.64, 9);
  });
  it("rejects too few, too many, out of range, flat and crossing outlines", () => {
    expect(validatePolygon([[0.1, 0.1], [0.5, 0.5]]).problems).toEqual(["too_few_points"]);
    const many = Array.from({ length: MAX_POINTS + 1 }, (_, i) => [0.5 + 0.4 * Math.cos(i), 0.5 + 0.4 * Math.sin(i)] as Pt);
    expect(validatePolygon(many).problems).toContain("too_many_points");
    expect(validatePolygon([[0, 0], [1, 0], [1.2, 1]]).problems).toEqual(["out_of_range"]);
    expect(validatePolygon([[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]]).problems).toEqual(["no_area"]);
    expect(validatePolygon([[0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]]).problems).toEqual(["self_intersecting"]);
    expect(validatePolygon([[Number.NaN, 0.1], [0.5, 0.5], [0.9, 0.2]]).problems).toContain("out_of_range");
  });
  it("selfIntersects ignores adjacent edges and accepts concave shapes", () => {
    const concave: Pt[] = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.5, 0.4], [0.1, 0.9]];
    expect(selfIntersects(concave)).toBe(false);
    expect(validatePolygon(concave).ok).toBe(true);
  });
});

describe("keyboard operations", () => {
  const sq = cornersRectangle(0.1);
  it("arrow keys move the active handle by 1% (0.2% with fine) and clamp at the image edge", () => {
    expect(moveHandle(sq, 0, "ArrowRight")![0]).toEqual([0.11, 0.1]);
    expect(moveHandle(sq, 0, "ArrowDown", true)![0]).toEqual([0.1, 0.102]);
    expect(moveHandle([[0.005, 0.5], [0.5, 0.5], [0.5, 0.9]], 0, "ArrowLeft")![0]).toEqual([0, 0.5]);
    expect(moveHandle([[0.5, 0.995], [0.5, 0.5], [0.2, 0.2]], 0, "ArrowDown")![0]).toEqual([0.5, 1]);
  });
  it("does not mutate its input and rejects a bad index", () => {
    const copy = JSON.stringify(sq);
    moveHandle(sq, 1, "ArrowUp");
    expect(JSON.stringify(sq)).toBe(copy);
    expect(moveHandle(sq, 9, "ArrowUp")).toBeNull();
  });
  it("Enter adds a point at the centre, nudging off an existing centre point, and stops at 64", () => {
    expect(addCentrePoint([])).toEqual([[0.5, 0.5]]);
    expect(addCentrePoint([[0.5, 0.5]])![1]).toEqual([0.53, 0.53]);
    expect(addCentrePoint(Array.from({ length: MAX_POINTS }, () => [0.1, 0.1] as Pt))).toBeNull();
    expect(addPoint(Array.from({ length: MAX_POINTS }, () => [0.1, 0.1] as Pt), [0.2, 0.2])).toBeNull();
  });
  it("a keyboard-only session can build a valid outline", () => {
    let p: Pt[] = [];
    const plan: [number, MoveKey, number][] = [];
    for (let i = 0; i < 4; i++) {
      p = addCentrePoint(p)!;
      const idx = p.length - 1;
      // each new point is moved to a different corner region with arrow presses
      const [dx, dy] = [[-1, -1], [1, -1], [1, 1], [-1, 1]][i]!;
      for (let k = 0; k < 30; k++) {
        p = moveHandle(p, idx, dx! < 0 ? "ArrowLeft" : "ArrowRight")!;
        p = moveHandle(p, idx, dy! < 0 ? "ArrowUp" : "ArrowDown")!;
      }
    }
    void plan;
    expect(validatePolygon(p)).toEqual({ ok: true, problems: [] });
  });
});
