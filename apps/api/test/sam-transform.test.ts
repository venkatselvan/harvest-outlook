import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpretSamText } from "../src/vision/sam/interpret";
import { qualityGate } from "../src/vision/sam/quality";
import { dropCollinear, largestComponent, maskToPolygon, traceOuterBoundary, type Pt } from "../src/vision/sam/raster";
import { boxToNormalizedPolygon, planSentImage, rasterToNormalized } from "../src/vision/sam/transform";
import { rectBits, record } from "./fixtures/sam/build";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/sam");
const opts = { base85Variant: "auto", base85Fallback: "rfc1924", bitOrder: "msb" } as const;
const area = (p: Pt[]) => Math.abs(p.reduce((s, [x, y], i) => s + (x * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * y), 0)) / 2;
const sorted = (p: Pt[]) => p.map((q) => q.join(",")).sort();

describe("mask raster to polygon", () => {
  it("40x30 rectangle gives exactly its four pixel-edge corners", () => {
    const r = maskToPolygon(rectBits(40, 30, 10, 5, 30, 25), 40, 30)!;
    expect(sorted(r.polygon)).toEqual(sorted([[10, 5], [30, 5], [30, 25], [10, 25]]));
    expect(r.areaFraction).toBeCloseTo(400 / 1200, 10);
  });
  it("keeps only the largest connected component", () => {
    const bits = rectBits(40, 30, 2, 2, 6, 6); // 16 px
    for (const [x, y] of [[20, 10], [21, 10], [20, 11], [21, 11], [22, 11]]) bits[y! * 40 + x!] = 1; // 5 px
    for (let y = 15; y < 25; y++) for (let x = 15; x < 35; x++) bits[y * 40 + x] = 1; // 200 px
    const c = largestComponent(bits, 40, 30)!;
    expect(c.size).toBe(200);
    expect(c.foreground).toBe(221);
    expect(sorted(maskToPolygon(bits, 40, 30)!.polygon)).toEqual(sorted([[15, 15], [35, 15], [35, 25], [15, 25]]));
  });
  it("traces an L shape and ignores interior holes (outer boundary only)", () => {
    const bits = rectBits(20, 20, 2, 2, 12, 12);
    for (let y = 2; y < 6; y++) for (let x = 6; x < 12; x++) bits[y * 20 + x] = 0; // notch
    const r = maskToPolygon(bits, 20, 20)!;
    expect(r.polygon).toHaveLength(6);
    expect(area(r.polygon)).toBe(100 - 24);
    const holed = rectBits(20, 20, 2, 2, 18, 18);
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) holed[y * 20 + x] = 0;
    expect(area(maskToPolygon(holed, 20, 20)!.polygon)).toBe(16 * 16);
  });
  it("terminates and joins diagonally touching pixels in one outline", () => {
    const bits = new Uint8Array(6 * 6);
    bits[1 * 6 + 1] = 1;
    bits[2 * 6 + 2] = 1;
    const ring = traceOuterBoundary(bits, 6, 6);
    expect(ring.length).toBeGreaterThanOrEqual(8);
    expect(area(dropCollinear(ring))).toBeGreaterThanOrEqual(2);
  });
  it("simplifies a circle to at most 64 points without drifting far from the true outline", () => {
    const W = 200;
    const bits = new Uint8Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if ((x - 100) ** 2 + (y - 100) ** 2 <= 80 ** 2) bits[y * W + x] = 1;
    const r = maskToPolygon(bits, W, W, 64)!;
    expect(r.polygon.length).toBeLessThanOrEqual(64);
    expect(r.polygon.length).toBeGreaterThan(12);
    expect(area(r.polygon)).toBeGreaterThan(Math.PI * 80 * 80 * 0.95);
    expect(area(r.polygon)).toBeLessThan(Math.PI * 80 * 80 * 1.03);
  });
  it("returns null for an empty raster", () => {
    expect(maskToPolygon(new Uint8Array(100), 10, 10)).toBeNull();
  });
});

describe("coordinate transforms after a known downscale", () => {
  // normalized derivative 1600x1200 -> sent 1024x768 (x0.64); mask raster 40x30
  const plan = planSentImage(1600, 1200, 1024);
  it("computes sent size and scale factors", () => {
    expect(plan).toMatchObject({ width: 1024, height: 768, scaleX: 0.64, scaleY: 0.64 });
    expect(planSentImage(600, 400, 1024)).toMatchObject({ width: 600, height: 400, scaleX: 1, scaleY: 1 });
    const p = planSentImage(1200, 1600, 1024);
    expect([p.width, p.height]).toEqual([768, 1024]);
  });
  it("maps the rectangle mask to the exact normalized coordinates", () => {
    const poly = maskToPolygon(rectBits(40, 30, 10, 5, 30, 25), 40, 30)!.polygon;
    const n = rasterToNormalized(poly, { width: 40, height: 30 }, { x: 0, y: 0 }, plan);
    expect(sorted(n.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]))).toEqual(sorted([[0.25, 5 / 30], [0.75, 5 / 30], [0.75, 25 / 30], [0.25, 25 / 30]].map(([x, y]) => [+x!.toFixed(6), +y!.toFixed(6)] as Pt)));
  });
  it("rejects a mask whose aspect differs from the image sent, or has an offset", () => {
    expect(() => rasterToNormalized([[0, 0]], { width: 40, height: 40 }, { x: 0, y: 0 }, plan)).toThrow(/aspect/);
    expect(() => rasterToNormalized([[0, 0]], { width: 40, height: 30 }, { x: 3, y: 0 }, plan)).toThrow(/offset/);
  });
  it("maps a box with inclusive x2/y2 to pixel edges", () => {
    const n = boxToNormalizedPolygon({ x1: 256, y1: 77, x2: 767, y2: 691, w: 1024, h: 768, confidence: null }, plan);
    expect(n[0]![0]).toBeCloseTo(0.25, 6);
    expect(n[1]![0]).toBeCloseTo(0.75, 6);
    expect(n[2]![1]).toBeCloseTo(692 / 768, 6);
  });
});

describe("quality gate", () => {
  const sq: Pt[] = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]];
  it("accepts a normal region", () => expect(qualityGate({ polygon: sq, areaFraction: 0.2 })).toEqual({ ok: true }));
  it("rejects empty, tiny, huge and degenerate regions", () => {
    expect(qualityGate({ polygon: null, areaFraction: 0 })).toEqual({ ok: false, reason: "empty_mask" });
    expect(qualityGate({ polygon: sq, areaFraction: 0.0199 })).toEqual({ ok: false, reason: "too_small" });
    expect(qualityGate({ polygon: sq, areaFraction: 0.9801 })).toEqual({ ok: false, reason: "too_large" });
    expect(qualityGate({ polygon: [[0, 0], [1, 1]], areaFraction: 0.5 })).toEqual({ ok: false, reason: "degenerate_polygon" });
    expect(qualityGate({ polygon: [[0, 0], [0.5, 0.5], [1, 1]], areaFraction: 0.5 })).toEqual({ ok: false, reason: "degenerate_polygon" });
  });
});

describe("interpretSamText end to end (SYNTHETIC fixtures, sent 160x120 -> derivative 640x480)", () => {
  const plan = planSentImage(640, 480, 160);
  it("ranks proposals by score, best first", () => {
    const r = interpretSamText(readFileSync(join(dir, "two-objects-rfc1924.txt"), "utf8"), plan, opts);
    expect(plan).toMatchObject({ width: 160, height: 120, scaleX: 0.25 });
    expect(r.objectCount).toBe(2);
    expect(r.proposals.map((p) => p.segmentationScore)).toEqual([0.9, 0.35]);
    expect(r.rejected).toEqual([]);
    expect(r.proposals[0]).toMatchObject({ source: "mask", segmentationScore: 0.9 });
    expect(sorted(r.proposals[0]!.polygon)).toEqual(sorted([[0.25, 0.166667], [0.75, 0.166667], [0.75, 0.833333], [0.25, 0.833333]]));
  });
  it("gates out a mask covering under 2% of the image", () => {
    const tiny = record({ id: 1, box: { x1: 0, y1: 0, x2: 11, y2: 11 }, mask: { bits: rectBits(40, 30, 0, 0, 3, 3), W: 40, H: 30, variant: "z85" } }, 160, 120);
    expect(interpretSamText(`<0f>${tiny}`, plan, opts)).toMatchObject({ proposals: [], rejected: [{ reason: "too_small" }] });
    const full = record({ id: 1, box: { x1: 0, y1: 0, x2: 159, y2: 119 }, mask: { bits: rectBits(40, 30, 0, 0, 40, 30), W: 40, H: 30, variant: "z85" } }, 160, 120);
    expect(interpretSamText(`<0f>${full}`, plan, opts).rejected).toEqual([{ reason: "too_large" }]);
    const empty = record({ id: 1, box: { x1: 0, y1: 0, x2: 11, y2: 11 }, mask: { bits: new Uint8Array(1200), W: 40, H: 30, variant: "z85" } }, 160, 120);
    expect(interpretSamText(`<0f>${empty}`, plan, opts).rejected).toEqual([{ reason: "empty_mask" }]);
  });
  it("auto alphabet detection is checked against the box, so an ambiguous payload is not decoded to garbage", () => {
    for (const variant of ["z85", "ascii85", "rfc1924"] as const) {
      const rec = record({ id: 1, box: { x1: 40, y1: 20, x2: 119, y2: 99 }, mask: { bits: rectBits(40, 30, 10, 5, 30, 25), W: 40, H: 30, variant } }, 160, 120);
      for (const fallback of ["rfc1924", "z85"] as const) {
        const r = interpretSamText(`<0f>${rec}`, plan, { ...opts, base85Fallback: fallback });
        expect(r.proposals[0]?.source, `${variant}/${fallback}`).toBe("mask");
        expect(sorted(r.proposals[0]!.polygon)).toEqual(sorted([[0.25, 0.166667], [0.75, 0.166667], [0.75, 0.833333], [0.25, 0.833333]]));
      }
    }
  });
  it("uses the box instead of a noisy mask decoded with the wrong explicit alphabet", () => {
    const rec = record({ id: 1, box: { x1: 40, y1: 20, x2: 119, y2: 99 }, mask: { bits: rectBits(40, 30, 10, 5, 30, 25), W: 40, H: 30, variant: "z85" } }, 160, 120);
    const r = interpretSamText(`<0f>${rec}`, plan, { ...opts, base85Variant: "rfc1924" });
    expect(r.proposals[0]?.source).toBe("box");
  });
  it("falls back to the box when the mask cannot be decoded", () => {
    const bad = `<0f>1<|box;x1=40;y1=20;x2=119;y2=99;w=160;h=120|><|mask;x=0;y=0;data=30,40,!abc|>`;
    const r = interpretSamText(bad, plan, opts);
    expect(r.proposals[0]).toMatchObject({ source: "box", segmentationScore: null });
    expect(r.warnings.join()).toMatch(/mask_unusable/);
  });
  it("rejects objects whose box w/h differ from the image that was sent", () => {
    const rec = record({ id: 1, box: { x1: 0, y1: 0, x2: 50, y2: 50 } }, 320, 240);
    expect(interpretSamText(`<0f>${rec}`, plan, opts)).toMatchObject({ proposals: [], rejected: [{ reason: "dimension_mismatch" }] });
  });
  it("zero matches gives no proposals and no rejections", () => {
    expect(interpretSamText("", plan, opts)).toMatchObject({ proposals: [], rejected: [], objectCount: 0 });
  });
  it("ignores negative-point echoes and non-zero frames", () => {
    const rec = record({ id: 1, box: { x1: 10, y1: 10, x2: 100, y2: 100 } }, 160, 120);
    const r = interpretSamText(`<2f>\n${rec}`, plan, opts);
    expect(r.proposals).toEqual([]);
    expect(r.warnings).toContain("unexpected_frames_ignored");
  });
});
