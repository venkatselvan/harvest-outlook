import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueue } from "../src/services/jobs";
import { farmBody, login, makeJpeg, multipart, ORIGIN, setupHarness, upload, type Client, type Harness } from "./helpers";

let h: Harness;
let a: Client;
let b: Client;
const MAX = 200_000;

beforeAll(async () => {
  h = await setupHarness({ MAX_UPLOAD_IMAGE_BYTES: String(MAX), ALLOWED_ORIGINS: `${ORIGIN},https://app.example.org` });
  a = await login(h.app);
  b = await login(h.app);
});
afterAll(async () => h.close());

const data = (r: { json: () => any }) => r.json().data;
const fileExists = (ownerId: string, key: string) => h.storage.exists({ ownerId, key });
const ownerOf = async (c: Client) => {
  const tok = c.cookie.match(/ho_session=([^;]+)/)![1]!;
  const { hashToken } = await import("../src/security/tokens");
  return (await h.pool.query("SELECT owner_id FROM sessions WHERE token_hash=$1", [hashToken(tok)])).rows[0].owner_id as string;
};

describe("sessions and cookies", () => {
  it("stores only the token hash and sets HttpOnly/SameSite cookies (not Secure on localhost)", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/v1/session", headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(201);
    const set = ([] as string[]).concat(res.headers["set-cookie"] as string[]);
    const sess = set.find((c) => c.startsWith("ho_session="))!;
    const csrf = set.find((c) => c.startsWith("ho_csrf="))!;
    expect(sess).toMatch(/HttpOnly/);
    expect(sess).toMatch(/SameSite=Lax/);
    expect(sess).toMatch(/Path=\//);
    expect(sess).toMatch(/Max-Age=2592000/);
    expect(sess).not.toMatch(/Secure/);
    expect(csrf).not.toMatch(/HttpOnly/);
    expect(csrf).toMatch(/SameSite=Lax/);
    const token = res.cookies.find((c) => c.name === "ho_session")!.value;
    expect(token.length).toBeGreaterThanOrEqual(43); // 256 bits base64url
    const rows = (await h.pool.query("SELECT token_hash FROM sessions")).rows.map((r) => r.token_hash);
    expect(rows).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(data(res)).toMatchObject({ authenticated: true, scope: "device_guest", reused: false });
    expect(data(res).caveat).toMatch(/no account recovery/);
  });

  it("marks cookies Secure for a non-localhost allowed origin", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/v1/session", headers: { origin: "https://app.example.org" } });
    const set = ([] as string[]).concat(res.headers["set-cookie"] as string[]);
    expect(set).toHaveLength(2);
    for (const c of set) expect(c).toMatch(/Secure/);
  });

  it("reuses a valid session instead of minting another owner, and revoke ends access", async () => {
    const c = await login(h.app);
    const before = Number((await h.pool.query("SELECT count(*) FROM owners")).rows[0].count);
    const again = await c.call("POST", "/api/v1/session", { csrf: null });
    expect(again.statusCode).toBe(200);
    expect(data(again).reused).toBe(true);
    expect(Number((await h.pool.query("SELECT count(*) FROM owners")).rows[0].count)).toBe(before);
    const del = await c.call("DELETE", "/api/v1/session");
    expect(del.statusCode).toBe(200);
    const after = await c.call("GET", "/api/v1/farms");
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("unauthenticated");
  });

  it("rejects private routes without a session and ignores a client-supplied ownerId", async () => {
    expect((await h.app.inject({ url: "/api/v1/farms" })).statusCode).toBe(401);
    const res = await a.call("POST", "/api/v1/farms", { payload: { ...farmBody(), ownerId: "00000000-0000-4000-8000-000000000000" } });
    expect(res.statusCode).toBe(201);
    const row = (await h.pool.query("SELECT owner_id FROM farms WHERE id=$1", [data(res).id])).rows[0];
    expect(row.owner_id).toBe(await ownerOf(a));
  });

  it("rate limits session creation per IP", async () => {
    const limited = await h.make({ SESSION_CREATE_PER_HOUR: "3" });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await limited.inject({ method: "POST", url: "/api/v1/session", headers: { origin: ORIGIN } })).statusCode);
    expect(codes).toEqual([201, 201, 201, 429, 429]);
  });
});

describe("CSRF and origin", () => {
  it("rejects missing, mismatched and forged CSRF tokens with 403", async () => {
    const missing = await a.call("POST", "/api/v1/farms", { payload: farmBody(), csrf: null });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe("csrf_invalid");
    expect((await a.call("POST", "/api/v1/farms", { payload: farmBody(), csrf: "x".repeat(43) })).statusCode).toBe(403);
    // attacker controls both cookie and header but cannot derive the server-bound value
    const forged = await a.call("POST", "/api/v1/farms", {
      payload: farmBody(),
      csrf: "forged-value",
      cookie: `${a.cookie.split(";")[0]}; ho_csrf=forged-value`,
    });
    expect(forged.statusCode).toBe(403);
    // another session's valid token does not work here
    expect((await a.call("POST", "/api/v1/farms", { payload: farmBody(), csrf: b.csrf })).statusCode).toBe(403);
    expect((await a.call("GET", "/api/v1/farms", { csrf: null })).statusCode).toBe(200); // safe methods need no token
  });

  it("rejects a bad Origin or Referer, and a missing one unless explicitly allowed", async () => {
    const bad = await a.call("POST", "/api/v1/farms", { payload: farmBody(), origin: "https://evil.example" });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe("origin_not_allowed");
    expect((await a.call("POST", "/api/v1/farms", { payload: farmBody(), origin: "null" })).statusCode).toBe(403);
    const badRef = await a.call("POST", "/api/v1/farms", { payload: farmBody(), origin: null, headers: { referer: "https://evil.example/x" } });
    expect(badRef.statusCode).toBe(403);
    const okRef = await a.call("POST", "/api/v1/farms", { payload: farmBody(), origin: null, headers: { referer: `${ORIGIN}/farms` } });
    expect(okRef.statusCode).toBe(201);
    const none = await a.call("POST", "/api/v1/farms", { payload: farmBody(), origin: null });
    expect(none.statusCode).toBe(403);
    expect(none.json().error.code).toBe("origin_required");
    const lax = await h.make({ ALLOW_MISSING_ORIGIN: "true" });
    const r = await lax.inject({ method: "POST", url: "/api/v1/farms", headers: { cookie: a.cookie, "x-csrf-token": a.csrf }, payload: farmBody() });
    expect(r.statusCode).toBe(201);
    const stillBad = await lax.inject({ method: "POST", url: "/api/v1/farms", headers: { cookie: a.cookie, "x-csrf-token": a.csrf, origin: "https://evil.example" }, payload: farmBody() });
    expect(stillBad.statusCode).toBe(403);
  });
});

describe("farms", () => {
  it("stores per-field provenance and appends superseding facts on PATCH", async () => {
    const created = await a.call("POST", "/api/v1/farms", { payload: farmBody({ location: { districtId: "IN-KL-WAY", districtName: "Wayanad", lat: 11.6054321, lon: 76.0834567, precision: "approximate" } }) });
    expect(created.statusCode).toBe(201);
    const farm = data(created);
    expect(farm.location).toMatchObject({ lat: 11.61, lon: 76.08, precision: "approximate" }); // coarsened
    expect(farm.facts.soil_ph).toMatchObject({ value: 6.2, unit: "pH", basis: "farmer_reported", confirmed: false, source: "own strip test" });
    const oldId = farm.facts.soil_ph.factId;

    const patched = await a.call("PATCH", `/api/v1/farms/${farm.id}`, {
      payload: { expectedVersion: 1, facts: { soil_ph: { value: 5.9, unit: "pH", basis: "lab_test", confirmed: true, source: "lab report 12" } } },
    });
    expect(patched.statusCode).toBe(200);
    expect(data(patched).version).toBe(2);
    expect(data(patched).facts.soil_ph).toMatchObject({ value: 5.9, basis: "lab_test", confirmed: true });
    expect(data(patched).facts.irrigation.value).toBe("drip"); // untouched

    const hist = data(await a.call("GET", `/api/v1/farms/${farm.id}?history=true`));
    const ph = hist.factHistory.filter((f: any) => f.key === "soil_ph");
    expect(ph.map((f: any) => [f.value, f.superseded])).toEqual([[6.2, true], [5.9, false]]);
    const rows = (await h.pool.query("SELECT id, supersedes_id, superseded_by FROM farm_facts WHERE farm_id=$1 AND fact_key='soil_ph' ORDER BY created_at", [farm.id])).rows;
    expect(rows[0].id).toBe(oldId);
    expect(rows[0].superseded_by).toBe(rows[1].id);
    expect(rows[1].supersedes_id).toBe(oldId);

    const stale = await a.call("PATCH", `/api/v1/farms/${farm.id}`, { payload: { expectedVersion: 1, name: "x" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_conflict");
  });

  it("validates location precision and fact basis", async () => {
    const coordsAsDistrict = await a.call("POST", "/api/v1/farms", { payload: farmBody({ location: { districtId: "d", districtName: "D", lat: 1, lon: 1, precision: "district" } }) });
    expect(coordsAsDistrict.statusCode).toBe(400);
    const noDistrict = await a.call("POST", "/api/v1/farms", { payload: farmBody({ location: { precision: "district" } }) });
    expect(noDistrict.statusCode).toBe(400);
    const badBasis = await a.call("POST", "/api/v1/farms", { payload: farmBody({ facts: { soil_ph: { value: 6, basis: "gut_feeling" } } }) });
    expect(badBasis.statusCode).toBe(400);
  });

  it("returns 404 (not 403) for another owner's farm on GET, PATCH and DELETE", async () => {
    const farm = data(await a.call("POST", "/api/v1/farms", { payload: farmBody() }));
    for (const [m, payload] of [["GET", undefined], ["PATCH", { name: "stolen" }], ["DELETE", undefined]] as const) {
      const res = await b.call(m, `/api/v1/farms/${farm.id}`, payload ? { payload } : {});
      expect(res.statusCode, m).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    const unknown = await b.call("GET", "/api/v1/farms/11111111-1111-4111-8111-111111111111");
    expect(unknown.json()).toMatchObject({ error: { code: "not_found" } }); // indistinguishable from "exists elsewhere"
    expect(data(await a.call("GET", `/api/v1/farms/${farm.id}`)).name).toBe("North plot");
    expect(data(await b.call("GET", "/api/v1/farms")).farms.map((f: any) => f.id)).not.toContain(farm.id);
  });

  it("idempotent create replays the identical body; a different payload is 422; concurrent duplicates create one farm", async () => {
    const payload = farmBody({ name: "Idem plot" });
    const key = "farm-create-0001";
    const first = await a.call("POST", "/api/v1/farms", { payload, headers: { "idempotency-key": key } });
    const second = await a.call("POST", "/api/v1/farms", { payload, headers: { "idempotency-key": key } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json()); // stored as jsonb: same content (key order may differ), same ids and timestamps
    expect(second.headers["idempotent-replay"]).toBe("true");
    const mismatch = await a.call("POST", "/api/v1/farms", { payload: { ...payload, name: "Other" }, headers: { "idempotency-key": key } });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe("idempotency_payload_mismatch");
    expect(Number((await h.pool.query("SELECT count(*) FROM farms WHERE name='Idem plot'")).rows[0].count)).toBe(1);
    // same key from another owner is independent
    expect((await b.call("POST", "/api/v1/farms", { payload, headers: { "idempotency-key": key } })).statusCode).toBe(201);

    const burst = await Promise.all(Array.from({ length: 6 }, () => a.call("POST", "/api/v1/farms", { payload: farmBody({ name: "Burst" }), headers: { "idempotency-key": "burst-key-0001" } })));
    expect(burst.every((r) => [201, 409].includes(r.statusCode))).toBe(true);
    expect(burst.some((r) => r.statusCode === 201)).toBe(true);
    expect(Number((await h.pool.query("SELECT count(*) FROM farms WHERE name='Burst'")).rows[0].count)).toBe(1);
    expect((await a.call("POST", "/api/v1/farms", { payload, headers: { "idempotency-key": "bad key!" } })).statusCode).toBe(400);
  });
});

describe("media upload", () => {
  it("stores original + normalized derivative, strips EXIF from the derivative, applies orientation", async () => {
    const farm = data(await a.call("POST", "/api/v1/farms", { payload: farmBody() }));
    const jpeg = await makeJpeg({ width: 200, height: 100, orientation: 6, exif: true });
    expect((await sharp(jpeg).metadata()).exif).toBeDefined(); // fixture really carries EXIF
    const res = await upload(a, jpeg, { farmId: farm.id });
    expect(res.statusCode).toBe(201);
    const m = data(res);
    expect(m).toMatchObject({ farmId: farm.id, contentType: "image/jpeg", width: 200, height: 100, exifOrientation: 6, orientedWidth: 100, orientedHeight: 200 });
    expect(m.normalized).toMatchObject({ width: 100, height: 200 });
    expect(JSON.stringify(m)).not.toMatch(/https?:\/\//);

    const owner = await ownerOf(a);
    const orig = await h.storage.get({ ownerId: owner, key: `media/${m.id}/original.jpg` });
    expect(Buffer.compare(Buffer.from(orig), jpeg)).toBe(0); // original untouched
    const norm = await h.storage.get({ ownerId: owner, key: `media/${m.id}/derived/normalized.jpg` });
    const nm = await sharp(Buffer.from(norm)).metadata();
    expect(nm.exif).toBeUndefined();
    expect(nm.orientation).toBeUndefined();
    expect(Buffer.from(norm).includes(Buffer.from("SECRET-OWNER-NAME"))).toBe(false);
    expect(orig.length && Buffer.from(orig).includes(Buffer.from("SECRET-OWNER-NAME"))).toBe(true);
    expect([nm.width, nm.height]).toEqual([100, 200]);

    const rows = (await h.pool.query("SELECT kind, sha256, byte_size::int AS bytes, width, height, exif_orientation, parent_media_id FROM media_objects WHERE owner_id=$1 AND (id=$2 OR parent_media_id=$2) ORDER BY kind", [owner, m.id])).rows;
    expect(rows.map((r) => r.kind)).toEqual(["derivative", "image"]);
    expect(rows[1]).toMatchObject({ bytes: jpeg.length, width: 200, height: 100, exif_orientation: 6 });
    expect(rows[1].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves content to the owner only, with private no-store caching; other owners and anonymous get 404/401", async () => {
    const m = data(await upload(a, await makeJpeg()));
    const ok = await a.call("GET", `/api/v1/media/${m.id}/content`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("private, no-store");
    expect(ok.headers["content-type"]).toBe("image/jpeg");
    expect((await sharp(ok.rawPayload).metadata()).format).toBe("jpeg");
    expect((await a.call("GET", `/api/v1/media/${m.id}/content?variant=original`)).statusCode).toBe(200);
    expect((await a.call("GET", `/api/v1/media/${m.id}/content?variant=thumb`)).statusCode).toBe(400);
    expect((await b.call("GET", `/api/v1/media/${m.id}/content`)).statusCode).toBe(404);
    expect((await b.call("GET", `/api/v1/media/${m.id}/content?variant=original`)).statusCode).toBe(404);
    expect((await b.call("GET", `/api/v1/media/${m.id}`)).statusCode).toBe(404);
    expect((await h.app.inject({ url: `/api/v1/media/${m.id}/content` })).statusCode).toBe(401);
  });

  it("rejects oversize uploads while streaming (header precheck and stream cap) and writes nothing", async () => {
    const before = Number((await h.pool.query("SELECT count(*) FROM media_objects")).rows[0].count);
    const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const huge = Buffer.concat([jpegHead, Buffer.alloc(MAX + 100_000, 1)]); // above max + multipart slack
    const r1 = await upload(a, huge);
    expect(r1.statusCode).toBe(413);
    expect(r1.json().error.code).toBe("payload_too_large");
    const slightly = Buffer.concat([jpegHead, Buffer.alloc(MAX + 10, 1)]); // inside the slack: caught by the stream cap
    const r2 = await upload(a, slightly);
    expect(r2.statusCode).toBe(413);
    expect(Number((await h.pool.query("SELECT count(*) FROM media_objects")).rows[0].count)).toBe(before);
  });

  it("rejects wrong magic bytes, SVG, GIF, truncated JPEG and non-multipart bodies regardless of declared type", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40)]);
    const text = Buffer.from("this is plainly not an image at all, just text");
    for (const [name, body] of [["svg", svg], ["gif", gif], ["text", text], ["tiny", Buffer.from("abc")]] as const) {
      const res = await upload(a, body, { type: "image/jpeg", filename: "photo.jpg" });
      expect(res.statusCode, name).toBe(415);
      expect(res.json().error.code).toBe("unsupported_media_type");
    }
    const real = await makeJpeg();
    const broken = Buffer.concat([real.subarray(0, 120), Buffer.alloc(200, 7)]);
    const res = await upload(a, broken);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_image");
    const json = await a.call("POST", "/api/v1/media", { payload: { x: 1 } });
    expect(json.statusCode).toBe(415);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer();
    expect((await upload(a, png)).statusCode).toBe(201);
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).webp().toBuffer();
    expect((await upload(a, webp)).statusCode).toBe(201);
  });

  it("refuses to attach media to another owner's farm", async () => {
    const farm = data(await a.call("POST", "/api/v1/farms", { payload: farmBody() }));
    const res = await upload(b, await makeJpeg(), { farmId: farm.id });
    expect(res.statusCode).toBe(404);
  });

  it("idempotent upload replays the same mediaId without storing again; a different file is 422", async () => {
    const jpeg = await makeJpeg({ width: 64, height: 64 });
    const key = "upload-key-0001";
    const r1 = await upload(a, jpeg, { key });
    const r2 = await upload(a, jpeg, { key });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(data(r2).id).toBe(data(r1).id);
    expect(r2.json()).toEqual(r1.json());
    const sha = data(r1).sha256;
    expect(Number((await h.pool.query("SELECT count(*) FROM media_objects WHERE sha256=$1 AND kind='image'", [sha])).rows[0].count)).toBe(1);
    const other = await upload(a, await makeJpeg({ width: 65, height: 64 }), { key });
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe("idempotency_payload_mismatch");
  });
});

describe("media region", () => {
  const poly = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
  it("validates point count, ranges, area and transform; increments region_version; owner-scoped", async () => {
    const m = data(await upload(a, await makeJpeg({ width: 200, height: 100, orientation: 6 })));
    const transform = { orientationApplied: true, normalizedWidth: m.normalized.width, normalizedHeight: m.normalized.height };
    const put = (c: Client, body: unknown, id = m.id) => c.call("PUT", `/api/v1/media/${id}/region`, { payload: body });

    expect((await put(a, { polygon: poly.slice(0, 2), source: "manual", transform })).statusCode).toBe(400);
    expect((await put(a, { polygon: [[0.1, 0.1], [1.2, 0.1], [0.9, 0.9]], source: "manual", transform })).statusCode).toBe(400);
    expect((await put(a, { polygon: [[0.1, -0.1], [0.5, 0.1], [0.9, 0.9]], source: "manual", transform })).statusCode).toBe(400);
    expect((await put(a, { polygon: Array.from({ length: 65 }, (_, i) => [i / 100, 0.5]), source: "manual", transform })).statusCode).toBe(400);
    expect((await put(a, { polygon: poly, source: "guess", transform })).statusCode).toBe(400);
    const flat = await put(a, { polygon: [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]], source: "manual", transform });
    expect(flat.statusCode).toBe(422);
    expect(flat.json().error.code).toBe("degenerate_region");
    expect((await put(a, { polygon: poly, source: "manual", transform: { ...transform, orientationApplied: false } })).json().error.code).toBe("orientation_not_applied");
    expect((await put(a, { polygon: poly, source: "manual", transform: { ...transform, normalizedWidth: 999 } })).json().error.code).toBe("transform_mismatch");
    expect((await put(b, { polygon: poly, source: "manual", transform })).statusCode).toBe(404);

    const ok = await put(a, { polygon: poly, source: "manual", transform });
    expect(ok.statusCode).toBe(200);
    expect(data(ok).region).toMatchObject({ source: "manual", version: 1, transform });
    const ok2 = await put(a, { polygon: poly, source: "sam_confirmed", transform });
    expect(data(ok2).region).toMatchObject({ source: "sam_confirmed", version: 2 });
    expect(data(await a.call("GET", `/api/v1/media/${m.id}`)).region.polygon).toEqual(poly);
  });
});

describe("farm deletion", () => {
  it("removes plans (trigger bypass), facts, journal, media rows and files in one go, leaving other owners intact", async () => {
    const farm = data(await a.call("POST", "/api/v1/farms", { payload: farmBody() }));
    const other = data(await b.call("POST", "/api/v1/farms", { payload: farmBody({ name: "Keep me" }) }));
    const otherMedia = data(await upload(b, await makeJpeg(), { farmId: other.id }));
    const m1 = data(await upload(a, await makeJpeg({ width: 50, height: 50 }), { farmId: farm.id }));
    const m2 = data(await upload(a, await makeJpeg({ width: 51, height: 50 }), { farmId: farm.id }));
    const unattached = data(await upload(a, await makeJpeg({ width: 52, height: 50 })));
    const owner = await ownerOf(a);
    const crop = (await h.pool.query("INSERT INTO crop_identities (slug) VALUES ('ginger-del') RETURNING id")).rows[0].id;
    const plan = (await h.pool.query("INSERT INTO plans (owner_id,farm_id,crop_id,mode,content_hash,snapshot) VALUES ($1,$2,$3,'synthetic','del1','{}') RETURNING id", [owner, farm.id, crop])).rows[0].id;
    await h.pool.query("INSERT INTO plans (owner_id,farm_id,crop_id,mode,content_hash,snapshot,parent_plan_id) VALUES ($1,$2,$3,'synthetic','del2','{}',$4)", [owner, farm.id, crop, plan]);
    await h.pool.query("INSERT INTO plan_outputs (owner_id,plan_id,kind,content_hash,output) VALUES ($1,$2,'x','h','{}')", [owner, plan]);
    const entry = (await h.pool.query("INSERT INTO journal_entries (owner_id,farm_id,entry_date,media_ids) VALUES ($1,$2,'2026-01-01',ARRAY[$3::uuid]) RETURNING id", [owner, farm.id, m1.id])).rows[0].id;
    await h.pool.query("INSERT INTO journal_facts (owner_id,entry_id,fact_key,value) VALUES ($1,$2,'k','1')", [owner, entry]);
    await h.pool.query("INSERT INTO actions (owner_id,plan_id,farm_id,action_type) VALUES ($1,$2,$3,'water')", [owner, plan, farm.id]);
    expect(await fileExists(owner, `media/${m1.id}/original.jpg`)).toBe(true);

    const del = await a.call("DELETE", `/api/v1/farms/${farm.id}`);
    expect(del.statusCode).toBe(200);
    expect(data(del)).toEqual({ deleted: true, mediaObjectsRemoved: 4, storageObjectsFailed: 0 });

    const count = async (sql: string, p: unknown[]) => Number((await h.pool.query(sql, p)).rows[0].count);
    expect(await count("SELECT count(*) FROM farms WHERE id=$1", [farm.id])).toBe(0);
    expect(await count("SELECT count(*) FROM plans WHERE farm_id=$1", [farm.id])).toBe(0);
    expect(await count("SELECT count(*) FROM plan_outputs WHERE plan_id=$1", [plan])).toBe(0);
    expect(await count("SELECT count(*) FROM farm_facts WHERE farm_id=$1", [farm.id])).toBe(0);
    expect(await count("SELECT count(*) FROM journal_entries WHERE farm_id=$1", [farm.id])).toBe(0);
    expect(await count("SELECT count(*) FROM actions WHERE farm_id=$1", [farm.id])).toBe(0);
    expect(await count("SELECT count(*) FROM media_objects WHERE id = ANY($1) OR parent_media_id = ANY($1)", [[m1.id, m2.id]])).toBe(0);
    for (const m of [m1, m2]) {
      for (const k of [`media/${m.id}/original.jpg`, `media/${m.id}/derived/normalized.jpg`]) expect(await fileExists(owner, k)).toBe(false);
    }
    // not scoped to the farm: untouched
    expect(await fileExists(owner, `media/${unattached.id}/original.jpg`)).toBe(true);
    expect(await fileExists(await ownerOf(b), `media/${otherMedia.id}/original.jpg`)).toBe(true);
    expect((await b.call("GET", `/api/v1/farms/${other.id}`)).statusCode).toBe(200);
    expect((await a.call("DELETE", `/api/v1/farms/${farm.id}`)).statusCode).toBe(404);

    // the bypass was transaction-local: plans are immutable again afterwards
    const p3 = (await h.pool.query("INSERT INTO plans (owner_id,farm_id,crop_id,mode,content_hash,snapshot) VALUES ($1,$2,$3,'synthetic','del3','{}') RETURNING id", [owner, other.id, crop])).rows[0].id;
    await expect(h.pool.query("DELETE FROM plans WHERE id=$1", [p3])).rejects.toThrow(/immutable/);
    await h.pool.query("BEGIN; SET LOCAL harvest.allow_plan_delete='on'; DELETE FROM plans WHERE id='" + p3 + "'; COMMIT;");
  });

  it("reports storage failures without failing the committed deletion", async () => {
    const farm = data(await a.call("POST", "/api/v1/farms", { payload: farmBody() }));
    await upload(a, await makeJpeg({ width: 33, height: 33 }), { farmId: farm.id });
    const failing = { ...h.storage, delete: async () => { throw new Error("disk gone"); } } as unknown as typeof h.storage;
    const { deleteFarm } = await import("../src/services/farms");
    const warns: object[] = [];
    const res = await deleteFarm(h.pool, failing, await ownerOf(a), farm.id, { warn: (o) => warns.push(o) });
    expect(res).toEqual({ mediaObjectsRemoved: 2, storageObjectsFailed: 2 });
    expect(warns).toHaveLength(2);
    expect(JSON.stringify(warns)).not.toMatch(/disk gone/);
    expect(Number((await h.pool.query("SELECT count(*) FROM farms WHERE id=$1", [farm.id])).rows[0].count)).toBe(0);
  });
});

describe("jobs", () => {
  it("returns sanitised owner-scoped status; cross-owner is 404; cancel sets the flag", async () => {
    const owner = await ownerOf(a);
    const { job } = await enqueue(h.pool, "noop", { secretInput: "do-not-leak" }, owner, "job-key-00001");
    const res = await a.call("GET", `/api/v1/jobs/${job.id}`);
    expect(res.statusCode).toBe(200);
    expect(data(res)).toMatchObject({ id: job.id, type: "noop", state: "queued", cancelRequested: false, error: null });
    expect(res.body).not.toContain("do-not-leak");
    expect((await b.call("GET", `/api/v1/jobs/${job.id}`)).statusCode).toBe(404);
    expect((await b.call("POST", `/api/v1/jobs/${job.id}/cancel`)).statusCode).toBe(404);
    expect((await a.call("POST", `/api/v1/jobs/${job.id}/cancel`, { csrf: null })).statusCode).toBe(403);
    const c = await a.call("POST", `/api/v1/jobs/${job.id}/cancel`);
    expect(c.statusCode).toBe(200);
    expect(data(c).cancelRequested).toBe(true);
    expect((await h.pool.query("SELECT cancel_requested FROM jobs WHERE id=$1", [job.id])).rows[0].cancel_requested).toBe(true);
  });

  it("hides raw worker error text; cancelling a finished job is 409", async () => {
    const owner = await ownerOf(a);
    const id = (await h.pool.query("INSERT INTO jobs (owner_id,type,state,error,retryable,finished_at) VALUES ($1,'x','failed',$2,false,now()) RETURNING id", [owner, JSON.stringify({ message: "ECONNREFUSED 10.0.0.5 key=sk-abc" })])).rows[0].id;
    const res = await a.call("GET", `/api/v1/jobs/${id}`);
    expect(data(res).error).toEqual({ code: "job_failed", retryable: false });
    expect(res.body).not.toContain("sk-abc");
    const c = await a.call("POST", `/api/v1/jobs/${id}/cancel`);
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe("job_finished");
  });

  it("enqueue returns the existing job for a duplicate key and rejects a different payload", async () => {
    const owner = await ownerOf(a);
    const first = await enqueue(h.pool, "noop", { n: 1 }, owner, "dup-key-000001");
    const again = await enqueue(h.pool, "noop", { n: 1 }, owner, "dup-key-000001");
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    await expect(enqueue(h.pool, "noop", { n: 2 }, owner, "dup-key-000001")).rejects.toMatchObject({ statusCode: 422, code: "idempotency_payload_mismatch" });
    const other = await enqueue(h.pool, "noop", { n: 1 }, await ownerOf(b), "dup-key-000001");
    expect(other.job.id).not.toBe(first.job.id);
  });
});

describe("capabilities budget block", () => {
  it("exposes remaining dev allocation and reserve, nothing per-user", async () => {
    const res = await h.app.inject({ url: "/api/v1/capabilities" });
    expect(data(res).budget).toEqual({ currency: "USD", devAllocationUsd: 120, remainingDevUsd: 120, demoReserveUsd: 30, exhausted: false });
    await h.pool.query("UPDATE budget_state SET reserved_usd = 20, settled_usd = 5.5");
    expect(data(await h.app.inject({ url: "/api/v1/capabilities" })).budget.remainingDevUsd).toBeCloseTo(94.5, 6);
  });
});

describe("logging", () => {
  it("redacts coordinates in logged request URLs and never logs cookies", async () => {
    const { reqSerializer } = await import("../src/security/logging");
    const out = reqSerializer({ method: "GET", url: "/api/v1/x?lat=11.6054&lon=76.08&keep=1", ip: "1.2.3.4" } as never);
    expect(out.url).toBe("/api/v1/x?lat=[redacted]&lon=[redacted]&keep=1");
    expect(JSON.stringify(out)).not.toMatch(/cookie|11\.6054/);
  });
});
