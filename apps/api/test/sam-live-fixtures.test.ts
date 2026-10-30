import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSamOutput, decodeMask, SamParseError } from "../src/vision/sam/parser";
import { SAM_MASK_ALPHABET, samMaskEnvelope, compatibleVariants } from "../src/vision/sam/base85";
import { interpretSamText } from "../src/vision/sam/interpret";
import { planSentImage } from "../src/vision/sam/transform";
import { DEFAULT_SAM_OPTIONS } from "../src/vision/sam/options";

// Raw sam-3.1 output recorded live on 2026-10-30 (task L4, scripts/smoke/sam-smoke.ts) on a synthetic image.
interface SamFixture {
  recordedFromLive: true;
  image: { width: number; height: number; groundTruthInclusive: Record<string, { x1: number; y1: number; x2: number; y2: number }> };
  outputText: string;
}
const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/meta/live/${n}`, import.meta.url), "utf8")) as SamFixture;
const conceptOneBit = load("sam-concept-one-bit.json");
const boxOneBit = load("sam-box-one-bit.json");
const lossless = load("sam-concept-lossless-default.json");
const plan = planSentImage(512, 384, 1024);
const opts = { base85Variant: DEFAULT_SAM_OPTIONS.base85Variant, base85Fallback: DEFAULT_SAM_OPTIONS.base85Fallback, bitOrder: DEFAULT_SAM_OPTIONS.bitOrder };

describe("SAM live fixtures (recordedFromLive)", () => {
  it("are marked as live recordings", () => {
    for (const f of [conceptOneBit, boxOneBit, lossless]) expect(f.recordedFromLive).toBe(true);
  });

  it("parses the real grammar: frame marker, box with c after h, mask with c between y and data", () => {
    const p = parseSamOutput(conceptOneBit.outputText);
    expect(p.warnings).toEqual([]);
    expect(p.frames).toHaveLength(1);
    const [red, blue] = p.frames[0]!.objects;
    const gt = conceptOneBit.image.groundTruthInclusive;
    expect(red!.box).toMatchObject({ ...gt.red, w: 512, h: 384 });
    expect(blue!.box).toMatchObject({ ...gt.blue, w: 512, h: 384 });
    expect(red!.box!.confidence).toBeGreaterThan(0);
    expect(red!.mask!.confidence).toBe(red!.box!.confidence);
    // The mask raster is box-local: H x W equals the box size, offset x=y=0.
    for (const o of [red!, blue!]) {
      expect(o.mask!.encoding).toBe("!");
      expect([o.mask!.x, o.mask!.y]).toEqual([0, 0]);
      expect(o.mask!.height).toBe(o.box!.y2 - o.box!.y1 + 1);
      expect(o.mask!.width).toBe(o.box!.x2 - o.box!.x1 + 1);
    }
  });

  it("mask payloads use the observed 85-character alphabet and a 4-byte big-endian length envelope", () => {
    expect(SAM_MASK_ALPHABET).toHaveLength(85);
    for (const f of [conceptOneBit, boxOneBit, lossless]) {
      for (const o of parseSamOutput(f.outputText).frames[0]!.objects) {
        for (const ch of o.mask!.payload) expect(SAM_MASK_ALPHABET).toContain(ch);
        const env = samMaskEnvelope(o.mask!.payload);
        expect(env).not.toBeNull();
        expect(env!.body.length).toBe(env!.declaredLength);
      }
    }
    // Lossless ('~') is the server default and ~50x longer than one_bit for the same objects.
    expect(parseSamOutput(lossless.outputText).frames[0]!.objects[0]!.mask!.encoding).toBe("~");
    expect(lossless.outputText.length).toBeGreaterThan(conceptOneBit.outputText.length * 20);
  });

  it("a payload that is also valid z85/rfc1924 is refused, never decoded into a wrong mask", () => {
    const blue = parseSamOutput(conceptOneBit.outputText).frames[0]!.objects[1]!;
    expect(compatibleVariants(blue.mask!.payload).length).toBeGreaterThan(0);
    expect(() => decodeMask(blue.mask!, opts)).toThrow(SamParseError);
    try {
      decodeMask(blue.mask!, opts);
    } catch (e) {
      expect((e as SamParseError).code).toBe("mask_encoding_unsupported");
    }
  });

  it("interpretation falls back to the exact box with the segmentation score", () => {
    const i = interpretSamText(boxOneBit.outputText, plan, opts);
    expect(i.objectCount).toBe(1);
    expect(i.proposals).toHaveLength(1);
    const p = i.proposals[0]!;
    expect(p.source).toBe("box");
    expect(p.segmentationScore).toBeCloseTo(0.99609375, 8);
    const gt = boxOneBit.image.groundTruthInclusive.red!;
    const xs = p.polygon.map((q) => q[0] * 512);
    const ys = p.polygon.map((q) => q[1] * 384);
    expect(Math.min(...xs)).toBeCloseTo(gt.x1, 3);
    expect(Math.max(...xs)).toBeCloseTo(gt.x2 + 1, 3);
    expect(Math.min(...ys)).toBeCloseTo(gt.y1, 3);
    expect(Math.max(...ys)).toBeCloseTo(gt.y2 + 1, 3);
    expect(i.warnings).toContain("mask_unusable_mask_encoding_unsupported");
    const c = interpretSamText(conceptOneBit.outputText, plan, opts);
    expect(c.proposals.map((q) => q.source)).toEqual(["box", "box"]);
    expect(c.rejected).toEqual([]);
  });
});
