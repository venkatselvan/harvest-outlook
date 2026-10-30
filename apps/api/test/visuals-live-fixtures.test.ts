import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildEditBody, editImage } from "../src/visuals/muse-image";

// /v1/images/edits response recorded live on 2026-10-30 (task L4, scripts/smoke/muse-image-smoke.ts); only the
// b64_json payload is downscaled. The base was a synthetic drawing; the output is an illustration, not a prediction.
const f = JSON.parse(readFileSync(new URL("./fixtures/meta/live/muse-image-edit-b64.json", import.meta.url), "utf8")) as {
  recordedFromLive: true;
  request: Record<string, unknown>;
  httpStatus: number;
  response: { data: { b64_json: string }[]; usage: Record<string, number>; output_format: string; background: string };
  observed: { outputWidth: number; outputHeight: number };
};

describe("Muse Image live fixture (recordedFromLive)", () => {
  it("the client's request body matches the body the live API accepted (data URL image, tools off, b64 png)", () => {
    expect(f.recordedFromLive).toBe(true);
    const body = buildEditBody({ model: "muse-image-1.0", prompt: "p", imageDataUrl: "data:image/jpeg;base64,[synthetic base]", size: "768x512" });
    const { prompt: _p, ...rest } = body;
    expect(rest).toEqual(f.request);
  });

  it("parses data[0].b64_json and passes usage through", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(f.response), { status: f.httpStatus, headers: { "content-type": "application/json", "x-request-id": "rq-fixture" } })) as typeof fetch;
    const r = await editImage({ baseUrl: "https://example.invalid/v1", apiKey: "k", model: "muse-image-1.0", prompt: "p", imageDataUrl: "data:image/jpeg;base64,AA==", size: "768x512", fetchImpl });
    const meta = await sharp(r.png).metadata();
    expect(meta.format).toBe("png");
    expect(r.requestId).toBe("rq-fixture");
    expect(r.usage).toEqual(f.response.usage);
    expect(Object.keys(f.response.usage).sort()).toEqual(["input_tokens", "output_tokens", "total_tokens"]);
    // Live output was upscaled (768x512 -> 1920x1280) with the aspect preserved.
    expect(f.observed.outputWidth / f.observed.outputHeight).toBeCloseTo(768 / 512, 6);
    expect(f.response.background).toBe("opaque");
  });
});
