import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { StructuredAssistantOutput, ToolSchemas, type ToolName } from "@harvest/contracts";
import { MetaClient, imageInputPart, parseOutputItems, parseUsage, redactSecrets } from "../src/providers/meta/client";
import { MetaError } from "../src/providers/meta/types";
import { restoreOptionals, strictViolations, toRawJsonSchema, toStrictJsonSchema } from "../src/providers/meta/strict-schema";
import { FixtureProvider, loadScenario } from "../src/agent/fixture-provider";
import { MetaProvider, selectProvider, UnavailableProvider } from "../src/agent/provider";

const KEY = "sk-test-SECRET-1234567890";
const ok = (body: unknown, headers: Record<string, string> = { "x-request-id": "req-abc" }) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
const err = (status: number, body: unknown = { error: { code: "x", message: "boom" } }, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const params = { model: "muse-spark-1.3", instructions: "i", input: "hello", maxOutputTokens: 100 };
const sleep = vi.fn(async () => undefined);
const client = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof MetaClient>[0]> = {}) => new MetaClient({ apiKey: KEY, baseUrl: "https://api.meta.ai/v1", fetchImpl, sleep, ...extra });

describe("Meta Responses client: documented shapes", () => {
  it("parses message output_text, usage with cached tokens, ids and request id", async () => {
    const f = vi.fn(async () =>
      ok({
        id: "resp_1",
        model: "muse-spark-1.3",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"a\":" }, { type: "output_text", text: "1}" }] },
        ],
        usage: { input_tokens: 1200, output_tokens: 80, input_tokens_details: { cached_tokens: 1000 }, total_tokens: 1280 },
      }),
    );
    const r = await client(f as unknown as typeof fetch).createResponse(params);
    expect(r).toMatchObject({ responseId: "resp_1", requestId: "req-abc", model: "muse-spark-1.3", outputText: '{"a":1}', functionCalls: [], usage: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 1000 }, retries: 0 });
  });

  it("parses function_call items with call_id and raw argument string", () => {
    const p = parseOutputItems({ output: [{ type: "function_call", id: "fc_1", call_id: "call_9", name: "resolve_crop_identity", arguments: '{"text":"ginger"}', status: "completed" }] });
    expect(p.functionCalls).toEqual([{ name: "resolve_crop_identity", arguments: '{"text":"ginger"}', callId: "call_9" }]);
    expect(p.outputText).toBeNull();
  });

  it("drops function calls with an unusable call_id (1-64 chars) instead of guessing", () => {
    expect(parseOutputItems({ output: [{ type: "function_call", call_id: "x".repeat(65), name: "n", arguments: "{}" }] }).functionCalls).toEqual([]);
  });

  it("parses usage defensively: missing, negative, wrong types and alternate names", () => {
    expect(parseUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(parseUsage({ input_tokens: "12", output_tokens: -3 })).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(parseUsage({ prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } })).toEqual({ inputTokens: 7, outputTokens: 2, cachedInputTokens: 5 });
  });

  it("sends the documented request shape: flat function tools, text.format fields, previous_response_id, Bearer key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return ok({ id: "r", output: [] });
    });
    const schema = { type: "object", properties: {}, required: [], additionalProperties: false };
    await client(f as unknown as typeof fetch).createResponse({
      ...params,
      tools: [{ type: "function", name: "get_job_status", description: "d", parameters: schema, strict: true }],
      textFormat: { name: "out", schema },
      previousResponseId: "resp_prev",
      reasoningEffort: "low",
    });
    const body = JSON.parse(seen!.init.body as string);
    expect(seen!.url).toBe("https://api.meta.ai/v1/responses");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(body.text).toEqual({ format: { type: "json_schema", name: "out", strict: true, schema } }); // not nested under json_schema
    expect(body.tools[0]).toEqual({ type: "function", name: "get_job_status", description: "d", parameters: schema, strict: true });
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.previous_response_id).toBe("resp_prev");
    expect(body.max_output_tokens).toBe(100);
    expect(JSON.stringify(body)).not.toMatch(/search|grounding/i);
  });

  it("refuses to send non-function tools (search grounding is never enabled)", async () => {
    const f = vi.fn();
    await expect(client(f as unknown as typeof fetch).createResponse({ ...params, tools: [{ type: "web_search" } as never] })).rejects.toMatchObject({ kind: "bad_request" });
    expect(f).not.toHaveBeenCalled();
  });

  it("without a key returns provider_unavailable and never calls fetch", async () => {
    const f = vi.fn();
    const c = new MetaClient({ apiKey: undefined, baseUrl: "https://api.meta.ai/v1", fetchImpl: f as unknown as typeof fetch });
    await expect(c.createResponse(params)).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("Meta client: retries and sanitised errors", () => {
  it("retries 429 and 5xx up to 2 times then succeeds, counting retries", async () => {
    const f = vi.fn().mockResolvedValueOnce(err(429, {}, { "retry-after": "1" })).mockResolvedValueOnce(err(503)).mockResolvedValueOnce(ok({ id: "r", output: [] }));
    const r = await client(f as unknown as typeof fetch).createResponse(params);
    expect(f).toHaveBeenCalledTimes(3);
    expect(r.retries).toBe(2);
  });

  it("gives up after 2 retries (3 calls) on persistent 500", async () => {
    const f = vi.fn(async () => err(500));
    await expect(client(f as unknown as typeof fetch).createResponse(params)).rejects.toMatchObject({ kind: "server_error", status: 500, retries: 2 });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("never retries a 400 and never retries 401", async () => {
    const f400 = vi.fn(async () => err(400, { error: { code: "invalid_request", message: "bad" } }));
    await expect(client(f400 as unknown as typeof fetch).createResponse(params)).rejects.toMatchObject({ kind: "bad_request", status: 400, retries: 0 });
    expect(f400).toHaveBeenCalledTimes(1);
    const f401 = vi.fn(async () => err(401));
    await expect(client(f401 as unknown as typeof fetch).createResponse(params)).rejects.toMatchObject({ kind: "unauthorized" });
    expect(f401).toHaveBeenCalledTimes(1);
  });

  it("retries a network error but not a timeout, which is flagged outcome-uncertain", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok({ id: "r", output: [] }));
    expect((await client(f as unknown as typeof fetch).createResponse(params)).retries).toBe(1);
    const slow = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" })))));
    const e = await client(slow as unknown as typeof fetch, { timeoutMs: 20 }).createResponse(params).catch((x) => x as MetaError);
    expect(e).toMatchObject({ kind: "timeout", outcomeUncertain: true });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("retry ceiling is capped at 2 even if configured higher", async () => {
    const f = vi.fn(async () => err(500));
    await expect(client(f as unknown as typeof fetch, { maxRetries: 9 }).createResponse(params)).rejects.toBeInstanceOf(MetaError);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("redacts the key and Authorization values from error messages and provider bodies", async () => {
    const f = vi.fn(async () => err(400, { error: { code: "invalid", message: `bad header Authorization: Bearer ${KEY} key=${KEY}` } }));
    const e = (await client(f as unknown as typeof fetch).createResponse(params).catch((x) => x)) as MetaError;
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toMatch(/Bearer\s+sk-/);
    expect(JSON.stringify(e)).not.toContain(KEY);
    expect(redactSecrets(`x ${KEY} y Bearer abc.def`, KEY)).toBe("x [redacted] y Bearer [redacted]");
  });

  it("a cancelled signal aborts without calling the provider", async () => {
    const f = vi.fn();
    const ac = new AbortController();
    ac.abort();
    await expect(client(f as unknown as typeof fetch).createResponse(params, ac.signal)).rejects.toMatchObject({ kind: "aborted" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("strict-mode schema post-processing", () => {
  it("StructuredAssistantOutput and every tool input have additionalProperties:false and all properties required", () => {
    expect(strictViolations(toRawJsonSchema(StructuredAssistantOutput)).length).toBeGreaterThan(0); // the detector does detect
    expect(strictViolations(toStrictJsonSchema(StructuredAssistantOutput))).toEqual([]);
    for (const name of Object.keys(ToolSchemas) as ToolName[]) {
      expect(strictViolations(toStrictJsonSchema(ToolSchemas[name].input)), name).toEqual([]);
    }
    const s = JSON.stringify(toStrictJsonSchema(StructuredAssistantOutput));
    expect(s).not.toContain('"oneOf"');
    expect(s).not.toContain('"default"');
  });

  it("optional properties become nullable-required and are restored to absent before zod validation", () => {
    const strict = toStrictJsonSchema(StructuredAssistantOutput) as { properties: Record<string, { anyOf?: unknown[] }> };
    expect(strict.properties.proposedPlanChange!.anyOf).toContainEqual({ type: "null" });
    const modelOut = { schemaVersion: "1.0", intent: "explore_crops", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [], numericRefs: [], claimEvidenceRefs: [], proposedPlanChange: null, limitations: [] };
    expect(StructuredAssistantOutput.safeParse(modelOut).success).toBe(false); // null is not a valid optional
    const restored = restoreOptionals(toRawJsonSchema(StructuredAssistantOutput), modelOut);
    expect(StructuredAssistantOutput.safeParse(restored).success).toBe(true);
  });

  it("does not strip an explicit null where the contract requires a nullable field", () => {
    const raw = toRawJsonSchema(ToolSchemas.get_job_status.output);
    expect(restoreOptionals(raw, { jobId: "j", state: "queued", progress: 0, resultIds: [], errorCode: null })).toMatchObject({ errorCode: null });
  });
});

describe("image input", () => {
  it("downscales to at most 1280px and returns a base64 data URL, never a public URL", async () => {
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 10, g: 120, b: 60 } } }).png().toBuffer();
    const part = await imageInputPart(big);
    expect(part.type).toBe("input_image");
    expect(part.image_url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(part.image_url).not.toMatch(/^https?:/);
    const meta = await sharp(Buffer.from(part.image_url.split(",")[1]!, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1280);
    expect(meta.width! / meta.height!).toBeCloseTo(1.5, 1);
  });
});

describe("provider abstraction", () => {
  const base = { apiKey: undefined, baseUrl: "https://api.meta.ai/v1" };
  it("synthetic mode always uses the FixtureProvider, even if a key is present, and labels provenance", async () => {
    const fixture = new FixtureProvider("profile_extraction");
    const fetchSpy = vi.fn();
    const p = selectProvider({ mode: "synthetic", apiKey: KEY, baseUrl: base.baseUrl, fixture: () => fixture, fetchImpl: fetchSpy as unknown as typeof fetch });
    expect(p).toBe(fixture);
    const out = await p.call({ pass: "interpretation", model: "m", instructions: "i", input: "x", maxOutputTokens: 10 });
    expect(out.ok && out.result.provenance).toBe("synthetic_fixture");
    expect(out.ok && out.result.requestId).toMatch(/^fixture-/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p.billable).toBe(false);
  });

  it.each(["live", "replay"] as const)("%s mode without a key returns a typed provider_unavailable result, no fake answer", async (mode) => {
    const p = selectProvider({ mode, ...base, fixture: () => new FixtureProvider("profile_extraction") });
    expect(p).toBeInstanceOf(UnavailableProvider);
    const out = await p.call({ pass: "interpretation", model: "m", instructions: "i", input: "x", maxOutputTokens: 10 });
    expect(out).toMatchObject({ ok: false, error: { code: "provider_unavailable", retryable: false, outcomeUncertain: false } });
  });

  it("live mode with a key uses MetaProvider; failures map to typed codes and never include the key", async () => {
    const f = vi.fn(async () => err(500, { error: { message: `leak ${KEY}` } }));
    const p = selectProvider({ mode: "live", apiKey: KEY, baseUrl: base.baseUrl, fixture: () => new FixtureProvider("profile_extraction"), fetchImpl: f as unknown as typeof fetch });
    expect(p).toBeInstanceOf(MetaProvider);
    const out = await p.call({ pass: "interpretation", model: "m", instructions: "i", input: "x", maxOutputTokens: 10 });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain(KEY);
  }, 15_000);

  it("fixture files are marked synthetic and loading rejects unsafe scenario names", () => {
    for (const n of ["profile_extraction", "tool_calling", "invalid_then_repaired", "unsupported_dosage"]) {
      const s = loadScenario(n);
      expect(s.synthetic).toBe(true);
      for (const step of s.steps) expect(parseOutputItems(step.response as Record<string, unknown>).outputText !== null || parseOutputItems(step.response as Record<string, unknown>).functionCalls.length > 0).toBe(true);
    }
    expect(() => loadScenario("../../etc/passwd")).toThrow();
  });

  it("a fixture step that expects another pass fails loudly instead of replaying the wrong answer", async () => {
    const p = new FixtureProvider("profile_extraction");
    const out = await p.call({ pass: "synthesis", model: "m", instructions: "i", input: "x", maxOutputTokens: 10 });
    expect(out).toMatchObject({ ok: false, error: { code: "fixture_error" } });
  });
});
