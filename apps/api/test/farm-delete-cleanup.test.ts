import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteFarm } from "../src/services/farms";
import { login, setupHarness, type Harness } from "./helpers";

// SYNTHETIC: rows and objects are inserted directly; no provider is called. The point is the privacy procedure:
// deleting a farm must remove the Today view objects (rendered satellite PNGs and generated illustrations) from the owner's
// private storage, and only that farm's objects.
let h: Harness;
let ownerId: string;
let otherOwnerId: string;
const log = { warn: () => undefined };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const ITEM = (n: number) => `S2A_MSIL2A_2026100${n}T052231_R062_T43PFQ_2026100${n}T101714`;
const HASH = "a".repeat(64);

beforeAll(async () => {
  h = await setupHarness();
  const ownerOf = async () => (await h.pool.query<{ owner_id: string }>("SELECT owner_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0]!.owner_id;
  await login(h.app);
  ownerId = await ownerOf();
  await login(h.app);
  otherOwnerId = await ownerOf();
  expect(otherOwnerId).not.toBe(ownerId);
});
afterAll(async () => h.close());

const newFarm = async (owner = ownerId) => (await h.pool.query<{ id: string }>("INSERT INTO farms (owner_id, name, district_code, state_code) VALUES ($1,'Cleanup farm','IN-KA-HAS','KA') RETURNING id", [owner])).rows[0]!.id;

/** Two analysed scenes (one with both images stored, one with only the visual image) and one ready plus one failed illustration. */
async function seedTodayObjects(farmId: string, owner = ownerId) {
  const keys = {
    sceneVisual: `ndvi/${farmId}/${ITEM(1)}/visual.png`,
    sceneNdvi: `ndvi/${farmId}/${ITEM(1)}/ndvi.png`,
    sceneOnlyVisual: `ndvi/${farmId}/${ITEM(2)}/visual.png`,
    illustration: "",
  };
  const scene = (item: string, imageKeys: Record<string, string> | null) => h.pool.query(
    `INSERT INTO ndvi_scene_stats (owner_id, farm_id, polygon_hash, item_id, acquired_at, field_stats, usable, image_keys) VALUES ($1,$2,$3,$4,now(),'{}'::jsonb,true,$5::jsonb)`,
    [owner, farmId, HASH, item, imageKeys ? JSON.stringify(imageKeys) : null],
  );
  await scene(ITEM(1), { visual: keys.sceneVisual, ndvi: keys.sceneNdvi });
  await scene(ITEM(2), { visual: keys.sceneOnlyVisual });
  await scene(ITEM(3), null); // analysed, never rendered
  const asset = (stage: string, status: string, key: string | null) => h.pool.query<{ id: string }>(
    `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, stage_id, stage_name, crop_id, crop_name, prompt_version, status, storage_key)
     VALUES ($1,$2,'cycle-1',$3,$4,'Stage','maize','Maize','future-look-v1',$5,$6) RETURNING id`,
    [owner, farmId, ITEM(1), stage, status, key],
  );
  keys.illustration = `future-look/${farmId}/00000000-0000-4000-8000-000000000001.png`;
  await asset("mid_season", "ready", keys.illustration);
  await asset("late_season", "failed", null);
  for (const k of [keys.sceneVisual, keys.sceneNdvi, keys.sceneOnlyVisual, keys.illustration]) await h.storage.put({ ownerId: owner, key: k }, PNG);
  return { keys };
}

const exists = (owner: string, key: string) => h.storage.exists({ ownerId: owner, key });
const count = async (sql: string, args: unknown[]) => Number((await h.pool.query<{ count: string }>(sql, args)).rows[0]!.count);

describe("deleteFarm removes the Today view objects", () => {
  it("deletes every recorded satellite image and illustration, leaves other farms and owners alone, and cascades the rows", async () => {
    const farmId = await newFarm();
    const mine = await seedTodayObjects(farmId);
    const sibling = await newFarm();
    const siblingKeys = (await seedTodayObjects(sibling)).keys;
    const foreignFarm = await newFarm(otherOwnerId);
    const foreign = await seedTodayObjects(foreignFarm, otherOwnerId);
    // The very same key text under another owner: deletion is owner-scoped and must not reach it.
    for (const k of Object.values(mine.keys)) await h.storage.put({ ownerId: otherOwnerId, key: k }, PNG);
    for (const k of Object.values(mine.keys)) expect(await exists(ownerId, k), k).toBe(true);

    const res = await deleteFarm(h.pool, h.storage, ownerId, farmId, log);

    expect(res).toEqual({ mediaObjectsRemoved: 0, storageObjectsFailed: 0 });
    for (const k of Object.values(mine.keys)) expect(await exists(ownerId, k), `${k} should be gone`).toBe(false);
    expect(await count("SELECT count(*) FROM ndvi_scene_stats WHERE farm_id=$1", [farmId])).toBe(0);
    expect(await count("SELECT count(*) FROM future_look_assets WHERE farm_id=$1", [farmId])).toBe(0);
    for (const k of Object.values(siblingKeys)) expect(await exists(ownerId, k), `${k} (other farm) must survive`).toBe(true);
    for (const k of [...Object.values(foreign.keys), ...Object.values(mine.keys)]) expect(await exists(otherOwnerId, k), `${k} (other owner) must survive`).toBe(true);
    expect(await count("SELECT count(*) FROM ndvi_scene_stats WHERE farm_id=$1", [sibling])).toBe(3);
    expect(await count("SELECT count(*) FROM future_look_assets WHERE farm_id=$1", [sibling])).toBe(2);
  });

  it("a key recorded on several rows is deleted once, and a missing object is not an error", async () => {
    const farmId = await newFarm();
    const key = `ndvi/${farmId}/${ITEM(1)}/visual.png`;
    for (const item of [ITEM(1), ITEM(2)]) {
      await h.pool.query(
        `INSERT INTO ndvi_scene_stats (owner_id, farm_id, polygon_hash, item_id, acquired_at, field_stats, usable, image_keys) VALUES ($1,$2,$3,$4,now(),'{}'::jsonb,true,$5::jsonb)`,
        [ownerId, farmId, HASH, item, JSON.stringify({ visual: key })],
      );
    }
    // The recorded object was never written (or was already removed).
    const deletes: string[] = [];
    const counting = { ...h.storage, delete: async (ref: { ownerId: string; key: string }) => { deletes.push(ref.key); await h.storage.delete(ref); } } as unknown as typeof h.storage;
    const res = await deleteFarm(h.pool, counting, ownerId, farmId, log);
    expect(deletes).toEqual([key]);
    expect(res.storageObjectsFailed).toBe(0);
  });

  it("a storage failure on these objects is counted and logged without leaking the error, and the farm is still gone", async () => {
    const farmId = await newFarm();
    const { keys } = await seedTodayObjects(farmId);
    const failing = {
      ...h.storage,
      delete: async (ref: { ownerId: string; key: string }) => {
        if (ref.key.startsWith("future-look/")) throw new Error("disk gone");
        await h.storage.delete(ref);
      },
    } as unknown as typeof h.storage;
    const warns: object[] = [];
    const res = await deleteFarm(h.pool, failing, ownerId, farmId, { warn: (o) => warns.push(o) });
    expect(res).toEqual({ mediaObjectsRemoved: 0, storageObjectsFailed: 1 });
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).not.toMatch(/disk gone/);
    expect(await count("SELECT count(*) FROM farms WHERE id=$1", [farmId])).toBe(0);
    expect(await exists(ownerId, keys.sceneVisual)).toBe(false);
    expect(await exists(ownerId, keys.illustration)).toBe(true); // orphaned, but unreachable through the API: its row is gone
  });
});
