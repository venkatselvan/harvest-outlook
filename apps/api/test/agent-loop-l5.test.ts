import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { Budget } from "../src/services/budget";
import { createFarm } from "../src/services/farms";
import { DEFAULT_LIMITS } from "../src/agent/limits";
import { runAgentTurn, type AgentTurnInput } from "../src/agent/loop";
import type { ProviderOutcome, TextModelProvider, TextRequest, TextResult } from "../src/agent/provider";
import { compactScreenCrops } from "../src/agent/tool-views";
import { mentionedProductBasis, resolveTurnProduct } from "../src/agent/product-resolution";
import { canonicalCropText, expandTopicWords, implementedBindings, retrieveEvidenceHandler, resolveCropIdentityHandler } from "../src/agent/tools/handlers";
import { ToolRegistry, type ToolBindings, type ToolContext } from "../src/agent/tools/registry";
import { GINGER_ID, GINGER_PRODUCT_ID, seedEvidence, seedGinger, seedOwner, seedRun, seedSession } from "./fixtures/meta/helpers";
import { TEST_DB, testConfig } from "./helpers";

/** Task L5: fixes for the agent-quality findings of the L4 live runs. All providers here are scripted (synthetic). */
let pool: Pool;
let owner: string;
let session: string;
const MODELS = { text: "muse-spark-1.3", escalation: "muse-wonder-1.0" };
const DRY_ID = "00000000-0000-4000-8000-0000000000d2";

beforeAll(async () => {
  pool = createPool(TEST_DB);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
  owner = await seedOwner(pool);
  session = await seedSession(pool, owner);
  await seedGinger(pool);
});
afterAll(async () => pool.end());
beforeEach(async () => {
  await pool.query("DELETE FROM tool_results; DELETE FROM agent_runs; DELETE FROM usage_ledger; DELETE FROM usage_reservations; DELETE FROM budget_state; DELETE FROM evidence_records; DELETE FROM source_documents");
});

let seq = 0;
const result = (over: Partial<TextResult> = {}): TextResult => ({ provenance: "meta_live", responseId: `resp_${++seq}`, requestId: `rq_${seq}`, model: "muse-spark-1.3", outputText: null, functionCalls: [], usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 }, latencyMs: 1, retries: 0, ...over });
const profileJson = (intent: string) => JSON.stringify({ intent, language: "en", cropMentions: [], facts: [], needsEscalation: false, clarificationQuestion: null });
const answerJson = () => JSON.stringify({ schemaVersion: "1.0", intent: "compare_crops", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [{ id: "b1", kind: "text", text: "The screening result is shown below.", numericRefIds: [], claimIds: [] }], numericRefs: [], claimEvidenceRefs: [], proposedPlanChange: null, limitations: [] });
const call = (name: string, args: unknown) => ({ name, arguments: JSON.stringify(args), callId: `call_${++seq}` });

class Scripted implements TextModelProvider {
  readonly kind = "meta" as const;
  readonly provenance = "meta_live" as const;
  readonly requests: TextRequest[] = [];
  readonly deleted: string[] = [];
  constructor(private readonly script: (req: TextRequest, n: number) => TextResult | ProviderOutcome, readonly billable = false, private readonly deleteFails = false) {}
  async call(req: TextRequest): Promise<ProviderOutcome> {
    this.requests.push(req);
    const out = this.script(req, this.requests.length);
    return "ok" in out ? out : { ok: true, result: out };
  }
  async deleteResponse(id: string) {
    this.deleted.push(id);
    return this.deleteFails ? { ok: false, code: "http_500" } : { ok: true, code: null };
  }
}

const turn = (over: Partial<AgentTurnInput> = {}): AgentTurnInput => ({ ownerId: owner, sessionId: session, mode: "synthetic", requestId: "req-l5", language: "en", text: "I have 2 acres near Hassan, rain-fed, want to plant in May; which crops?", ...over });
async function deps(provider: TextModelProvider, bindings: ToolBindings = implementedBindings()) {
  const budget = new Budget(pool, { totalUsd: 100, devAllocationUsd: 50, demoReserveUsd: 1, perSessionUsd: 40, perOwnerDayUsd: 40 });
  await budget.init();
  return { pool, budget, provider, registry: new ToolRegistry(bindings), limits: { ...DEFAULT_LIMITS }, models: MODELS };
}
const farm = () => createFarm(pool, owner, { name: "Plot", location: { districtId: "IN-KA-hassan", districtName: "Hassan", stateCode: "KA", precision: "district" }, areaHectares: 0.81 } as never);

describe("L5 finding 1: crop-choice questions are screened", () => {
  const screened: string[] = [];
  // 2026-11-02: production binds get_farm_briefing, so every farm turn also carries the server-initiated briefing.
  const bindings = (): ToolBindings => ({ ...implementedBindings({ config: testConfig(), budget: new Budget(pool, { totalUsd: 100, devAllocationUsd: 50, demoReserveUsd: 1, perSessionUsd: 40, perOwnerDayUsd: 40 }) }), screen_crops: async (input) => { screened.push(input.contextId); return { results: [] }; } });

  it("server-initiated screen_crops when the model ends tool rounds without it; result reaches synthesis and the trace", async () => {
    screened.length = 0;
    const f = await farm();
    const p = new Scripted((req) =>
      req.pass === "interpretation" ? result({ outputText: profileJson("compare_crops") })
        : req.pass === "tool_round" && !req.previousResponseId ? result({ functionCalls: [call("get_farm_context", { farmId: f.id })] })
        : req.pass === "tool_round" ? result({ outputText: "done" })
        : result({ outputText: answerJson() }));
    const r = await runAgentTurn(await deps(p, bindings()), turn({ farmId: f.id }));
    expect(screened).toEqual([f.id]);
    expect(r.serverInitiatedTools).toEqual(["get_farm_briefing", "screen_crops"]);
    const ev = r.trace.toJSON().steps.find((s) => s.kind === "server_initiated_tool" && (s.detail as { tool?: string }).tool === "screen_crops");
    expect(ev?.detail).toMatchObject({ tool: "screen_crops", reason: "crop_choice_intent_without_screening", intent: "compare_crops" });
    const synth = p.requests.find((q) => q.pass === "synthesis")!;
    const text = JSON.stringify(synth.input);
    expect(text).toContain("server_initiated_tool_result");
    const stored = await pool.query("SELECT tool_name, status FROM tool_results WHERE agent_run_id=$1 ORDER BY ordinal", [r.runId]);
    expect(stored.rows.map((x) => `${x.tool_name}:${x.status}`)).toEqual(["get_farm_briefing:ok", "get_farm_context:ok", "screen_crops:ok"]);
    expect(r.toolCalls).toBe(2);
  });

  it("no server call when the model already screened, for other intents, or without a farm", async () => {
    screened.length = 0;
    const f = await farm();
    const modelScreens = new Scripted((req) =>
      req.pass === "interpretation" ? result({ outputText: profileJson("compare_crops") })
        : req.pass === "tool_round" && !req.previousResponseId ? result({ functionCalls: [call("screen_crops", { contextId: f.id })] })
        : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson() }));
    const a = await runAgentTurn(await deps(modelScreens, bindings()), turn({ farmId: f.id }));
    expect(a.serverInitiatedTools).toEqual(["get_farm_briefing"]);
    expect(screened).toEqual([f.id]);
    const water = new Scripted((req) => req.pass === "interpretation" ? result({ outputText: profileJson("water_question") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson() }));
    expect((await runAgentTurn(await deps(water, bindings()), turn({ farmId: f.id }))).serverInitiatedTools).toEqual(["get_farm_briefing"]);
    const noFarm = new Scripted((req) => req.pass === "interpretation" ? result({ outputText: profileJson("compare_crops") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson() }));
    expect((await runAgentTurn(await deps(noFarm, bindings()), turn())).serverInitiatedTools).toBeUndefined();
    expect(screened).toEqual([f.id]);
  });

  it("tool descriptions and prompts require screen_crops with the farm id as contextId", async () => {
    const reg = new ToolRegistry(bindings());
    const adv = reg.advertisedFor("live");
    expect(adv.find((t) => t.name === "screen_crops")!.description).toMatch(/REQUIRED.*contextId = the farm id/s);
    expect(adv.find((t) => t.name === "get_farm_context")!.description).toMatch(/contextId for screen_crops/);
    const { TOOL_INSTRUCTIONS, INTERPRETATION_INSTRUCTIONS } = await import("../src/agent/prompts");
    expect(TOOL_INSTRUCTIONS).toMatch(/MUST call screen_crops with contextId = request_context.farmId/);
    expect(INTERPRETATION_INSTRUCTIONS).toMatch(/compare_crops/);
  });
});

describe("L5 finding 2: Hindi/Tamil/romanised crop names", () => {
  const ctx = async (): Promise<ToolContext> => ({ ownerId: owner, mode: "live", requestId: "r", pool, agentRunId: await seedRun(pool, owner, "live"), asOf: new Date().toISOString() });
  it("canonicalises zero-width joiners, nukta, chandrabindu and a trailing virama/pulli", () => {
    expect(canonicalCropText("अ‍दरक")).toBe("अदरक");
    expect(canonicalCropText("गेहूँ")).toBe(canonicalCropText("गेहूं"));
    expect(canonicalCropText("उड़द")).toBe(canonicalCropText("उडद"));
    expect(canonicalCropText("மஞ்சள்")).toBe(canonicalCropText("மஞ்சள"));
    expect(canonicalCropText("  अदरक  ")).toBe("अदरक");
  });
  it("resolves अदरक (also with a ZWJ), இஞ்சி and romanised adrak/inji stored with the manifest's {text, kind} shape", async () => {
    await pool.query("UPDATE crop_identities SET names=$2::jsonb WHERE id=$1", [GINGER_ID, JSON.stringify({ en: [{ text: "Ginger", kind: "common" }], hi: [{ text: "अदरक", kind: "local" }, { text: "adrak", kind: "transliteration" }], ta: [{ text: "இஞ்சி", kind: "local" }, { text: "inji", kind: "transliteration" }] })]);
    const c = await ctx();
    for (const [text, language] of [["अदरक", "hi"], ["अ‍दरक", "hi"], ["இஞ்சி", "ta"], ["adrak", "hi"], ["Inji", "ta"]] as const) {
      const r = await resolveCropIdentityHandler({ text, language }, c);
      expect(r.candidates.map((x) => x.cropId), text).toEqual([GINGER_ID]);
      expect(r.unresolvedReason).toBe("product_basis_unresolved");
    }
    const r = await resolveCropIdentityHandler({ text: "अदरक", language: "hi" }, c);
    expect(r.candidates[0]!.matchedAlias).toBe("अदरक");
    expect((await resolveCropIdentityHandler({ text: "अद", language: "hi" }, c)).unresolvedReason).toBe("no_alias_match");
  });
});

describe("L5 finding 3: product form resolution order", () => {
  const products = [{ productId: GINGER_PRODUCT_ID, productBasis: "fresh" }, { productId: DRY_ID, productBasis: "dry" }];
  it("plan -> explicit mention -> crop level; only market questions ask the form", () => {
    expect(resolveTurnProduct(GINGER_ID, products, { planProductIds: [DRY_ID], userText: "fresh ginger water?", intent: "water_question" })).toMatchObject({ productId: DRY_ID, source: "plan" });
    expect(resolveTurnProduct(GINGER_ID, products, { planProductIds: [], userText: "सोंठ का भाव क्या है?", intent: "market_question" })).toMatchObject({ productId: DRY_ID, source: "explicit_mention", askProductForm: false });
    expect(resolveTurnProduct(GINGER_ID, products, { planProductIds: [], userText: "fresh ginger price", intent: "market_question" })).toMatchObject({ productId: GINGER_PRODUCT_ID, source: "explicit_mention" });
    expect(resolveTurnProduct(GINGER_ID, products, { planProductIds: [], userText: "अदरक को कितना पानी चाहिए?", intent: "water_question" })).toMatchObject({ productId: null, source: "crop_level", askProductForm: false });
    expect(resolveTurnProduct(GINGER_ID, products, { planProductIds: [], userText: "ginger price in May?", intent: "market_question" })).toMatchObject({ productId: null, source: "crop_level", askProductForm: true });
    expect(mentionedProductBasis("dry and fresh ginger")).toBeNull();
  });
  it("in the loop the resolve_crop_identity view carries serverProductResolution (crop level for a water question) outside the stored result", async () => {
    const f = await farm();
    const p = new Scripted((req) =>
      req.pass === "interpretation" ? result({ outputText: profileJson("water_question") })
        : req.pass === "tool_round" && !req.previousResponseId ? result({ functionCalls: [call("resolve_crop_identity", { text: "ginger", language: "en" })] })
        : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson() }));
    const r = await runAgentTurn(await deps(p), turn({ farmId: f.id, text: "How much water does ginger need?" }));
    const second = p.requests.filter((q) => q.pass === "tool_round")[1]!;
    const out = JSON.parse((second.input as { output: string }[])[0]!.output);
    expect(out.serverProductResolution).toMatchObject({ cropId: GINGER_ID, productId: null, source: "crop_level", askProductForm: false });
    expect(out.result.serverProductResolution).toBeUndefined();
    expect(r.trace.toJSON().steps.some((s) => s.kind === "product_resolution")).toBe(true);
  });
});

describe("L5 finding 4: ginger water evidence for a Hassan farm", () => {
  const ctx = async (): Promise<ToolContext> => ({ ownerId: owner, mode: "live", requestId: "r", pool, agentRunId: await seedRun(pool, owner, "live"), asOf: new Date().toISOString() });
  it("slug-scoped grounded national 'irrigation' rows are found from the crop UUID, 'water_management' and the farm's district id", async () => {
    const nat = await seedEvidence(pool, { mode: "live", level: "national", geographyIds: ["IN"], cropIds: ["ginger"], topics: ["irrigation"] });
    await pool.query("UPDATE evidence_records SET validation_status='grounded' WHERE id=$1", [nat]);
    const state = await seedEvidence(pool, { mode: "live", level: "state", geographyIds: ["IN-KA"], cropIds: ["ginger"], topics: ["climate_and_soil"] });
    const dist = await seedEvidence(pool, { mode: "live", level: "district", geographyIds: ["IN-KA-hassan"], cropIds: ["ginger"], topics: ["rainfall"] });
    await seedEvidence(pool, { mode: "live", level: "state", geographyIds: ["IN-KL"], cropIds: ["ginger"], topics: ["irrigation"] });
    await seedEvidence(pool, { mode: "live", level: "national", geographyIds: ["IN"], cropIds: ["ginger"], topics: ["harvesting"] });
    await seedEvidence(pool, { mode: "synthetic", level: "national", geographyIds: ["IN"], cropIds: ["ginger"], topics: ["irrigation"] });
    const c = await ctx();
    const r = await retrieveEvidenceHandler({ cropIds: [GINGER_ID], regionIds: ["IN-KA-hassan"], topics: ["water_management", "irrigation"], limit: 10 }, c);
    expect(r.passages.map((x) => x.evidenceId)).toEqual([dist, nat]); // district first, then national fallback; KL and harvesting excluded
    expect(r.passages.map((x) => x.scope.level)).toEqual(["district", "national"]);
    expect(r.passages.find((x) => x.evidenceId === nat)!.validationStatus).toBe("grounded");
    expect(r.passages[0]!.cropIds).toEqual([GINGER_ID]);
    const soil = await retrieveEvidenceHandler({ cropIds: ["ginger"], regionIds: ["IN-KA-hassan"], topics: ["soil_drainage"], limit: 10 }, c);
    expect(soil.passages.map((x) => x.evidenceId)).toEqual([state]);
    expect(expandTopicWords(["water_management"])).toEqual(expect.arrayContaining(["water", "irrigation", "moisture", "rain", "rainfall"]));
  });
});

describe("L5 finding 5: provider responses are deleted after every run", () => {
  it("deletes every response id on success, records the cleanup in the trace and result", async () => {
    const p = new Scripted((req) => req.pass === "interpretation" ? result({ outputText: profileJson("water_question") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson() }));
    const r = await runAgentTurn(await deps(p), turn({ text: "how much water?" }));
    expect(p.deleted.length).toBe(3);
    expect(new Set(p.deleted).size).toBe(3);
    expect(r.providerCleanup).toEqual({ attempted: 3, deleted: 3, failedCodes: [] });
    expect(r.trace.toJSON().steps.some((s) => s.kind === "response_cleanup")).toBe(true);
  });
  it("deletes on failure too, and a failing delete never changes the answer", async () => {
    const failing = new Scripted((req, n) => (n === 1 ? result({ outputText: profileJson("water_question") }) : { ok: false, error: { code: "provider_error", message: "x", retryable: false, outcomeUncertain: false, requestId: null, retries: 0 } }));
    const a = await runAgentTurn(await deps(failing), turn());
    expect(a.status).toBe("failed");
    expect(failing.deleted).toHaveLength(1);
    const badDelete = new Scripted((req) => req.pass === "interpretation" ? result({ outputText: profileJson("water_question") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson() }), false, true);
    const b = await runAgentTurn(await deps(badDelete), turn());
    expect(b.status).toBe("approved");
    expect(b.providerCleanup).toMatchObject({ attempted: 3, deleted: 0, failedCodes: ["http_500", "http_500", "http_500"] });
  });
});

describe("L5 live follow-ups: chain recovery and compact screening view", () => {
  it("a chained call rejected with 'referenced response not found' is re-sent once unchained with the stored tool results", async () => {
    const f = await farm();
    let failed = false;
    const p = new Scripted((req) => {
      if (req.pass === "interpretation") return result({ outputText: profileJson("water_question") });
      if (req.pass === "tool_round" && !req.previousResponseId && !failed) return result({ functionCalls: [call("get_farm_context", { farmId: f.id })] });
      if (req.pass === "tool_round" && req.previousResponseId && !failed) {
        failed = true;
        return { ok: false, error: { code: "bad_request", message: "Provider returned HTTP 400: invalid_request_error / referenced response not found or expired", retryable: false, outcomeUncertain: false, requestId: null, retries: 0 } };
      }
      if (req.pass === "tool_round") return result({ outputText: "done" });
      return result({ outputText: answerJson() });
    });
    const r = await runAgentTurn(await deps(p), turn({ farmId: f.id, text: "how much water?" }));
    expect(r.status).toBe("approved");
    const resent = p.requests.filter((q) => q.pass === "tool_round")[2]!;
    expect(resent.previousResponseId).toBeUndefined();
    expect(JSON.stringify(resent.input)).toContain("stored_tool_results");
    expect(JSON.stringify(resent.input)).not.toContain("function_call_output");
    expect(r.trace.toJSON().steps.filter((s) => s.kind === "chain_recovery")).toHaveLength(1);
  });
  it("only one recovery per run: a second lost reference fails the run", async () => {
    const f = await farm();
    const lost = { ok: false as const, error: { code: "bad_request" as const, message: "referenced response not found or expired", retryable: false, outcomeUncertain: false, requestId: null, retries: 0 } };
    const p = new Scripted((req) => req.pass === "interpretation" ? result({ outputText: profileJson("water_question") }) : req.previousResponseId ? lost : result({ functionCalls: [call("get_farm_context", { farmId: f.id })] }));
    const r = await runAgentTurn(await deps(p), turn({ farmId: f.id }));
    expect(r.status).toBe("failed");
    expect(r.trace.toJSON().steps.filter((s) => s.kind === "chain_recovery")).toHaveLength(1);
  });
  it("a large screen_crops result is shown compactly with pointers into the stored result, every crop kept", () => {
    const big = { results: Array.from({ length: 40 }, (_, i) => ({ cropId: `crop-${i}`, productIds: [`crop-${i}-p`], outcome: i % 2 ? "unknown" : "requires_review", unknownFields: ["irrigation"], ruleResults: [{ ruleId: `r${i}`, effect: "requires_review", reasons: [{ source: "rule", reasonCode: "planting_outside_sourced_window" }], unknownFields: [] }], coverage: Array.from({ length: 8 }, (_, k) => ({ capability: k === 0 ? "screening_supported" : "forecast_evaluated", supportStatus: "partial", region: { level: "national", ids: ["IN"] }, season: null, missingReason: null, padding: "x".repeat(500) })), dimensions: [{ dimension: "time_to_first_income", value: { kind: "quantity", value: 180, unit: "d", evidenceState: "derived", missingReason: null, evidenceIds: ["e1"] } }] })) };
    const v = compactScreenCrops(big) as { results: { index: number; cropId: string; dimensions: { pointer: string }[]; screeningCoverage: unknown[] }[] };
    expect(v.results).toHaveLength(40);
    expect(v.results[7]!.dimensions[0]!.pointer).toBe("/results/7/dimensions/0/value");
    expect(v.results[7]!.screeningCoverage).toHaveLength(1);
    expect(JSON.stringify(v).length).toBeLessThan(JSON.stringify(big).length / 3);
  });
});

describe("L5 crop id forms in the gate", () => {
  it("evidence stored with the catalogue slug supports claims declared with the slug or the UUID", async () => {
    const f = await farm();
    const ev = await seedEvidence(pool, { level: "district", geographyIds: ["IN-KA-hassan"], cropIds: ["ginger"], topics: ["irrigation"] });
    for (const cropIds of [["ginger"], [GINGER_ID]]) {
      const answer = JSON.stringify({ schemaVersion: "1.0", intent: "water_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [{ id: "b1", kind: "evidence", text: "Keep the soil evenly moist during rhizome development.", numericRefIds: [], claimIds: ["c1"] }], numericRefs: [], claimEvidenceRefs: [{ claimId: "c1", text: "Keep soil evenly moist.", evidenceIds: [ev], cropIds, granularity: "district" }], proposedPlanChange: null, limitations: [] });
      const p = new Scripted((req) => req.pass === "interpretation" ? result({ outputText: profileJson("water_question") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answer }));
      const r = await runAgentTurn(await deps(p), turn({ farmId: f.id, text: "How should I water ginger?" }));
      expect(r.status, JSON.stringify(cropIds)).toBe("approved");
      expect(r.approved.claimEvidenceRefs).toHaveLength(1);
    }
    const bad = JSON.stringify({ schemaVersion: "1.0", intent: "water_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [{ id: "b1", kind: "evidence", text: "Keep the soil evenly moist.", numericRefIds: [], claimIds: ["c1"] }], numericRefs: [], claimEvidenceRefs: [{ claimId: "c1", text: "Keep soil evenly moist.", evidenceIds: [ev], cropIds: ["not-a-crop"], granularity: "district" }], proposedPlanChange: null, limitations: [] });
    const p = new Scripted((req) => req.pass === "interpretation" ? result({ outputText: profileJson("water_question") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: bad }));
    const r = await runAgentTurn(await deps(p), turn({ farmId: f.id, text: "How should I water ginger?" }));
    expect(r.status).not.toBe("approved");
    expect(JSON.stringify(r.gateReport)).toContain("claim_crop_unknown");
  });
});
