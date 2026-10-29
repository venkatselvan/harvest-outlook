import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { Budget } from "../src/services/budget";
import { createFarm } from "../src/services/farms";
import { FixtureProvider } from "../src/agent/fixture-provider";
import { DEFAULT_LIMITS, loadAgentLimits, type AgentLimits } from "../src/agent/limits";
import { runAgentTurn, type AgentTurnInput } from "../src/agent/loop";
import type { ProviderOutcome, TextModelProvider, TextRequest, TextResult } from "../src/agent/provider";
import { implementedBindings } from "../src/agent/tools/handlers";
import { ToolRegistry, type ToolContext } from "../src/agent/tools/registry";
import { redactForTrace } from "../src/agent/trace";
import { EVIDENCE_ID, GINGER_ID, seedEvidence, seedGinger, seedOwner, seedSession } from "./fixtures/meta/helpers";
import { TEST_DB } from "./helpers";

let pool: Pool;
let owner: string;
let session: string;
let otherOwner: string;

const MODELS = { text: "muse-spark-1.3", escalation: "muse-wonder-1.0" };
const budgetLimits = (dev = 50) => ({ totalUsd: 100, devAllocationUsd: dev, demoReserveUsd: 1, perSessionUsd: 40, perOwnerDayUsd: 40 });

beforeAll(async () => {
  pool = createPool(TEST_DB);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
  owner = await seedOwner(pool);
  otherOwner = await seedOwner(pool);
  session = await seedSession(pool, owner);
  await seedGinger(pool);
});
afterAll(async () => pool.end());
beforeEach(async () => {
  await pool.query("DELETE FROM tool_results; DELETE FROM agent_runs; DELETE FROM usage_ledger; DELETE FROM usage_reservations; DELETE FROM budget_state; DELETE FROM evidence_records; DELETE FROM source_documents");
});

const turn = (over: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
  ownerId: owner,
  sessionId: session,
  mode: "synthetic",
  requestId: "req-test-1",
  language: "en",
  text: "I have 2 acres and little water in Hassan",
  geographyIds: ["IN-KA-HAS", "KA", "IN-KA", "IN"],
  ...over,
});

async function deps(provider: TextModelProvider, o: { limits?: Partial<AgentLimits>; signal?: AbortSignal; budget?: Budget; registry?: ToolRegistry } = {}) {
  const budget = o.budget ?? new Budget(pool, budgetLimits());
  await budget.init();
  return { pool, budget, provider, registry: o.registry ?? new ToolRegistry(implementedBindings()), limits: { ...DEFAULT_LIMITS, ...o.limits }, models: MODELS, signal: o.signal };
}

// ------------------------------------------------------------------ scripted live-like provider
let seq = 0;
const result = (over: Partial<TextResult> = {}): TextResult => ({
  provenance: "meta_live",
  responseId: `resp_${++seq}`,
  requestId: `rq_${seq}`,
  model: "muse-spark-1.3",
  outputText: null,
  functionCalls: [],
  usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 },
  latencyMs: 4,
  retries: 0,
  ...over,
});
const profileJson = (over: object = {}) => JSON.stringify({ intent: "explore_crops", language: "en", cropMentions: [], facts: [], needsEscalation: false, clarificationQuestion: null, ...over });
const answerJson = (over: object = {}) =>
  JSON.stringify({ schemaVersion: "1.0", intent: "explore_crops", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [{ id: "b1", kind: "text", text: "Please confirm your water source.", numericRefIds: [], claimIds: [] }], numericRefs: [], claimEvidenceRefs: [], proposedPlanChange: null, limitations: [], ...over });
const call = (name: string, args: unknown, id = `call_${++seq}`) => ({ name, arguments: JSON.stringify(args), callId: id });

class Scripted implements TextModelProvider {
  readonly kind = "meta" as const;
  readonly provenance = "meta_live" as const;
  readonly billable: boolean;
  readonly requests: TextRequest[] = [];
  constructor(
    private readonly script: (req: TextRequest, n: number) => ProviderOutcome | TextResult | Promise<ProviderOutcome | TextResult>,
    billable = true,
  ) {
    this.billable = billable;
  }
  async call(req: TextRequest): Promise<ProviderOutcome> {
    this.requests.push(req);
    const out = await this.script(req, this.requests.length);
    return "ok" in out ? out : { ok: true, result: out };
  }
}
const fail = (code: "timeout" | "provider_error" | "aborted", uncertain: boolean): ProviderOutcome => ({ ok: false, error: { code, message: "synthetic failure", retryable: false, outcomeUncertain: uncertain, requestId: null, retries: 0 } });

/** Default happy script: interpretation, no tools, valid synthesis. */
const happy = (req: TextRequest): TextResult =>
  req.pass === "interpretation" ? result({ outputText: profileJson() }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson() });

describe("loop with the synthetic fixture provider", () => {
  it("profile extraction: proposals only (needs confirmation), provenance labelled, no budget spend, trace persisted", async () => {
    const r = await runAgentTurn(await deps(new FixtureProvider("profile_extraction")), turn());
    expect(r.status).toBe("approved");
    expect(r.provenance).toBe("synthetic_fixture");
    expect(r.cost).toMatchObject({ providerCalls: 3, billable: false, estimatedUsd: 0 });
    expect(r.limitations.join(" ")).toMatch(/Synthetic fixture/);
    const area = r.proposedFacts.find((f) => f.field === "area")!;
    expect(area).toMatchObject({ requiresConfirmation: true, value: { kind: "quantity", value: 2, unit: "acre", evidenceState: "farmer_reported", validationStatus: "pending" } });
    expect(r.proposedFacts.every((f) => f.requiresConfirmation === true)).toBe(true);
    expect(r.clarifications).toHaveLength(1);
    expect(r.approved.answerBlocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(Number((await pool.query("SELECT count(*) FROM usage_reservations")).rows[0].count)).toBe(0);
    const row = (await pool.query("SELECT status, provenance, trace, rounds, prompt_version, limits FROM agent_runs WHERE id=$1", [r.runId])).rows[0];
    expect(row).toMatchObject({ status: "succeeded", provenance: "synthetic_fixture" });
    expect(row.prompt_version).toMatch(/^harvest-assistant@/);
    expect(row.trace.steps.some((s: { kind: string }) => s.kind === "gate")).toBe(true);
    expect(row.limits.maxToolRounds).toBe(6);
    expect((await pool.query("SELECT count(*) FROM prompt_versions")).rows[0].count).toBe("1");
  });

  it("tool-calling turn: resolve_crop_identity then retrieve_evidence, results stored, cited claim approved", async () => {
    await seedEvidence(pool, { id: EVIDENCE_ID });
    const r = await runAgentTurn(await deps(new FixtureProvider("tool_calling")), turn());
    expect(r.status).toBe("approved");
    expect(r.toolRounds).toBe(2);
    expect(r.toolCalls).toBe(2);
    const rows = (await pool.query("SELECT tool_name, status, result FROM tool_results WHERE agent_run_id=$1 ORDER BY ordinal", [r.runId])).rows;
    expect(rows.map((x) => x.tool_name)).toEqual(["resolve_crop_identity", "retrieve_evidence"]);
    expect(rows[0].result.candidates[0]).toMatchObject({ cropId: GINGER_ID, productId: null, matchedAlias: "இஞ்சி" });
    expect(rows[0].result.ambiguous).toBe(true); // fresh vs dry product basis is not guessed
    expect(rows[1].result.passages[0].evidenceId).toBe(EVIDENCE_ID);
    expect(r.approved.claimEvidenceRefs).toEqual([{ claimId: "c1", text: expect.any(String), evidenceIds: [EVIDENCE_ID] }]);
  });

  it("tool-calling turn without the evidence row is blocked by the gate, not approved", async () => {
    const r = await runAgentTurn(await deps(new FixtureProvider("tool_calling")), turn({ geographyIds: ["IN-KA-HAS"] }));
    expect(r.approved.answerBlocks).toEqual([]);
    expect(r.status).not.toBe("approved");
    expect(r.gateStatus).toBe("correction_requested");
    const gate = r.trace.steps.find((s) => s.kind === "gate" && (s.detail as { issues?: unknown[] }).issues?.length) as { detail: { issues: { code: string }[] } };
    expect(gate.detail.issues.map((i) => i.code)).toContain("evidence_missing");
  });

  it("invalid output then repaired: one repair call, approved after repair", async () => {
    const f = new FixtureProvider("invalid_then_repaired");
    const r = await runAgentTurn(await deps(f), turn());
    expect(f.seenPasses).toEqual(["interpretation", "tool_round", "synthesis", "repair"]);
    expect(r.status).toBe("approved");
    const gates = r.trace.steps.filter((s) => s.kind === "gate").map((s) => (s.detail as { status: string }).status);
    expect(gates).toEqual(["correction_requested", "approved"]);
  });

  // F5 policy change: after the repair budget is exhausted the withheld dosage block is replaced by the
  // server-authored safety template (previously: nothing returned, status incomplete).
  it("unsupported dosage: blocked on the first output and on both repairs; only the server safety template is returned", async () => {
    const f = new FixtureProvider("unsupported_dosage");
    const r = await runAgentTurn(await deps(f), turn());
    expect(f.seenPasses).toEqual(["interpretation", "tool_round", "synthesis", "repair", "repair"]);
    expect(r.status).toBe("partial");
    expect(r.approved.answerBlocks).toEqual([{ id: "b1", kind: "warning", text: "Please consult a local agricultural officer before applying any chemical.", numericRefIds: [], claimIds: [] }]);
    expect(r.incomplete?.reasons).toEqual(expect.arrayContaining(["chemical_dosage", "template_substituted"]));
    expect(r.gateReport?.templated).toEqual([{ blockId: "b1", template: "chemical_dosage", numericRefIds: [] }]);
    expect(r.limitations.join(" ")).toMatch(/standard wording written by the application/);
    expect(JSON.stringify(r.approved)).not.toMatch(/chlorpyrifos|2\.5/);
  });
});

describe("loop ceilings", () => {
  it("the 7th tool round is refused: 6 rounds executed, the refusal is delivered to the model", async () => {
    const p = new Scripted((req) => {
      if (req.pass === "interpretation") return result({ outputText: profileJson() });
      if (req.pass === "tool_round") return result({ functionCalls: [call("resolve_crop_identity", { text: "ginger", language: "en", context: null })] });
      return result({ outputText: answerJson() });
    });
    const r = await runAgentTurn(await deps(p), turn());
    expect(r.toolRounds).toBe(6);
    expect(r.toolCalls).toBe(6);
    expect(p.requests.filter((q) => q.pass === "tool_round")).toHaveLength(7);
    expect((await pool.query("SELECT count(*) FROM tool_results WHERE agent_run_id=$1", [r.runId])).rows[0].count).toBe("6");
    expect(r.trace.steps.some((s) => s.kind === "ceiling_refused" && (s.detail as { ceiling: string }).ceiling === "tool_rounds")).toBe(true);
    const synth = p.requests.find((q) => q.pass === "synthesis")!;
    expect(JSON.stringify(synth.input)).toContain("ceiling_exceeded");
    expect(r.status).toBe("approved");
  });

  it("the 13th tool call is refused even within a round; calls beyond 12 never execute", async () => {
    const five = () => Array.from({ length: 5 }, () => call("resolve_crop_identity", { text: "ginger", language: "en", context: null }));
    const p = new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson() }) : req.pass === "tool_round" ? result({ functionCalls: five() }) : result({ outputText: answerJson() })));
    const r = await runAgentTurn(await deps(p), turn());
    expect(r.toolCalls).toBe(12);
    expect((await pool.query("SELECT count(*) FROM tool_results WHERE agent_run_id=$1", [r.runId])).rows[0].count).toBe("12");
    expect(r.trace.steps.some((s) => s.kind === "ceiling_refused" && (s.detail as { ceiling: string }).ceiling === "tool_calls")).toBe(true);
    expect(p.requests.filter((q) => q.pass === "tool_round")).toHaveLength(3); // stops after the ceiling is hit
    const synth = p.requests.find((q) => q.pass === "synthesis")!;
    expect(JSON.stringify(synth.input)).toContain("ceiling_exceeded");
  });

  it("repair attempts are capped at 2; Wonder is not used unless enabled", async () => {
    const p = new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson() }) : req.pass === "tool_round" ? result({ outputText: "x" }) : result({ outputText: "{ not json" })));
    const r = await runAgentTurn(await deps(p), turn());
    expect(p.requests.map((q) => q.pass)).toEqual(["interpretation", "tool_round", "synthesis", "repair", "repair"]);
    expect(p.requests.every((q) => q.model === MODELS.text)).toBe(true);
    expect(r.status).toBe("incomplete");
  });

  it("Wonder escalation: at most once, only when enabled, after repeated schema failure", async () => {
    const p = new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson() }) : req.pass === "tool_round" ? result({ outputText: "x" }) : result({ outputText: "{ not json" })));
    const r = await runAgentTurn(await deps(p, { limits: { wonderEnabled: true } }), turn());
    const escalated = p.requests.filter((q) => q.model === MODELS.escalation);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.pass).toBe("escalation");
    expect(p.requests).toHaveLength(6);
    expect(r.trace.steps.filter((s) => s.kind === "escalation")).toHaveLength(1);
    expect(r.status).toBe("incomplete");
  });

  it("needs_escalation routes the synthesis to Wonder only when enabled", async () => {
    const mk = () => new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson({ needsEscalation: true }) }) : req.pass === "tool_round" ? result({ outputText: "x" }) : result({ outputText: answerJson() })));
    const off = mk();
    await runAgentTurn(await deps(off), turn());
    expect(off.requests.some((q) => q.model === MODELS.escalation)).toBe(false);
    const on = mk();
    await runAgentTurn(await deps(on, { limits: { wonderEnabled: true } }), turn());
    expect(on.requests.filter((q) => q.model === MODELS.escalation)).toHaveLength(1);
  });

  it("ceilings come from configuration with safe fallbacks and a hard cap of one escalation", () => {
    expect(loadAgentLimits({ AGENT_MAX_TOOL_ROUNDS: "3", AGENT_MAX_TOOL_CALLS: "x", AGENT_MAX_WONDER_ESCALATIONS: "5", AGENT_WONDER_ENABLED: "true" })).toMatchObject({ maxToolRounds: 3, maxToolCalls: 12, maxWonderEscalations: 1, wonderEnabled: true });
    expect(loadAgentLimits({}).wonderEnabled).toBe(false);
  });
});

describe("budget handling", () => {
  const spies = (b: Budget) => ({ reserve: vi.spyOn(b, "reserve"), settle: vi.spyOn(b, "settle"), release: vi.spyOn(b, "release"), markUncertain: vi.spyOn(b, "markUncertain") });

  it("reserves worst case before every billable call and settles from actual usage; nothing released or uncertain", async () => {
    const b = new Budget(pool, budgetLimits());
    const s = spies(b);
    const p = new Scripted(happy);
    const r = await runAgentTurn(await deps(p, { budget: b }), turn());
    expect(r.status).toBe("approved");
    expect(s.reserve).toHaveBeenCalledTimes(3);
    expect(s.settle).toHaveBeenCalledTimes(3);
    expect(s.release).not.toHaveBeenCalled();
    expect(s.markUncertain).not.toHaveBeenCalled();
    // reserve happened before the provider call each time; the reservation covers worst case output
    const firstReserve = s.reserve.mock.calls[0]![0];
    expect(firstReserve).toMatchObject({ ownerId: owner, sessionId: session, provider: "meta", model: MODELS.text });
    expect(firstReserve.estimate).toBeGreaterThanOrEqual((DEFAULT_LIMITS.interpretationMaxOutputTokens * 4.25) / 1_000_000);
    // 3 calls x (1000 in x $1.25/M + 100 out x $4.25/M)
    expect(r.cost.settledUsd).toBeCloseTo(3 * (1000 * 1.25 + 100 * 4.25) / 1_000_000, 6);
    expect(r.cost.settledUsd).toBeLessThan(r.cost.estimatedUsd);
    const led = (await pool.query("SELECT count(*)::int AS n, bool_and(cost_basis='estimated') AS est FROM usage_ledger")).rows[0];
    expect(led).toEqual({ n: 3, est: true });
    expect((await pool.query("SELECT state, count(*)::int AS n FROM usage_reservations GROUP BY state")).rows).toEqual([{ state: "settled", n: 3 }]);
    expect(r.cost.cachedInputTokensObserved).toBe(0);
  });

  it("releases the reservation when the provider fails definitively", async () => {
    const b = new Budget(pool, budgetLimits());
    const s = spies(b);
    const r = await runAgentTurn(await deps(new Scripted(() => fail("provider_error", false)), { budget: b }), turn());
    expect(r.status).toBe("failed");
    expect(s.reserve).toHaveBeenCalledTimes(1);
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.markUncertain).not.toHaveBeenCalled();
    expect(s.settle).not.toHaveBeenCalled();
    expect((await b.summary())!.remainingDevUsd).toBeCloseTo(50, 6);
  });

  it("keeps the reservation as uncertain on timeout (no automatic release, no settle)", async () => {
    const b = new Budget(pool, budgetLimits());
    const s = spies(b);
    const r = await runAgentTurn(await deps(new Scripted(() => fail("timeout", true)), { budget: b }), turn());
    expect(r.status).toBe("failed");
    expect(s.markUncertain).toHaveBeenCalledTimes(1);
    expect(s.release).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state FROM usage_reservations")).rows).toEqual([{ state: "uncertain" }]);
    expect((await b.summary())!.remainingDevUsd).toBeLessThan(50);
  });

  it("a provider that throws instead of returning an outcome leaves the reservation uncertain, not leaked", async () => {
    const b = new Budget(pool, budgetLimits());
    const s = spies(b);
    const r = await runAgentTurn(await deps(new Scripted(() => { throw new Error("boom"); }), { budget: b }), turn());
    expect(r.status).toBe("failed");
    expect(s.markUncertain).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT state FROM usage_reservations")).rows).toEqual([{ state: "uncertain" }]);
  });

  it("a denied reservation stops the run before any provider call", async () => {
    const b = new Budget(pool, { ...budgetLimits(), devAllocationUsd: 0.0001 });
    const p = new Scripted(happy);
    const r = await runAgentTurn(await deps(p, { budget: b }), turn());
    expect(r.status).toBe("budget_exceeded");
    expect(p.requests).toHaveLength(0);
  });

  it("treats missing usage as the reserved estimate (never as free)", async () => {
    const b = new Budget(pool, budgetLimits());
    const p = new Scripted((req) => ({ ...happy(req), usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } }));
    const r = await runAgentTurn(await deps(p, { budget: b }), turn());
    expect(r.cost.settledUsd).toBeCloseTo(r.cost.estimatedUsd, 6);
    expect(r.cost.settledUsd).toBeGreaterThan(0);
  });

  it("chained calls reserve for the re-billed conversation, so estimates grow along the chain", async () => {
    const b = new Budget(pool, budgetLimits());
    const s = spies(b);
    await runAgentTurn(await deps(new Scripted(happy), { budget: b }), turn());
    const est = s.reserve.mock.calls.map((c) => c[0].estimate);
    expect(est[2]).toBeGreaterThan(est[1]!);
  });
});

describe("cancellation", () => {
  it("an already-aborted signal stops before any provider call or reservation", async () => {
    const ac = new AbortController();
    ac.abort();
    const b = new Budget(pool, budgetLimits());
    const p = new Scripted(happy);
    const r = await runAgentTurn(await deps(p, { signal: ac.signal, budget: b }), turn());
    expect(r.status).toBe("cancelled");
    expect(p.requests).toHaveLength(0);
    expect((await pool.query("SELECT status FROM agent_runs WHERE id=$1", [r.runId])).rows[0].status).toBe("cancelled");
  });

  it("aborting during a provider call cancels the run and leaves the in-flight reservation uncertain", async () => {
    const ac = new AbortController();
    const b = new Budget(pool, budgetLimits());
    const markUncertain = vi.spyOn(b, "markUncertain");
    const p = new Scripted(() => {
      ac.abort();
      return fail("aborted", true);
    });
    const r = await runAgentTurn(await deps(p, { signal: ac.signal, budget: b }), turn());
    expect(r.status).toBe("cancelled");
    expect(markUncertain).toHaveBeenCalledTimes(1);
  });

  it("aborting between tool calls stops execution of the remaining calls", async () => {
    const ac = new AbortController();
    const p = new Scripted((req) => {
      if (req.pass === "interpretation") return result({ outputText: profileJson() });
      if (req.pass === "tool_round") return result({ functionCalls: [call("resolve_crop_identity", { text: "a", language: "en", context: null }), call("resolve_crop_identity", { text: "b", language: "en", context: null })] });
      return result({ outputText: answerJson() });
    });
    const registry = new ToolRegistry({
      ...implementedBindings(),
      resolve_crop_identity: async () => {
        ac.abort();
        return { candidates: [], ambiguous: false, unresolvedReason: "no_alias_match" };
      },
    });
    const r = await runAgentTurn(await deps(p, { signal: ac.signal, registry }), turn());
    expect(r.status).toBe("cancelled");
    expect(r.toolCalls).toBe(1);
  });
});

describe("tool registry and allowlist", () => {
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ ownerId: owner, mode: "synthetic", requestId: "r", pool, agentRunId: "run", asOf: "2026-10-30T00:00:00Z", ...over });
  const reg = new ToolRegistry(implementedBindings());

  it("exposes exactly the 12 contract tools; unbound ones answer unavailable/tool_not_bound and are not advertised", async () => {
    expect(reg.all()).toHaveLength(12);
    const advertised = reg.advertisedFor("synthetic").map((t) => t.name).sort();
    expect(advertised).toEqual(["get_farm_context", "get_job_status", "resolve_crop_identity", "retrieve_evidence"]);
    const def = reg.get("screen_crops")!;
    expect(def.bound).toBe(false);
    expect(await reg.execute(def, { contextId: "c" }, ctx())).toEqual({ status: "unavailable", reason: "tool_not_bound" });
  });

  it("a bound handler is advertised and its output is validated against the contract", async () => {
    const bad = new ToolRegistry({ ...implementedBindings(), get_job_status: (async () => ({ nope: 1 })) as never });
    expect(await bad.execute(bad.get("get_job_status")!, { jobId: "j" }, ctx())).toMatchObject({ status: "error", code: "invalid_tool_output" });
    const good = new ToolRegistry({ ...implementedBindings(), screen_crops: async () => ({ results: [] }) });
    expect(good.advertisedFor("synthetic").map((t) => t.name)).toContain("screen_crops");
    expect(await good.execute(good.get("screen_crops")!, { contextId: "c" }, ctx())).toEqual({ status: "ok", output: { results: [] } });
  });

  it("rejects ownerId, mode and unknown fields in tool inputs", () => {
    for (const [name, args] of [
      ["resolve_crop_identity", { text: "ginger", language: "en", ownerId: "x" }],
      ["get_farm_context", { farmId: "f", ownerId: "x" }],
      ["retrieve_evidence", { limit: 3, mode: "live" }],
      ["get_job_status", { jobId: "j", ownerId: "x" }],
    ] as const) {
      const r = reg.parseArguments(name, JSON.stringify(args));
      expect(r.ok, name).toBe(false);
    }
    expect(reg.parseArguments("get_job_status", "{not json").ok).toBe(false);
    expect(reg.parseArguments("retrieve_evidence", JSON.stringify({ cropIds: null, regionIds: null, topics: null, availableBefore: null, limit: 3 })).ok).toBe(true);
  });

  it("in the loop, a model-supplied ownerId is refused before any handler runs", async () => {
    const handler = vi.fn(async () => ({ candidates: [], ambiguous: false, unresolvedReason: null }));
    const registry = new ToolRegistry({ ...implementedBindings(), resolve_crop_identity: handler });
    const p = new Scripted((req) => {
      if (req.pass === "interpretation") return result({ outputText: profileJson() });
      if (req.pass === "tool_round") return req.previousResponseId ? result({ outputText: "x" }) : result({ functionCalls: [call("resolve_crop_identity", { text: "ginger", language: "en", context: null, ownerId: otherOwner })] });
      return result({ outputText: answerJson() });
    });
    const r = await runAgentTurn(await deps(p, { registry }), turn());
    expect(handler).not.toHaveBeenCalled();
    const row = (await pool.query("SELECT status, error FROM tool_results WHERE agent_run_id=$1", [r.runId])).rows[0];
    expect(row.status).toBe("error");
    expect(row.error.code).toBe("invalid_arguments");
  });

  it("replay mode removes tools that read current data and never offers search grounding", async () => {
    const replay = reg.allowedFor("replay").map((t) => t.name);
    for (const n of ["interpret_observation", "request_segmentation", "request_visual_keyframes", "get_job_status"]) {
      expect(replay).not.toContain(n);
      expect(reg.isAllowed(n, "replay")).toBe(false);
      expect(reg.isAllowed(n, "live")).toBe(true);
    }
    expect(reg.advertisedFor("replay").map((t) => t.name)).toEqual(["resolve_crop_identity", "get_farm_context", "retrieve_evidence"]);
    expect(JSON.stringify(reg.advertisedFor("replay"))).not.toMatch(/search|ground/i);
    expect(reg.isAllowed("web_search", "replay")).toBe(false);
    expect(reg.isAllowed("search_grounding", "live")).toBe(false);
  });

  it("in replay mode the loop refuses a current-data tool call even if the model asks for it", async () => {
    const p = new Scripted((req) => {
      if (req.pass === "interpretation") return result({ outputText: profileJson() });
      if (req.pass === "tool_round") return req.previousResponseId ? result({ outputText: "x" }) : result({ functionCalls: [call("get_job_status", { jobId: "00000000-0000-4000-8000-000000000001" })] });
      return result({ outputText: answerJson() });
    });
    const r = await runAgentTurn(await deps(p), turn({ mode: "replay", asOf: "2026-03-01T00:00:00Z" }));
    const row = (await pool.query("SELECT status, error FROM tool_results WHERE agent_run_id=$1", [r.runId])).rows[0];
    expect(row.error.code).toBe("tool_not_allowed");
    const advertisedNames = p.requests.find((q) => q.pass === "tool_round")!.tools!.map((t) => t.name);
    expect(advertisedNames).not.toContain("get_job_status");
  });

  it("unknown tool names are refused and stored without trusting the name", async () => {
    const p = new Scripted((req) => {
      if (req.pass === "interpretation") return result({ outputText: profileJson() });
      if (req.pass === "tool_round") return req.previousResponseId ? result({ outputText: "x" }) : result({ functionCalls: [call("web_search", { q: "rain" })] });
      return result({ outputText: answerJson() });
    });
    const r = await runAgentTurn(await deps(p), turn());
    const row = (await pool.query("SELECT tool_name, error FROM tool_results WHERE agent_run_id=$1", [r.runId])).rows[0];
    expect(row.error.code).toBe("unknown_tool");
    expect(row.tool_name).toBe("invalid:web_search");
  });
});

describe("implemented tool handlers", () => {
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ ownerId: owner, mode: "synthetic", requestId: "r", pool, agentRunId: "run", asOf: "2026-10-30T00:00:00Z", ...over });
  const reg = new ToolRegistry(implementedBindings());
  const run = async (name: Parameters<ToolRegistry["get"]>[0], args: unknown, c = ctx()) => {
    const parsed = reg.parseArguments(name as never, JSON.stringify(args));
    if (!parsed.ok) throw new Error(parsed.message);
    return reg.execute(reg.get(name)!, parsed.input, c);
  };

  it("resolve_crop_identity never forces a match", async () => {
    const none = await run("resolve_crop_identity", { text: "dragonfruit", language: "en", context: null });
    expect(none).toEqual({ status: "ok", output: { candidates: [], ambiguous: false, unresolvedReason: "no_alias_match" } });
    const dry = await run("resolve_crop_identity", { text: "Ginger (dry)", language: "en", context: null });
    expect(dry).toMatchObject({ status: "ok", output: { candidates: [{ cropId: GINGER_ID, productId: "00000000-0000-4000-8000-0000000000d2" }] } });
  });

  it("get_farm_context is owner scoped, hides precise coordinates and provenance-labels facts", async () => {
    const farm = await createFarm(pool, owner, { name: "Plot", location: { districtId: "IN-KA-HAS", districtName: "Hassan", stateCode: "KA", precision: "precise", lat: 13.00712345, lon: 76.10223456 }, areaHectares: 0.81, facts: { soil_ph: { value: 6.4, unit: "pH", basis: "lab_test", confirmed: true, source: "lab" }, irrigation: { value: "rainfed", basis: "farmer_reported", confirmed: false } } } as never);
    const ok = await run("get_farm_context", { farmId: farm.id });
    expect(ok.status).toBe("ok");
    const out = (ok as { output: { farm: { location: { value: { districtId: string; point: unknown } }; soil: { ph: { value: number; basis: string; confirmed: boolean } }; water: { category: { value: string } }; area: { value: { amount: number; unit: string } } } } }).output.farm;
    expect(out.location.value).toMatchObject({ districtId: "IN-KA-hassan", point: null });
    expect(out.soil.ph).toMatchObject({ value: 6.4, basis: "lab_test", confirmed: true });
    expect(out.water.category.value).toBe("rainfed");
    expect(out.area.value).toEqual({ amount: 0.81, unit: "ha" });
    expect(JSON.stringify(ok)).not.toMatch(/13\.0071|76\.1022/);
    // another owner, a missing farm and a malformed id are indistinguishable
    const foreign = await run("get_farm_context", { farmId: farm.id }, ctx({ ownerId: otherOwner }));
    const missing = await run("get_farm_context", { farmId: "00000000-0000-4000-8000-000000000999" });
    expect(foreign).toMatchObject({ status: "error", code: "not_found" });
    expect(missing).toEqual(foreign);
  });

  it("retrieve_evidence filters crop, region, topic, mode and availability; returns ids and excerpts only for validated rows", async () => {
    const keep = await seedEvidence(pool, { geographyIds: ["IN-KA-HAS"], topics: ["irrigation"] });
    await seedEvidence(pool, { geographyIds: ["IN-KA-MND"] }); // other district
    await seedEvidence(pool, { cropIds: ["other"] }); // other crop
    await seedEvidence(pool, { topics: ["pest"] }); // other topic
    await seedEvidence(pool, { validation: "pending" });
    await seedEvidence(pool, { mode: "live" }); // wrong mode for synthetic
    await seedEvidence(pool, { availableAt: "2027-06-01T00:00:00Z" }); // not yet available at asOf
    const nat = await seedEvidence(pool, { level: "national", geographyIds: ["IN"], topics: ["irrigation"] });
    const r = await run("retrieve_evidence", { cropIds: [GINGER_ID], regionIds: ["IN-KA-HAS"], topics: ["irrigation"], limit: 10 });
    const ids = (r as { output: { passages: { evidenceId: string; scope: { level: string }; excerpt: string }[] } }).output.passages.map((p) => p.evidenceId).sort();
    expect(ids).toEqual([keep, nat].sort());
  });

  it("retrieve_evidence in replay requires a verified availability time at or before the cutoff", async () => {
    const early = await seedEvidence(pool, { mode: "replay", availableAt: "2026-01-01T00:00:00Z" });
    await seedEvidence(pool, { mode: "replay", availableAt: "2026-06-01T00:00:00Z" }); // after cutoff
    await seedEvidence(pool, { mode: "replay", availableAt: null }); // unknown availability: rejected in replay
    await seedEvidence(pool, { mode: "replay", availableAt: "2026-01-01T00:00:00Z", basis: "unverified" });
    const r = await run("retrieve_evidence", { limit: 10 }, ctx({ mode: "replay", asOf: "2026-03-01T00:00:00Z" }));
    expect((r as { output: { passages: { evidenceId: string }[] } }).output.passages.map((p) => p.evidenceId)).toEqual([early]);
    const capped = await run("retrieve_evidence", { limit: 10, availableBefore: "2025-12-31T00:00:00Z" }, ctx({ mode: "replay", asOf: "2026-03-01T00:00:00Z" }));
    expect((capped as { output: { passages: unknown[] } }).output.passages).toEqual([]);
  });

  it("get_job_status is owner scoped", async () => {
    const j = (await pool.query<{ id: string }>("INSERT INTO jobs (owner_id, type) VALUES ($1,'segmentation') RETURNING id", [owner])).rows[0]!.id;
    expect(await run("get_job_status", { jobId: j })).toMatchObject({ status: "ok", output: { jobId: j, state: "queued", progress: 0, resultIds: [], errorCode: null } });
    expect(await run("get_job_status", { jobId: j }, ctx({ ownerId: otherOwner }))).toMatchObject({ status: "error", code: "not_found" });
  });
});

describe("trace redaction", () => {
  it("redactForTrace removes coordinates, image data URLs and truncates long free text", () => {
    const long = "ஏ".repeat(500);
    const r = redactForTrace({ text: long, location: { lat: 13.0071234, lon: 76.1022345, point: { coordinates: [76.1, 13.0] } }, image_url: "data:image/jpeg;base64,AAAA", note: "met at 13.0071234, 76.1022345 today", nested: [{ transcript: "x".repeat(300) }] }) as Record<string, any>;
    expect(r.text.length).toBeLessThan(260);
    expect(r.location.lat).toBe("[coordinates redacted]");
    expect(r.location.point).toBe("[coordinates redacted]");
    expect(r.image_url).toBe("[omitted]");
    expect(r.note).not.toMatch(/13\.0071/);
    expect(r.nested[0].transcript.length).toBeLessThan(260);
    expect(JSON.stringify(r)).not.toMatch(/data:image|76\.1022/);
  });

  it("a persisted run never contains raw coordinates, photo data or long transcripts", async () => {
    const farm = await createFarm(pool, owner, { name: "Plot", location: { districtId: "IN-KA-HAS", districtName: "Hassan", stateCode: "KA", precision: "precise", lat: 13.00712345, lon: 76.10223456 }, areaHectares: 1 } as never);
    const longText = `I have a field at 13.00712345, 76.10223456. ${"very long story ".repeat(40)} data:image/jpeg;base64,${"QUJD".repeat(50)}`;
    const p = new Scripted((req) => {
      if (req.pass === "interpretation") return result({ outputText: profileJson() });
      if (req.pass === "tool_round") return req.previousResponseId ? result({ outputText: "x" }) : result({ functionCalls: [call("get_farm_context", { farmId: farm.id })] });
      return result({ outputText: answerJson() });
    });
    const r = await runAgentTurn(await deps(p), turn({ text: longText, farmId: farm.id }));
    const stored = (await pool.query("SELECT trace, limits, output FROM agent_runs WHERE id=$1", [r.runId])).rows[0];
    const blob = JSON.stringify(stored.trace);
    expect(blob).not.toMatch(/13\.00712|76\.10223/);
    expect(blob).not.toContain("QUJDQUJD");
    expect(blob).not.toContain("very long story very long story very long story very long story very long story very long story very long story very long story very long story very long story");
    const startStep = stored.trace.steps.find((s: { kind: string }) => s.kind === "run_started");
    // F9: the farmer's message is stored as length + sha256 only (previously a 200-char prefix).
    expect(startStep.detail.text).toBeUndefined();
    expect(startStep.detail.textLength).toBe(longText.length);
    expect(startStep.detail.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(blob).not.toContain("I have a field");
    // the model-visible farm context withheld the precise point
    const farmView = (p.requests.find((q) => Array.isArray(q.input) && q.input.some((i) => "type" in i && i.type === "function_call_output"))!.input as { output: string }[])[0]!.output;
    expect(farmView).not.toMatch(/13\.0071|76\.1022/);
    // request bodies sent to the model never include a public image URL
    expect(JSON.stringify(p.requests.map((q) => q.input))).not.toMatch(/https?:\/\/[^"]*\.(jpg|png)/);
  });
});
