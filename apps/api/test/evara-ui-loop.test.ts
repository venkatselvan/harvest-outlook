import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvaraUi } from "@harvest/contracts";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { Budget } from "../src/services/budget";
import { createFarm } from "../src/services/farms";
import { putWorkspace } from "../src/services/workspace";
import { FixtureProvider } from "../src/agent/fixture-provider";
import { DEFAULT_LIMITS } from "../src/agent/limits";
import { runAgentTurn, type AgentTurnInput } from "../src/agent/loop";
import type { ProviderOutcome, TextModelProvider, TextRequest, TextResult } from "../src/agent/provider";
import { implementedBindings } from "../src/agent/tools/handlers";
import { ToolRegistry } from "../src/agent/tools/registry";
import { loadEvaraData } from "../src/agent/ui/load";
import { GINGER_ID, seedGinger, seedOwner, seedSession } from "./fixtures/meta/helpers";
import { TEST_DB } from "./helpers";

/** Evara UI in the loop (synthetic mode and a scripted provider) and the read-only loader against a real database. */
let pool: Pool;
let owner: string;
let session: string;

beforeAll(async () => {
  pool = createPool(TEST_DB);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
  owner = await seedOwner(pool);
  session = await seedSession(pool, owner);
  await seedGinger(pool);
});
afterAll(async () => pool.end());

const MODELS = { text: "muse-spark-1.3", escalation: "muse-wonder-1.0" };
async function deps(provider: TextModelProvider) {
  const budget = new Budget(pool, { totalUsd: 100, devAllocationUsd: 50, demoReserveUsd: 1, perSessionUsd: 40, perOwnerDayUsd: 40 });
  await budget.init();
  return { pool, budget, provider, registry: new ToolRegistry(implementedBindings()), limits: { ...DEFAULT_LIMITS }, models: MODELS };
}
const turn = (over: Partial<AgentTurnInput> = {}): AgentTurnInput => ({ ownerId: owner, sessionId: session, mode: "synthetic", requestId: "req-evara", language: "en", text: "I have 2 acres and little water in Hassan", geographyIds: ["IN-KA-HAS", "KA", "IN-KA", "IN"], ...over });

let seq = 0;
const result = (over: Partial<TextResult> = {}): TextResult => ({ provenance: "meta_live", responseId: `resp_${++seq}`, requestId: `rq_${seq}`, model: "muse-spark-1.3", outputText: null, functionCalls: [], usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, latencyMs: 1, retries: 0, ...over });
const profileJson = (intent: string) => JSON.stringify({ intent, language: "en", cropMentions: [], facts: [], needsEscalation: false, clarificationQuestion: null });
const answerJson = (over: object = {}) =>
  JSON.stringify({ schemaVersion: "1.0", intent: "observation", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [{ id: "b1", kind: "text", text: "Please confirm your water source.", numericRefIds: [], claimIds: [] }, { id: "b2", kind: "text", text: "Check the field after rain.", numericRefIds: [], claimIds: [] }], numericRefs: [], claimEvidenceRefs: [], proposedPlanChange: null, limitations: [], ...over });
class Scripted implements TextModelProvider {
  readonly kind = "meta" as const;
  readonly provenance = "meta_live" as const;
  readonly billable = false;
  constructor(private readonly script: (req: TextRequest) => TextResult) {}
  async call(req: TextRequest): Promise<ProviderOutcome> {
    return { ok: true, result: this.script(req) };
  }
}
const scripted = (intent: string, ui: string | null) => new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson(intent) }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson({ intent, ui }) })));
const uiStep = (r: Awaited<ReturnType<typeof runAgentTurn>>) => r.trace.toJSON().steps.find((s) => s.kind === "ui_resolved");

describe("loop: Evara UI after the gate", () => {
  it("synthetic fixture (no ui in the output): the fallback composer gives a stack of the approved text blocks; traced", async () => {
    const r = await runAgentTurn(await deps(new FixtureProvider("profile_extraction")), turn());
    expect(r.status).toBe("approved");
    expect(r.ui).not.toBeNull();
    expect(EvaraUi.safeParse(r.ui).success).toBe(true);
    expect(r.ui!.origin).toBe("fallback");
    expect(r.ui!.root.type).toBe("stack");
    const kids = (r.ui!.root as { children: { type: string; blockId?: string; text?: string }[] }).children;
    const texts = kids.filter((k) => k.type === "text");
    expect(texts.map((k) => k.blockId)).toEqual(r.approved.answerBlocks.map((b) => b.id));
    expect(texts.map((k) => k.text)).toEqual(r.approved.answerBlocks.map((b) => b.text));
    expect(uiStep(r)?.detail).toMatchObject({ origin: "fallback", root: "stack", programChars: 0 });
    const stored = (await pool.query("SELECT trace FROM agent_runs WHERE id=$1", [r.runId])).rows[0].trace;
    expect(stored.steps.some((s: { kind: string }) => s.kind === "ui_resolved")).toBe(true);
  });

  it("a model program is resolved (origin model); a prose string is dropped and the trace never carries the program text", async () => {
    const r = await runAgentTurn(await deps(scripted("observation", 'root = Stack([Text("b2"), Text("b1")])\nnote = Callout("info", "Water the field daily")')), turn());
    expect(r.ui!.origin).toBe("model");
    expect((r.ui!.root as { children: { blockId: string }[] }).children.map((c) => c.blockId)).toEqual(["b2", "b1"]);
    const bad = await runAgentTurn(await deps(scripted("observation", 'root = Stack([a, Text("b1")])\na = Callout("info", "Water the field daily")')), turn());
    expect(bad.ui!.dropped).toContainEqual({ line: 2, code: "prose-not-allowed", detail: expect.any(String) });
    expect(uiStep(bad)?.detail).toMatchObject({ origin: "model", dropped: [{ line: 2, code: "prose-not-allowed" }] });
    expect(JSON.stringify(bad.trace.toJSON())).not.toContain("Callout(");
  });

  // Review fix E7c-3: an over-long program is cut before the strict validation; the answer is not repaired or withheld.
  it("a ui program over 4000 characters is truncated (parse-failed / program truncated), the candidate validates and the turn proceeds", async () => {
    const filler = Array.from({ length: 50 }, (_, i) => `n${i} = Text("b1") # ${"p".repeat(80)}`);
    const program = ['root = Stack([Text("b2"), Text("b1")])', ...filler].join("\n");
    expect(program.length).toBeGreaterThan(4000);
    const passes: string[] = [];
    const p = new Scripted((req) => {
      passes.push(req.pass);
      return req.pass === "interpretation" ? result({ outputText: profileJson("observation") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: answerJson({ ui: program }) });
    });
    const r = await runAgentTurn(await deps(p), turn());
    expect(passes.filter((x) => x === "repair" || x === "escalation")).toEqual([]);
    const gates = r.trace.toJSON().steps.filter((s) => s.kind === "gate");
    expect(gates.flatMap((g) => (g.detail as { issues: { code: string }[] }).issues.map((i) => i.code))).not.toContain("schema_invalid");
    expect(r.approved.answerBlocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(r.ui!.origin).toBe("model");
    expect((r.ui!.root as { children: { blockId: string }[] }).children.map((c) => c.blockId)).toEqual(["b2", "b1"]);
    expect(r.ui!.dropped).toContainEqual({ line: expect.any(Number), code: "parse-failed", detail: "program truncated" });
    expect(r.ui!.dropped[0]!.line).toBeGreaterThan(30);
    expect(uiStep(r)?.detail).toMatchObject({ origin: "model", programChars: expect.any(Number) });
    expect((uiStep(r)!.detail as { programChars: number }).programChars).toBeLessThanOrEqual(4000);
  });

  it("a failed turn still returns a fallback tree with the code callout", async () => {
    const p = new Scripted((req) => (req.pass === "interpretation" ? result({ outputText: profileJson("observation") }) : req.pass === "tool_round" ? result({ outputText: "done" }) : result({ outputText: "not json" })));
    const r = await runAgentTurn(await deps(p), turn());
    expect(r.approved.answerBlocks).toEqual([]);
    expect(r.ui!.origin).toBe("fallback");
    expect((r.ui!.root as { children: { type: string; text: string }[] }).children[0]).toMatchObject({ type: "callout", text: expect.stringMatching(/could not produce a checked answer/) });
  });
});

describe("loadEvaraData (read-only, guarded)", () => {
  it("reads crop names, the viewed field's saved seasons with realisation and the stored crop-fit review", async () => {
    const farm = await createFarm(pool, owner, { name: "Evara plot", location: { districtId: "IN-KA-HAS", districtName: "Hassan", stateCode: "KA", precision: "precise", lat: 13.00712345, lon: 76.10223456 }, areaHectares: 0.5 } as never);
    await putWorkspace(pool, owner, farm.id, {
      expectedVersion: 0, boundary: null, previousHarvest: { status: "unknown" },
      cycles: [{ id: "c1", cropId: "paddy", cropName: "Paddy", sowingDate: "2026-10-31", stage: "sowed" }],
      rotationPlans: [
        { id: "rp-planned", year: 2027, season: "Summer", cropId: "pigeon-pea", cropName: "Pigeon pea", plannedSowingDate: "2027-02-12" },
        { id: "rp-sown", year: 2026, season: "Rabi", cropId: "paddy", cropName: "Paddy", plannedSowingDate: "2026-10-20" },
        { id: "rp-overdue", year: 2026, season: "Kharif", cropId: "maize", cropName: "Maize", plannedSowingDate: "2026-07-01" },
      ],
    } as never);
    const before = (await pool.query("SELECT (SELECT count(*) FROM jobs) j, (SELECT count(*) FROM crop_fit_reviews) f")).rows[0];
    const data = await loadEvaraData(pool, { ownerId: owner, mode: "synthetic", farmId: farm.id, asOf: "2026-11-04T05:00:00.000Z", language: "en", intent: "compare_crops", blocks: [], hasClarification: false, program: null, toolOutputs: [{ name: "resolve_crop_identity", output: { candidates: [{ cropId: GINGER_ID, productId: null, matchedAlias: "Ginger", aliasLanguage: "en", matchKind: "exact", products: [] }], ambiguous: false, unresolvedReason: null } }] });
    expect(data.crops[GINGER_ID]).toEqual({ slug: "ginger", en: "Ginger", hi: "अदरक", ta: "இஞ்சி" });
    expect(data.crops.ginger).toBe(data.crops[GINGER_ID]);
    expect(data.resolvedCropIds).toEqual([GINGER_ID]);
    expect(data.today).toBe("2026-11-04");
    expect(data.occupants.map((o) => [o.rotationPlanId, o.realisation])).toEqual([["rp-planned", "planned"], ["rp-sown", "sown"], ["rp-overdue", "overdue"]]);
    expect(data.currentCycle).toEqual({ cropId: "paddy", productId: null, sowingDate: "2026-10-31" });
    expect(data.cropFit).toBeNull();
    expect(data.yearPlan).toBeNull(); // not a plan turn, and no config
    // Review fix E7c-4: an @AddSeason crop's catalogue compare row (its planting window) is requested on a non-crop turn too.
    // This database has no loaded catalogue (only the seeded ginger identity), so the source is attempted and reported failed;
    // the resolver then applies the 730-day bound only. Without @AddSeason the source is not touched at all.
    const seen: Record<string, string> = {};
    await loadEvaraData(pool, { ownerId: owner, mode: "synthetic", farmId: farm.id, asOf: "2026-11-04T05:00:00.000Z", language: "en", intent: "observation", blocks: [], hasClarification: false, program: 'root = Stack([Actions([@AddSeason("ginger", "2027-04-10")])])', toolOutputs: [], report: (src, st) => void (seen[src] = st) });
    expect(seen).toHaveProperty("farm", "ok");
    expect(seen).toHaveProperty("catalogue_compare");
    const plainSeen: Record<string, string> = {};
    await loadEvaraData(pool, { ownerId: owner, mode: "synthetic", farmId: farm.id, asOf: "2026-11-04T05:00:00.000Z", language: "en", intent: "observation", blocks: [], hasClarification: false, program: 'root = Stack([Actions([@Open("plan")])])', toolOutputs: [], report: (src, st) => void (plainSeen[src] = st) });
    expect(plainSeen).not.toHaveProperty("catalogue_compare");
    expect(plainSeen).not.toHaveProperty("farm");
    const after = (await pool.query("SELECT (SELECT count(*) FROM jobs) j, (SELECT count(*) FROM crop_fit_reviews) f")).rows[0];
    expect(after).toEqual(before); // nothing enqueued or written
  });

  it("a failing source becomes absent data, never a throw; the report names it", async () => {
    const broken = new Proxy(pool, { get: (t, p) => (p === "query" ? () => Promise.reject(new Error("db down")) : Reflect.get(t, p)) }) as Pool;
    const seen: Record<string, string> = {};
    const data = await loadEvaraData(broken, { ownerId: owner, mode: "synthetic", farmId: "11111111-1111-4111-8111-111111111111", asOf: new Date().toISOString(), language: "hi", intent: "plan_question", blocks: [], hasClarification: false, program: 'root = Stack([PlanOptions(null)])', toolOutputs: [], report: (s, st) => void (seen[s] = st) });
    expect(seen).toMatchObject({ catalogue_names: "failed", workspace: "failed", crop_fit: "failed", year_plan: "skipped" });
    expect(data).toMatchObject({ cropFit: null, yearPlan: null, occupants: [], language: "hi" });
  });
});
