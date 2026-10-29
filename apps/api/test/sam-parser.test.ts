import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASE85_VECTORS, base85SelfTest, compatibleVariants, decodeBase85, encodeBase85, resolveVariant, Base85Error } from "../src/vision/sam/base85";
import { decodeMask, parseSamOutput, SamParseError } from "../src/vision/sam/parser";
import { buildPromptText } from "../src/vision/sam/prompt";
import { buildRequestBody, extractOutputText, readSse } from "../src/vision/sam/client";
import { DEFAULT_SAM_OPTIONS } from "../src/vision/sam/options";
import { packOneBit, rectBits, record } from "./fixtures/sam/build";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/sam");
const fx = (n: string) => readFileSync(join(dir, n), "utf8");
const opts = { base85Variant: "auto", base85Fallback: "rfc1924", bitOrder: "msb" } as const;

describe("base85 (SYNTHETIC vectors; real SAM alphabet unverified)", () => {
  it("passes known-answer vectors for ascii85, z85 and rfc1924", () => {
    expect(base85SelfTest()).toEqual([]);
    expect(BASE85_VECTORS.map((v) => v.variant).sort()).toEqual(["ascii85", "ascii85", "ascii85", "rfc1924", "rfc1924", "z85"]);
  });
  it("round-trips arbitrary bytes of every length in all variants", () => {
    for (const v of ["ascii85", "z85", "rfc1924"] as const) {
      for (let n = 0; n <= 23; n++) {
        const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 255);
        expect(Array.from(decodeBase85(encodeBase85(bytes, v), v))).toEqual(Array.from(bytes));
      }
    }
  });
  it("rejects characters outside the alphabet and dangling digits", () => {
    expect(() => decodeBase85("abécd", "rfc1924")).toThrow(Base85Error);
    expect(() => decodeBase85("0", "z85")).toThrow(Base85Error);
    expect(() => decodeBase85("|||||", "ascii85")).toThrow(Base85Error);
  });
  it("auto variant uses alphabet membership, falling back to the configured default when ambiguous", () => {
    expect(compatibleVariants("|NsC0{{")).toEqual(["rfc1924"]);
    expect(resolveVariant("|NsC0{{", "auto", "ascii85")).toBe("rfc1924");
    expect(resolveVariant("9jqo^", "auto", "rfc1924")).toBe("rfc1924"); // valid in several alphabets: default wins
    expect(resolveVariant("9jqo^", "ascii85", "rfc1924")).toBe("ascii85");
  });
});

describe("SAM output parser (SYNTHETIC fixtures)", () => {
  it("parses two objects with confidence on box and mask", () => {
    const p = parseSamOutput(fx("two-objects-rfc1924.txt"));
    expect(p.frames).toHaveLength(1);
    const [a, b] = p.frames[0]!.objects;
    expect(a!.id).toBe("1");
    expect(a!.box).toEqual({ x1: 40, y1: 20, x2: 119, y2: 99, w: 160, h: 120, confidence: 0.93 });
    expect(a!.mask).toMatchObject({ x: 0, y: 0, confidence: 0.9, height: 30, width: 40, encoding: "!" });
    expect(b!.id).toBe("2");
    expect(b!.box!.confidence).toBe(0.41);
    expect(p.warnings).toEqual([]);
  });
  it("handles confidence absent", () => {
    const o = parseSamOutput(fx("one-object-no-confidence-ascii85.txt")).frames[0]!.objects[0]!;
    expect(o.box!.confidence).toBeNull();
    expect(o.mask!.confidence).toBeNull();
    expect(decodeMask(o.mask!, opts).bits.reduce((s, v) => s + v, 0)).toBe(20 * 20);
  });
  it("keeps frame indexes when frames are skipped or empty", () => {
    const p = parseSamOutput(fx("skipped-frames.txt"));
    expect(p.frames.map((f) => [f.index, f.objects.length])).toEqual([[0, 0], [3, 1], [5, 0]]);
  });
  it("empty output is zero matches, not an error", () => {
    expect(parseSamOutput(fx("empty.txt"))).toEqual({ frames: [], warnings: [] });
    expect(parseSamOutput("<0f>\n").frames[0]!.objects).toEqual([]);
  });
  it("parses a box-only record and a mask payload that contains pipe characters", () => {
    const t = `<0f>7<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10|>`;
    expect(parseSamOutput(t).frames[0]!.objects[0]).toMatchObject({ id: "7", mask: null, box: { x2: 3 } });
    const bits = rectBits(8, 8, 1, 1, 7, 7);
    const rec = record({ id: 1, box: { x1: 0, y1: 0, x2: 7, y2: 7 }, mask: { bits, W: 8, H: 8, variant: "rfc1924" } }, 8, 8);
    const o = parseSamOutput(`<0f>${rec},${rec.replace(/^1/, "2")}`).frames[0]!.objects;
    expect(o.map((x) => x.id)).toEqual(["1", "2"]);
    expect(Array.from(decodeMask(o[1]!.mask!, opts).bits)).toEqual(Array.from(bits));
  });
  it("ignores out-of-range confidence", () => {
    const t = `<0f>1<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10;c=7|>`;
    expect(parseSamOutput(t).frames[0]!.objects[0]!.box!.confidence).toBeNull();
  });
});

describe("mask decoding", () => {
  const mk = (bytes: Uint8Array, W: number, H: number, enc = "!", variant: "rfc1924" | "ascii85" = "rfc1924") => ({
    x: 0, y: 0, confidence: null, width: W, height: H, encoding: enc, payload: encodeBase85(bytes, variant),
  });
  it("unpacks one-bit rows MSB first, flat stream", () => {
    const bits = Uint8Array.from([1, 0, 1, 1, 0, 0, 0, 1, /*row2*/ 0, 1, 0, 1, 1, 0, 0, 0, /*row3*/ 1, 1, 1, 1, 1, 1, 1, 1].slice(0, 20));
    const raster = decodeMask(mk(packOneBit(bits, 5, 4), 5, 4), opts);
    expect(Array.from(raster.bits)).toEqual(Array.from(bits));
  });
  it("recognises row-padded one-bit data by length and honours lsb order", () => {
    const bits = rectBits(11, 3, 2, 0, 9, 3);
    expect(Array.from(decodeMask(mk(packOneBit(bits, 11, 3, { rowPadded: true }), 11, 3), opts).bits)).toEqual(Array.from(bits));
    expect(Array.from(decodeMask(mk(packOneBit(bits, 11, 3, { lsb: true }), 11, 3), { ...opts, bitOrder: "lsb" }).bits)).toEqual(Array.from(bits));
  });
  it("rejects a length mismatch instead of guessing", () => {
    expect(() => decodeMask(mk(new Uint8Array(3), 40, 30), opts)).toThrow(SamParseError);
  });
  it("lossless: byte per pixel; PNG container is reported unsupported", () => {
    const px = Uint8Array.from([0, 255, 255, 0, 200, 10]);
    expect(Array.from(decodeMask(mk(px, 3, 2, "~"), opts).bits)).toEqual([0, 1, 1, 0, 1, 0]);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    expect(() => decodeMask(mk(png, 3, 3, "~"), opts)).toThrowError(/PNG/);
    expect(() => decodeMask(mk(px, 3, 2, "?"), opts)).toThrow(SamParseError);
  });
});

describe("prompt grammar and request body", () => {
  it("concept prompt is a plain noun phrase with grammar characters stripped", () => {
    expect(buildPromptText({ kind: "concept", text: " field<|x|> " }, { width: 100, height: 100 })).toBe("field x");
  });
  it("box prompt uses pixel coordinates with inclusive x2/y2 and w/h of the sent image", () => {
    expect(buildPromptText({ kind: "box", x0: 0.25, y0: 0.1, x1: 0.75, y1: 0.9 }, { width: 1024, height: 768 })).toBe(
      "<0f>1<|box;x1=256;y1=77;x2=767;y2=690;w=1024;h=768|>",
    );
  });
  it("point prompt marks negative points with a - prefix", () => {
    expect(buildPromptText({ kind: "points", points: [{ x: 0.5, y: 0.5 }, { x: 0, y: 1, positive: false }] }, { width: 100, height: 50 })).toBe(
      "<0f>1<|point;x=50;y=25;w=100;h=50|>,-1<|point;x=0;y=49;w=100;h=50|>",
    );
  });
  it("request body follows the documented Responses shape and flags", () => {
    const b = buildRequestBody({ model: "sam-3.1", text: "field", imageDataUrl: "data:image/jpeg;base64,AA==", options: DEFAULT_SAM_OPTIONS }) as Record<string, unknown>;
    expect(b).toMatchObject({
      model: "sam-3.1",
      stream: true,
      metadata: { mask_encoding: "onebit" },
      include_confidence: "true",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "field" }, { type: "input_image", image_url: "data:image/jpeg;base64,AA==" }] }],
    });
    const off = buildRequestBody({ model: "m", text: "t", imageDataUrl: "d", options: { ...DEFAULT_SAM_OPTIONS, stream: false, maskEncoding: null, includeConfidence: false } });
    expect(off).not.toHaveProperty("metadata");
    expect(off).not.toHaveProperty("include_confidence");
  });
  it("extracts text from both common non-streaming shapes and concatenates SSE deltas", async () => {
    expect(extractOutputText({ output_text: "abc" })).toBe("abc");
    expect(extractOutputText({ output: [{ content: [{ type: "output_text", text: "<0f>" }, { type: "output_text", text: "x" }] }] })).toBe("<0f>x");
    const enc = new TextEncoder();
    const sse = 'event: a\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\ndata: {"type":"response.output_text.delta","delta":"<0f"}\n\ndata: {"type":"response.output_text.delta","delta":">"}\n\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":3}}}\n\ndata: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(sse.slice(0, 40))); c.enqueue(enc.encode(sse.slice(40))); c.close(); } });
    expect(await readSse(stream)).toMatchObject({ text: "<0f>", id: "resp_1", usage: { input_tokens: 3 } });
  });
});
