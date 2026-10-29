import type pg from "pg";
import type { PlanSnapshot } from "@harvest/contracts";
import type { Pool } from "../db/pool";
import type { OutputKind } from "./types";

/** SQL access for plans. Every read is owner-scoped; plans and plan_outputs are append-only (DB triggers). */

export interface FarmRow {
  id: string;
  state_code: string | null;
  district_code: string | null;
  lon: number | null;
  lat: number | null;
}

export interface PlanRow {
  id: string;
  owner_id: string;
  parent_plan_id: string | null;
  content_hash: string;
  snapshot: PlanSnapshot;
  data_versions: Record<string, unknown>;
  created_at: Date;
}

export interface OutputRow<T = unknown> {
  id: string;
  plan_id: string;
  kind: OutputKind;
  method_version: string | null;
  content_hash: string;
  output: T;
}

export interface NewOutput {
  id: string;
  kind: OutputKind;
  methodVersion: string;
  contentHash: string;
  output: unknown;
}

type Q = Pick<pg.PoolClient, "query">;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export async function findFarm(db: Q, ownerId: string, farmId: string): Promise<FarmRow | null> {
  if (!isUuid(farmId)) return null;
  const r = await db.query<FarmRow>(
    "SELECT id, state_code, district_code, lon, lat FROM farms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
    [farmId, ownerId],
  );
  return r.rows[0] ?? null;
}

/** Resolves a crop by catalogue UUID or slug. */
export async function resolveCrop(db: Q, cropId: string): Promise<string | null> {
  const r = isUuid(cropId)
    ? await db.query<{ id: string }>("SELECT id FROM crop_identities WHERE id=$1", [cropId])
    : await db.query<{ id: string }>("SELECT id FROM crop_identities WHERE slug=$1", [cropId]);
  return r.rows[0]?.id ?? null;
}

/** True when the product exists (UUID or slug) and belongs to the crop. */
export async function productBelongsToCrop(db: Q, productId: string, cropUuid: string): Promise<boolean> {
  const r = isUuid(productId)
    ? await db.query("SELECT 1 FROM crop_products WHERE id=$1 AND crop_id=$2", [productId, cropUuid])
    : await db.query("SELECT 1 FROM crop_products WHERE slug=$1 AND crop_id=$2", [productId, cropUuid]);
  return (r.rowCount ?? 0) > 0;
}

const PLAN_COLS = "id, owner_id, parent_plan_id, content_hash, snapshot, data_versions, created_at";

export async function findPlan(db: Q, ownerId: string, planId: string, forUpdate = false): Promise<PlanRow | null> {
  if (!isUuid(planId)) return null;
  const r = await db.query<PlanRow>(`SELECT ${PLAN_COLS} FROM plans WHERE id=$1 AND owner_id=$2${forUpdate ? " FOR UPDATE" : ""}`, [planId, ownerId]);
  return r.rows[0] ?? null;
}

export async function findPlanByInputHash(db: Q, ownerId: string, inputHash: string): Promise<PlanRow | null> {
  const r = await db.query<PlanRow>(`SELECT ${PLAN_COLS} FROM plans WHERE owner_id=$1 AND input_hash=$2`, [ownerId, inputHash]);
  return r.rows[0] ?? null;
}

export async function childPlanIds(db: Q, ownerId: string, planId: string): Promise<string[]> {
  const r = await db.query<{ id: string }>("SELECT id FROM plans WHERE parent_plan_id=$1 AND owner_id=$2 ORDER BY created_at", [planId, ownerId]);
  return r.rows.map((x) => x.id);
}

export async function insertPlan(
  db: Q,
  p: { snapshot: PlanSnapshot; cropUuid: string; inputHash: string; dataVersions: Record<string, unknown>; outputs: NewOutput[] },
): Promise<void> {
  const s = p.snapshot;
  await db.query(
    `INSERT INTO plans (id, owner_id, farm_id, crop_id, parent_plan_id, mode, content_hash, snapshot, data_versions, input_hash, product_ref, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)`,
    [s.id, s.ownerId, s.farmId, p.cropUuid, s.parentId, s.mode, s.contentHash, JSON.stringify(s), JSON.stringify(p.dataVersions), p.inputHash, s.productId, s.createdAt],
  );
  for (const o of p.outputs) {
    await db.query(
      `INSERT INTO plan_outputs (id, owner_id, plan_id, kind, content_hash, output, method_version) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [o.id, s.ownerId, s.id, o.kind, o.contentHash, JSON.stringify(o.output), o.methodVersion],
    );
  }
}

export async function getOutputs(db: Q, ownerId: string, ids: readonly string[]): Promise<OutputRow[]> {
  if (ids.length === 0) return [];
  const r = await db.query<OutputRow>(
    "SELECT id, plan_id, kind, method_version, content_hash, output FROM plan_outputs WHERE owner_id=$1 AND id = ANY($2::uuid[])",
    [ownerId, ids],
  );
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

export async function getCachedTimeline(db: Q, ownerId: string, planId: string, scenarioId: string, dataVersion: string): Promise<unknown | null> {
  const r = await db.query<{ timeline: unknown }>(
    "SELECT timeline FROM plan_timelines WHERE owner_id=$1 AND plan_id=$2 AND scenario_id=$3 AND data_version=$4",
    [ownerId, planId, scenarioId, dataVersion],
  );
  return r.rows[0]?.timeline ?? null;
}

export async function putCachedTimeline(db: Q, ownerId: string, planId: string, scenarioId: string, dataVersion: string, timeline: unknown): Promise<void> {
  await db.query(
    `INSERT INTO plan_timelines (owner_id, plan_id, scenario_id, data_version, timeline) VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (plan_id, scenario_id, data_version) DO NOTHING`,
    [ownerId, planId, scenarioId, dataVersion, JSON.stringify(timeline)],
  );
}
