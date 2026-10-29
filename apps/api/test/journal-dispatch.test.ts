import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FixtureProvider } from "../src/agent/fixture-provider";
import type { ProviderOutcome, TextModelProvider } from "../src/agent/provider";
import { runJournalAnalysis, type JournalWorkerDeps } from "../src/journal";
import { PlanService, defaultSources } from "../src/plans";
import { Budget } from "../src/services/budget";
import { processImage, storeImage } from "../src/services/media";
import { login, setupHarness, type Client, type Harness } from "./helpers";

// SYNTHETIC: stub provider replays a fixture. No live Meta call is made.
let h: Harness;
let budget: Budget;
let plans: PlanService;
let c: Client;
let ownerId: string;
let farmId: string;
let mediaId: string;
let seq = 0;

beforeAll(async () => {
  h = await setupHarness();
  budget = Budget.fromConfig(h.pool, h.config);
  await budget.init();
  plans = new PlanService({ pool: h.pool, mode: "synthetic", sources: defaultSources() });
  c = await login(h.app);
  ownerId = (await h.pool.query<{ owner_id: string }>("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0]!.owner_id;
  farmId = (await h.pool.query<{ id: string }>("INSERT INTO farms (owner_id, name, district_code, state_code) VALUES ($1,'F','IN-KA-HAS','KA') RETURNING id", [ownerId])).rows[0]!.id;
  const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 60 } } }).jpeg().toBuffer();
  mediaId = (await storeImage(h.pool, h.storage, ownerId, farmId, img, await processImage(img))).id;
});
afterAll(async () => h.close());

async function queue() {
  const e = await c.call("POST", "/api/v1/journal", {
    payload: { clientEntryId: `entry-f9-${Date.now()}-${++seq}`, farmId, observedOn: new Date().toISOString().slice(0, 10), note: "Water standing near the lower rows.", language: "en", mediaIds: [mediaId], activity: "observation" },
  });
  expect(e.statusCode, e.body).toBe(201);
  const entryId = e.json().data.entry.id as string;
  const q = await c.call("POST", `/api/v1/journal/${entryId}/analysis`);
  expect(q.statusCode, q.body).toBe(202);
  const { jobId, analysisId } = q.json().data as { jobId: string; analysisId: string };
  const job = (await h.pool.query("SELECT id, owner_id, payload, attempt, max_attempts FROM jobs WHERE id=$1", [jobId])).rows[0];
  return { entryId, jobId, analysisId, job };
}
const deps = (over: Partial<JournalWorkerDeps>): JournalWorkerDeps => ({ pool: h.pool, config: h.config, storage: h.storage, budget, plans, ...over });
const hb = { heartbeat: async () => undefined };

function countingProvider() {
  const fixture = new FixtureProvider("journal_waterlogging");
  const call = vi.fn(async (req: Parameters<TextModelProvider["call"]>[0]): Promise<ProviderOutcome> => fixture.call(req));
  const provider: TextModelProvider = { kind: "meta", provenance: "meta_live", billable: true, call };
  return { provider, call };
}

describe("F9: journal analysis never pays twice for one job", () => {
  it("a failure after the provider call (settle throws) then two re-runs: zero further calls, one reservation, marked uncertain", async () => {
    const { entryId, jobId, analysisId, job } = await queue();
    const { provider, call } = countingProvider();
    const crashingBudget = Object.create(budget) as Budget;
    crashingBudget.settle = async () => {
      throw new Error("simulated crash during settlement");
    };

    await expect(runJournalAnalysis(deps({ provider, budget: crashingBudget }), job, hb)).rejects.toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    expect((await h.pool.query("SELECT outcome FROM job_dispatches WHERE job_id=$1", [jobId])).rows[0].outcome).toBeNull(); // still open

    for (let i = 0; i < 2; i++) await expect(runJournalAnalysis(deps({ provider }), job, hb)).rejects.toMatchObject({ code: "provider_outcome_uncertain", retryable: false });
    expect(call).toHaveBeenCalledTimes(1);
    const res = (await h.pool.query<{ state: string }>("SELECT state FROM usage_reservations WHERE job_id=$1", [jobId])).rows;
    expect(res).toEqual([{ state: "uncertain" }]);
    expect((await h.pool.query("SELECT outcome FROM job_dispatches WHERE job_id=$1", [jobId])).rows[0].outcome).toBe("uncertain");
    // The entry keeps only the farmer's originals; no proposals were created.
    expect((await h.pool.query("SELECT count(*)::int AS n FROM journal_facts WHERE entry_id=$1 AND kind='proposed'", [entryId])).rows[0].n).toBe(0);
    expect((await h.pool.query("SELECT status, error_code FROM journal_analyses WHERE id=$1", [analysisId])).rows[0]).toMatchObject({ status: "failed", error_code: "provider_outcome_uncertain" });
  });

  it("normal path: marker ends completed, one call, reservation settled", async () => {
    const { jobId, job } = await queue();
    const { provider, call } = countingProvider();
    await runJournalAnalysis(deps({ provider }), job, hb);
    expect(call).toHaveBeenCalledTimes(1);
    expect((await h.pool.query("SELECT outcome FROM job_dispatches WHERE job_id=$1", [jobId])).rows[0].outcome).toBe("completed");
    expect((await h.pool.query("SELECT state FROM usage_reservations WHERE job_id=$1", [jobId])).rows[0].state).toBe("settled");
  });

  it("a definite provider failure releases the reservation, marks the marker failed and may retry (re-armed marker, new call)", async () => {
    const { jobId, job } = await queue();
    const { provider, call } = countingProvider();
    call.mockResolvedValueOnce({ ok: false, error: { code: "rate_limited", message: "x", retryable: true, outcomeUncertain: false, requestId: null, retries: 0 } });
    await expect(runJournalAnalysis(deps({ provider }), { ...job, attempt: 1, max_attempts: 3 }, hb)).rejects.toMatchObject({ retryable: true });
    expect((await h.pool.query("SELECT outcome FROM job_dispatches WHERE job_id=$1", [jobId])).rows[0].outcome).toBe("failed");
    await runJournalAnalysis(deps({ provider }), { ...job, attempt: 2, max_attempts: 3 }, hb);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
