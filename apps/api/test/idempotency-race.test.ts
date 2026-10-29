import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteFarm } from "../src/services/farms";
import { runIdempotent } from "../src/services/idempotency";
import { login, setupHarness, type Harness } from "./helpers";

let h: Harness;
let ownerId: string;
const log = { warn: () => undefined };

beforeAll(async () => {
  h = await setupHarness();
  await login(h.app);
  ownerId = (await h.pool.query<{ owner_id: string }>("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0]!.owner_id;
});
afterAll(async () => h.close());

const newFarm = async () => (await h.pool.query<{ id: string }>("INSERT INTO farms (owner_id, name, district_code, state_code) VALUES ($1,'Race farm','IN-KA-HAS','KA') RETURNING id", [ownerId])).rows[0]!.id;

describe("F9: a farm delete between exec and the stored-response write leaves nothing to replay", () => {
  it("delete committing in the gap: no idempotency row remains, the caller still gets its response", async () => {
    const farmId = await newFarm();
    const out = await runIdempotent(
      h.pool,
      {
        ownerId,
        key: "race-key-00000001",
        route: "POST /api/v1/journal",
        hashInput: { farmId },
        beforeStore: async () => {
          await deleteFarm(h.pool, h.storage, ownerId, farmId, log); // commits after exec, before the write
        },
      },
      async () => ({ status: 201, body: { data: { id: "x", farmId, note: "private" } } }),
    );
    expect(out.status).toBe(201);
    const rows = await h.pool.query("SELECT 1 FROM idempotency_keys WHERE owner_id=$1 AND (farm_id=$2 OR response::text LIKE '%' || $2::text || '%' OR key='race-key-00000001')", [ownerId, farmId]);
    expect(rows.rowCount).toBe(0);
  });

  it("no race: the response is stored, linked to the farm, replays, and is purged by a later delete", async () => {
    const farmId = await newFarm();
    const opts = { ownerId, key: "race-key-00000002", route: "POST /api/v1/journal", hashInput: { farmId } };
    await runIdempotent(h.pool, opts, async () => ({ status: 201, body: { data: { farmId } } }));
    const replay = await runIdempotent(h.pool, opts, async () => ({ status: 500, body: {} }));
    expect(replay.replay).toBe(true);
    await deleteFarm(h.pool, h.storage, ownerId, farmId, log);
    expect((await h.pool.query("SELECT 1 FROM idempotency_keys WHERE key='race-key-00000002'")).rowCount).toBe(0);
  });

  it("delete racing the write itself: the write waits on the farm lock; either order leaves no row", async () => {
    const farmId = await newFarm();
    const results = await Promise.all([
      runIdempotent(h.pool, { ownerId, key: "race-key-00000003", route: "POST /api/v1/journal", hashInput: { farmId } }, async () => ({ status: 201, body: { data: { farmId } } })),
      deleteFarm(h.pool, h.storage, ownerId, farmId, log),
    ]);
    expect(results[0].status).toBe(201);
    expect((await h.pool.query("SELECT 1 FROM idempotency_keys WHERE key='race-key-00000003'")).rowCount).toBe(0);
  });
});

describe("F11: media upload idempotency rows vs concurrent media/farm deletion", () => {
  const newMedia = async (farmId: string) =>
    (await h.pool.query<{ id: string }>(
      "INSERT INTO media_objects (owner_id, farm_id, kind, storage_key, content_type, byte_size, sha256) VALUES ($1,$2,'image',$3,'image/jpeg',1,'00') RETURNING id",
      [ownerId, farmId, `media/${farmId}/o.jpg`],
    )).rows[0]!.id;
  const upload = (key: string, farmId: string, mediaId: string, beforeStore?: () => Promise<void>) =>
    runIdempotent(
      h.pool,
      { ownerId, key, route: "POST /api/v1/media", hashInput: { farmId }, ...(beforeStore ? { beforeStore } : {}) },
      async () => ({ status: 201, body: { data: { id: mediaId, farmId } } }),
    );
  const rowsFor = (key: string) => h.pool.query("SELECT 1 FROM idempotency_keys WHERE key=$1", [key]);

  it("farm delete committing between exec and store: media row gone, no idempotency row", async () => {
    const farmId = await newFarm();
    const mediaId = await newMedia(farmId);
    const out = await upload("race-media-0000001", farmId, mediaId, async () => void (await deleteFarm(h.pool, h.storage, ownerId, farmId, log)));
    expect(out.status).toBe(201);
    expect((await h.pool.query("SELECT 1 FROM media_objects WHERE id=$1", [mediaId])).rowCount).toBe(0);
    expect((await rowsFor("race-media-0000001")).rowCount).toBe(0);
  });

  it("media row deleted (farm kept) before the store: the conditional write finds no media, no row remains", async () => {
    const farmId = await newFarm();
    const mediaId = await newMedia(farmId);
    const out = await upload("race-media-0000002", farmId, mediaId, async () => void (await h.pool.query("DELETE FROM media_objects WHERE id=$1", [mediaId])));
    expect(out.status).toBe(201);
    expect((await rowsFor("race-media-0000002")).rowCount).toBe(0);
    await deleteFarm(h.pool, h.storage, ownerId, farmId, log);
  });

  it("deletion racing the write itself: either order leaves no row", async () => {
    const farmId = await newFarm();
    const mediaId = await newMedia(farmId);
    const [r] = await Promise.all([upload("race-media-0000003", farmId, mediaId), deleteFarm(h.pool, h.storage, ownerId, farmId, log)]);
    expect(r.status).toBe(201);
    expect((await rowsFor("race-media-0000003")).rowCount).toBe(0);
  });

  it("no race: the row is stored, linked to the media, and purged when the farm is deleted", async () => {
    const farmId = await newFarm();
    const mediaId = await newMedia(farmId);
    await upload("race-media-0000004", farmId, mediaId);
    expect((await h.pool.query("SELECT media_id FROM idempotency_keys WHERE key=$1", ["race-media-0000004"])).rows[0]?.media_id).toBe(mediaId);
    await deleteFarm(h.pool, h.storage, ownerId, farmId, log);
    expect((await rowsFor("race-media-0000004")).rowCount).toBe(0);
  });
});
