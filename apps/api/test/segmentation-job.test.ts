import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Pool } from "../src/db/pool";
import { Budget } from "../src/services/budget";
import { runSegmentation, registerSegmentationHandler, SEGMENT_JOB_TYPE, type SegmentationDeps } from "../src/vision/jobs/segmentation";
import { handlers as workerHandlers } from "../src/worker/main";
import { DEFAULT_SAM_OPTIONS } from "../src/vision/sam/options";
import { frame, rectBits, record } from "./fixtures/sam/build";
import { login, makeJpeg, setupHarness, testConfig, upload, type Client, type Harness } from "./helpers";

// SYNTHETIC provider output: mock fetch only. Nothing here talks to Meta.
let h: Harness;
let c: Client;
let mediaId: string;
let jobCounter = 0;
const KEY = "unit-test-key-not-real";
const live = { RUNTIME_MODE: "live", MODEL_API_KEY: KEY };

async function newJob(client: Client, over: Record<string, unknown> = {}) {
  const res = await client.call("POST", `/api/v1/media/${mediaId}/segmentation`, { payload: { prompt: { kind: "concept", text: `field ${jobCounter++}`, ...over } } });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().data.jobId as string;
  const row = (await h.pool.query<{ id: string; owner_id: string; payload: unknown }>("SELECT id, owner_id, payload FROM jobs WHERE id=$1", [jobId])).rows[0]!;
  return row;
}

function deps(over: Record<string, string>, fetchImpl: typeof fetch, extra: Partial<SegmentationDeps> = {}): SegmentationDeps {
  const config = testConfig({ ...over });
  return { pool: h.pool as Pool, config, storage: h.storage, budget: Budget.fromConfig(h.pool, config), fetchImpl, options: { ...DEFAULT_SAM_OPTIONS, stream: false }, ...extra };
}

const hb = { heartbeat: async () => undefined };
const okText = (w = 1024, hh = 768) =>
  frame(0, [record({ id: 1, box: { x1: 256, y1: 128, x2: 767, y2: 639, c: 0.9 }, mask: { bits: rectBits(40, 30, 10, 5, 30, 25), W: 40, H: 30, c: 0.87, variant: "rfc1924" } }, w, hh)]);
const jsonRes = (text: string, id = "resp_test_1") => new Response(JSON.stringify({ id, output_text: text, usage: { input_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json", "x-request-id": id } });

beforeAll(async () => {
  h = await setupHarness(live);
  c = await login(h.app);
  const up = await upload(c, await makeJpeg({ width: 2000, height: 1500 }));
  expect(up.statusCode).toBe(201);
  mediaId = up.json().data.id;
});
afterAll(async () => h.close());

describe("segmentation job: unavailable paths make no network call", () => {
  it("synthetic mode and replay mode return unavailable without a provider call", async () => {
    for (const [mode, reason] of [["synthetic", "synthetic_mode"], ["replay", "replay_mode"]] as const) {
      const f = vi.fn();
      const job = await newJob(c);
      const out = await runSegmentation(deps({ RUNTIME_MODE: mode, MODEL_API_KEY: KEY }, f as unknown as typeof fetch), job, hb);
      expect(out).toMatchObject({ status: "unavailable", reason });
      expect(f).not.toHaveBeenCalled();
    }
  });
  it("live mode without MODEL_API_KEY returns provider_not_configured, no fetch, no reservation", async () => {
    const f = vi.fn();
    const before = (await h.pool.query("SELECT count(*)::int AS n FROM usage_reservations")).rows[0].n;
    const out = await runSegmentation(deps({ RUNTIME_MODE: "live" }, f as unknown as typeof fetch), await newJob(c), hb);
    expect(out).toMatchObject({ status: "unavailable", reason: "provider_not_configured" });
    expect(f).not.toHaveBeenCalled();
    expect((await h.pool.query("SELECT count(*)::int AS n FROM usage_reservations")).rows[0].n).toBe(before);
  });
  it("budget exhaustion returns unavailable before any provider call", async () => {
    const f = vi.fn();
    const out = await runSegmentation(deps({ ...live, BUDGET_PER_OWNER_DAY_USD: "0.001" }, f as unknown as typeof fetch), await newJob(c), hb);
    expect(out).toMatchObject({ status: "unavailable", reason: "budget_exceeded" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("segmentation job: provider call", () => {
  it("sends the documented request, reserves/settles $0.0025 with the provider request id, and returns a normalized proposal", async () => {
    let seen: { url: string; headers: Record<string, string>; body: any } | null = null;
    const f = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
      return jsonRes(okText(), "resp_abc123");
    });
    const job = await newJob(c);
    const out = await runSegmentation(deps(live, f as unknown as typeof fetch), job, hb);
    expect(f).toHaveBeenCalledTimes(1);
    expect(seen!.url).toBe("https://api.meta.ai/v1/responses");
    expect(seen!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen!.body).toMatchObject({ model: "sam-3.1", stream: false, metadata: { mask_encoding: "one_bit", include_confidence: "true" }, store: false });
    const parts = seen!.body.input[0].content;
    expect(parts[0]).toMatchObject({ type: "input_text" });
    const img = Buffer.from(parts[1].image_url.split(",")[1], "base64");
    const m = await sharp(img).metadata();
    expect([m.format, m.width, m.height]).toEqual(["jpeg", 1024, 768]); // 1600x1200 derivative downscaled to <=1024
    expect(out).toMatchObject({ status: "ok", modelId: "sam-3.1", segmentationScore: 0.87, imageSizeUsed: { width: 1024, height: 768, scaleX: 0.64, scaleY: 0.64 }, providerRequestId: "resp_abc123" });
    expect(out.polygon).toHaveLength(4);
    const xs = out.polygon!.map((p) => p[0]).sort((a, b) => a - b);
    expect([xs[0], xs[3]]).toEqual([0.25, 0.75]);
    const res = (await h.pool.query("SELECT state, estimated_usd, settled_usd, provider_request_id FROM usage_reservations WHERE job_id=$1", [job.id])).rows;
    expect(res).toEqual([{ state: "settled", estimated_usd: "0.002500", settled_usd: "0.002500", provider_request_id: "resp_abc123" }]);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
  it("accepts a streamed (SSE) response", async () => {
    const text = okText();
    const sse = `data: {"type":"response.output_text.delta","delta":${JSON.stringify(text.slice(0, 50))}}\n\ndata: {"type":"response.output_text.delta","delta":${JSON.stringify(text.slice(50))}}\n\ndata: {"type":"response.completed","response":{"id":"resp_sse"}}\n\n`;
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const out = await runSegmentation(deps(live, f as unknown as typeof fetch, { options: { ...DEFAULT_SAM_OPTIONS, stream: true } }), await newJob(c), hb);
    expect(out).toMatchObject({ status: "ok", providerRequestId: "resp_sse" });
  });
  it("empty provider output is no_match; quality-gate rejection is reported, not hidden", async () => {
    const none = await runSegmentation(deps(live, (async () => jsonRes("")) as unknown as typeof fetch), await newJob(c), hb);
    expect(none).toMatchObject({ status: "no_match", reason: "no_objects" });
    const tiny = frame(0, [record({ id: 1, box: { x1: 0, y1: 0, x2: 40, y2: 40 }, mask: { bits: rectBits(40, 30, 0, 0, 3, 3), W: 40, H: 30, variant: "rfc1924" } }, 1024, 768)]);
    const rej = await runSegmentation(deps(live, (async () => jsonRes(tiny)) as unknown as typeof fetch), await newJob(c), hb);
    expect(rej).toMatchObject({ status: "no_match", reason: "all_rejected_by_quality_gate", rejected: [{ reason: "too_small" }] });
    expect(rej.polygon).toBeUndefined();
  });
  it("definitive 4xx releases the reservation and is not retryable; 503 releases and is retryable", async () => {
    const j1 = await newJob(c);
    const f400 = vi.fn(async () => new Response(JSON.stringify({ error: { code: "invalid_request", message: "secret-detail" } }), { status: 400 }));
    await expect(runSegmentation(deps(live, f400 as unknown as typeof fetch), j1, hb)).rejects.toMatchObject({ retryable: false });
    const j2 = await newJob(c);
    const f503 = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(runSegmentation(deps(live, f503 as unknown as typeof fetch), j2, hb)).rejects.toMatchObject({ retryable: true });
    const st = async (id: string) => (await h.pool.query("SELECT state FROM usage_reservations WHERE job_id=$1", [id])).rows.map((r) => r.state);
    expect(await st(j1.id)).toEqual(["released"]);
    expect(await st(j2.id)).toEqual(["released"]);
  });
  it("a lost connection keeps the reservation uncertain and does not auto-retry", async () => {
    const j = await newJob(c);
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(runSegmentation(deps(live, f as unknown as typeof fetch), j, hb)).rejects.toMatchObject({ retryable: false });
    expect(f).toHaveBeenCalledTimes(1);
    expect((await h.pool.query("SELECT state FROM usage_reservations WHERE job_id=$1", [j.id])).rows).toEqual([{ state: "uncertain" }]);
  });
  it("a crash between dispatch and settle: the re-claimed job makes zero provider calls, fails as provider_outcome_uncertain and keeps the reservation uncertain", async () => {
    const j = await newJob(c);
    const f1 = vi.fn(async () => jsonRes(okText()));
    const d1 = deps(live, f1 as unknown as typeof fetch);
    d1.budget.settle = async () => {
      throw new Error("process died before settle");
    };
    await expect(runSegmentation(d1, j, hb)).rejects.toThrow("process died");
    expect(f1).toHaveBeenCalledTimes(1);
    expect((await h.pool.query("SELECT outcome FROM job_dispatches WHERE job_id=$1", [j.id])).rows).toEqual([{ outcome: null }]);

    const f2 = vi.fn(async () => jsonRes(okText()));
    await expect(runSegmentation(deps(live, f2 as unknown as typeof fetch), j, hb)).rejects.toMatchObject({ message: "provider_outcome_uncertain", retryable: false });
    expect(f2).not.toHaveBeenCalled();
    expect((await h.pool.query("SELECT state FROM usage_reservations WHERE job_id=$1", [j.id])).rows).toEqual([{ state: "uncertain" }]);
    // Still blocked on a third claim, and no extra reservation was made.
    await expect(runSegmentation(deps(live, f2 as unknown as typeof fetch), j, hb)).rejects.toMatchObject({ message: "provider_outcome_uncertain" });
    expect(f2).not.toHaveBeenCalled();
    expect((await h.pool.query("SELECT count(*)::int AS n FROM usage_reservations WHERE job_id=$1", [j.id])).rows[0].n).toBe(1);
  });
  it("a definitive provider failure leaves a failed marker so a retryable 503 can be re-dispatched by the same job", async () => {
    const j = await newJob(c);
    const f503 = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(runSegmentation(deps(live, f503 as unknown as typeof fetch), j, hb)).rejects.toMatchObject({ retryable: true });
    const f = vi.fn(async () => jsonRes(okText()));
    const out = await runSegmentation(deps(live, f as unknown as typeof fetch), j, hb);
    expect(out.status).toBe("ok");
    expect(f).toHaveBeenCalledTimes(1);
    expect((await h.pool.query("SELECT outcome FROM job_dispatches WHERE job_id=$1", [j.id])).rows).toEqual([{ outcome: "completed" }]);
  });
  it("a cross-owner job cannot read another owner's media", async () => {
    const other = await login(h.app);
    const job = await newJob(c);
    const forged = { ...job, owner_id: (await h.pool.query<{ owner_id: string }>("SELECT owner_id FROM sessions WHERE token_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1")).rows[0]!.owner_id };
    expect(other.cookie).toBeTruthy();
    const f = vi.fn();
    await expect(runSegmentation(deps(live, f as unknown as typeof fetch), forged, hb)).rejects.toMatchObject({ retryable: false });
    expect(f).not.toHaveBeenCalled();
  });
  it("registerSegmentationHandler installs vision.segment in a registry", async () => {
    const reg: Record<string, unknown> = {};
    registerSegmentationHandler(reg as never, deps(live, vi.fn() as unknown as typeof fetch));
    expect(typeof reg[SEGMENT_JOB_TYPE]).toBe("function");
  });
  it("is type-compatible with the worker's real handler registry", () => {
    registerSegmentationHandler(workerHandlers, deps(live, vi.fn() as unknown as typeof fetch));
    expect(workerHandlers[SEGMENT_JOB_TYPE]).toBeTypeOf("function");
    delete workerHandlers[SEGMENT_JOB_TYPE];
  });
});
