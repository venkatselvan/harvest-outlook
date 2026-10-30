import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ToolSchemas } from "@harvest/contracts";
import { MetaClient, parseOutputItems, parseUsage } from "../src/providers/meta/client";
import { MetaError } from "../src/providers/meta/types";
import { MetaProvider } from "../src/agent/provider";
import { restoreOptionals, toRawJsonSchema } from "../src/providers/meta/strict-schema";

/** Responses recorded from the real Meta API on 2026-10-30 (sanitized ids; see each fixture's `sanitization`). */
interface LiveFixture {
  recordedFromLive: true;
  recordedAt: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}
const load = (name: string): LiveFixture => JSON.parse(readFileSync(new URL(`./fixtures/meta/live/${name}.json`, import.meta.url), "utf8")) as LiveFixture;
const KEY = "test-key-live-fixtures";
const replay = (body: unknown) => new MetaClient({ apiKey: KEY, baseUrl: "https://api.meta.ai/v1", fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200, headers: { "x-request-id": "req-live" } })) as typeof fetch, sleep: async () => {} });
const params = { model: "muse-spark-1.3", instructions: "i", input: "x", maxOutputTokens: 200 };

describe("Meta live-recorded fixtures (2026-10-30)", () => {
  it("every fixture is marked as recorded from live", () => {
    for (const n of ["incomplete-default-effort", "text-minimal-effort", "structured-output-trivial", "function-call-commentary", "function-call-anyof-null-string", "function-call-type-array-null", "image-data-url-png"]) {
      const f = load(n);
      expect(f.recordedFromLive).toBe(true);
      expect(f.recordedAt).toBe("2026-10-30");
      expect(JSON.stringify(f)).not.toMatch(/Bearer|MODEL_API_KEY/);
    }
  });

  it("reads output_text after a leading reasoning item, and reasoning tokens from output_tokens_details", async () => {
    const f = load("text-minimal-effort");
    expect((f.response.output as { type: string }[])[0]!.type).toBe("reasoning");
    const r = await replay(f.response).createResponse(params);
    expect(r).toMatchObject({ status: "completed", outputText: "Four", functionCalls: [], refusal: null, incompleteReason: null });
    expect(r.usage).toEqual({ inputTokens: 24, outputTokens: 36, cachedInputTokens: 0, reasoningTokens: 26 });
  });

  it("surfaces status incomplete (max_output_tokens) as a typed, outcome-uncertain error carrying usage", async () => {
    const f = load("incomplete-default-effort");
    const err = await replay(f.response).createResponse(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaError);
    const e = err as MetaError;
    expect(e.kind).toBe("incomplete");
    expect(e.outcomeUncertain).toBe(true);
    expect(e.info.incompleteReason).toBe("max_output_tokens");
    expect(e.info.usage).toMatchObject({ outputTokens: 200, reasoningTokens: 198 });
    expect(e.message).toContain("max_output_tokens");
  });

  it("MetaProvider maps an incomplete response to a non-retryable provider_error that keeps the reservation", async () => {
    const out = await new MetaProvider(replay(load("incomplete-default-effort").response), KEY).call({ pass: "interpretation", ...params });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatchObject({ code: "provider_error", retryable: false, outcomeUncertain: true });
  });

  it("structured output arrives as JSON text in message.content[].output_text", async () => {
    const r = await replay(load("structured-output-trivial").response).createResponse(params);
    expect(JSON.parse(r.outputText!)).toEqual({ city: "Pune", people: 3 });
  });

  it("drops the commentary preamble when a function call is present", () => {
    const f = load("function-call-commentary");
    const p = parseOutputItems(f.response);
    expect(p.outputText).toBeNull();
    expect(p.functionCalls).toHaveLength(1);
    expect(p.functionCalls[0]).toMatchObject({ name: "get_weather", arguments: '{"city":"Pune"}' });
    expect(p.functionCalls[0]!.callId.length).toBeLessThanOrEqual(64);
  });

  it('restores the live "null"-string quirk and the type-array null to a contract-valid tool input', () => {
    const raw = toRawJsonSchema(ToolSchemas.resolve_crop_identity.input);
    for (const n of ["function-call-anyof-null-string", "function-call-type-array-null"]) {
      const fc = parseOutputItems(load(n).response).functionCalls[0]!;
      expect(fc.name).toBe("resolve_crop_identity");
      const parsed = ToolSchemas.resolve_crop_identity.input.safeParse(restoreOptionals(raw, JSON.parse(fc.arguments)));
      expect(parsed.success).toBe(true);
    }
  });

  it("answers an inline data-URL PNG image", async () => {
    const f = load("image-data-url-png");
    const r = await replay(f.response).createResponse(params);
    expect(r.outputText).toBe("Red");
    expect(parseUsage(f.response.usage).inputTokens).toBe(34);
  });

  it("uses commentary text only when there is no other answer and no function call", () => {
    const body = { output: [{ type: "message", phase: "commentary", content: [{ type: "output_text", text: "only commentary" }] }] };
    expect(parseOutputItems(body).outputText).toBe("only commentary");
    const truncated = { output: [{ type: "function_call", name: "x", call_id: "call_1", arguments: "{\"a\":", status: "incomplete" }] };
    expect(parseOutputItems(truncated).functionCalls).toEqual([]);
  });
});
