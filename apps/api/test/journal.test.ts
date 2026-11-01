import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixtureProvider } from "../src/agent/fixture-provider";
import { MetaProvider, type ProviderOutcome, type TextModelProvider, type TextRequest } from "../src/agent/provider";
import { Budget } from "../src/services/budget";
import { privateRouteGuard } from "../src/security/guards";
import { requireAuth } from "../src/security/session";
import { runIdempotent } from "../src/services/idempotency";
import { PlanService, defaultSources } from "../src/plans";
import {
  JournalService,
  bindInterpretObservation,
  bindProposePlanRevision,
  journalTaskCompletionSource,
  registerJournalRoutes,
  runJournalAnalysis,
  type JournalWorkerDeps,
} from "../src/journal";
import { gateInterpretation } from "../src/journal/gate";
import { assessImage } from "../src/journal/quality";
import type { InterpretationOutput } from "../src/journal/types";
import { login, makeJpeg, setupHarness, type Client, type Harness } from "./helpers";
import { processImage, storeImage } from "../src/services/media";
import { errorEnvelope } from "../src/envelope";
import { ApiError } from "../src/services/errors";
import { redactForTrace } from "../src/agent/trace";

/*
 * T13 journal tests. Everything the model "returns" here comes from SYNTHETIC fixtures
 * (test/fixtures/meta/journal_*.json) or a stub provider. No live Meta call is made.
 */

const FIX = resolve(__dirname, "../../../data/fixtures/synthetic");
const ginger = JSON.parse(readFileSync(resolve(FIX, "plan-ginger-basic.json"), "utf8"));
const TODAY = new Date().toISOString().slice(0, 10);

let h: Harness;
let app: FastifyInstance;
let plans: PlanService;
let service: JournalService;
let budget: Budget;

async function mount(): Promise<FastifyInstance> {
  const a = await h.make();
  // INT2: buildServer registers the journal routes itself.
  return a;
}


const noiseJpeg = (mean: number, sigma: number): Promise<Buffer> =>
  sharp({ create: { width: 800, height: 600, channels: 3 as const, background: { r: mean, g: mean, b: mean }, noise: { type: "gaussian" as const, mean, sigma } } })
    .jpeg()
    .toBuffer();

interface World {
  c: Client;
  farmId: string;
  ownerId: string;
  planId: string;
  planHash: string;
  mediaId: string;
}

/** Sessions, farm, plan and photo are created directly (the API has a 120 requests per minute limit); routes under test are called over HTTP. */
async function world(opts: { plan?: boolean; photo?: "uniform" | "textured" } = {}): Promise<World> {
  const c = await login(app);
  const ownerId = (await h.pool.query<{ owner_id: string }>("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0]!.owner_id;
  const farmId = (await h.pool.query<{ id: string }>("INSERT INTO farms (owner_id, name, district_code, state_code) VALUES ($1,'Test farm','IN-KA-HAS','KA') RETURNING id", [ownerId])).rows[0]!.id;
  let planId = "";
  let planHash = "";
  if (opts.plan !== false) {
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
    planId = p.snapshot.id;
    planHash = p.snapshot.contentHash;
  }
  const img =
    opts.photo === "textured"
      ? await noiseJpeg(128, 60)
      : await makeJpeg({ width: 800, height: 600 });
  const media = await storeImage(h.pool, h.storage, ownerId, farmId, img, await processImage(img));
  return { c, farmId, ownerId, planId, planHash, mediaId: media.id };
}

let seq = 0;

const entryBody = (w: World, over: Record<string, unknown> = {}) => ({
  clientEntryId: `entry-t13-${Date.now()}-${++seq}`,
  farmId: w.farmId,
  observedOn: TODAY,
  note: "Heavy rain last night. Water standing near the lower rows.",
  language: "en",
  mediaIds: [w.mediaId],
  activity: "observation",
  ...over,
});
const createEntry = async (w: World, over: Record<string, unknown> = {}) => {
  const r = await w.c.call("POST", "/api/v1/journal", { payload: entryBody(w, over) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().data.entry as { id: string; version: number; facts: { id: string; field: string; kind: string }[] };
};

function workerDeps(over: Partial<JournalWorkerDeps> = {}): JournalWorkerDeps {
  return { pool: h.pool, config: h.config, storage: h.storage, budget, plans, ...over };
}
async function runAnalysis(w: World, entryId: string, over: Partial<JournalWorkerDeps> = {}) {
  const q = await w.c.call("POST", `/api/v1/journal/${entryId}/analysis`);
  expect(q.statusCode, q.body).toBe(202);
  const { jobId, analysisId } = q.json().data as { jobId: string; analysisId: string };
  const job = (await h.pool.query("SELECT id, owner_id, payload, attempt, max_attempts FROM jobs WHERE id=$1", [jobId])).rows[0];
  const result = await runJournalAnalysis(workerDeps(over), job, { heartbeat: async () => undefined });
  return { jobId, analysisId, result };
}
const getEntry = async (w: World, id: string) => (await w.c.call("GET", `/api/v1/journal/${id}`)).json().data.entry;
const proposed = (e: { facts: { id: string; field: string; kind: string; status?: string; source?: string }[] }) => e.facts.filter((f) => f.kind === "proposed");

beforeAll(async () => {
  h = await setupHarness();
  const g = (await h.pool.query("INSERT INTO crop_identities (slug) VALUES ('ginger') RETURNING id")).rows[0].id;
  await h.pool.query("INSERT INTO crop_products (crop_id, slug, name) VALUES ($1,'ginger-fresh','Fresh ginger (synthetic test row)')", [g]);
  budget = Budget.fromConfig(h.pool, h.config);
  await budget.init();
  plans = new PlanService({ pool: h.pool, mode: "synthetic", sources: { ...defaultSources(), completions: journalTaskCompletionSource(h.pool) } });
  service = new JournalService({ pool: h.pool, mode: "synthetic", plans });
  app = await mount();
});
afterAll(async () => h.close());

describe("entries: originals are immutable, creation is idempotent", () => {
  it("saves the entry as farmer-reported originals and rejects edits to originals and original facts", async () => {
    const w = await world();
    const e = await createEntry(w, { quantity: { value: 40, unit: "L" }, expense: { amountInr: "250.50", category: "labour" } });
    const full = await getEntry(w, e.id);
    expect(full.provenanceLabel).toMatch(/Farmer-reported/);
    expect(full.expense).toEqual({ amountInr: "250.50", category: "labour" });
    const originals = full.facts.filter((f: { kind: string }) => f.kind === "original");
    expect(originals.map((f: { field: string }) => f.field).sort()).toEqual(["activity", "expense_inr", "quantity"]);
    expect(originals.every((f: { source: string; status: string; evidenceState: string }) => f.source === "farmer" && f.status === "recorded" && f.evidenceState === "farmer_reported")).toBe(true);
    await expect(h.pool.query("UPDATE journal_entries SET text_body='edited' WHERE id=$1", [e.id])).rejects.toThrow(/cannot be modified/);
    await expect(h.pool.query("UPDATE journal_entries SET media_ids='{}' WHERE id=$1", [e.id])).rejects.toThrow(/cannot be modified/);
    await expect(h.pool.query("UPDATE journal_facts SET value='999'::jsonb WHERE entry_id=$1 AND kind='original'", [e.id])).rejects.toThrow(/original facts cannot be modified/);
    await expect(h.pool.query("DELETE FROM journal_facts WHERE entry_id=$1", [e.id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query("DELETE FROM journal_entries WHERE id=$1", [e.id])).rejects.toThrow(/immutable/);
    // Workflow columns may still change.
    await h.pool.query("UPDATE journal_entries SET processing_status='ready' WHERE id=$1", [e.id]);
  });

  it("an AI fact can never be an original, be marked as requiring no confirmation, or carry the farmer-reported state unless confirmed", async () => {
    const w = await world({ plan: false });
    const e = await createEntry(w);
    const ins = (cols: string) => h.pool.query(`INSERT INTO journal_facts (owner_id, entry_id, fact_key, value, ${cols.split("|")[0]}) VALUES ($1,$2,'x','1'::jsonb, ${cols.split("|")[1]})`, [w.ownerId, e.id]);
    await expect(ins("kind, source, status|'original','ai','recorded'")).rejects.toThrow(/journal_facts_ai_not_original_chk/);
    await expect(ins("kind, source, requires_confirmation|'proposed','ai',false")).rejects.toThrow(/journal_facts_proposed_confirm_chk/);
    await expect(ins("kind, source, evidence_state|'proposed','ai','farmer_reported'")).rejects.toThrow(/journal_facts_ai_evidence_chk/);
  });

  it("POST /journal replays: same Idempotency-Key returns the same entry; different payload is 422; same client id with other content is 409", async () => {
    const w = await world({ plan: false });
    const body = entryBody(w);
    const headers = { "idempotency-key": `key-${body.clientEntryId}` };
    const r1 = await w.c.call("POST", "/api/v1/journal", { payload: body, headers });
    expect(r1.statusCode).toBe(201);
    const r2 = await w.c.call("POST", "/api/v1/journal", { payload: body, headers });
    expect(r2.statusCode).toBe(201);
    expect(r2.headers["idempotent-replay"]).toBe("true");
    expect(r2.json().data.entry.id).toBe(r1.json().data.entry.id);
    const r3 = await w.c.call("POST", "/api/v1/journal", { payload: { ...body, note: "changed" }, headers });
    expect(r3.statusCode).toBe(422);
    // Without a key the stable client entry id still prevents a duplicate, and never overwrites the original.
    const r4 = await w.c.call("POST", "/api/v1/journal", { payload: { ...body, version: 3 } });
    expect(r4.statusCode).toBe(200);
    expect(r4.json().data.entry.id).toBe(r1.json().data.entry.id);
    const r5 = await w.c.call("POST", "/api/v1/journal", { payload: { ...body, note: "rewritten" } });
    expect(r5.statusCode).toBe(409);
    expect(r5.json().error.code).toBe("version_conflict");
    expect((await h.pool.query("SELECT count(*)::int AS n FROM journal_entries WHERE client_entry_id=$1", [body.clientEntryId])).rows[0].n).toBe(1);
    expect((await getEntry(w, r1.json().data.entry.id)).note).toBe(body.note);
  });

  it("validates input: foreign media, future dates and unknown stage ids are refused", async () => {
    const w = await world();
    const other = await world({ plan: false });
    expect((await w.c.call("POST", "/api/v1/journal", { payload: entryBody(w, { mediaIds: [other.mediaId] }) })).statusCode).toBe(404);
    expect((await w.c.call("POST", "/api/v1/journal", { payload: entryBody(w, { observedOn: "2099-01-01" }) })).statusCode).toBe(422);
    const bad = await w.c.call("POST", "/api/v1/journal", { payload: entryBody(w, { stageId: "not_a_stage" }) });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("unknown_stage");
    expect((await w.c.call("POST", "/api/v1/journal", { payload: { ...entryBody(w), ownerId: "x" } })).statusCode).toBe(400);
  });
});

describe("sale amounts: farmer-reported proceeds beside quantity and expense", () => {
  const saleBody = { activity: "sale", mediaIds: [] as string[], note: "Sold fresh ginger at the Hassan mandi", quantity: { value: 3.2, unit: "quintal" }, sale: { amountInr: "12500.5", note: "Local mandi buyer" }, expense: { amountInr: "400", category: "transport" } };

  it("stores the sale on create and returns it on get and on the farm timeline, with an original fact", async () => {
    const w = await world({ plan: false });
    const e = await createEntry(w, saleBody);
    const created = (e as unknown as { sale: unknown }).sale;
    expect(created).toEqual({ amountInr: "12500.50", note: "Local mandi buyer" });
    const full = await getEntry(w, e.id);
    expect(full.sale).toEqual({ amountInr: "12500.50", note: "Local mandi buyer" });
    expect(full.expense).toEqual({ amountInr: "400.00", category: "transport" });
    expect(full.quantity).toEqual({ value: 3.2, unit: "quintal" });
    const originals = full.facts.filter((f: { kind: string }) => f.kind === "original");
    expect(originals.map((f: { field: string }) => f.field).sort()).toEqual(["activity", "expense_inr", "quantity", "sale_inr"]);
    const saleFact = originals.find((f: { field: string }) => f.field === "sale_inr");
    expect(saleFact).toMatchObject({ value: "12500.5", unit: "INR", source: "farmer", status: "recorded", evidenceState: "farmer_reported" });
    const tl = (await w.c.call("GET", `/api/v1/farms/${w.farmId}/journal`)).json().data;
    expect(tl.entries).toHaveLength(1);
    expect(tl.entries[0].sale).toEqual({ amountInr: "12500.50", note: "Local mandi buyer" });
    // A sale without a note is allowed; entries without a sale report null.
    const bare = await createEntry(w, { ...saleBody, sale: { amountInr: "0" }, expense: undefined });
    expect((await getEntry(w, bare.id)).sale).toEqual({ amountInr: "0.00", note: null });
    const plain = await createEntry(w, { mediaIds: [] });
    expect((await getEntry(w, plain.id)).sale).toBeNull();
    const saleNoAmount = await createEntry(w, { mediaIds: [], activity: "sale", note: "Sold, amount not recorded" });
    expect((await getEntry(w, saleNoAmount.id)).sale).toBeNull();
  });

  it("refuses a sale on any other activity (or none) and malformed amounts, and saves nothing", async () => {
    const w = await world({ plan: false });
    for (const activity of ["harvest", "expense", "observation", "other", undefined]) {
      const body = entryBody(w, { ...saleBody, activity });
      const r = await w.c.call("POST", "/api/v1/journal", { payload: body });
      expect(r.statusCode, `${String(activity)} ${r.body}`).toBe(400);
      expect(r.json().error.code).toBe("validation_error");
      expect(r.json().error.message).toMatch(/sale amount can only be recorded on a 'sale' entry/);
      expect((await h.pool.query("SELECT count(*)::int AS n FROM journal_entries WHERE client_entry_id=$1", [body.clientEntryId])).rows[0].n).toBe(0);
    }
    for (const amountInr of ["-5", "12.345", "1e3", "", "abc", "01"]) {
      const r = await w.c.call("POST", "/api/v1/journal", { payload: entryBody(w, { ...saleBody, sale: { amountInr } }) });
      expect(r.statusCode, `${amountInr} ${r.body}`).toBe(400);
    }
    expect((await w.c.call("POST", "/api/v1/journal", { payload: entryBody(w, { ...saleBody, sale: { amountInr: "10", buyer: "x" } }) })).statusCode).toBe(400);
    expect((await w.c.call("POST", "/api/v1/journal", { payload: entryBody(w, { ...saleBody, sale: { amountInr: "10", note: "x".repeat(121) } }) })).statusCode).toBe(400);
  });

  it("replays the same sale (200, same entry) and refuses a changed, added or removed sale with 409; an Idempotency-Key replay with other content is 422", async () => {
    const w = await world({ plan: false });
    const body = entryBody(w, saleBody);
    const headers = { "idempotency-key": `key-${body.clientEntryId}` };
    const r1 = await w.c.call("POST", "/api/v1/journal", { payload: body, headers });
    expect(r1.statusCode).toBe(201);
    const same = await w.c.call("POST", "/api/v1/journal", { payload: { ...body, version: 4 } });
    expect(same.statusCode).toBe(200);
    expect(same.json().data.entry.id).toBe(r1.json().data.entry.id);
    expect(same.json().data.entry.sale).toEqual({ amountInr: "12500.50", note: "Local mandi buyer" });
    for (const changed of [
      { ...body, sale: { amountInr: "12500.6", note: "Local mandi buyer" } },
      { ...body, sale: { amountInr: "12500.5", note: "Another buyer" } },
      { ...body, sale: { amountInr: "12500.5" } },
      { ...body, sale: undefined },
    ]) {
      const r = await w.c.call("POST", "/api/v1/journal", { payload: changed });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe("version_conflict");
    }
    expect((await w.c.call("POST", "/api/v1/journal", { payload: { ...body, sale: { amountInr: "1" } }, headers })).statusCode).toBe(422);
    expect((await getEntry(w, r1.json().data.entry.id)).sale).toEqual({ amountInr: "12500.50", note: "Local mandi buyer" });
    expect((await h.pool.query("SELECT count(*)::int AS n FROM journal_entries WHERE client_entry_id=$1", [body.clientEntryId])).rows[0].n).toBe(1);
    // An entry saved without a sale cannot be given one later by replaying the same id.
    const plain = entryBody(w, { activity: "sale", mediaIds: [] });
    expect((await w.c.call("POST", "/api/v1/journal", { payload: plain })).statusCode).toBe(201);
    expect((await w.c.call("POST", "/api/v1/journal", { payload: { ...plain, sale: { amountInr: "500" } } })).statusCode).toBe(409);
  });

  it("the database refuses edits to a saved sale amount or note, a negative amount, and a delete; workflow columns still change", async () => {
    const w = await world({ plan: false });
    const e = await createEntry(w, saleBody);
    await expect(h.pool.query("UPDATE journal_entries SET sale_inr=99999 WHERE id=$1", [e.id])).rejects.toThrow(/cannot be modified/);
    await expect(h.pool.query("UPDATE journal_entries SET sale_inr=NULL WHERE id=$1", [e.id])).rejects.toThrow(/cannot be modified/);
    await expect(h.pool.query("UPDATE journal_entries SET sale_note='edited' WHERE id=$1", [e.id])).rejects.toThrow(/cannot be modified/);
    await expect(h.pool.query("UPDATE journal_entries SET sale_note=NULL WHERE id=$1", [e.id])).rejects.toThrow(/cannot be modified/);
    await expect(h.pool.query("UPDATE journal_entries SET expense_inr=1 WHERE id=$1", [e.id])).rejects.toThrow(/cannot be modified/);
    await expect(h.pool.query("DELETE FROM journal_entries WHERE id=$1", [e.id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query("INSERT INTO journal_entries (owner_id, farm_id, status, entry_date, activity, sale_inr) VALUES ($1,$2,'final',$3,'sale',-1)", [w.ownerId, w.farmId, TODAY])).rejects.toThrow(/sale_inr/);
    await h.pool.query("UPDATE journal_entries SET processing_status='ready' WHERE id=$1", [e.id]);
    expect((await getEntry(w, e.id)).sale).toEqual({ amountInr: "12500.50", note: "Local mandi buyer" });
  });

  it("another owner gets 404 for the sale entry and its farm timeline, and cannot save a sale on someone else's farm", async () => {
    const w = await world({ plan: false });
    const e = await createEntry(w, saleBody);
    const o = await login(app);
    expect((await o.call("GET", `/api/v1/journal/${e.id}`)).statusCode).toBe(404);
    expect((await o.call("GET", `/api/v1/farms/${w.farmId}/journal`)).statusCode).toBe(404);
    const r = await o.call("POST", "/api/v1/journal", { payload: entryBody(w, { ...saleBody, clientEntryId: "entry-cross-owner-sale-1" }) });
    expect(r.statusCode).toBe(404);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM journal_entries WHERE client_entry_id='entry-cross-owner-sale-1'")).rows[0].n).toBe(0);
  });
});

describe("analysis job", () => {
  it("synthetic mode uses the fixture, stores proposals that require confirmation and never confirms them", async () => {
    const w = await world();
    const e = await createEntry(w);
    const { result } = await runAnalysis(w, e.id);
    expect(result).toMatchObject({ status: "succeeded", provenance: "synthetic_fixture", requestAnotherAngle: false });
    const full = await getEntry(w, e.id);
    expect(full.processingStatus).toBe("ready");
    expect(full.version).toBe(e.version + 1);
    const rows = (await h.pool.query("SELECT kind, source, status, requires_confirmation, evidence_state, confirmed_at, agent_run_id, analysis_id FROM journal_facts WHERE entry_id=$1 AND source='ai'", [e.id])).rows;
    expect(rows.map((r) => r.status).sort()).toEqual(["proposed", "proposed"]);
    expect(rows.every((r) => r.kind === "proposed" && r.requires_confirmation === true && r.evidence_state === "derived" && r.confirmed_at === null && r.agent_run_id && r.analysis_id)).toBe(true);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM journal_facts WHERE entry_id=$1 AND kind='confirmed'", [e.id])).rows[0].n).toBe(0);
    const a = full.analysis;
    expect(a.provenance).toBe("synthetic_fixture");
    expect(a.label).toBe("AI proposal — confirm before it changes your plan");
    // Prose is stored as an AI interpretation, never as an observation.
    expect(a.aiNarrative.evidenceState).toBe("illustrative");
    expect(a.aiNarrative.label).toMatch(/not an observation/);
    // The plan is unchanged until the farmer confirms.
    const leaf = (await h.pool.query("SELECT count(*)::int AS n FROM plans WHERE farm_id=$1", [w.farmId])).rows[0].n;
    expect(leaf).toBe(1);
    // Duplicate request returns the same job and does not run twice.
    const again = await w.c.call("POST", `/api/v1/journal/${e.id}/analysis`);
    expect(again.json().data.deduplicated).toBe(true);
  });

  it("code-computed image quality attaches to the entry even when the model says the photo is fine", async () => {
    const w = await world(); // uniform image: no texture
    const e = await createEntry(w);
    await runAnalysis(w, e.id);
    const q = (await getEntry(w, e.id)).imageQuality;
    expect(q.method).toBe("heuristic-v1");
    expect(q.issues).toContain("blur");
    expect(q.perImage[0].mediaId).toBe(w.mediaId);
    const sharpQ = await assessImage("m", await noiseJpeg(128, 60));
    expect(sharpQ.issues).not.toContain("blur");
    const dark = await assessImage("m", await noiseJpeg(15, 20));
    expect(dark.issues).toContain("too_dark");
  });

  it("a poor image asks for another photo and stores no proposals", async () => {
    const w = await world();
    const e = await createEntry(w);
    const { result } = await runAnalysis(w, e.id, { fixtureScenario: "journal_poor_image" });
    expect(result).toMatchObject({ proposalCount: 0, requestAnotherAngle: true });
    const full = await getEntry(w, e.id);
    expect(full.analysis.requestAnotherAngle).toBe(true);
    expect(full.analysis.imageQualityIssues).toEqual(expect.arrayContaining(["blur", "too_dark"]));
    expect(proposed(full)).toHaveLength(0);
  });

  it("live mode without a key fails with provider_unavailable, the entry stays saved as farmer-reported, nothing is reserved", async () => {
    const w = await world();
    const e = await createEntry(w);
    const before = await budget.summary();
    const liveConfig = { ...h.config, RUNTIME_MODE: "live" as const, MODEL_API_KEY: undefined };
    await expect(runAnalysis(w, e.id, { config: liveConfig })).rejects.toMatchObject({ code: "provider_unavailable", retryable: false });
    const full = await getEntry(w, e.id);
    expect(full.note).toMatch(/Heavy rain/);
    expect(full.provenanceLabel).toMatch(/Farmer-reported/);
    expect(full.analysis).toMatchObject({ status: "unavailable", errorCode: "provider_unavailable" });
    expect(full.processingStatus).toBe("failed");
    expect(proposed(full)).toHaveLength(0);
    expect(await budget.summary()).toEqual(before);
    // The farmer can retry later: a fresh analysis is queued.
    const retry = await w.c.call("POST", `/api/v1/journal/${e.id}/analysis`);
    expect(retry.json().data.deduplicated).toBe(false);
  });

  it("a billable provider: budget is reserved and settled from usage, photos are downscaled, the trace holds no image bytes and truncates the note", async () => {
    const w = await world();
    const longNote = `Water near the lower rows. ${"x".repeat(900)}`;
    const e = await createEntry(w, { note: longNote });
    const fixture = new FixtureProvider("journal_waterlogging");
    let seen: TextRequest | undefined;
    const stub: TextModelProvider = {
      kind: "meta",
      provenance: "meta_live",
      billable: true,
      call: async (req): Promise<ProviderOutcome> => {
        seen = req;
        return fixture.call(req);
      },
    };
    const reservedBefore = (await h.pool.query("SELECT reserved_usd::float AS r, settled_usd::float AS s FROM budget_state WHERE id=1")).rows[0];
    const { result } = await runAnalysis(w, e.id, { provider: stub });
    expect(result.provenance).toBe("synthetic_fixture"); // the stub replays the fixture, so the result must not claim to be live
    const after = (await h.pool.query("SELECT reserved_usd::float AS r, settled_usd::float AS s FROM budget_state WHERE id=1")).rows[0];
    expect(after.r).toBeCloseTo(reservedBefore.r, 6); // reservation released from "reserved"
    expect(after.s).toBeGreaterThan(reservedBefore.s); // and settled
    expect((await h.pool.query("SELECT count(*)::int AS n FROM usage_ledger WHERE cost_basis='estimated'")).rows[0].n).toBeGreaterThan(0);
    // One image part, at most 1280 px on the longest side.
    const content = (seen!.input as { content: { type: string; image_url?: string }[] }[])[0]!.content;
    const img = content.find((p) => p.type === "input_image")!;
    const meta = await sharp(Buffer.from(img.image_url!.split(",")[1]!, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1280);
    expect(seen!.textFormat?.name).toBe("journal_observation");
    expect(JSON.stringify(seen!.textFormat!.schema)).not.toContain('"oneOf"');
    // Trace: redacted.
    const run = (await h.pool.query("SELECT trace, purpose FROM agent_runs WHERE purpose='journal_observation' AND owner_id=$1", [w.ownerId])).rows[0];
    const trace = JSON.stringify(run.trace);
    expect(trace).not.toMatch(/data:image|base64/);
    const start = run.trace.steps.find((s: { kind: string }) => s.kind === "run_started").detail;
    expect(start.note.length).toBeLessThan(260);
    expect(start.note).toMatch(/truncated/);
    expect(start.photoSha256).toHaveLength(1);
  });

  it("provider failure releases the reservation; an unparsable body fails closed with no proposals", async () => {
    const w = await world();
    const e = await createEntry(w);
    const failing: TextModelProvider = {
      kind: "meta",
      provenance: "meta_live",
      billable: true,
      call: async () => ({ ok: false, error: { code: "provider_error", message: "boom", retryable: false, outcomeUncertain: false, requestId: null, retries: 0 } }),
    };
    const before = (await h.pool.query("SELECT reserved_usd::float AS r FROM budget_state WHERE id=1")).rows[0].r;
    await expect(runAnalysis(w, e.id, { provider: failing })).rejects.toMatchObject({ code: "provider_error" });
    expect((await h.pool.query("SELECT reserved_usd::float AS r FROM budget_state WHERE id=1")).rows[0].r).toBeCloseTo(before, 6);

    const w2 = await world();
    const e2 = await createEntry(w2);
    const garbage: TextModelProvider = {
      kind: "fixture",
      provenance: "synthetic_fixture",
      billable: false,
      call: async () => ({ ok: true, result: { provenance: "synthetic_fixture", responseId: null, requestId: "x", model: "m", outputText: '{"visibleObservations":"not an array"}', functionCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, latencyMs: 0, retries: 0 } }),
    };
    await expect(runAnalysis(w2, e2.id, { provider: garbage })).rejects.toMatchObject({ code: "provider_bad_response" });
    expect(proposed(await getEntry(w2, e2.id))).toHaveLength(0);
  });
});

describe("gate", () => {
  const base: InterpretationOutput = {
    visibleObservations: ["Standing water between rows."],
    competingInterpretations: [],
    missingContext: [],
    proposedFacts: [],
    candidatePlanChanges: [],
    imageQualityIssues: [],
    requestAnotherAngle: false,
    aiNarrative: "Possible waterlogging. Check drainage in person.",
  };
  const ctx = { observedOn: "2026-06-01", entryId: "e1", stageIds: new Set(["sprouting", "vegetative"]), asOf: new Date("2026-06-01T00:00:00Z") };
  const fact = (field: string, value: string | number) => ({ field, value, unit: null, basis: "ai_proposed" as const, requiresConfirmation: true as const });

  it("drops unknown stages and bad values instead of repairing them, and keeps proposals as proposals", () => {
    const g = gateInterpretation({ ...base, proposedFacts: [fact("observed_stage", "flowering"), fact("irrigation_category", "flood"), fact("observed_stage", "vegetative"), fact("waterlogging_visible", "yes")] }, ctx);
    expect(g.facts.map((f) => `${f.field}=${f.value}`)).toEqual(["observed_stage=vegetative", "waterlogging_visible=yes"]);
    expect(g.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["unknown_stage", "invalid_value"]));
  });

  it("withholds every proposal when another angle is requested", () => {
    const g = gateInterpretation({ ...base, requestAnotherAngle: true, proposedFacts: [fact("observed_stage", "vegetative")], candidatePlanChanges: [{ type: "observed_stage", stageId: "vegetative", category: null, date: null, note: null, rationale: "x" }] }, ctx);
    expect(g.facts).toHaveLength(0);
    expect(g.issues.map((i) => i.code)).toContain("proposals_withheld");
  });

  it("removes prose that states a certain diagnosis, a dose, a photo yield or a confidence percentage", () => {
    const g = gateInterpretation(
      {
        ...base,
        aiNarrative: "This is definitely rhizome rot.",
        visibleObservations: ["Spray 5 ml per litre of the fungicide.", "Pale leaves.", "Photo shows a yield of 3 tonnes per acre.", "I am 90% confident."],
      },
      ctx,
    );
    expect(g.narrative).toBeNull();
    expect(g.visibleObservations).toEqual(["Pale leaves."]);
    expect(g.issues.length).toBeGreaterThanOrEqual(4);
  });

  it("has no plan context: plan-mapped proposals are dropped", () => {
    const g = gateInterpretation({ ...base, proposedFacts: [fact("observed_stage", "vegetative")] }, { ...ctx, stageIds: null });
    expect(g.facts).toHaveLength(0);
  });
});

describe("confirmation and revision", () => {
  async function analysed(opts: Parameters<typeof world>[0] = {}) {
    const w = await world(opts);
    const e = await createEntry(w);
    await runAnalysis(w, e.id);
    const full = await getEntry(w, e.id);
    return { w, e, full };
  }
  const stageFact = (full: { facts: { id: string; field: string; kind: string }[] }) => full.facts.find((f) => f.kind === "proposed" && f.field === "observed_stage")!;
  const noteFact = (full: { facts: { id: string; field: string; kind: string }[] }) => full.facts.find((f) => f.kind === "proposed" && f.field === "waterlogging_visible")!;

  it("a confirmed observed_stage calls the plan engine with the typed change and returns the change summary for 'Why this changed'", async () => {
    const { w, e, full } = await analysed();
    const spy = vi.spyOn(PlanService.prototype, "revisePlan");
    const r = await w.c.call("POST", `/api/v1/journal/${e.id}/confirmations`, { payload: { expectedVersion: full.version, accept: [stageFact(full).id, noteFact(full).id], expectedPlanContentHash: w.planHash } });
    expect(r.statusCode, r.body).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual({
      ownerId: w.ownerId,
      planId: w.planId,
      expectedParentContentHash: w.planHash,
      changes: [{ type: "observed_stage", stageId: "vegetative", observedOn: TODAY, journalEntryId: e.id, basis: "farmer_reported" }],
    });
    spy.mockRestore();
    const d = r.json().data;
    expect(d.revision.newContentHash).not.toBe(w.planHash);
    expect(d.revision.fromPlanId).toBe(w.planId);
    const cs = d.revision.changeSummary;
    expect(cs.changes[0]).toMatchObject({ type: "observed_stage", stageId: "vegetative" });
    expect(Array.isArray(cs.changedTaskIds)).toBe(true);
    expect(cs.oldAssumptions.confirmedInputs.length).toBeGreaterThan(0);
    expect(cs.newAssumptions.confirmedInputs.some((i: { key: string }) => i.key === "observed_stage")).toBe(true);
    expect(cs).toHaveProperty("economicDelta");
    // Superseding rows: proposed decided, confirmed rows added, nothing edited in place.
    const facts = d.entry.facts;
    expect(facts.filter((f: { kind: string }) => f.kind === "confirmed")).toHaveLength(2);
    const sup = facts.find((f: { kind: string; field: string }) => f.kind === "confirmed" && f.field === "observed_stage");
    expect(sup.supersedesId).toBe(stageFact(full).id);
    expect(sup.evidenceState).toBe("farmer_reported");
    expect(facts.find((f: { id: string }) => f.id === stageFact(full).id).status).toBe("confirmed");
    expect(d.entry.version).toBe(full.version + 1);
    // The timeline now shows the revision and the new current plan.
    const tl = (await w.c.call("GET", `/api/v1/farms/${w.farmId}/journal`)).json().data;
    expect(tl.currentPlan.contentHash).toBe(d.revision.newContentHash);
    expect(tl.revisions).toHaveLength(1);
    expect(tl.revisions[0].changeSummary.changedTaskIds).toEqual(cs.changedTaskIds);
    // A decision is final.
    await expect(h.pool.query("UPDATE journal_facts SET status='rejected', rejected_at=now() WHERE id=$1", [stageFact(full).id])).rejects.toThrow(/final|restrict/);
  });

  it("a stale entry version is 409; a missing or stale plan hash refuses and leaves everything proposed", async () => {
    const { w, e, full } = await analysed();
    const ok = { accept: [stageFact(full).id] };
    const stale = await w.c.call("POST", `/api/v1/journal/${e.id}/confirmations`, { payload: { ...ok, expectedVersion: full.version - 1, expectedPlanContentHash: w.planHash } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_conflict");
    const noHash = await w.c.call("POST", `/api/v1/journal/${e.id}/confirmations`, { payload: { ...ok, expectedVersion: full.version } });
    expect(noHash.statusCode).toBe(422);
    const wrongHash = await w.c.call("POST", `/api/v1/journal/${e.id}/confirmations`, { payload: { ...ok, expectedVersion: full.version, expectedPlanContentHash: "0".repeat(64) } });
    expect(wrongHash.statusCode).toBe(409);
    const after = await getEntry(w, e.id);
    expect(after.version).toBe(full.version);
    expect(proposed(after).every((f) => f.status === "proposed")).toBe(true);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM plans WHERE farm_id=$1", [w.farmId])).rows[0].n).toBe(1);
    // Deciding the same facts twice is refused.
    const first = await w.c.call("POST", `/api/v1/journal/${e.id}/confirmations`, { payload: { expectedVersion: full.version, reject: [stageFact(full).id] } });
    expect(first.statusCode).toBe(200);
    const twice = await w.c.call("POST", `/api/v1/journal/${e.id}/confirmations`, { payload: { expectedVersion: full.version + 1, reject: [stageFact(full).id] } });
    expect(twice.statusCode).toBe(409);
  });

  it("rejecting or accepting a non-plan fact never calls the plan engine", async () => {
    const { w, e, full } = await analysed();
    const spy = vi.spyOn(PlanService.prototype, "revisePlan");
    const r = await w.c.call("POST", `/api/v1/journal/${e.id}/confirmations`, { payload: { expectedVersion: full.version, accept: [noteFact(full).id], reject: [stageFact(full).id] } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data.revision).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const entry = r.json().data.entry;
    expect(entry.facts.find((f: { id: string }) => f.id === stageFact(full).id)).toMatchObject({ status: "rejected" });
    expect((await h.pool.query("SELECT count(*)::int AS n FROM plans WHERE farm_id=$1", [w.farmId])).rows[0].n).toBe(1);
  });

  it("the preview runs the engine and saves nothing", async () => {
    const { w, e, full } = await analysed();
    const plansBefore = (await h.pool.query("SELECT count(*)::int AS n FROM plans WHERE owner_id=$1", [w.ownerId])).rows[0].n;
    const outsBefore = (await h.pool.query("SELECT count(*)::int AS n FROM plan_outputs WHERE owner_id=$1", [w.ownerId])).rows[0].n;
    const r = await w.c.call("POST", `/api/v1/journal/${e.id}/revision-preview`, { payload: { factIds: [stageFact(full).id] } });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().data;
    expect(d.planChanging).toBe(true);
    expect(d.changes[0]).toMatchObject({ type: "observed_stage", stageId: "vegetative" });
    expect(d.recompute).toEqual(expect.arrayContaining(["stages", "tasks"]));
    expect(d.preview.changeSummary.changedTaskIds).toBeDefined();
    expect((await h.pool.query("SELECT count(*)::int AS n FROM plans WHERE owner_id=$1", [w.ownerId])).rows[0].n).toBe(plansBefore);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM plan_outputs WHERE owner_id=$1", [w.ownerId])).rows[0].n).toBe(outsBefore);
    const notePreview = await w.c.call("POST", `/api/v1/journal/${e.id}/revision-preview`, { payload: { factIds: [noteFact(full).id] } });
    expect(notePreview.json().data).toMatchObject({ planChanging: false, preview: null });
    // And the real confirm still works afterwards with the same plan hash.
    const real = await w.c.call("POST", `/api/v1/journal/${e.id}/confirmations`, { payload: { expectedVersion: full.version, accept: [stageFact(full).id], expectedPlanContentHash: w.planHash } });
    expect(real.statusCode, real.body).toBe(200);
    expect(real.json().data.revision.changeSummary.changedTaskIds).toEqual(d.preview.changeSummary.changedTaskIds);
  });

  it("a farmer-selected stage is stored as an original plus a proposal and needs the same confirmation", async () => {
    const w = await world();
    const e = await createEntry(w, { stageId: "rhizome_bulking", mediaIds: [] });
    const full = await getEntry(w, e.id);
    expect(full.facts.filter((f: { field: string }) => f.field === "observed_stage").map((f: { kind: string }) => f.kind).sort()).toEqual(["original", "proposed"]);
    expect(proposed(full)[0]).toMatchObject({ source: "farmer", status: "proposed", requiresConfirmation: true });
    expect((await h.pool.query("SELECT count(*)::int AS n FROM plans WHERE farm_id=$1", [w.farmId])).rows[0].n).toBe(1);
  });
});

describe("routine entries involve no provider", () => {
  it("an expense-only entry, its timeline and a task completion never call a provider or queue a job", async () => {
    const w = await world();
    const fixtureCalls = vi.spyOn(FixtureProvider.prototype, "call");
    const metaCalls = vi.spyOn(MetaProvider.prototype, "call");
    const jobsBefore = (await h.pool.query("SELECT count(*)::int AS n FROM jobs WHERE type='journal.analysis'")).rows[0].n;
    const runsBefore = (await h.pool.query("SELECT count(*)::int AS n FROM agent_runs WHERE owner_id=$1", [w.ownerId])).rows[0].n;
    const e = await createEntry(w, { mediaIds: [], note: "Paid labour for weeding", activity: "weeding", expense: { amountInr: "600", category: "labour" } });
    const tl = (await w.c.call("GET", `/api/v1/farms/${w.farmId}/journal`)).json().data;
    expect(tl.entries[0].expense.amountInr).toBe("600.00");
    expect(tl.entries[0].provenanceLabel).toMatch(/Farmer-reported/);
    // Asking for an analysis without a photo is refused before any job exists.
    expect((await w.c.call("POST", `/api/v1/journal/${e.id}/analysis`)).statusCode).toBe(422);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM jobs WHERE type='journal.analysis'")).rows[0].n).toBe(jobsBefore);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM agent_runs WHERE owner_id=$1", [w.ownerId])).rows[0].n).toBe(runsBefore);
    expect(fixtureCalls).not.toHaveBeenCalled();
    expect(metaCalls).not.toHaveBeenCalled();
    fixtureCalls.mockRestore();
    metaCalls.mockRestore();
  });
});

describe("task completions", () => {
  it("feed the TaskCompletionSource and change its version; unknown tasks are refused", async () => {
    const w = await world();
    const e = await createEntry(w, { mediaIds: [] });
    const source = journalTaskCompletionSource(h.pool);
    const v0 = await source.version(w.ownerId, w.planId);
    expect(await source.getCompletions(w.ownerId, w.planId)).toEqual([]);
    const task = (await plans.getPlan(w.ownerId, w.planId)).outputs.find((o) => o.kind === "tasks")!.output as { tasks: { task: { id: string } }[] };
    const taskId = task.tasks[0]!.task.id;
    const r = await w.c.call("POST", `/api/v1/journal/${e.id}/task-completions`, { payload: { taskId, completedOn: TODAY } });
    expect(r.statusCode, r.body).toBe(200);
    const v1 = await source.version(w.ownerId, w.planId);
    expect(v1).not.toBe(v0);
    expect(await source.getCompletions(w.ownerId, w.planId)).toEqual([{ taskId, completedOn: TODAY }]);
    // Marking it again on another date changes the version again.
    await w.c.call("POST", `/api/v1/journal/${e.id}/task-completions`, { payload: { taskId, completedOn: "2026-01-02" } });
    expect(await source.version(w.ownerId, w.planId)).not.toBe(v1);
    expect((await w.c.call("POST", `/api/v1/journal/${e.id}/task-completions`, { payload: { taskId: "nope", completedOn: TODAY } })).statusCode).toBe(422);
    // It appears in the farm timeline and is owner-scoped.
    const tl = (await w.c.call("GET", `/api/v1/farms/${w.farmId}/journal`)).json().data;
    expect(tl.completedTasks).toEqual([{ taskId, completedOn: "2026-01-02", entryId: e.id, planId: w.planId }]);
    expect(await source.getCompletions("00000000-0000-4000-8000-000000000001", w.planId)).toEqual([]);
  });
});

describe("owner scoping", () => {
  it("another owner gets 404 on every route and sees nothing", async () => {
    const w = await world();
    const e = await createEntry(w);
    const o = await login(app);
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/v1/farms/${w.farmId}/journal`],
      ["GET", `/api/v1/journal/${e.id}`],
      ["POST", `/api/v1/journal/${e.id}/analysis`],
      ["POST", `/api/v1/journal/${e.id}/revision-preview`, { factIds: [e.facts[0]?.id ?? "00000000-0000-4000-8000-000000000002"] }],
      ["POST", `/api/v1/journal/${e.id}/confirmations`, { expectedVersion: 1, accept: ["00000000-0000-4000-8000-000000000002"] }],
      ["POST", `/api/v1/journal/${e.id}/task-completions`, { taskId: "plant:0", completedOn: TODAY }],
      ["POST", "/api/v1/journal", entryBody(w, { clientEntryId: "entry-cross-owner-1" })],
    ];
    for (const [m, u, p] of calls) {
      const r = await o.call(m, u, p === undefined ? {} : { payload: p });
      expect(r.statusCode, `${m} ${u} ${r.body}`).toBe(404);
    }
    expect((await h.pool.query("SELECT count(*)::int AS n FROM journal_entries WHERE client_entry_id='entry-cross-owner-1'")).rows[0].n).toBe(0);
    // Foreign plan id on create is 404 too.
    const w2 = await world();
    expect((await w2.c.call("POST", "/api/v1/journal", { payload: entryBody(w2, { planId: w.planId }) })).statusCode).toBe(404);
    // Unauthenticated and CSRF-less calls are refused.
    expect((await w.c.call("GET", `/api/v1/journal/${e.id}`, { cookie: null })).statusCode).toBe(401);
    expect((await w.c.call("POST", "/api/v1/journal", { payload: entryBody(w), csrf: null })).statusCode).toBe(403);
  });
});

describe("tool bindings", () => {
  it("interpret_observation queues the job and never calls a provider; it returns stored proposals afterwards; foreign media is 404", async () => {
    const w = await world();
    await createEntry(w);
    const handler = bindInterpretObservation({ pool: h.pool, service, plans });
    const ctx = { ownerId: w.ownerId, mode: "synthetic" as const, requestId: "r", pool: h.pool, agentRunId: "a", asOf: new Date().toISOString() };
    const queued = await handler({ mediaIds: [w.mediaId], farmId: w.farmId }, ctx);
    expect(queued.abstained).toBe(true);
    expect(queued.abstainReason).toMatch(/analysis_queued: job /);
    const again = await handler({ mediaIds: [w.mediaId], farmId: w.farmId }, ctx);
    expect(again.abstainReason).toMatch(/analysis_in_progress/);
    const job = (await h.pool.query("SELECT id, owner_id, payload FROM jobs WHERE type='journal.analysis' AND owner_id=$1", [w.ownerId])).rows[0];
    await runJournalAnalysis(workerDeps(), job, { heartbeat: async () => undefined });
    const done = await handler({ mediaIds: [w.mediaId], farmId: w.farmId }, ctx);
    expect(done.abstained).toBe(false);
    expect(done.proposals.map((p) => p.field).sort()).toEqual(["observed_stage", "waterlogging_visible"]);
    expect(done.proposals.every((p) => p.requiresConfirmation === true && p.proposed.evidenceState === "derived")).toBe(true);
    const other = await world({ plan: false });
    await expect(handler({ mediaIds: [other.mediaId], farmId: w.farmId }, ctx)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("propose_plan_revision validates typed changes, never commits and surfaces required confirmation", async () => {
    const w = await world();
    const handler = bindProposePlanRevision({ pool: h.pool, service, plans });
    const ctx = { ownerId: w.ownerId, mode: "synthetic" as const, requestId: "r", pool: h.pool, agentRunId: "a", asOf: new Date().toISOString() };
    const val = (kind: "category" | "text", value: string, validFrom: string | null = null) => ({
      schemaVersion: "1.0" as const, kind, value, unit: null, evidenceState: "farmer_reported" as const, scope: { level: "farm" as const, ids: [w.farmId] },
      validFrom, validTo: null, issuedAt: null, evidenceIds: [], assumptionIds: [], methodVersion: null, validationStatus: "pending" as const, missingReason: null,
    });
    const out = await handler(
      { planId: w.planId, expectedContentHash: w.planHash, changes: [{ key: "irrigation_category", to: val("category", "irrigated") }, { key: "observed_stage", to: val("category", "vegetative", TODAY) }] },
      ctx,
    );
    expect(out.requiresUserConfirmation).toBe(true);
    expect(out.validationErrors).toEqual([]);
    expect(out.diff.map((d) => d.key)).toEqual(["irrigation_category", "observed_stage"]);
    expect(out.recomputeRequired).toEqual(expect.arrayContaining(["water", "stages"]));
    const bad = await handler({ planId: w.planId, expectedContentHash: "1".repeat(64), changes: [{ key: "observed_stage", to: val("category", "no_such_stage", TODAY) }, { key: "budget", to: val("text", "x") }] }, ctx);
    expect(bad.validationErrors.join(" ")).toMatch(/plan_hash_mismatch/);
    expect(bad.validationErrors.join(" ")).toMatch(/observed_stage/);
    expect(bad.validationErrors.join(" ")).toMatch(/unsupported_key:budget/);
    expect(bad.diff).toEqual([]);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM plans WHERE farm_id=$1", [w.farmId])).rows[0].n).toBe(1);
    const other = await world({ plan: false });
    await expect(handler({ planId: w.planId, expectedContentHash: w.planHash, changes: [{ key: "area", to: val("category", "1") }] }, { ...ctx, ownerId: other.ownerId })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("misc", () => {
  it("trace redaction keeps notes to 200 characters and drops image data URLs", () => {
    const r = redactForTrace({ note: "n".repeat(500), image: "data:image/jpeg;base64,AAAA", nested: { image_url: "data:image/jpeg;base64,BBBB" } }) as Record<string, unknown>;
    expect(String(r.note).length).toBeLessThan(260);
    expect(JSON.stringify(r)).not.toMatch(/AAAA|BBBB/);
  });

  it("the standalone app error shape renders ApiError (sanity for the route plugin in isolation)", async () => {
    const solo = Fastify();
    solo.setValidatorCompiler(validatorCompiler);
    solo.setSerializerCompiler(serializerCompiler);
    solo.setErrorHandler((err, req, reply) => {
      const e = err as ApiError;
      reply.code(e.statusCode ?? 500).send(errorEnvelope(req.id, "synthetic", { code: e.code ?? "internal_error", message: e.message }));
    });
    await registerJournalRoutes(solo, { config: h.config, service, resolveOwner: () => "00000000-0000-4000-8000-0000000000aa" });
    const r = await solo.inject({ method: "GET", url: "/api/v1/journal/00000000-0000-4000-8000-0000000000bb" });
    expect(r.statusCode).toBe(404);
    await solo.close();
  });
});
