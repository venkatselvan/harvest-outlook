import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "../src/db/pool";
import { Budget } from "../src/services/budget";
import { registerVisualRoutes } from "../src/routes/visuals";
import { runVisualKeyframes, type VisualJobDeps } from "../src/visuals/job";
import { dataUrlToBuffer, editRegionOnly, providerOk, REGION, sceneJpeg } from "./fixtures/muse-image/build";
import { farmBody, login, setupHarness, testConfig, upload, type Client, type Harness } from "./helpers";

// SYNTHETIC: mock fetch only. Nothing here talks to Meta.
const STAGES = JSON.parse(readFileSync(resolve(__dirname, "../../../data/curated/stages/ginger.hassan-kharif.stages.json"), "utf8"));
const live = { RUNTIME_MODE: "live", MODEL_API_KEY: "unit-test-key-not-real" };
const hb = { heartbeat: async () => undefined };
const TRANSFORM = { orientationApplied: true, normalizedWidth: 320, normalizedHeight: 240 };

let h: Harness;
let a: Client;
let ownerA: string;
let farmId: string;
let scene: Buffer;

async function makePlan(c: Client, ownerId: string): Promise<string> {
  if (!farmId) {
    const farm = await c.call("POST", "/api/v1/farms", { payload: farmBody() });
    farmId = farm.json().data.id as string;
  }
  await h.pool.query("INSERT INTO crop_identities (slug) VALUES ('ginger') ON CONFLICT (slug) DO NOTHING");
  const crop = (await h.pool.query<{ id: string }>("SELECT id FROM crop_identities WHERE slug='ginger'")).rows[0]!.id;
  const planId = randomUUID();
  const outId = randomUUID();
  await h.pool.query(`INSERT INTO plans (id, owner_id, farm_id, crop_id, mode, content_hash, snapshot) VALUES ($1,$2,$3,$4,'live',$5,$6::jsonb)`, [
    planId,
    ownerId,
    farmId,
    crop,
    randomUUID().replace(/-/g, ""),
    JSON.stringify({ id: planId, mode: "live", outputIds: [outId] }),
  ]);
  await h.pool.query(`INSERT INTO plan_outputs (id, owner_id, plan_id, kind, content_hash, output, method_version) VALUES ($1,$2,$3,'inputs','h',$4::jsonb,'t')`, [
    outId,
    ownerId,
    planId,
    JSON.stringify({ engineVersion: "test", stageDefinitions: STAGES }),
  ]);
  return planId;
}

/** Uploads the same photo again and confirms a region on it; returns media id and region version. */
async function mediaWithRegion(polygon: [number, number][]): Promise<{ mediaId: string; version: number }> {
  const up = await upload(a, scene);
  expect(up.statusCode).toBe(201);
  const mediaId = up.json().data.id as string;
  const res = await a.call("PUT", `/api/v1/media/${mediaId}/region`, { payload: { polygon, source: "manual", transform: TRANSFORM } });
  expect(res.statusCode).toBe(200);
  return { mediaId, version: res.json().data.region.version as number };
}

function deps(fetchImpl: typeof fetch, over: Partial<VisualJobDeps> = {}): VisualJobDeps {
  const config = testConfig(live);
  return { pool: h.pool as Pool, config, storage: h.storage, budget: Budget.fromConfig(h.pool, config), fetchImpl, sleep: async () => undefined, ...over };
}
const start = (planId: string, mediaId: string, regionVersion: number, headers: Record<string, string> = {}) =>
  a.call("POST", `/api/v1/plans/${planId}/visuals`, { payload: { mediaId, regionVersion }, headers });
const jobRow = async (jobId: string) => (await h.pool.query<{ id: string; owner_id: string; payload: unknown }>("SELECT id, owner_id, payload FROM jobs WHERE id=$1", [jobId])).rows[0]!;
const goodEdit = () =>
  vi.fn(async (_u: string, init: RequestInit) => {
    const sent = dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url);
    return providerOk(await editRegionOnly(sent), `req_${Math.random().toString(36).slice(2, 8)}`);
  });
/** Provider double that takes a moment, so concurrent jobs overlap on the same stage. */
const slowEdit = (ms = 40) =>
  vi.fn(async (_u: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, ms));
    const sent = dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url);
    return providerOk(await editRegionOnly(sent), `req_${Math.random().toString(36).slice(2, 8)}`);
  });

beforeAll(async () => {
  h = await setupHarness(live);
  await h.app.register(registerVisualRoutes, { config: h.config, pool: h.pool, storage: h.storage });
  a = await login(h.app);
  scene = await sceneJpeg();
  const probe = await upload(a, scene);
  ownerA = (await h.pool.query<{ owner_id: string }>("SELECT owner_id FROM media_objects WHERE id=$1", [probe.json().data.id])).rows[0]!.owner_id;
});
afterAll(async () => h.close());

describe("F6: one provider call per stage across concurrent jobs and Idempotency-Keys", () => {
  it("different Idempotency-Keys for the same content share one queued job", async () => {
    const plan = await makePlan(a, ownerA);
    const m = await mediaWithRegion(REGION);
    const r1 = await start(plan, m.mediaId, m.version, { "idempotency-key": "client-key-000001" });
    const r2 = await start(plan, m.mediaId, m.version, { "idempotency-key": "client-key-000002" });
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    expect(r2.json().data.jobId).toBe(r1.json().data.jobId);
    expect(r2.json().data.deduplicated).toBe(true);
    // The same client key still replays the stored response.
    const again = await start(plan, m.mediaId, m.version, { "idempotency-key": "client-key-000001" });
    expect(again.json().data.jobId).toBe(r1.json().data.jobId);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'planId'=$1", [plan])).rows[0].n).toBe(1);
  });

  it("two concurrent jobs for the same content call the provider once per stage; one reservation settles, the other is released", async () => {
    const plan = await makePlan(a, ownerA);
    const m = await mediaWithRegion(REGION);
    const payload = { planId: plan, mediaId: m.mediaId, regionVersion: m.version, sessionId: null };
    const ids: string[] = [];
    for (const k of ["conc-a-0001", "conc-b-0002"]) {
      const r = await h.pool.query<{ id: string }>(`INSERT INTO jobs (owner_id, type, payload, payload_hash, idempotency_key) VALUES ($1,'visuals.keyframes',$2::jsonb,$3,$4) RETURNING id`, [ownerA, JSON.stringify(payload), k, k]);
      ids.push(r.rows[0]!.id);
    }
    const f = slowEdit();
    const [o1, o2] = await Promise.all(ids.map(async (id) => runVisualKeyframes(deps(f as unknown as typeof fetch), await jobRow(id), hb))).then((r) => [r[0]!, r[1]!] as const);
    expect(f).toHaveBeenCalledTimes(5);
    expect(o1.providerCalls + o2.providerCalls).toBe(5);
    expect(o1.assets).toHaveLength(5);
    expect(o2.assets).toHaveLength(5);
    const states = (await h.pool.query<{ state: string }>("SELECT state FROM usage_reservations WHERE job_id = ANY($1::uuid[]) ORDER BY state", [ids])).rows.map((r) => r.state);
    expect(states).toEqual(["released", "settled"]);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM visual_assets WHERE plan_id=$1 AND status='ready'", [plan])).rows[0].n).toBe(5);
  });

  it("concurrent jobs on two plans with identical content adopt instead of generating twice", async () => {
    const p1 = await makePlan(a, ownerA);
    const p2 = await makePlan(a, ownerA);
    const m = await mediaWithRegion(REGION);
    const ids: string[] = [];
    for (const p of [p1, p2]) {
      const payload = { planId: p, mediaId: m.mediaId, regionVersion: m.version, sessionId: null };
      const r = await h.pool.query<{ id: string }>(`INSERT INTO jobs (owner_id, type, payload, payload_hash, idempotency_key) VALUES ($1,'visuals.keyframes',$2::jsonb,$3,$4) RETURNING id`, [ownerA, JSON.stringify(payload), p, p]);
      ids.push(r.rows[0]!.id);
    }
    const f = slowEdit();
    await Promise.all(ids.map(async (id) => runVisualKeyframes(deps(f as unknown as typeof fetch), await jobRow(id), hb)));
    expect(f).toHaveBeenCalledTimes(5);
    for (const p of [p1, p2]) expect((await h.pool.query("SELECT count(*)::int AS n FROM visual_assets WHERE plan_id=$1 AND status='ready'", [p])).rows[0].n).toBe(5);
  });
});

describe("F7: cache key binds the region polygon and the media", () => {
  it("identical photos with different polygons never share keyframes; the same media and polygon on a second plan still adopts", async () => {
    const planA = await makePlan(a, ownerA);
    const planB = await makePlan(a, ownerA);
    const planC = await makePlan(a, ownerA);
    const m1 = await mediaWithRegion(REGION);
    const other: [number, number][] = [[0.05, 0.05], [0.4, 0.05], [0.4, 0.3], [0.05, 0.3]];
    const m2 = await mediaWithRegion(other);
    const rA = await start(planA, m1.mediaId, m1.version);
    expect(rA.statusCode).toBe(202);
    const f = goodEdit();
    await runVisualKeyframes(deps(f as unknown as typeof fetch), await jobRow(rA.json().data.jobId), hb);
    expect(f).toHaveBeenCalledTimes(5);

    // Same bytes, different polygon: must not adopt a keyframe generated for the other region.
    const rB = await start(planB, m2.mediaId, m2.version);
    expect(rB.statusCode).toBe(202);
    expect(rB.json().data.cached).toBe(false);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM visual_assets WHERE plan_id=$1", [planB])).rows[0].n).toBe(0);
    const keysA = (await h.pool.query<{ cache_key: string }>("SELECT cache_key FROM visual_assets WHERE plan_id=$1", [planA])).rows.map((r) => r.cache_key);
    await runVisualKeyframes(deps(f as unknown as typeof fetch), await jobRow(rB.json().data.jobId), hb);
    const rowsB = (await h.pool.query<{ cache_key: string; reused_from: string | null }>("SELECT cache_key, reused_from FROM visual_assets WHERE plan_id=$1", [planB])).rows;
    expect(rowsB.every((r) => r.reused_from === null && !keysA.includes(r.cache_key))).toBe(true);
    expect(f).toHaveBeenCalledTimes(10);

    // Same media and polygon, another plan: spend-saving adoption is kept.
    const rC = await start(planC, m1.mediaId, m1.version);
    expect(rC.statusCode).toBe(200);
    expect(rC.json().data).toMatchObject({ cached: true, jobId: null });
    expect(f).toHaveBeenCalledTimes(10);
  });
});

describe("F8: dispatch markers stop a re-claimed job from calling the provider again", () => {
  it("a marker without outcome (crash after dispatch) means no new call; the stage is uncertain_needs_review and the reservation is uncertain", async () => {
    const plan = await makePlan(a, ownerA);
    const m = await mediaWithRegion(REGION);
    const res = await start(plan, m.mediaId, m.version);
    const job = await jobRow(res.json().data.jobId);
    const stageId = STAGES[1].stageId as string;
    // State a crashed process leaves behind: reservation made, marker committed, no outcome.
    const config = testConfig(live);
    const budget = Budget.fromConfig(h.pool, config);
    const { reservationId } = await budget.reserve({ ownerId: ownerA, sessionId: null, provider: "meta", model: config.META_IMAGE_MODEL, estimate: 0.1, jobId: job.id, requestId: job.id });
    await h.pool.query("INSERT INTO job_dispatches (job_id, stage_key, reservation_id) VALUES ($1,$2,$3)", [job.id, stageId, reservationId]);

    const f = goodEdit();
    const out = await runVisualKeyframes(deps(f as unknown as typeof fetch), job, hb);
    expect(f).toHaveBeenCalledTimes(4); // every stage except the uncertain one
    expect(out.assets.find((x) => x.stageId === stageId)).toMatchObject({ state: "failed", reason: "uncertain_needs_review" });
    expect((await h.pool.query("SELECT state FROM usage_reservations WHERE id=$1", [reservationId])).rows[0].state).toBe("uncertain");
    expect((await h.pool.query("SELECT outcome FROM job_dispatches WHERE job_id=$1 AND stage_key=$2", [job.id, stageId])).rows[0].outcome).toBe("uncertain");

    // A further re-claim stays blocked and makes zero calls.
    const f2 = goodEdit();
    await runVisualKeyframes(deps(f2 as unknown as typeof fetch), job, hb);
    expect(f2).not.toHaveBeenCalled();
  });

  it("every dispatched stage ends with an outcome in the normal path", async () => {
    const plan = await makePlan(a, ownerA);
    const m = await mediaWithRegion(REGION);
    const res = await start(plan, m.mediaId, m.version);
    const job = await jobRow(res.json().data.jobId);
    await runVisualKeyframes(deps(goodEdit() as unknown as typeof fetch), job, hb);
    const rows = (await h.pool.query<{ outcome: string | null }>("SELECT outcome FROM job_dispatches WHERE job_id=$1", [job.id])).rows;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.outcome === "completed")).toBe(true);
  });
});
