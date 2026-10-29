import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { Budget } from "../src/services/budget";
import { createFarm } from "../src/services/farms";
import { FixtureProvider } from "../src/agent/fixture-provider";
import { DEFAULT_LIMITS } from "../src/agent/limits";
import { runAgentTurn, type AgentTurnInput } from "../src/agent/loop";
import type { ProviderOutcome, TextModelProvider, TextRequest } from "../src/agent/provider";
import { riskSentence } from "../src/agent/templates";
import { implementedBindings } from "../src/agent/tools/handlers";
import { ToolRegistry } from "../src/agent/tools/registry";
import { GINGER_ID, seedEvidence, seedGinger, seedOwner, seedSession } from "./fixtures/meta/helpers";
import { TEST_DB } from "./helpers";

/** F5 loop-level evidence: Hindi/Tamil templating end to end, referenced Hindi numbers, plan crop scope, farm_id, trace privacy, D28. */

let pool: Pool;
let owner: string;
let other: string;
let session: string;

beforeAll(async () => {
  pool = createPool(TEST_DB);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
  owner = await seedOwner(pool);
  other = await seedOwner(pool);
  session = await seedSession(pool, owner);
  await seedGinger(pool);
});
afterAll(async () => pool.end());
beforeEach(async () => {
  await pool.query("DELETE FROM tool_results; DELETE FROM agent_runs; DELETE FROM evidence_records; DELETE FROM source_documents");
});

const HASSAN = { districtId: "IN-KA-HAS", stateCode: "KA" };
const turn = (over: Partial<AgentTurnInput> = {}): AgentTurnInput => ({ ownerId: owner, sessionId: session, mode: "synthetic", requestId: "req-f5", language: "en", text: "I have 2 acres in Hassan", farmGeography: HASSAN, ...over });
async function deps(provider: TextModelProvider) {
  const budget = new Budget(pool, { totalUsd: 100, devAllocationUsd: 50, demoReserveUsd: 1, perSessionUsd: 40, perOwnerDayUsd: 40 });
  await budget.init();
  return { pool, budget, provider, registry: new ToolRegistry(implementedBindings()), limits: { ...DEFAULT_LIMITS }, models: { text: "muse-spark-1.3", escalation: "muse-wonder-1.0" } };
}
const farm = (o: { areaHectares?: number; ownerId?: string } = {}) =>
  createFarm(pool, o.ownerId ?? owner, { name: "Plot", location: { districtId: "IN-KA-HAS", districtName: "Hassan", stateCode: "KA", precision: "district" }, areaHectares: o.areaHectares ?? 0.81 } as never);

/** Free scripted provider: interpretation, no tools, then a fixed synthesis answer on every synthesis/repair. */
class Fixed implements TextModelProvider {
  readonly kind = "fixture" as const;
  readonly provenance = "synthetic_fixture" as const;
  readonly billable = false;
  readonly passes: string[] = [];
  private n = 0;
  constructor(private readonly answer: object) {}
  async call(req: TextRequest): Promise<ProviderOutcome> {
    this.passes.push(req.pass);
    const text = req.pass === "interpretation" ? JSON.stringify({ intent: "plan_question", language: "en", cropMentions: [], facts: [], needsEscalation: false, clarificationQuestion: null }) : req.pass === "tool_round" ? "no tools" : JSON.stringify(this.answer);
    return { ok: true, result: { provenance: "synthetic_fixture", responseId: `fx_${++this.n}`, requestId: `fx_${this.n}`, model: req.model, outputText: text, functionCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, latencyMs: 0, retries: 0 } };
  }
}
const answer = (o: object) => ({ schemaVersion: "1.0", intent: "plan_question", language: "en", proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [], numericRefs: [], claimEvidenceRefs: [], proposedPlanChange: null, limitations: [], ...o });

describe("Hindi and Tamil unsafe prose is withheld and templated end to end", () => {
  it.each([
    ["hi", "hi_unsafe_dosage_diagnosis", /सड़न|मिलीलीटर|छिड़काव|निश्चित/],
    ["ta", "ta_unsafe_dosage_diagnosis", /அழுகல்|மில்லி|தெளிக்கவும்|நிச்சயமாக/],
  ] as const)("%s", async (lang, scenario, forbidden) => {
    const f = new FixtureProvider(scenario);
    const r = await runAgentTurn(await deps(f), turn({ language: lang, text: lang === "hi" ? "मेरी अदरक के पत्ते पीले हैं" : "என் இஞ்சி இலைகள் மஞ்சளாக உள்ளன" }));
    expect(f.seenPasses).toEqual(["interpretation", "tool_round", "synthesis", "repair", "repair"]);
    expect(r.status).toBe("partial");
    expect(r.approved.answerBlocks.map((b) => [b.id, b.text])).toEqual([
      ["b1", riskSentence(lang, "diagnosis_certainty")],
      ["b2", riskSentence(lang, "chemical_dosage")],
    ]);
    expect(JSON.stringify(r.approved)).not.toMatch(forbidden);
    expect(r.incomplete?.reasons).toEqual(expect.arrayContaining(["diagnosis_certainty", "chemical_dosage", "template_substituted"]));
    expect(r.gateReport?.templated.map((t) => t.template)).toEqual(["diagnosis_certainty", "chemical_dosage"]);
    expect(r.gateReport?.removed.filter((x) => x.field === "answerBlock").map((x) => x.id)).toEqual(["b1", "b2"]);
    const stored = (await pool.query("SELECT output FROM agent_runs WHERE id=$1", [r.runId])).rows[0].output;
    expect(JSON.stringify(stored)).not.toMatch(forbidden);
  });

  it("a Hindi answer whose numbers are all referenced (with unit conversion) is approved without repair", async () => {
    const f0 = await farm({ areaHectares: 0.81 });
    const f = new FixtureProvider("hi_referenced_numbers", undefined, { farmId: f0.id });
    const r = await runAgentTurn(await deps(f), turn({ language: "hi", text: "मेरे खेत का क्षेत्रफल बताइए", farmId: f0.id, farmGeography: undefined }));
    expect(f.seenPasses).toEqual(["interpretation", "tool_round", "tool_round", "synthesis"]);
    expect(r.status).toBe("approved");
    expect(r.approved.answerBlocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(r.approved.numericRefs.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(r.limitations).toContain("पानी के स्रोत की जानकारी अभी उपलब्ध नहीं है।");
  });
});

describe("server-derived claim scope", () => {
  const claimAnswer = (claim: object = {}) =>
    answer({ answerBlocks: [{ id: "b1", kind: "evidence", text: "Keep the soil evenly moist during rhizome development.", numericRefIds: [], claimIds: ["c1"] }], claimEvidenceRefs: [{ claimId: "c1", text: "Keep soil evenly moist.", evidenceIds: [EV], ...claim }] });
  const EV = "00000000-0000-4000-8000-0000000000e5";

  it("crop scope comes from the plan's crop; without a plan an undeclared claim is withheld", async () => {
    await seedEvidence(pool, { id: EV });
    const f0 = await farm();
    const plan = (await pool.query<{ id: string }>("INSERT INTO plans (owner_id, farm_id, crop_id, mode, content_hash, snapshot) VALUES ($1,$2,$3,'synthetic',md5(random()::text),'{}'::jsonb) RETURNING id", [owner, f0.id, GINGER_ID])).rows[0]!.id;
    const withPlan = await runAgentTurn(await deps(new Fixed(claimAnswer())), turn({ planId: plan }));
    expect(withPlan.status).toBe("approved");
    expect(withPlan.approved.claimEvidenceRefs).toEqual([{ claimId: "c1", text: "Keep soil evenly moist.", evidenceIds: [EV] }]); // agent-local fields never leave the server
    const noPlan = await runAgentTurn(await deps(new Fixed(claimAnswer())), turn());
    expect(noPlan.approved.answerBlocks).toEqual([]);
    expect(noPlan.incomplete?.reasons).toContain("claim_crop_scope_missing");
    const declared = await runAgentTurn(await deps(new Fixed(claimAnswer({ cropIds: [GINGER_ID], granularity: "district" }))), turn());
    expect(declared.status).toBe("approved");
    // another owner's plan id contributes no scope
    const foreignPlan = await runAgentTurn(await deps(new Fixed(claimAnswer())), turn({ ownerId: other, sessionId: null, planId: plan }));
    expect(foreignPlan.incomplete?.reasons).toContain("claim_crop_scope_missing");
  });
});

describe("agent_runs.farm_id and trace privacy", () => {
  it("farm_id is set for an owned farm only, and farm deletion can find the run", async () => {
    const mine = await farm();
    const theirs = await farm({ ownerId: other });
    const ok = answer({ answerBlocks: [{ id: "b1", kind: "text", text: "Please confirm your water source.", numericRefIds: [], claimIds: [] }] });
    const r1 = await runAgentTurn(await deps(new Fixed(ok)), turn({ farmId: mine.id }));
    const r2 = await runAgentTurn(await deps(new Fixed(ok)), turn({ farmId: theirs.id }));
    const rows = (await pool.query("SELECT id, farm_id FROM agent_runs WHERE id = ANY($1::uuid[])", [[r1.runId, r2.runId]])).rows;
    expect(rows.find((x) => x.id === r1.runId)!.farm_id).toBe(mine.id);
    expect(rows.find((x) => x.id === r2.runId)!.farm_id).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM agent_runs WHERE farm_id = $1", [mine.id])).rows[0].n).toBe(1);
  });

  it("the trace stores only the length and sha256 of the farmer's message", async () => {
    const text = "Private note: my neighbour Ravi owes me money for the ginger seed";
    const r = await runAgentTurn(await deps(new Fixed(answer({ answerBlocks: [{ id: "b1", kind: "text", text: "Please confirm your water source.", numericRefIds: [], claimIds: [] }] }))), turn({ text }));
    const blob = JSON.stringify((await pool.query("SELECT trace FROM agent_runs WHERE id=$1", [r.runId])).rows[0].trace);
    expect(blob).not.toMatch(/Ravi|neighbour|Private note/);
    const start = r.trace.steps.find((s) => s.kind === "run_started")!.detail as Record<string, unknown>;
    expect(start).toMatchObject({ textLength: text.length });
    expect(start.textSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("D28: retrieve_evidence returns machine-grounded rows with their status", () => {
  /**
   * The CHECK constraint on evidence_records.validation_status does not yet allow 'grounded' (INT2 adds
   * that migration concurrently). This test widens it in the test database only, mirroring that change.
   */
  async function allowGrounded() {
    const c = await pool.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid = 'evidence_records'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%validation_status%'");
    for (const row of c.rows) await pool.query(`ALTER TABLE evidence_records DROP CONSTRAINT "${row.conname}"`);
    await pool.query("ALTER TABLE evidence_records ADD CONSTRAINT evidence_records_validation_status_check CHECK (validation_status IN ('validated','grounded','unsupported','pending','rejected'))");
  }

  it("returns validated and grounded rows with validationStatus; never pending or rejected", async () => {
    await allowGrounded();
    const v = await seedEvidence(pool);
    const g = await seedEvidence(pool, { validation: "grounded" as never });
    await seedEvidence(pool, { validation: "pending" });
    await seedEvidence(pool, { validation: "rejected" });
    const reg = new ToolRegistry(implementedBindings());
    const out = await reg.execute(reg.get("retrieve_evidence")!, { cropIds: [GINGER_ID], limit: 10 }, { ownerId: owner, mode: "synthetic", requestId: "r", pool, agentRunId: "run", asOf: "2026-10-30T00:00:00Z" });
    expect(out.status).toBe("ok");
    const passages = (out as { output: { passages: { evidenceId: string; validationStatus: string }[] } }).output.passages;
    expect(passages.map((p) => [p.evidenceId, p.validationStatus]).sort()).toEqual([[v, "validated"], [g, "grounded"]].sort());
  });

  it("an answer citing only grounded evidence is labelled as machine-grounded, human review pending", async () => {
    await allowGrounded();
    const g = await seedEvidence(pool, { validation: "grounded" as never });
    const a = answer({ answerBlocks: [{ id: "b1", kind: "evidence", text: "Keep the soil evenly moist.", numericRefIds: [], claimIds: ["c1"] }], claimEvidenceRefs: [{ claimId: "c1", text: "Keep soil evenly moist.", evidenceIds: [g], cropIds: [GINGER_ID] }] });
    const r = await runAgentTurn(await deps(new Fixed(a)), turn());
    expect(r.status).toBe("approved");
    expect(r.gateReport?.groundedEvidenceIds).toEqual([g]);
    expect(r.limitations.join(" ")).toMatch(/machine-grounded excerpt; human review of its meaning and scope is pending/);
  });
});
