import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AssistantRouteDeps } from "../src/routes/assistant";
import { FixtureProvider } from "../src/agent/fixture-provider";
import type { TextModelProvider } from "../src/agent/provider";
import { Budget } from "../src/services/budget";
import { createFarm } from "../src/services/farms";
import { EVIDENCE_ID, GINGER_ID, seedEvidence, seedGinger } from "./fixtures/meta/helpers";
import { farmBody, login, setupHarness, type Client, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await setupHarness();
  await seedGinger(h.pool);
});
afterAll(async () => h.close());

/** A real server (the assistant plugin is wired by buildServer) with per-test assistant overrides. */
async function appWith(over: Record<string, string> = {}, deps: Partial<AssistantRouteDeps> = {}): Promise<{ app: FastifyInstance; client: Client }> {
  const app = await h.make(over, { assistant: deps });
  return { app, client: await login(app) };
}
const body = (o: Record<string, unknown> = {}) => ({ text: "என்கிட்ட 2 acre நிலம் இருக்கு, தண்ணீர் கம்மி, Hassan district", language: "ta", ...o });
const post = (c: Client, payload: unknown, headers: Record<string, string> = {}) => c.call("POST", "/api/v1/assistant/turns", { payload, headers });

describe("POST /api/v1/assistant/turns (synthetic mode)", () => {
  it("replays the synthetic fixture, labels provenance, returns only gate-approved blocks, trace id and cost estimate", async () => {
    const { client } = await appWith();
    const res = await post(client, body());
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.mode).toBe("synthetic");
    expect(j.warnings.map((w: { message: string }) => w.message).join(" ")).toMatch(/Synthetic mode/);
    expect(j.data).toMatchObject({ status: "approved", provenance: "synthetic_fixture", gateStatus: "approved", intent: "explore_crops", costEstimate: { billable: false, estimatedUsd: 0, basis: "estimated_not_billed" } });
    expect(j.data.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(j.data.answerBlocks.length).toBeGreaterThan(0);
    expect(j.data.clarifications).toHaveLength(1);
    // F8: the gate report is exposed so the Ask UI can show what was withheld.
    expect(j.data.gateReport).toMatchObject({ removed: expect.any(Array), groundedEvidenceIds: expect.any(Array), templateSubstituted: expect.any(Array) });
    expect(j.data.limitations.join(" ")).toMatch(/Synthetic fixture/);
    const { isApprovedText } = await import("../src/speech/approved");
    const ownerId = (await h.pool.query("SELECT owner_id FROM agent_runs WHERE id=$1", [j.data.traceId])).rows[0].owner_id;
    expect(j.data.approvedText).toBe(j.data.answerBlocks.map((b: { text: string }) => b.text).join("\n\n"));
    expect(await isApprovedText(h.pool, ownerId, j.data.approvedText, j.data.approvedTextHash)).toBe(true);
    expect(await isApprovedText(h.pool, ownerId, `${j.data.approvedText} extra`, j.data.approvedTextHash)).toBe(false);
    expect(j.data.proposedFacts.find((f: { field: string }) => f.field === "area")).toMatchObject({ requiresConfirmation: true });
    const run = (await h.pool.query("SELECT provenance, mode, status FROM agent_runs WHERE id=$1", [j.data.traceId])).rows[0];
    expect(run).toEqual({ provenance: "synthetic_fixture", mode: "synthetic", status: "succeeded" });
  });

  it("requires a session and CSRF like other private routes", async () => {
    const { app, client } = await appWith();
    expect((await app.inject({ method: "POST", url: "/api/v1/assistant/turns", headers: { origin: "http://localhost:5173" }, payload: body() })).statusCode).toBe(401);
    expect((await client.call("POST", "/api/v1/assistant/turns", { payload: body(), csrf: null })).statusCode).toBe(403);
  });

  it("accepts a confirmedTranscript instead of text, but not both or neither", async () => {
    const { client } = await appWith();
    expect((await post(client, { confirmedTranscript: "இஞ்சி பற்றி சொல்லுங்கள்", language: "ta" })).statusCode).toBe(200);
    expect((await post(client, { text: "a", confirmedTranscript: "b", language: "en" })).statusCode).toBe(400);
    expect((await post(client, { language: "en" })).statusCode).toBe(400);
  });

  it("rejects client-supplied owner/mode, bad language, oversized text and malformed ids", async () => {
    const { client } = await appWith();
    for (const p of [body({ ownerId: "x" }), body({ mode: "live" }), body({ language: "fr" }), body({ text: "x".repeat(2001) }), body({ farmId: "not-a-uuid" }), body({ selectedDate: "tomorrow" })]) {
      expect((await post(client, p)).statusCode, JSON.stringify(p).slice(0, 60)).toBe(400);
    }
  });

  it("another owner's farmId or planId is a 404 and no model call or run is made", async () => {
    const { client } = await appWith();
    const other = await login((await appWith()).app);
    const theirFarm = await createFarm(h.pool, (await h.pool.query("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0].owner_id, farmBody() as never);
    const before = Number((await h.pool.query("SELECT count(*) FROM agent_runs")).rows[0].count);
    const res = await post(client, body({ farmId: theirFarm.id }));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(res.body).not.toContain(theirFarm.name);
    // missing farm looks identical
    const missing = await post(client, body({ farmId: "00000000-0000-4000-8000-000000000999" }));
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual(res.json().error);
    // plan owned by someone else
    const theirs = await h.pool.query<{ id: string }>(
      "INSERT INTO plans (owner_id, farm_id, crop_id, mode, content_hash, snapshot) VALUES ($1,$2,$3,'synthetic','hash-t09','{}'::jsonb) RETURNING id",
      [(await h.pool.query("SELECT owner_id FROM farms WHERE id=$1", [theirFarm.id])).rows[0].owner_id, theirFarm.id, GINGER_ID],
    );
    expect((await post(client, body({ planId: theirs.rows[0]!.id }))).statusCode).toBe(404);
    expect(Number((await h.pool.query("SELECT count(*) FROM agent_runs")).rows[0].count)).toBe(before);
    void other;
  });

  it("an owned farm is accepted and scopes evidence to its district", async () => {
    await seedEvidence(h.pool, { id: EVIDENCE_ID, geographyIds: ["IN-KA-hassan"] }); // farms store canonical registry ids (F12)
    const { client } = await appWith({}, { fixtureScenario: "tool_calling" });
    const farm = (await client.call("POST", "/api/v1/farms", { payload: farmBody({ location: { districtId: "IN-KA-hassan", stateId: "IN-KA", precision: "district" } }) })).json().data;
    const res = await post(client, body({ farmId: farm.id }));
    expect(res.statusCode).toBe(200);
    expect(res.json().data.claimEvidenceRefs[0].evidenceIds).toEqual([EVIDENCE_ID]);
    // the same evidence is refused for a farm in another district
    const wayanad = (await client.call("POST", "/api/v1/farms", { payload: farmBody() })).json().data;
    const res2 = await post(client, body({ farmId: wayanad.id }));
    expect(res2.json().data.claimEvidenceRefs).toEqual([]);
    expect(res2.json().data.answerBlocks).toEqual([]);
  });

  it("supplies only the selected owned demo provenance even without a farm-context tool call", async () => {
    const seen: string[] = [];
    const { client } = await appWith({}, { providerFactory: () => {
      const fixture = new FixtureProvider("profile_extraction");
      const original = fixture.call.bind(fixture);
      fixture.call = async (request) => { seen.push(typeof request.input === "string" ? request.input : request.input.map(item => "content" in item ? (typeof item.content === "string" ? item.content : JSON.stringify(item.content)) : "").join("\n")); return original(request); };
      return fixture;
    } });
    const demo = (await client.call("POST", "/api/v1/farms/demo", { payload: {} })).json().data;
    expect((await post(client, body({ farmId: demo.farm.id }))).statusCode).toBe(200);
    const context = JSON.parse(seen[0]!.match(/<request_context>(.*?)<\/request_context>/s)![1]!);
    expect(context.selectedFarmProvenance).toMatchObject({ kind: "prefilled_boundary_demo", publicReference: { source: "https://uasmandya.edu.in/ars-arasikere" }, prefilledComponents: ["map boundary", "public location reference", "crop history", "journal entries and sales", "current crop", "saved seasons"] });
    expect(context.selectedFarmProvenance.limitations).toContain("sample records");expect(JSON.stringify(context)).not.toMatch(/illustrative/i);
    expect(JSON.stringify(context)).not.toContain('"coordinates"');
    seen.length = 0;
    const ordinary = (await client.call("POST", "/api/v1/farms", { payload: farmBody() })).json().data;
    expect((await post(client, body({ farmId: ordinary.id }))).statusCode).toBe(200);
    const ordinaryContext = JSON.parse(seen[0]!.match(/<request_context>(.*?)<\/request_context>/s)![1]!);
    expect(ordinaryContext.selectedFarmProvenance).toBeUndefined();
  });

  it("honours Idempotency-Key: one run for a repeated request, 422 for a different payload", async () => {
    let created = 0;
    const { client } = await appWith({}, { providerFactory: () => (created++, new FixtureProvider("profile_extraction")) });
    const key = "idem-key-0001";
    const first = await post(client, body(), { "idempotency-key": key });
    const second = await post(client, body(), { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.json().data.traceId).toBe(first.json().data.traceId);
    // 2026-11-04: the Evara UI tree is part of the stored response, so the replay returns the same tree.
    expect(first.json().data.ui).toMatchObject({ version: "1", origin: "fallback", root: { type: "stack" } });
    expect(second.json().data.ui).toEqual(first.json().data.ui);
    expect(created).toBe(1);
    expect((await post(client, body({ text: "something else" }), { "idempotency-key": key })).statusCode).toBe(422);
  });

  it("is rate limited per route", async () => {
    const { client } = await appWith({}, { limits: { turnsPerMinute: 2 } });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await post(client, body())).statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    expect(codes[0]).toBe(200);
  });
});

describe("live mode", () => {
  it("without MODEL_API_KEY returns a typed provider_unavailable error and no answer", async () => {
    const { client } = await appWith({ RUNTIME_MODE: "live" });
    const res = await post(client, body());
    expect(res.statusCode).toBe(503);
    const j = res.json();
    expect(j.data).toBeNull();
    expect(j.error.code).toBe("provider_unavailable");
    expect(JSON.stringify(j)).not.toMatch(/answerBlocks/);
  });

  it("with a key, the real client path runs against recorded Responses shapes; the key never reaches the response", async () => {
    const KEY = "sk-live-SECRET-ABCDEFGH";
    const seen: { auth: string | null; body: Record<string, unknown> }[] = [];
    const bodies = [
      { text: JSON.stringify({ intent: "explore_crops", language: "en", cropMentions: [], facts: [], needsEscalation: false, clarificationQuestion: null }) },
      { text: "done" },
      { text: JSON.stringify({ schemaVersion: "1.0", intent: "explore_crops", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [{ id: "b1", kind: "text", text: "Tell me your water source first.", numericRefIds: [], claimIds: [] }], numericRefs: [], claimEvidenceRefs: [], proposedPlanChange: null, limitations: [] }) },
    ];
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ auth: (init.headers as Record<string, string>).authorization ?? null, body: JSON.parse(init.body as string) });
      const b = bodies[n++]!;
      return new Response(JSON.stringify({ id: `resp_live_${n}`, model: "muse-spark-1.3", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: b.text }] }], usage: { input_tokens: 1500, output_tokens: 120, input_tokens_details: { cached_tokens: 0 } } }), { status: 200, headers: { "x-request-id": `meta-req-${n}` } });
    });
    const { client } = await appWith({ RUNTIME_MODE: "live", MODEL_API_KEY: KEY }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await post(client, body({ language: "en", text: "Which crop for little water?" }));
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.data).toMatchObject({ status: "approved", provenance: "meta_live", costEstimate: { billable: true } });
    expect(j.data.costEstimate.settledUsd).toBeCloseTo(3 * (1500 * 1.25 + 120 * 4.25) / 1_000_000, 6);
    expect(res.body).not.toContain(KEY);
    expect(seen.every((s) => s.auth === `Bearer ${KEY}`)).toBe(true);
    // documented request shapes
    expect(seen[0]!.body).toMatchObject({ model: "muse-spark-1.3", text: { format: { type: "json_schema", name: "proposed_profile", strict: true } } });
    expect(seen[1]!.body.tools).toBeInstanceOf(Array);
    expect(seen[1]!.body.tool_choice).toBe("auto");
    expect(seen[2]!.body).toMatchObject({ text: { format: { name: "assistant_output" } } });
    expect(JSON.stringify(seen.map((s) => s.body))).not.toMatch(/web_search|grounding/i);
    const led = (await h.pool.query("SELECT provider_request_id FROM usage_ledger ORDER BY created_at DESC LIMIT 3")).rows.map((r) => r.provider_request_id).sort();
    expect(led).toEqual(["meta-req-1", "meta-req-2", "meta-req-3"]);
    expect(JSON.stringify((await h.pool.query("SELECT trace FROM agent_runs WHERE id=$1", [j.data.traceId])).rows[0])).not.toContain(KEY);
  });

  it("budget exhaustion before any answer is a 429 budget_exceeded", async () => {
    const budget = new Budget(h.pool, { totalUsd: 1, devAllocationUsd: 0.000001, demoReserveUsd: 0, perSessionUsd: 1, perOwnerDayUsd: 1 });
    const provider: TextModelProvider = { kind: "meta", provenance: "meta_live", billable: true, call: async () => { throw new Error("must not be called"); } };
    const { client } = await appWith({ RUNTIME_MODE: "live", MODEL_API_KEY: "k-123456789" }, { budget, providerFactory: () => provider });
    await budget.init(); // after the server's own init: re-syncs the shared budget_state row to this tiny allocation (last test in the file)
    const res = await post(client, body());
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("budget_exceeded");
  });
});

// ---------------------------------------------------------------- F13: gate removals at the route level
class Scripted implements TextModelProvider {
  readonly kind = "fixture" as const;
  readonly provenance = "synthetic_fixture" as const;
  readonly billable = false;
  private n = 0;
  constructor(private readonly answer: object, private readonly lang: string) {}
  async call(req: Parameters<TextModelProvider["call"]>[0]): ReturnType<TextModelProvider["call"]> {
    const text = req.pass === "interpretation" ? JSON.stringify({ intent: "plan_question", language: this.lang, cropMentions: [], facts: [], needsEscalation: false, clarificationQuestion: null }) : req.pass === "tool_round" ? "no tools" : JSON.stringify(this.answer);
    return { ok: true, result: { provenance: "synthetic_fixture", responseId: `sc_${++this.n}`, requestId: `sc_${this.n}`, model: req.model, outputText: text, functionCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, latencyMs: 0, retries: 0 } };
  }
}

describe("F13: route-level gate removals and spoken notices", () => {
  it.each([
    ["en", "Please confirm your water source.", "Mix the fungicide stronger this time.", "Drench the beds with the fungicide."],
    ["hi", "कृपया पानी के स्रोत की पुष्टि करें।", "दो गज की दूरी पर पौधे लगाएं।", "हर पौधे में खाद डालें।"],
  ] as const)("%s: removed content is reported and the spoken text carries the withheld/template notices", async (lang, safe, unsafe, badLimitation) => {
    const { TEMPLATE_LIMITATION, WITHHELD_LIMITATION } = await import("../src/agent/templates");
    const answer = {
      schemaVersion: "1.0", intent: "plan_question", language: lang, proposedFacts: [], clarifications: [], toolRequests: [],
      answerBlocks: [{ id: "b1", kind: "text", text: safe, numericRefIds: [], claimIds: [] }, { id: "b2", kind: "text", text: unsafe, numericRefIds: [], claimIds: [] }],
      numericRefs: [], claimEvidenceRefs: [], proposedPlanChange: null, limitations: [badLimitation],
    };
    const { client } = await appWith({}, { providerFactory: () => new Scripted(answer, lang) });
    const res = await post(client, body({ language: lang, text: lang === "hi" ? "पौधे कैसे लगाएं?" : "How do I plant?" }));
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.data.status).toBe("partial");
    const removed = j.data.gateReport.removed as { field: string; id: string | null; index: number; codes: string[] }[];
    expect(removed).toEqual(expect.arrayContaining([expect.objectContaining({ field: "answerBlock", id: "b2" }), expect.objectContaining({ field: "limitation", id: null, index: 0 })]));
    expect(JSON.stringify(j.data.answerBlocks)).not.toContain(unsafe);
    expect(j.data.limitations).not.toContain(badLimitation);
    const blockText = j.data.answerBlocks.map((b: { text: string }) => b.text).join("\n\n");
    const notices = [...(j.data.gateReport.templateSubstituted.length > 0 ? [TEMPLATE_LIMITATION[lang]] : []), WITHHELD_LIMITATION[lang]];
    expect(j.data.approvedText).toBe([blockText, ...notices].join("\n\n"));
    const { isApprovedText } = await import("../src/speech/approved");
    const ownerId = (await h.pool.query("SELECT owner_id FROM agent_runs WHERE id=$1", [j.data.traceId])).rows[0].owner_id;
    expect(await isApprovedText(h.pool, ownerId, j.data.approvedText, j.data.approvedTextHash)).toBe(true);
    expect(await isApprovedText(h.pool, ownerId, blockText, j.data.approvedTextHash)).toBe(false);
  });
});
