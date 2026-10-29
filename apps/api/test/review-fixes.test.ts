import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeExpiredIdempotencyKeys } from "../src/services/idempotency";
import { farmBody, login, makeJpeg, ORIGIN, setupHarness, upload, type Client, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await setupHarness({ ALLOWED_ORIGINS: `${ORIGIN},https://app.example.org` });
});
afterAll(async () => h.close());

const preciseFarm = () =>
  farmBody({ location: { districtId: "IN-KL-WAY", districtName: "Wayanad", stateCode: "KL", precision: "precise", lat: 11.68537, lon: 76.13214 } });
const ownerOf = async (c: Client) => {
  const { hashToken } = await import("../src/security/tokens");
  const tok = c.cookie.match(/ho_session=([^;]+)/)![1]!;
  return (await h.pool.query("SELECT owner_id FROM sessions WHERE token_hash=$1", [hashToken(tok)])).rows[0].owner_id as string;
};

describe("H2: farm deletion purges idempotency rows", () => {
  it("removes the stored precise-coordinate response, and replaying the key does not resurrect the deleted farm", async () => {
    const c = await login(h.app);
    const key = "farm-create-0001";
    const first = await c.call("POST", "/api/v1/farms", { payload: preciseFarm(), headers: { "idempotency-key": key } });
    expect(first.statusCode).toBe(201);
    const farmId = first.json().data.id as string;
    const stored = await h.pool.query("SELECT farm_id, response::text AS r FROM idempotency_keys WHERE key=$1", [key]);
    expect(stored.rows[0].farm_id).toBe(farmId);
    expect(stored.rows[0].r).toContain("11.68537"); // the private data really is in the row before deletion

    expect((await c.call("DELETE", `/api/v1/farms/${farmId}`)).statusCode).toBe(200);
    const left = await h.pool.query("SELECT 1 FROM idempotency_keys WHERE key=$1 OR response::text LIKE '%11.68537%' OR farm_id=$2", [key, farmId]);
    expect(left.rowCount).toBe(0);

    const again = await c.call("POST", "/api/v1/farms", { payload: preciseFarm(), headers: { "idempotency-key": key } });
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replay"]).toBeUndefined();
    expect(again.json().data.id).not.toBe(farmId);
  });

  it("purges media upload keys of the farm, and keeps other farms' keys", async () => {
    const c = await login(h.app);
    const f1 = (await c.call("POST", "/api/v1/farms", { payload: farmBody() })).json().data.id as string;
    const f2 = (await c.call("POST", "/api/v1/farms", { payload: farmBody({ name: "Other" }), headers: { "idempotency-key": "farm-other-0001" } })).json().data.id as string;
    const up = await upload(c, await makeJpeg(), { farmId: f1, key: "media-up-0001" });
    expect(up.statusCode).toBe(201);
    const row = await h.pool.query("SELECT farm_id, media_id FROM idempotency_keys WHERE key='media-up-0001'");
    expect(row.rows[0]).toMatchObject({ farm_id: f1, media_id: up.json().data.id });
    await c.call("DELETE", `/api/v1/farms/${f1}`);
    expect((await h.pool.query("SELECT 1 FROM idempotency_keys WHERE key='media-up-0001'")).rowCount).toBe(0);
    expect((await h.pool.query("SELECT 1 FROM idempotency_keys WHERE key='farm-other-0001'")).rowCount).toBe(1);
    expect(f2).toBeTruthy();
  });

  it("TTL purge removes only expired keys", async () => {
    const c = await login(h.app);
    const owner = await ownerOf(c);
    await h.pool.query(
      `INSERT INTO idempotency_keys (owner_id, key, route, payload_hash, status_code, response, created_at) VALUES
       ($1,'old-key-0001','R','h',201,'{}', now() - interval '30 hours'), ($1,'new-key-0001','R','h',201,'{}', now() - interval '1 hour')`,
      [owner],
    );
    expect(await purgeExpiredIdempotencyKeys(h.pool, 24)).toBeGreaterThanOrEqual(1);
    const keys = (await h.pool.query("SELECT key FROM idempotency_keys WHERE owner_id=$1", [owner])).rows.map((r) => r.key);
    expect(keys).toContain("new-key-0001");
    expect(keys).not.toContain("old-key-0001");
  });
});

describe("L4: farm deletion removes jobs, agent runs, tool results, visual assets, timelines", () => {
  it("deletes the whole dependent tree and the generated keyframe file, leaving a second farm intact", async () => {
    const c = await login(h.app);
    const owner = await ownerOf(c);
    const farm = (await c.call("POST", "/api/v1/farms", { payload: farmBody() })).json().data.id as string;
    const keep = (await c.call("POST", "/api/v1/farms", { payload: farmBody({ name: "Keep" }) })).json().data.id as string;
    const media = (await upload(c, await makeJpeg(), { farmId: farm })).json().data.id as string;
    const crop = (await h.pool.query("INSERT INTO crop_identities (slug) VALUES ($1) RETURNING id", [`crop-${randomUUID()}`])).rows[0].id;
    const plan = async (farmId: string, hash: string) =>
      (await h.pool.query("INSERT INTO plans (owner_id, farm_id, crop_id, mode, content_hash, snapshot) VALUES ($1,$2,$3,'synthetic',$4,'{}') RETURNING id", [owner, farmId, crop, hash])).rows[0].id as string;
    const planId = await plan(farm, "h1");
    const keepPlan = await plan(keep, "h2");
    await h.pool.query("INSERT INTO plan_timelines (owner_id, plan_id, scenario_id, data_version, timeline) VALUES ($1,$2,'s','v','{}')", [owner, planId]);
    const job = (await h.pool.query("INSERT INTO jobs (owner_id, type, payload) VALUES ($1,'visual.generate',$2) RETURNING id", [owner, JSON.stringify({ planId, mediaId: media })])).rows[0].id;
    const keepJob = (await h.pool.query("INSERT INTO jobs (owner_id, type, payload) VALUES ($1,'visual.generate',$2) RETURNING id", [owner, JSON.stringify({ planId: keepPlan })])).rows[0].id;
    const run = (await h.pool.query("INSERT INTO agent_runs (owner_id, mode, purpose, farm_id) VALUES ($1,'synthetic','assistant_turn',$2) RETURNING id", [owner, farm])).rows[0].id;
    const keepRun = (await h.pool.query("INSERT INTO agent_runs (owner_id, mode, purpose, farm_id) VALUES ($1,'synthetic','assistant_turn',$2) RETURNING id", [owner, keep])).rows[0].id;
    await h.pool.query("INSERT INTO tool_results (owner_id, agent_run_id, tool_name, args_hash) VALUES ($1,$2,'t','a'), ($1,$3,'t','a')", [owner, run, keepRun]);
    const key = `${owner}/visual-keyframe.png`;
    await h.storage.put({ ownerId: owner, key }, Buffer.from("png"));
    await h.pool.query(
      `INSERT INTO visual_assets (owner_id, plan_id, mode, cache_key, status, storage_key, kind) VALUES ($1,$2,'synthetic','ck1','ready',$3,'illustrative')`,
      [owner, planId, key],
    );
    expect(await h.storage.exists({ ownerId: owner, key })).toBe(true);

    const del = await c.call("DELETE", `/api/v1/farms/${farm}`);
    expect(del.statusCode).toBe(200);
    const count = async (sql: string, p: unknown[]) => Number((await h.pool.query(sql, p)).rows[0].n);
    expect(await count("SELECT count(*) n FROM jobs WHERE id=$1", [job])).toBe(0);
    expect(await count("SELECT count(*) n FROM agent_runs WHERE id=$1", [run])).toBe(0);
    expect(await count("SELECT count(*) n FROM tool_results WHERE agent_run_id=$1", [run])).toBe(0);
    expect(await count("SELECT count(*) n FROM visual_assets WHERE plan_id=$1", [planId])).toBe(0);
    expect(await count("SELECT count(*) n FROM plan_timelines WHERE plan_id=$1", [planId])).toBe(0);
    expect(await h.storage.exists({ ownerId: owner, key })).toBe(false);
    // The other farm's rows survive.
    expect(await count("SELECT count(*) n FROM jobs WHERE id=$1", [keepJob])).toBe(1);
    expect(await count("SELECT count(*) n FROM agent_runs WHERE id=$1", [keepRun])).toBe(1);
    expect(await count("SELECT count(*) n FROM tool_results WHERE agent_run_id=$1", [keepRun])).toBe(1);
    expect(await count("SELECT count(*) n FROM plans WHERE id=$1", [keepPlan])).toBe(1);
  });
});

describe("L2: cookie hardening", () => {
  const setCookies = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat(r.headers["set-cookie"] as string[]);

  it("COOKIE_SECURE=true forces Secure and the __Host- name even for a localhost origin, and the session works via that cookie", async () => {
    const app = await h.make({ COOKIE_SECURE: "true" });
    const res = await app.inject({ method: "POST", url: "/api/v1/session", headers: { origin: ORIGIN } });
    const set = setCookies(res);
    const sess = set.find((s) => s.startsWith("__Host-ho_session="))!;
    expect(sess).toMatch(/Secure/);
    expect(sess).toMatch(/Path=\//);
    expect(sess).not.toMatch(/Domain=/);
    expect(set.some((s) => s.startsWith("ho_session="))).toBe(false);
    const tok = res.cookies.find((c) => c.name === "__Host-ho_session")!.value;
    const csrf = res.cookies.find((c) => c.name === "ho_csrf")!.value;
    const ok = await app.inject({ url: "/api/v1/farms", headers: { cookie: `__Host-ho_session=${tok}; ho_csrf=${csrf}` } });
    expect(ok.statusCode).toBe(200);
    // A plain-named cookie is not accepted in Secure mode (cookie-tossing defence).
    const plain = await app.inject({ url: "/api/v1/farms", headers: { cookie: `ho_session=${tok}; ho_csrf=${csrf}` } });
    expect(plain.statusCode).toBe(401);
  });

  it("production auto mode is Secure even when a proxy presents Host: localhost", async () => {
    const app = await h.make({ NODE_ENV: "production" });
    const res = await app.inject({ method: "POST", url: "/api/v1/session", headers: { origin: ORIGIN, host: "localhost:5173" } });
    expect(setCookies(res).find((s) => s.startsWith("__Host-ho_session="))).toMatch(/Secure/);
  });

  it("COOKIE_SECURE=false and auto on localhost keep the plain name", async () => {
    const app = await h.make({ COOKIE_SECURE: "false" });
    const res = await app.inject({ method: "POST", url: "/api/v1/session", headers: { origin: "https://app.example.org" } });
    const sess = setCookies(res).find((s) => s.startsWith("ho_session="))!;
    expect(sess).not.toMatch(/Secure/);
  });

  it("POST /session with a valid session rotates the token, keeps the owner and revokes the old token", async () => {
    const c = await login(h.app);
    const owner = await ownerOf(c);
    const owners = Number((await h.pool.query("SELECT count(*) FROM owners")).rows[0].count);
    const res = await c.call("POST", "/api/v1/session", { csrf: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.reused).toBe(true);
    const fresh = res.cookies.find((x) => x.name === "ho_session")!.value;
    const oldTok = c.cookie.match(/ho_session=([^;]+)/)![1]!;
    expect(fresh).not.toBe(oldTok);
    expect(Number((await h.pool.query("SELECT count(*) FROM owners")).rows[0].count)).toBe(owners);
    // old token is dead, new token resolves to the same owner
    expect((await c.call("GET", "/api/v1/farms")).statusCode).toBe(401);
    const csrf = res.cookies.find((x) => x.name === "ho_csrf")!.value;
    const rotated: Client = { ...c, cookie: `ho_session=${fresh}; ho_csrf=${csrf}`, csrf };
    expect((await h.app.inject({ url: "/api/v1/farms", headers: { cookie: rotated.cookie } })).statusCode).toBe(200);
    expect(await ownerOf(rotated)).toBe(owner);
  });
});
