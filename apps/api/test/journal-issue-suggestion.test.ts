import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FixtureProvider, loadScenario, type FixtureScenario } from "../src/agent/fixture-provider";
import { PlanService, defaultSources } from "../src/plans";
import { Budget } from "../src/services/budget";
import { processImage, storeImage } from "../src/services/media";
import { journalTaskCompletionSource, runJournalAnalysis, type JournalWorkerDeps } from "../src/journal";
import { gateInterpretation, issueNoteProblems } from "../src/journal/gate";
import { factToPlanChange } from "../src/journal/mapping";
import { INSTRUCTIONS } from "../src/journal/prompt";
import { ISSUE_CATEGORIES, PROMPT_VERSION, type InterpretationOutput } from "../src/journal/types";
import { login, setupHarness, type Client, type Harness } from "./helpers";

/*
 * FIELD_OPERATIONS_SPEC 5.5 (packet O3): the journal analysis proposes an issue category (observed_issue) and an
 * observation-worded note (observed_issue_note). Everything the model "returns" here is the SYNTHETIC fixture
 * test/fixtures/meta/journal_leaf_damage.json or a variant of it built below. No live Meta call is made.
 */

const FIX = resolve(__dirname, "../../../data/fixtures/synthetic");
const ginger = JSON.parse(readFileSync(resolve(FIX, "plan-ginger-basic.json"), "utf8"));
const TODAY = new Date().toISOString().slice(0, 10);
const NOTE = "Irregular holes and chewed leaf edges consistent with insect feeding; no insects visible in the photo";

let h: Harness;
let plans: PlanService;
let budget: Budget;
let seq = 0;

interface World {
  c: Client;
  farmId: string;
  ownerId: string;
  planId: string;
  planHash: string;
  mediaId: string;
}

async function world(): Promise<World> {
  const c = await login(h.app);
  const ownerId = (await h.pool.query<{ owner_id: string }>("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0]!.owner_id;
  const farmId = (await h.pool.query<{ id: string }>("INSERT INTO farms (owner_id, name, district_code, state_code) VALUES ($1,'Leaf farm','IN-KA-HAS','KA') RETURNING id", [ownerId])).rows[0]!.id;
  const p = await plans.createPlan({
    ownerId,
    farmId,
    cropId: ginger.cropId,
    productId: ginger.productId,
    mode: "synthetic",
    confirmedInputs: ginger.confirmedInputs,
    assumptions: ginger.assumptions,
    ruleVersions: ginger.ruleVersions,
    stageDefinitions: ginger.stageDefinitions,
    parameters: ginger.parameters,
    sourceSnapshotId: "synthetic-fixtures-v1",
  });
  const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 60, g: 140, b: 70 }, noise: { type: "gaussian", mean: 110, sigma: 50 } } }).jpeg().toBuffer();
  const media = await storeImage(h.pool, h.storage, ownerId, farmId, img, await processImage(img));
  return { c, farmId, ownerId, planId: p.snapshot.id, planHash: p.snapshot.contentHash, mediaId: media.id };
}

async function createEntry(w: World) {
  const r = await w.c.call("POST", "/api/v1/journal", {
    payload: { clientEntryId: `entry-o3-${Date.now()}-${++seq}`, farmId: w.farmId, observedOn: TODAY, note: "Holes in the leaves near the gate.", language: "en", mediaIds: [w.mediaId], activity: "observation" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().data.entry as { id: string; version: number };
}

async function runAnalysis(w: World, entryId: string, over: Partial<JournalWorkerDeps>) {
  const q = await w.c.call("POST", `/api/v1/journal/${entryId}/analysis`);
  expect(q.statusCode, q.body).toBe(202);
  const { jobId } = q.json().data as { jobId: string };
  const job = (await h.pool.query("SELECT id, owner_id, payload, attempt, max_attempts FROM jobs WHERE id=$1", [jobId])).rows[0];
  return runJournalAnalysis({ pool: h.pool, config: h.config, storage: h.storage, budget, plans, ...over }, job, { heartbeat: async () => undefined });
}

type Fact = { id: string; field: string; kind: string; status: string; value: unknown; unit: string | null; source: string; evidenceState: string; requiresConfirmation: boolean; supersedesId: string | null };
const getEntry = async (w: World, id: string) => (await w.c.call("GET", `/api/v1/journal/${id}`)).json().data.entry as { version: number; facts: Fact[]; analysis: { gateIssues: { code: string; detail: string }[] } };
const proposedAi = (e: { facts: Fact[] }) => e.facts.filter((f) => f.kind === "proposed" && f.source === "ai");

/** The leaf damage scenario with its proposedFacts replaced: a variant built from the same synthetic response body. */
function variant(name: string, proposedFacts: InterpretationOutput["proposedFacts"]): FixtureScenario {
  const base = loadScenario("journal_leaf_damage");
  const copy = JSON.parse(JSON.stringify(base)) as FixtureScenario;
  const content = ((copy.steps[0]!.response.output as { content: { text: string }[] }[])[0]!.content)[0]!;
  const out = JSON.parse(content.text) as InterpretationOutput;
  content.text = JSON.stringify({ ...out, proposedFacts });
  return { ...copy, scenario: name };
}
const pf = (field: string, value: string | number) => ({ field, value, unit: null, basis: "ai_proposed" as const, requiresConfirmation: true as const });

beforeAll(async () => {
  h = await setupHarness();
  const g = (await h.pool.query("INSERT INTO crop_identities (slug) VALUES ('ginger') RETURNING id")).rows[0].id;
  await h.pool.query("INSERT INTO crop_products (crop_id, slug, name) VALUES ($1,'ginger-fresh','Fresh ginger (synthetic test row)')", [g]);
  budget = Budget.fromConfig(h.pool, h.config);
  await budget.init();
  plans = new PlanService({ pool: h.pool, mode: "synthetic", sources: { ...defaultSources(), completions: journalTaskCompletionSource(h.pool) } });
});
afterAll(async () => h.close());

describe("prompt and constants", () => {
  it("asks for an observation category from the fixed list, never a certain diagnosis, product or dose; the prompt version moved", () => {
    expect([...ISSUE_CATEGORIES]).toEqual(["pest", "disease", "weed", "water_stress", "nutrient", "weather_damage", "animal_damage", "other"]);
    expect(INSTRUCTIONS).toContain("observed_issue whose value is exactly one of: pest, disease, weed, water_stress, nutrient, weather_damage, animal_damage, other");
    expect(INSTRUCTIONS).toMatch(/observed_issue_note: at most 200 characters/);
    expect(INSTRUCTIONS).toMatch(/Never name a pathogen or pest species as certain/);
    expect(INSTRUCTIONS).toMatch(/never name a product, chemical, spray or input, and never give a dose/);
    expect(PROMPT_VERSION).toBe("2");
  });

  it("neither issue fact maps to a plan change", () => {
    const ctx = { observedOn: "2026-06-01", entryId: "e1", stageIds: new Set(["vegetative"]) };
    expect(factToPlanChange({ field: "observed_issue", value: "pest" }, ctx)).toEqual({ mapped: false });
    expect(factToPlanChange({ field: "observed_issue_note", value: NOTE }, ctx)).toEqual({ mapped: false });
  });
});

describe("analysis job (synthetic fixture journal_leaf_damage)", () => {
  it("stores observed_issue and observed_issue_note as AI proposals that require confirmation", async () => {
    const w = await world();
    const e = await createEntry(w);
    const result = await runAnalysis(w, e.id, { fixtureScenario: "journal_leaf_damage" });
    expect(result).toMatchObject({ status: "succeeded", provenance: "synthetic_fixture", proposalCount: 2, requestAnotherAngle: false });
    const full = await getEntry(w, e.id);
    const facts = proposedAi(full);
    expect(facts.map((f) => `${f.field}=${String(f.value)}`).sort()).toEqual([`observed_issue=pest`, `observed_issue_note=${NOTE}`]);
    expect(facts.every((f) => f.status === "proposed" && f.requiresConfirmation === true && f.evidenceState === "derived" && f.unit === null)).toBe(true);
    expect(full.analysis.gateIssues).toEqual([]);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM journal_facts WHERE entry_id=$1 AND kind='confirmed'", [e.id])).rows[0].n).toBe(0);
  });

  it("a note naming a chemical with a dose is dropped with its issue codes; the category is still proposed", async () => {
    const w = await world();
    const e = await createEntry(w);
    const scenario = variant("journal_leaf_damage_chemical", [pf("observed_issue", "pest"), pf("observed_issue_note", "Chewed leaf edges consistent with insect feeding; spray chlorpyrifos 2 ml per litre")]);
    const result = await runAnalysis(w, e.id, { provider: new FixtureProvider(scenario) });
    expect(result.proposalCount).toBe(1);
    const full = await getEntry(w, e.id);
    expect(proposedAi(full).map((f) => f.field)).toEqual(["observed_issue"]);
    const codes = full.analysis.gateIssues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["observed_issue_note_chemical", "observed_issue_note_dose"]));
    // The trace explains the drop as well.
    const run = (await h.pool.query("SELECT trace, gate_status FROM agent_runs WHERE owner_id=$1 AND purpose='journal_observation' ORDER BY created_at DESC LIMIT 1", [w.ownerId])).rows[0];
    const gate = run.trace.steps.find((s: { kind: string }) => s.kind === "gate").detail;
    expect(gate.issues).toEqual(expect.arrayContaining(["observed_issue_note_chemical", "observed_issue_note_dose"]));
    expect(run.gate_status).toBe("filtered");
  });

  it("an unknown category is dropped, and its note goes with it", async () => {
    const w = await world();
    const e = await createEntry(w);
    const scenario = variant("journal_leaf_damage_unknown", [pf("observed_issue", "fungal_blight"), pf("observed_issue_note", NOTE)]);
    const result = await runAnalysis(w, e.id, { provider: new FixtureProvider(scenario) });
    expect(result.proposalCount).toBe(0);
    const full = await getEntry(w, e.id);
    expect(proposedAi(full)).toHaveLength(0);
    expect(full.analysis.gateIssues.map((i) => i.code)).toEqual(["observed_issue_unknown_category", "observed_issue_note_without_issue"]);
  });
});

describe("gate rules for the issue suggestion", () => {
  const base: InterpretationOutput = {
    visibleObservations: ["Chewed leaf edges."],
    competingInterpretations: [],
    missingContext: [],
    proposedFacts: [],
    candidatePlanChanges: [],
    imageQualityIssues: [],
    requestAnotherAngle: false,
    aiNarrative: "Some leaves look chewed.",
  };
  const ctx = { observedOn: "2026-06-01", entryId: "e1", stageIds: new Set(["vegetative"]), asOf: new Date("2026-06-01T00:00:00Z") };
  const gate = (facts: InterpretationOutput["proposedFacts"]) => gateInterpretation({ ...base, proposedFacts: facts }, ctx);

  it("keeps every listed category and only as non-plan proposals; values outside the list (including case variants and numbers) are dropped", () => {
    for (const c of ISSUE_CATEGORIES) expect(gate([pf("observed_issue", c)]).facts).toEqual([{ field: "observed_issue", value: c, unit: null, planMapped: false }]);
    for (const bad of ["Pest", "rhizome_rot", "insect", 3]) {
      const g = gate([pf("observed_issue", bad)]);
      expect(g.facts).toHaveLength(0);
      expect(g.issues.map((i) => i.code)).toEqual(["observed_issue_unknown_category"]);
    }
  });

  it("drops a note when observed_issue is absent or was dropped, wherever the note sits in the list", () => {
    expect(gate([pf("observed_issue_note", NOTE)]).issues.map((i) => i.code)).toEqual(["observed_issue_note_without_issue"]);
    const g = gate([pf("observed_issue_note", NOTE), pf("observed_issue", "pest")]);
    expect(g.facts.map((f) => f.field)).toEqual(["observed_issue", "observed_issue_note"]);
  });

  it("drops notes that name a chemical, give a dose or use a certainty word, each with its own code", () => {
    const cases: [string, string[]][] = [
      ["Leaf spots; looks like it needs a fungicide", ["observed_issue_note_chemical"]],
      ["Chewed edges, apply mancozeb", ["observed_issue_note_chemical"]],
      ["Pale leaves, add urea", ["observed_issue_note_chemical"]],
      ["Holes in leaves, use 20 g in the tank", ["observed_issue_note_dose"]],
      ["Holes in leaves, use 1.5 kg", ["observed_issue_note_dose"]],
      ["Holes in leaves; mix 5 l with water", ["observed_issue_note_dose"]],
      ["Holes in leaves; 0.2% solution", ["observed_issue_note_dose"]],
      ["Holes in leaves; 500 ppm", ["observed_issue_note_dose"]],
      ["Holes in leaves; two millilitres", ["observed_issue_note_dose"]],
      ["Holes in leaves; give a little per acre", ["observed_issue_note_dose"]],
      ["Holes in leaves; spread evenly per ha", ["observed_issue_note_dose"]],
      ["This is Certainly stem borer damage", ["observed_issue_note_certainty"]],
      ["DEFINITELY caterpillar feeding", ["observed_issue_note_certainty"]],
      ["Confirmed leaf blight", ["observed_issue_note_certainty"]],
    ];
    for (const [note, codes] of cases) {
      expect(issueNoteProblems(note), note).toEqual(codes);
      const g = gate([pf("observed_issue", "pest"), pf("observed_issue_note", note)]);
      expect(g.facts.map((f) => f.field), note).toEqual(["observed_issue"]);
      expect(g.issues.map((i) => i.code), note).toEqual(codes);
    }
  });

  it("keeps ordinary observation wording, including counts of leaves and 'clearly visible'", () => {
    for (const note of [NOTE, "Clearly visible holes on 3 leaves near the bed edge", "Pale yellow older leaves; no spots visible", "Standing water for 2 days after rain"]) {
      expect(issueNoteProblems(note), note).toEqual([]);
      expect(gate([pf("observed_issue", "other"), pf("observed_issue_note", note)]).facts.map((f) => f.field), note).toEqual(["observed_issue", "observed_issue_note"]);
    }
  });

  it("keeps at most one category and one note; an empty note is invalid; a requested retake withholds both", () => {
    const g = gate([pf("observed_issue", "pest"), pf("observed_issue", "weed"), pf("observed_issue_note", NOTE), pf("observed_issue_note", "Chewed edges on the lower leaves")]);
    expect(g.facts.map((f) => `${f.field}=${f.value}`)).toEqual(["observed_issue=pest", `observed_issue_note=${NOTE}`]);
    expect(g.issues.map((i) => i.code)).toEqual(["observed_issue_duplicate", "observed_issue_note_duplicate"]);
    expect(gate([pf("observed_issue", "pest"), pf("observed_issue_note", 7)]).issues.map((i) => i.code)).toEqual(["observed_issue_note_invalid"]);
    const w = gateInterpretation({ ...base, requestAnotherAngle: true, proposedFacts: [pf("observed_issue", "pest"), pf("observed_issue_note", NOTE)] }, ctx);
    expect(w.facts).toHaveLength(0);
    expect(w.issues.map((i) => i.code)).toEqual(["proposals_withheld"]);
  });
});

describe("confirmation", () => {
  it("accepting observed_issue produces a confirmed farmer-reported fact and no plan revision", async () => {
    const w = await world();
    const e = await createEntry(w);
    await runAnalysis(w, e.id, { fixtureScenario: "journal_leaf_damage" });
    const full = await getEntry(w, e.id);
    const issue = proposedAi(full).find((f) => f.field === "observed_issue")!;
    const note = proposedAi(full).find((f) => f.field === "observed_issue_note")!;
    const plansBefore = (await h.pool.query("SELECT count(*)::int AS n FROM plans WHERE farm_id=$1", [w.farmId])).rows[0].n;
    const preview = await w.c.call("POST", `/api/v1/journal/${e.id}/revision-preview`, { payload: { factIds: [issue.id, note.id] } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data).toMatchObject({ planChanging: false, preview: null });
    const spy = vi.spyOn(PlanService.prototype, "revisePlan");
    // No plan hash is needed: nothing accepted here maps to a plan change.
    const r = await w.c.call("POST", `/api/v1/journal/${e.id}/confirmations`, { payload: { expectedVersion: full.version, accept: [issue.id], reject: [note.id] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const d = r.json().data;
    expect(d.revision).toBeNull();
    const confirmed = (d.entry.facts as Fact[]).filter((f) => f.kind === "confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ field: "observed_issue", value: "pest", status: "confirmed", evidenceState: "farmer_reported", supersedesId: issue.id });
    expect((d.entry.facts as Fact[]).find((f) => f.id === issue.id)!.status).toBe("confirmed");
    expect((d.entry.facts as Fact[]).find((f) => f.id === note.id)!.status).toBe("rejected");
    expect((await h.pool.query("SELECT count(*)::int AS n FROM plans WHERE farm_id=$1", [w.farmId])).rows[0].n).toBe(plansBefore);
    const tl = (await w.c.call("GET", `/api/v1/farms/${w.farmId}/journal`)).json().data;
    expect(tl.revisions).toHaveLength(0);
    expect(tl.currentPlan.contentHash).toBe(w.planHash);
  });
});
