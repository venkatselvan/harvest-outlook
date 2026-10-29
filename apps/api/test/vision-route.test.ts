import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, makeJpeg, setupHarness, upload, type Client, type Harness } from "./helpers";

let h: Harness;
let a: Client;
let b: Client;
let mediaId: string;
const seg = (c: Client, id: string, prompt: unknown, o: { csrf?: string | null; cookie?: string | null } = {}) =>
  c.call("POST", `/api/v1/media/${id}/segmentation`, { payload: { prompt }, ...o });

beforeAll(async () => {
  h = await setupHarness();
  a = await login(h.app);
  b = await login(h.app);
  mediaId = (await upload(a, await makeJpeg({ width: 300, height: 200 }))).json().data.id;
});
afterAll(async () => h.close());

describe("POST /media/:id/segmentation", () => {
  it("queues a vision.segment job and returns the manual-fallback flag and the AI label", async () => {
    const r = await seg(a, mediaId, { kind: "concept", text: "field" });
    expect(r.statusCode).toBe(202);
    const d = r.json().data;
    expect(d).toMatchObject({ state: "queued", deduplicated: false, manualFallbackAvailable: true });
    expect(d.label).toMatch(/illustrative outline, confirm or correct/);
    const job = (await a.call("GET", `/api/v1/jobs/${d.jobId}`)).json().data;
    expect(job).toMatchObject({ type: "vision.segment", state: "queued", result: null });
  });
  it("identical requests return the same job; a different prompt creates another", async () => {
    const p = { kind: "box", x0: 0.1, y0: 0.1, x1: 0.8, y1: 0.9 };
    const r1 = (await seg(a, mediaId, p)).json().data;
    const r2 = (await seg(a, mediaId, p)).json().data;
    expect(r2.jobId).toBe(r1.jobId);
    expect(r2.deduplicated).toBe(true);
    const r3 = (await seg(a, mediaId, { ...p, x1: 0.7 })).json().data;
    expect(r3.jobId).not.toBe(r1.jobId);
  });
  it("re-runs after a failed job instead of returning the failure forever", async () => {
    const p = { kind: "concept", text: "paddy field" };
    const r1 = (await seg(a, mediaId, p)).json().data;
    await h.pool.query("UPDATE jobs SET state='failed', finished_at=now() WHERE id=$1", [r1.jobId]);
    const r2 = (await seg(a, mediaId, p)).json().data;
    expect(r2.jobId).not.toBe(r1.jobId);
    expect(r2.deduplicated).toBe(false);
    await h.pool.query("UPDATE jobs SET state='succeeded', result=$2::jsonb, finished_at=now() WHERE id=$1", [r2.jobId, JSON.stringify({ status: "unavailable", reason: "provider_not_configured" })]);
    const r3 = (await seg(a, mediaId, p)).json().data;
    expect(r3.jobId).not.toBe(r2.jobId); // 'unavailable' results are re-runnable
    const again = (await seg(a, mediaId, p)).json().data;
    expect(again).toMatchObject({ jobId: r3.jobId, deduplicated: true }); // the queued replacement is reused
  });
  it("another owner's media is 404 and creates no job", async () => {
    const before = (await h.pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n;
    const r = await seg(b, mediaId, { kind: "concept", text: "field" });
    expect(r.statusCode).toBe(404);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n).toBe(before);
  });
  it("requires a session and CSRF, and validates the prompt", async () => {
    expect((await seg(a, mediaId, { kind: "concept", text: "field" }, { cookie: null, csrf: null })).statusCode).toBe(401);
    expect((await seg(a, mediaId, { kind: "concept", text: "field" }, { csrf: null })).statusCode).toBe(403);
    for (const bad of [
      { kind: "box", x0: -0.1, y0: 0, x1: 1, y1: 1 },
      { kind: "box", x0: 0, y0: 0, x1: 1.5, y1: 1 },
      { kind: "points", points: [] },
      { kind: "concept", text: "x".repeat(41) },
      { kind: "concept", text: "  " },
      { kind: "polygon" },
      { kind: "concept", text: "field", extra: 1 },
    ]) {
      expect((await seg(a, mediaId, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await a.call("POST", "/api/v1/media/not-a-uuid/segmentation", { payload: { prompt: { kind: "concept", text: "field" } } })).statusCode).toBe(400);
  });
});

describe("GET /farms/:id/media", () => {
  it("lists the owner's farm images newest first with the saved region, and 404s for another owner", async () => {
    const farm = (await a.call("POST", "/api/v1/farms", { payload: { name: "F", location: { districtId: "d1", districtName: "Wayanad", precision: "district" } } })).json().data;
    const m1 = (await upload(a, await makeJpeg({ width: 300, height: 200 }), { farmId: farm.id })).json().data;
    const m2 = (await upload(a, await makeJpeg({ width: 200, height: 300 }), { farmId: farm.id })).json().data;
    const put = await a.call("PUT", `/api/v1/media/${m1.id}/region`, {
      payload: { polygon: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]], source: "manual", transform: { orientationApplied: true, normalizedWidth: 300, normalizedHeight: 200 } },
    });
    expect(put.statusCode).toBe(200);
    const list = await a.call("GET", `/api/v1/farms/${farm.id}/media`);
    expect(list.statusCode).toBe(200);
    const media = list.json().data.media;
    expect(media.map((m: { id: string }) => m.id)).toEqual([m2.id, m1.id]);
    expect(media[1].region).toMatchObject({ source: "manual", version: 1 });
    expect(media[0].region).toBeNull();
    expect((await b.call("GET", `/api/v1/farms/${farm.id}/media`)).statusCode).toBe(404);
    expect((await a.call("GET", `/api/v1/farms/${farm.id}/media`, { cookie: null })).statusCode).toBe(401);
  });
});
