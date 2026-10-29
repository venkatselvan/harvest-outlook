import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Pool } from "../src/db/pool";
import { Budget } from "../src/services/budget";
import { registerVisualRoutes } from "../src/routes/visuals";
import { runVisualKeyframes, registerVisualHandlers, type VisualJobDeps } from "../src/visuals/job";
import { PgVisualAssetSource } from "../src/visuals/repository";
import { VISUAL_JOB_TYPE } from "../src/visuals/labels";
import { dataUrlToBuffer, editRegionOnly, editWholeImage, providerOk, REGION, sceneJpeg } from "./fixtures/muse-image/build";
import { farmBody, login, setupHarness, testConfig, upload, type Client, type Harness } from "./helpers";

// SYNTHETIC: mock fetch only. Nothing here talks to Meta, and every image is a programmatic fixture.
const STAGES = JSON.parse(readFileSync(resolve(__dirname, "../../../data/curated/stages/ginger.hassan-kharif.stages.json"), "utf8"));
const KEY = "unit-test-key-not-real";
const live = { RUNTIME_MODE: "live", MODEL_API_KEY: KEY };
const hb = { heartbeat: async () => undefined };

let h: Harness;
let a: Client;
let b: Client;
let ownerA: string;
let planA: string;
let mediaA: string;
let regionVersion = 0;
let base: Buffer;

async function ownerOf(mediaId: string): Promise<string> {
  return (await h.pool.query<{ owner_id: string }>("SELECT owner_id FROM media_objects WHERE id=$1", [mediaId])).rows[0]!.owner_id;
}

async function makePlan(c: Client, ownerId: string, mode: "live" | "synthetic" = "live"): Promise<string> {
  const farm = await c.call("POST", "/api/v1/farms", { payload: farmBody() });
  expect(farm.statusCode).toBe(201);
  const farmId = farm.json().data.id as string;
  await h.pool.query("INSERT INTO crop_identities (slug) VALUES ('ginger') ON CONFLICT (slug) DO NOTHING");
  const crop = (await h.pool.query<{ id: string }>("SELECT id FROM crop_identities WHERE slug='ginger'")).rows[0]!.id;
  const planId = randomUUID();
  const outId = randomUUID();
  await h.pool.query(
    `INSERT INTO plans (id, owner_id, farm_id, crop_id, mode, content_hash, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [planId, ownerId, farmId, crop, mode, randomUUID().replace(/-/g, ""), JSON.stringify({ id: planId, mode, outputIds: [outId] })],
  );
  await h.pool.query(`INSERT INTO plan_outputs (id, owner_id, plan_id, kind, content_hash, output, method_version) VALUES ($1,$2,$3,'inputs','h',$4::jsonb,'t')`, [
    outId,
    ownerId,
    planId,
    JSON.stringify({ engineVersion: "test", stageDefinitions: STAGES }),
  ]);
  return planId;
}

/** Bumps region_version and returns it, so every call starts from fresh cache keys. */
async function freshRegion(): Promise<number> {
  const res = await a.call("PUT", `/api/v1/media/${mediaA}/region`, {
    payload: { polygon: REGION, source: "manual", transform: { orientationApplied: true, normalizedWidth: 320, normalizedHeight: 240 } },
  });
  expect(res.statusCode).toBe(200);
  regionVersion = res.json().data.region.version;
  return regionVersion;
}

function deps(over: Record<string, string>, fetchImpl: typeof fetch): VisualJobDeps {
  const config = testConfig(over);
  return { pool: h.pool as Pool, config, storage: h.storage, budget: Budget.fromConfig(h.pool, config), fetchImpl, sleep: async () => undefined };
}

async function startJob(c: Client, planId = planA, body: Record<string, unknown> = {}) {
  const res = await c.call("POST", `/api/v1/plans/${planId}/visuals`, { payload: { mediaId: mediaA, regionVersion, ...body } });
  return res;
}
async function jobRow(jobId: string) {
  return (await h.pool.query<{ id: string; owner_id: string; payload: unknown }>("SELECT id, owner_id, payload FROM jobs WHERE id=$1", [jobId])).rows[0]!;
}
/** Route + job in one step for the common case. */
async function runFresh(over: Record<string, string>, f: typeof fetch, body: Record<string, unknown> = {}) {
  await freshRegion();
  const res = await startJob(a, planA, body);
  expect(res.statusCode, res.body).toBe(202);
  return runVisualKeyframes(deps(over, f), await jobRow(res.json().data.jobId), hb);
}

/** Provider double: returns the clean sent image with only the region edited (as a good edit would). */
const goodEdit = () =>
  vi.fn(async (_u: string, init: RequestInit) => {
    const sent = dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url);
    return providerOk(await editRegionOnly(sent), `req_${Math.random().toString(36).slice(2, 8)}`);
  });

const count = async (sql: string, args: unknown[] = []) => (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, args)).rows[0]!.n;

beforeAll(async () => {
  h = await setupHarness(live);
  await h.app.register(registerVisualRoutes, { config: h.config, pool: h.pool, storage: h.storage });
  a = await login(h.app);
  b = await login(h.app);
  base = await sceneJpeg();
  const up = await upload(a, base);
  expect(up.statusCode).toBe(201);
  mediaA = up.json().data.id;
  ownerA = await ownerOf(mediaA);
  planA = await makePlan(a, ownerA);
  await freshRegion();
});
afterAll(async () => h.close());

describe("generation, cache and dedup", () => {
  it("generates five illustrative keyframes with full provenance, then a repeat makes zero provider calls", async () => {
    const f = goodEdit();
    const res = await startJob(a);
    expect(res.statusCode).toBe(202);
    expect(res.json().data).toMatchObject({ cached: false, label: expect.stringContaining("not a prediction") });
    const out = await runVisualKeyframes(deps(live, f as unknown as typeof fetch), await jobRow(res.json().data.jobId), hb);
    expect(f).toHaveBeenCalledTimes(5);
    expect(out).toMatchObject({ cacheHit: false, providerCalls: 5, mode: "live" });
    expect(out.assets).toHaveLength(5);
    expect(out.assets.every((x) => x.state === "ready" && x.illustrative && x.evidenceState === "illustrative" && x.kind === "illustrative")).toBe(true);
    expect(out.assets.map((x) => x.qa?.passed)).toEqual([true, true, true, true, true]);

    // Request contract: clean sent image (no overlay), tools off, n=1, sized to the sent image.
    const first = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(first).toMatchObject({ model: "muse-image-1.0", n: 1, response_format: "b64_json", output_format: "png", size: "320x240" });
    const sent = dataUrlToBuffer(first.images[0].image_url);
    const srcPx = await sharp(base).removeAlpha().raw().toBuffer();
    const sentPx = await sharp(sent).removeAlpha().raw().toBuffer();
    let diff = 0;
    for (let i = 0; i < srcPx.length; i += 7) diff += Math.abs(srcPx[i]! - sentPx[i]!);
    expect(diff / (srcPx.length / 7)).toBeLessThan(6); // JPEG round-trip only; the polygon is not drawn on the reference
    expect(first.prompt).toContain("Keep the same field, camera angle, lighting and background");

    const rows = (await h.pool.query("SELECT * FROM visual_assets WHERE plan_id=$1 AND region_version=$2 ORDER BY stage_key", [planA, regionVersion])).rows;
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r).toMatchObject({ kind: "illustrative", status: "ready", illustrative: true, evidence_state: "illustrative", label: "illustrative", provider: "meta", model: "muse-image-1.0", mode: "live", source_media_id: mediaA, region_version: regionVersion, prompt_version: "ginger-brief-1", crop_id: "ginger" });
      expect(r.cache_key).toHaveLength(64);
      expect(r.brief_hash).toHaveLength(64);
      expect(r.prompt_template_hash).toHaveLength(64);
      expect(r.provider_request_id).toMatch(/^req_/);
      expect(r.job_id).toBe(res.json().data.jobId);
      expect(r.storage_key).toBe(`visuals/${r.id}/keyframe.png`);
      expect(await h.storage.exists({ ownerId: ownerA, key: r.storage_key })).toBe(true);
    }

    // Budget: reserved worst case (5 images x 2 for a retry) vs settled (5 x $0.01).
    const led = (await h.pool.query("SELECT estimated_usd::float AS e, settled_usd::float AS s, cost_basis FROM usage_ledger WHERE request_id=$1", [res.json().data.jobId])).rows[0];
    expect(led).toMatchObject({ e: 0.1, s: 0.05, cost_basis: "estimated" });
    expect(out.cost).toMatchObject({ reservedUsd: 0.1, settledUsd: 0.05, images: 5, outcome: "settled" });

    // Dedup through the route: same photo/region/crop/stages/brief/model/mode -> cached, no job, same assets.
    const again = await startJob(a);
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ cached: true, jobId: null });
    expect(again.json().data.assets.map((x: { assetId: string }) => x.assetId).sort()).toEqual(out.assets.map((x) => x.assetId).sort());
    // And through the job itself (e.g. a duplicate already queued).
    const none = vi.fn(async () => {
      throw new Error("provider must not be called on a cache hit");
    });
    const dup = await runVisualKeyframes(deps(live, none as unknown as typeof fetch), await jobRow(res.json().data.jobId), hb);
    expect(none).not.toHaveBeenCalled();
    expect(dup).toMatchObject({ cacheHit: true, providerCalls: 0, cost: null });
    expect(dup.assets.map((x) => x.assetId).sort()).toEqual(out.assets.map((x) => x.assetId).sort());
  });

  it("a second plan with the same photo, region, crop and stages adopts the keyframes: no job, no provider call, no new spend", async () => {
    const planB = await makePlan(a, ownerA);
    const ledgerBefore = await count("usage_ledger");
    const res = await startJob(a, planB);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ cached: true, jobId: null });
    const adopted = res.json().data.assets as { assetId: string; planId: string; state: string }[];
    expect(adopted).toHaveLength(5);
    expect(adopted.every((x) => x.planId === planB && x.state === "ready")).toBe(true);
    const rows = (await h.pool.query("SELECT b.storage_key AS bk, o.storage_key AS ok, b.reused_from, o.id AS oid, b.id AS bid FROM visual_assets b JOIN visual_assets o ON o.id = b.reused_from WHERE b.plan_id=$1", [planB])).rows;
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.bk).toBe(r.ok);
      expect(r.bid).not.toBe(r.oid);
    }
    expect(await count("usage_ledger")).toBe(ledgerBefore);
    const list = (await a.call("GET", `/api/v1/plans/${planB}/visuals`)).json().data.stages as { state: string }[];
    expect(list.every((s) => s.state === "ready")).toBe(true);
  });

  it("a changed region version is a different cache key; a stale version is rejected", async () => {
    const stale = regionVersion;
    await freshRegion();
    const res = await startJob(a, planA, { regionVersion: stale });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("region_version_mismatch");
    const ok = await startJob(a);
    expect(ok.statusCode).toBe(202);
    expect(ok.json().data.cached).toBe(false);
    // While the job is queued every stage reads as queued, so the UI can show progress.
    const fresh = await makePlan(a, ownerA);
    await startJob(a, fresh);
    const q = (await a.call("GET", `/api/v1/plans/${fresh}/visuals`)).json().data;
    expect(q.generating).toBe(true);
    expect(q.stages).toHaveLength(5);
    expect(q.stages.every((s: { state: string }) => s.state === "queued")).toBe(true);
    // Same request again while queued returns the same job (dedup).
    const dup = await startJob(a);
    expect(dup.json().data).toMatchObject({ jobId: ok.json().data.jobId, deduplicated: true });
  });

  it("registers the handler under visuals.keyframes", () => {
    const reg: Record<string, unknown> = {};
    registerVisualHandlers(reg as never, deps(live, vi.fn() as never));
    expect(typeof reg[VISUAL_JOB_TYPE]).toBe("function");
  });
});

describe("failure handling and budget", () => {
  it("a failing stage is marked failed, the others succeed, only the failed one is regenerated, and billing counts returned images", async () => {
    let n = 0;
    const flaky = vi.fn(async (_u: string, init: RequestInit) => {
      n++;
      if (n === 2) return new Response("{}", { status: 500 });
      return providerOk(await editRegionOnly(dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url)), `req_f${n}`);
    });
    const out = await runFresh(live, flaky as unknown as typeof fetch);
    const states = Object.fromEntries(out.assets.map((x) => [x.stageId, x.state]));
    expect(Object.values(states).filter((s) => s === "ready")).toHaveLength(4);
    expect(Object.values(states).filter((s) => s === "failed")).toHaveLength(1);
    expect(out.cost).toMatchObject({ settledUsd: 0.04, images: 4, outcome: "settled" });
    const failed = out.assets.find((x) => x.state === "failed")!;
    expect(failed.reason).toBe("provider_server");
    expect(failed.contentPath).toBeNull();

    // The plan is still readable and shows per-stage state. (Jobs queued by earlier tests would read as "generating".)
    await h.pool.query("UPDATE jobs SET state='cancelled' WHERE type='visuals.keyframes' AND state IN ('queued','running')");
    const list = await a.call("GET", `/api/v1/plans/${planA}/visuals`);
    expect(list.statusCode).toBe(200);
    const stages = list.json().data.stages as { stageId: string; state: string; label: string }[];
    expect(stages.find((s) => s.stageId === failed.stageId)).toMatchObject({ state: "failed", label: expect.stringContaining("Schematic") });
    expect(stages.filter((s) => s.state === "ready").every((s) => s.label.includes("not a prediction"))).toBe(true);

    const gen = await a.call("GET", `/api/v1/plans/${planA}/visuals`);
    expect(gen.json().data.generating).toBe(false);
    // Retry: only the failed stage is dispatched.
    const retry = vi.fn(async (_u: string, init: RequestInit) => providerOk(await editRegionOnly(dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url)), "req_retry"));
    const res = await startJob(a);
    expect(res.statusCode).toBe(202);
    const out2 = await runVisualKeyframes(deps(live, retry as unknown as typeof fetch), await jobRow(res.json().data.jobId), hb);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(out2.assets.every((x) => x.state === "ready")).toBe(true);
  });

  it("releases the reservation when every call fails definitively, and keeps it uncertain when the outcome is unknown", async () => {
    const reject = vi.fn(async () => new Response("{}", { status: 400 }));
    const out = await runFresh(live, reject as unknown as typeof fetch, { stageIds: ["sprouting_vegetative", "maturation"] });
    expect(reject).toHaveBeenCalledTimes(2);
    expect(out.cost).toMatchObject({ settledUsd: 0, images: 0, outcome: "released" });
    expect(out.assets.every((x) => x.state === "failed" && x.reason === "provider_bad_request")).toBe(true);
    const rel = (await h.pool.query("SELECT state, estimated_usd::float AS e FROM usage_reservations WHERE state='released' ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(rel).toMatchObject({ state: "released", e: 0.04 });

    const boom = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const out2 = await runFresh(live, boom as unknown as typeof fetch, { stageIds: ["maturation"] });
    expect(boom).toHaveBeenCalledTimes(1); // never auto-retried
    expect(out2.cost).toMatchObject({ outcome: "uncertain" });
    expect((await h.pool.query("SELECT state FROM usage_reservations ORDER BY created_at DESC LIMIT 1")).rows[0].state).toBe("uncertain");
  });

  it("budget exhaustion marks stages failed without a provider call or a reservation", async () => {
    const f = vi.fn();
    const before = await count("usage_reservations");
    const out = await runFresh({ ...live, BUDGET_PER_OWNER_DAY_USD: "0.001" }, f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
    expect(out.assets.every((x) => x.state === "failed" && x.reason === "budget_exceeded")).toBe(true);
    expect(await count("usage_reservations")).toBe(before);
  });

  it("stops between stages when cancellation is requested and settles only what was generated", async () => {
    let n = 0;
    let jobId = "";
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      n++;
      if (n === 1) await h.pool.query("UPDATE jobs SET cancel_requested=true WHERE id=$1", [jobId]);
      return providerOk(await editRegionOnly(dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url)), "req_c1");
    });
    await freshRegion();
    const res = await startJob(a);
    jobId = res.json().data.jobId;
    const out = await runVisualKeyframes(deps(live, f as unknown as typeof fetch), await jobRow(jobId), hb);
    expect(f).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ cancelled: true, providerCalls: 1 });
    expect(out.assets).toHaveLength(1);
    expect(out.cost).toMatchObject({ images: 1, settledUsd: 0.01, outcome: "settled" });
  });
});

describe("scene QA integration", () => {
  it("keeps a generated image whose scene changed but flags it for the UI", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => providerOk(await editWholeImage(dataUrlToBuffer(JSON.parse(init.body as string).images[0].image_url)), "req_q"));
    const out = await runFresh(live, f as unknown as typeof fetch, { stageIds: ["rhizome_initiation"] });
    expect(out.assets[0]).toMatchObject({ state: "ready", qa: { passed: false }, qaWarning: "Scene changed outside the planting region" });
    expect(out.assets[0]!.qa!.reasons).toContain("scene_changed_outside_region");
    expect(out.assets[0]!.contentPath).toMatch(/^\/api\/v1\/visuals\/.+\/content$/);
    const list = (await a.call("GET", `/api/v1/plans/${planA}/visuals`)).json().data.stages as { stageId: string; asset: { qaWarning: string | null } | null }[];
    expect(list.find((s) => s.stageId === "rhizome_initiation")!.asset!.qaWarning).toBe("Scene changed outside the planting region");
  });
});

describe("no fake keyframes", () => {
  it("synthetic mode produces schematic assets, no storage object, no fetch, no budget use, and is stable on repeat", async () => {
    const f = vi.fn();
    const before = await count("usage_reservations");
    const out = await runFresh({ ...live, RUNTIME_MODE: "synthetic" }, f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
    expect(out.mode).toBe("synthetic");
    expect(out.assets).toHaveLength(5);
    expect(out.assets.every((x) => x.state === "schematic" && x.kind === "schematic" && x.reason === "synthetic_mode" && x.contentPath === null && x.label.startsWith("Schematic"))).toBe(true);
    expect(await count("usage_reservations")).toBe(before);
    const stored = await count("visual_assets WHERE storage_key IS NOT NULL AND mode='synthetic'");
    expect(stored).toBe(0);
    // A schematic asset cannot become an observation: the table forbids it.
    await expect(h.pool.query("UPDATE visual_assets SET label='observed' WHERE mode='synthetic'")).rejects.toThrow();
    const rep = await runVisualKeyframes(deps({ ...live, RUNTIME_MODE: "synthetic" }, f as unknown as typeof fetch), await jobRow((await startJob(a, planA)).json().data.jobId ?? (await h.pool.query("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 1")).rows[0].id), hb);
    expect(rep.cacheHit).toBe(true);
  });

  it("a synthetic plan never generates, even with a live runtime and key", async () => {
    const planS = await makePlan(a, ownerA, "synthetic");
    await freshRegion();
    const f = vi.fn();
    const res = await startJob(a, planS, { stageIds: ["maturation"] });
    const out = await runVisualKeyframes(deps(live, f as unknown as typeof fetch), await jobRow(res.json().data.jobId), hb);
    expect(f).not.toHaveBeenCalled();
    expect(out.assets[0]).toMatchObject({ state: "schematic", reason: "synthetic_mode" });
  });

  it("live without MODEL_API_KEY yields schematic + provider_unavailable that is retried once a key exists", async () => {
    const f = vi.fn();
    await freshRegion();
    const res = await startJob(a, planA, { stageIds: ["maturation"] });
    const job = await jobRow(res.json().data.jobId);
    const out = await runVisualKeyframes(deps({ RUNTIME_MODE: "live" }, f as unknown as typeof fetch), job, hb);
    expect(f).not.toHaveBeenCalled();
    expect(out.assets[0]).toMatchObject({ state: "schematic", reason: "provider_unavailable" });
    // Not a stable outcome: with a key the same request generates.
    const g = goodEdit();
    const out2 = await runVisualKeyframes(deps(live, g as unknown as typeof fetch), job, hb);
    expect(g).toHaveBeenCalledTimes(1);
    expect(out2.assets[0]).toMatchObject({ state: "ready" });
  });
});

describe("ownership and routes", () => {
  it("serves content only to the owner, as a private PNG; schematic/failed/foreign/anonymous get 404/401", async () => {
    const ready = (await h.pool.query<{ id: string }>("SELECT id FROM visual_assets WHERE status='ready' AND owner_id=$1 LIMIT 1", [ownerA])).rows[0]!.id;
    const ok = await a.call("GET", `/api/v1/visuals/${ready}/content`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(String(ok.headers["cache-control"])).toContain("private");
    expect((await sharp(ok.rawPayload).metadata()).format).toBe("png");
    expect((await b.call("GET", `/api/v1/visuals/${ready}/content`)).statusCode).toBe(404);
    expect((await a.call("GET", `/api/v1/visuals/${randomUUID()}/content`)).statusCode).toBe(404);
    const schem = (await h.pool.query<{ id: string }>("SELECT id FROM visual_assets WHERE status='schematic' LIMIT 1")).rows[0]!.id;
    expect((await a.call("GET", `/api/v1/visuals/${schem}/content`)).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/api/v1/visuals/${ready}/content` })).statusCode).toBe(401);
  });

  it("another owner cannot start or list visuals for this plan or use this photo", async () => {
    expect((await b.call("GET", `/api/v1/plans/${planA}/visuals`)).statusCode).toBe(404);
    const res = await b.call("POST", `/api/v1/plans/${planA}/visuals`, { payload: { mediaId: mediaA, regionVersion } });
    expect(res.statusCode).toBe(404);
  });

  it("requires a confirmed region and validates stage ids", async () => {
    const up = await upload(a, await sceneJpeg(64, 48));
    const noRegion = await a.call("POST", `/api/v1/plans/${planA}/visuals`, { payload: { mediaId: up.json().data.id, regionVersion: 0 } });
    expect(noRegion.statusCode).toBe(422);
    expect(noRegion.json().error.code).toBe("region_required");
    const bad = await startJob(a, planA, { stageIds: ["not_a_stage"] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("unknown_stage");
  });
});

describe("VisualAssetSource for the plan timeline", () => {
  it("returns only ready keyframes as illustrative refs and its version changes when assets change", async () => {
    const src = new PgVisualAssetSource(h.pool);
    const planV = await makePlan(a, ownerA);
    expect(await src.getAssets(ownerA, planV)).toEqual([]);
    expect(await src.version(ownerA, planV)).toBe("none");
    await freshRegion();
    const res = await startJob(a, planV, { stageIds: ["sprouting_vegetative"] });
    await runVisualKeyframes(deps(live, goodEdit() as unknown as typeof fetch), await jobRow(res.json().data.jobId), hb);
    const refs = await src.getAssets(ownerA, planV);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "illustrative", date: null, stageId: "sprouting_vegetative" });
    const v1 = await src.version(ownerA, planV);
    expect(v1).not.toBe("none");
    expect(await src.version(ownerA, planV)).toBe(v1); // stable without changes
    const res2 = await startJob(a, planV, { stageIds: ["maturation"] });
    await runVisualKeyframes(deps(live, goodEdit() as unknown as typeof fetch), await jobRow(res2.json().data.jobId), hb);
    expect((await src.getAssets(ownerA, planV)).map((r) => r.stageId).sort()).toEqual(["maturation", "sprouting_vegetative"]);
    expect(await src.version(ownerA, planV)).not.toBe(v1);
    // Schematic outcomes are not illustrative refs: the timeline falls back to its schematic state.
    const planW = await makePlan(a, ownerA, "synthetic");
    const res3 = await startJob(a, planW, { stageIds: ["maturation"] });
    await runVisualKeyframes(deps(live, vi.fn() as never), await jobRow(res3.json().data.jobId), hb);
    expect(await src.getAssets(ownerA, planW)).toEqual([]);
  });
});
