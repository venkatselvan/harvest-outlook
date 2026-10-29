import { describe, expect, it, vi } from "vitest";
import { evaluateScene, pointInPolygon, rasterizePolygon } from "../src/visuals/qa";
import { buildEditBody, editImage, MuseImageError } from "../src/visuals/muse-image";
import { dataUrlToBuffer, editNothing, editRegionOnly, editWholeImage, providerOk, REGION, sceneJpeg } from "./fixtures/muse-image/build";

describe("scene QA background preservation", () => {
  it("passes when only the region changed", async () => {
    const base = await sceneJpeg();
    const qa = await evaluateScene({ base, output: await editRegionOnly(base), polygon: REGION });
    expect(qa.reasons).toEqual([]);
    expect(qa.passed).toBe(true);
    expect(qa.scores.outsideMeanAbsDiff!).toBeLessThan(0.02);
    expect(qa.scores.insideMeanAbsDiff!).toBeGreaterThan(0.1);
  });

  it("flags a whole-image change as altered outside the region", async () => {
    const base = await sceneJpeg();
    const qa = await evaluateScene({ base, output: await editWholeImage(base), polygon: REGION });
    expect(qa.passed).toBe(false);
    expect(qa.reasons).toContain("scene_changed_outside_region");
    expect(qa.scores.outsideMeanAbsDiff!).toBeGreaterThan(0.08);
  });

  it("flags a no-op edit, an undecodable output and an aspect change", async () => {
    const base = await sceneJpeg(320, 240);
    expect((await evaluateScene({ base, output: await editNothing(base), polygon: REGION })).reasons).toContain("region_unchanged");
    expect((await evaluateScene({ base, output: Buffer.from("not an image"), polygon: REGION })).reasons).toEqual(["output_undecodable"]);
    const square = await editRegionOnly(await sceneJpeg(240, 240));
    expect((await evaluateScene({ base, output: square, polygon: REGION })).reasons).toEqual(["aspect_mismatch"]);
  });

  it("does not fail the outside check when the region fills nearly the whole frame", async () => {
    const base = await sceneJpeg();
    const full: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const qa = await evaluateScene({ base, output: await editRegionOnly(base, full), polygon: full });
    expect(qa.scores.outsideMeanAbsDiff).toBeNull();
    expect(qa.passed).toBe(true);
  });

  it("rasterises the polygon with even-odd containment", () => {
    expect(pointInPolygon(0.5, 0.6, REGION)).toBe(true);
    expect(pointInPolygon(0.1, 0.1, REGION)).toBe(false);
    const m = rasterizePolygon(REGION, 20, 20);
    expect(m[12 * 20 + 10]).toBe(1);
    expect(m[0]).toBe(0);
  });
});

describe("Muse Image client", () => {
  const base = { baseUrl: "https://example.test/v1/", apiKey: "sk-test-secret-1234", model: "muse-image-1.0", prompt: "p", imageDataUrl: "data:image/jpeg;base64,AAAA", size: "320x240", sleep: async () => undefined };

  it("sends only documented fields with tools disabled and the key in a header", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return providerOk(await editNothing(await sceneJpeg(16, 12)), "req_x");
    });
    const out = await editImage({ ...base, fetchImpl: f as unknown as typeof fetch });
    expect(seen!.url).toBe("https://example.test/v1/images/edits");
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toEqual(buildEditBody(base));
    expect(body).toMatchObject({ n: 1, response_format: "b64_json", output_format: "png", tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false } });
    for (const banned of ["mask", "seed", "input_fidelity", "partial_images", "moderation"]) expect(body).not.toHaveProperty(banned);
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-secret-1234");
    expect(out.requestId).toBe("req_x");
    expect(dataUrlToBuffer(body.images[0].image_url).length).toBe(3);
  });

  it("retries once on 503 then fails without leaking the key; never retries a network error", async () => {
    const f503 = vi.fn(async () => new Response("{}", { status: 503 }));
    const err = await editImage({ ...base, fetchImpl: f503 as unknown as typeof fetch }).catch((e) => e as MuseImageError);
    expect(f503).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({ kind: "server" });
    expect(String((err as Error).message)).not.toContain("sk-test");
    expect((err as MuseImageError).outcomeUnknown).toBe(false);
    const fnet = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const e2 = (await editImage({ ...base, fetchImpl: fnet as unknown as typeof fetch }).catch((e) => e)) as MuseImageError;
    expect(fnet).toHaveBeenCalledTimes(1);
    expect(e2.outcomeUnknown).toBe(true);
  });

  it("treats an empty data array as filtered (not billed)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const e = (await editImage({ ...base, fetchImpl: f as unknown as typeof fetch }).catch((x) => x)) as MuseImageError;
    expect(e.kind).toBe("filtered");
    expect(e.outcomeUnknown).toBe(false);
  });
});
