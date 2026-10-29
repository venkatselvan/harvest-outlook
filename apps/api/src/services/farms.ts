import type { PoolClient } from "pg";
import { withTransaction, type Pool } from "../db/pool";
import type { StorageAdapter } from "../storage/types";
import type { CreateFarmBody, FarmOut, PatchFarmBody } from "../routes/schemas/farms";
import { ApiError, notFound } from "./errors";

interface FarmRow {
  id: string;
  name: string;
  state_code: string | null;
  district_code: string | null;
  district_name: string | null;
  lat: number | null;
  lon: number | null;
  location_precision: "district" | "approximate" | "precise";
  area_hectares: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface FactRow {
  id: string;
  fact_key: string;
  value: unknown;
  unit: string | null;
  basis: FarmOut["facts"][string]["basis"];
  confirmed: boolean;
  source: string | null;
  recorded_at: Date;
  superseded_by: string | null;
}

type FactInput = NonNullable<CreateFarmBody["facts"]>[string];

/** Legacy 0001 `provenance` column, kept consistent with the richer basis/confirmed fields. */
function legacyProvenance(f: { basis: string; confirmed: boolean }): string {
  if (f.basis === "farmer_reported" || f.basis === "lab_test") return f.confirmed ? "user_confirmed" : "user_entered";
  if (f.basis === "district_proxy") return "public_data";
  return "default";
}

/** Approximate locations are coarsened to 2 decimals (~1 km) before storage. */
function storedCoords(l: { lat?: number | undefined; lon?: number | undefined; precision: string }) {
  if (l.lat === undefined || l.lon === undefined) return { lat: null, lon: null, geo: null };
  const r = (n: number) => (l.precision === "approximate" ? Math.round(n * 100) / 100 : n);
  const lat = r(l.lat);
  const lon = r(l.lon);
  return { lat, lon, geo: JSON.stringify({ type: "Point", coordinates: [lon, lat] }) };
}

const factOut = (r: FactRow) => ({
  factId: r.id,
  value: r.value,
  unit: r.unit,
  basis: r.basis,
  confirmed: r.confirmed,
  source: r.source,
  recordedAt: r.recorded_at.toISOString(),
});

async function insertFact(c: PoolClient, ownerId: string, farmId: string, key: string, f: FactInput, supersedesId: string | null) {
  const ins = await c.query<{ id: string }>(
    `INSERT INTO farm_facts (owner_id, farm_id, fact_key, value, unit, provenance, basis, confirmed, source, recorded_at, supersedes_id)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, now()),$11) RETURNING id`,
    [ownerId, farmId, key, JSON.stringify(f.value), f.unit ?? null, legacyProvenance(f), f.basis, f.confirmed, f.source ?? null, f.recordedAt ?? null, supersedesId],
  );
  return ins.rows[0]!.id;
}

function assemble(farm: FarmRow, facts: FactRow[], history: boolean): FarmOut {
  const current: FarmOut["facts"] = {};
  for (const f of facts) if (!f.superseded_by) current[f.fact_key] = factOut(f);
  return {
    id: farm.id,
    name: farm.name,
    location: {
      districtId: farm.district_code,
      districtName: farm.district_name,
      stateCode: farm.state_code,
      lat: farm.lat,
      lon: farm.lon,
      precision: farm.location_precision,
    },
    areaHectares: farm.area_hectares === null ? null : Number(farm.area_hectares),
    version: farm.version,
    facts: current,
    ...(history ? { factHistory: facts.map((f) => ({ ...factOut(f), key: f.fact_key, superseded: !!f.superseded_by })) } : {}),
    createdAt: farm.created_at.toISOString(),
    updatedAt: farm.updated_at.toISOString(),
  };
}

const FARM_COLS = "id, name, state_code, district_code, district_name, lat, lon, location_precision, area_hectares, version, created_at, updated_at";
const FACT_COLS = "id, fact_key, value, unit, basis, confirmed, source, recorded_at, superseded_by";

export async function createFarm(pool: Pool, ownerId: string, body: CreateFarmBody): Promise<FarmOut> {
  return withTransaction(pool, async (c) => {
    const { lat, lon, geo } = storedCoords(body.location);
    const f = await c.query<{ id: string }>(
      `INSERT INTO farms (owner_id, name, state_code, district_code, district_name, lat, lon, location_geojson, location_precision, area_hectares)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id`,
      [ownerId, body.name, body.location.stateCode ?? null, body.location.districtId, body.location.districtName, lat, lon, geo, body.location.precision, body.areaHectares ?? null],
    );
    const id = f.rows[0]!.id;
    for (const [k, v] of Object.entries(body.facts ?? {})) await insertFact(c, ownerId, id, k, v, null);
    return (await readFarm(c, ownerId, id, false))!;
  });
}

async function readFarm(db: Pool | PoolClient, ownerId: string, id: string, history: boolean): Promise<FarmOut | null> {
  const f = await db.query<FarmRow>(`SELECT ${FARM_COLS} FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`, [id, ownerId]);
  if (!f.rows[0]) return null;
  const facts = await db.query<FactRow>(`SELECT ${FACT_COLS} FROM farm_facts WHERE farm_id=$1 AND owner_id=$2 ORDER BY recorded_at, created_at, id`, [id, ownerId]);
  return assemble(f.rows[0], facts.rows, history);
}

export const getFarm = (pool: Pool, ownerId: string, id: string, history = false) => readFarm(pool, ownerId, id, history);

export async function listFarms(pool: Pool, ownerId: string): Promise<FarmOut[]> {
  const f = await pool.query<FarmRow>(`SELECT ${FARM_COLS} FROM farms WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY created_at, id`, [ownerId]);
  if (f.rows.length === 0) return [];
  const facts = await pool.query<FactRow & { farm_id: string }>(
    `SELECT farm_id, ${FACT_COLS} FROM farm_facts WHERE owner_id=$1 AND superseded_by IS NULL ORDER BY recorded_at, id`,
    [ownerId],
  );
  return f.rows.map((row) => assemble(row, facts.rows.filter((x) => x.farm_id === row.id), false));
}

/** Facts are never overwritten: each change appends a superseding row and links superseded_by. */
export async function patchFarm(pool: Pool, ownerId: string, id: string, body: PatchFarmBody): Promise<FarmOut> {
  return withTransaction(pool, async (c) => {
    const cur = await c.query<FarmRow>(`SELECT ${FARM_COLS} FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE`, [id, ownerId]);
    const farm = cur.rows[0];
    if (!farm) throw notFound("Farm");
    if (body.expectedVersion !== undefined && body.expectedVersion !== farm.version) {
      throw new ApiError(409, "version_conflict", "Farm was changed elsewhere", { currentVersion: farm.version });
    }
    const sets: string[] = ["version = version + 1"];
    const params: unknown[] = [id];
    const add = (col: string, val: unknown, cast = "") => {
      params.push(val);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (body.name !== undefined) add("name", body.name);
    if (body.areaHectares !== undefined) add("area_hectares", body.areaHectares);
    if (body.location) {
      const l = body.location;
      const { lat, lon, geo } = storedCoords(l);
      add("district_code", l.districtId);
      add("district_name", l.districtName);
      add("state_code", l.stateCode ?? null);
      add("lat", lat);
      add("lon", lon);
      add("location_geojson", geo, "::jsonb");
      add("location_precision", l.precision);
    }
    await c.query(`UPDATE farms SET ${sets.join(", ")} WHERE id = $1`, params);
    for (const [k, v] of Object.entries(body.facts ?? {})) {
      const prev = await c.query<{ id: string }>("SELECT id FROM farm_facts WHERE farm_id=$1 AND fact_key=$2 AND superseded_by IS NULL FOR UPDATE", [id, k]);
      await appendFact(c, ownerId, id, k, v, prev.rows[0]?.id ?? null);
    }
    return (await readFarm(c, ownerId, id, false))!;
  });
}

/**
 * Appends the new current row. The partial unique index allows one current fact per key, so the old
 * row is first pointed at itself (frees the slot), then re-pointed at its successor.
 */
async function appendFact(c: PoolClient, ownerId: string, farmId: string, key: string, f: FactInput, prevId: string | null): Promise<void> {
  if (prevId) await c.query("UPDATE farm_facts SET superseded_by = id WHERE id = $1", [prevId]);
  const newId = await insertFact(c, ownerId, farmId, key, f, prevId);
  if (prevId) await c.query("UPDATE farm_facts SET superseded_by = $2 WHERE id = $1", [prevId, newId]);
}

export interface DeleteResult {
  mediaObjectsRemoved: number;
  storageObjectsFailed: number;
}

/**
 * Hard delete. One transaction removes the farm and every dependent row (plans via the immutable-plan
 * trigger bypass, plan outputs, journal, actions, visual assets, facts, media rows). Private files are
 * deleted after commit; a failed file delete is logged and counted, never silently ignored, and the
 * database rows are already gone so the object is unreachable through the API.
 */
export async function deleteFarm(
  pool: Pool,
  storage: StorageAdapter,
  ownerId: string,
  id: string,
  log: { warn: (o: object, m: string) => void },
): Promise<DeleteResult> {
  const keys = await withTransaction(pool, async (c) => {
    const f = await c.query("SELECT id FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE", [id, ownerId]);
    if (!f.rows[0]) throw notFound("Farm");
    await c.query("SET LOCAL harvest.allow_plan_delete = 'on'");
    const media = await c.query<{ id: string; storage_key: string }>("SELECT id, storage_key FROM media_objects WHERE farm_id=$1 AND owner_id=$2", [id, ownerId]);
    const plans = "(SELECT id FROM plans WHERE farm_id = $1 AND owner_id = $2)";
    await c.query(`DELETE FROM visual_assets WHERE plan_id IN ${plans} AND owner_id = $2`, [id, ownerId]);
    await c.query(`DELETE FROM plan_outputs WHERE plan_id IN ${plans} AND owner_id = $2`, [id, ownerId]);
    await c.query(`DELETE FROM actions WHERE farm_id = $1 AND owner_id = $2`, [id, ownerId]);
    await c.query(`DELETE FROM journal_facts WHERE entry_id IN (SELECT id FROM journal_entries WHERE farm_id = $1 AND owner_id = $2)`, [id, ownerId]);
    await c.query(`DELETE FROM journal_entries WHERE farm_id = $1 AND owner_id = $2`, [id, ownerId]);
    await c.query(`DELETE FROM plans WHERE farm_id = $1 AND owner_id = $2`, [id, ownerId]);
    await c.query(`DELETE FROM farm_facts WHERE farm_id = $1 AND owner_id = $2`, [id, ownerId]);
    await c.query(`DELETE FROM media_objects WHERE farm_id = $1 AND owner_id = $2`, [id, ownerId]);
    await c.query(`DELETE FROM farms WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
    return media.rows;
  });
  let failed = 0;
  for (const m of keys) {
    try {
      await storage.delete({ ownerId, key: m.storage_key });
    } catch (e) {
      failed++;
      log.warn({ mediaId: m.id, err: (e as Error).name }, "storage delete failed after farm deletion; object orphaned");
    }
  }
  return { mediaObjectsRemoved: keys.length, storageObjectsFailed: failed };
}
