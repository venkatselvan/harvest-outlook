import type { Pool } from "../../../src/db/pool";

/** Fixed ids shared by the synthetic fixtures in this directory. All rows seeded here are synthetic. */
export const GINGER_ID = "00000000-0000-4000-8000-0000000000c1";
export const GINGER_PRODUCT_ID = "00000000-0000-4000-8000-0000000000d1";
export const EVIDENCE_ID = "00000000-0000-4000-8000-0000000000e1";

export async function seedOwner(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0]!.id;
}

export async function seedSession(pool: Pool, ownerId: string): Promise<string> {
  return (await pool.query<{ id: string }>("INSERT INTO sessions (owner_id, token_hash, expires_at) VALUES ($1, md5(random()::text), now() + interval '1 day') RETURNING id", [ownerId])).rows[0]!.id;
}

export async function seedGinger(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO crop_identities (id, slug, scientific_name, names) VALUES ($1,'ginger','Zingiber officinale',$2::jsonb) ON CONFLICT DO NOTHING`,
    [GINGER_ID, JSON.stringify({ en: ["Ginger"], ta: ["இஞ்சி"], hi: ["अदरक"] })],
  );
  await pool.query(`INSERT INTO crop_products (id, crop_id, slug, name, form) VALUES ($1,$2,'ginger-fresh','Ginger (fresh rhizome)','fresh') ON CONFLICT DO NOTHING`, [GINGER_PRODUCT_ID, GINGER_ID]);
  await pool.query(`INSERT INTO crop_products (id, crop_id, slug, name, form) VALUES ('00000000-0000-4000-8000-0000000000d2',$1,'ginger-dry','Ginger (dry)','dry') ON CONFLICT DO NOTHING`, [GINGER_ID]);
}

export interface EvidenceSeed {
  id?: string;
  mode?: "live" | "replay" | "synthetic";
  validation?: "validated" | "pending" | "rejected" | "unsupported";
  level?: string;
  geographyIds?: string[];
  cropIds?: string[];
  topics?: string[];
  availableAt?: string | null;
  basis?: string;
  excerpt?: string;
}

export async function seedEvidence(pool: Pool, o: EvidenceSeed = {}): Promise<string> {
  const doc = await pool.query<{ id: string }>(
    `INSERT INTO source_documents (content_hash, title, publisher, licence) VALUES (md5(random()::text) || md5(random()::text), 'Synthetic note', 'Synthetic publisher', 'synthetic') RETURNING id`,
  );
  const r = await pool.query<{ id: string }>(
    `INSERT INTO evidence_records (id, source_id, excerpt, mode, validation_status, geography_level, geography_ids, crop_ids, topics, effective_available_at, availability_basis)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::text[], $10::timestamptz, $11) RETURNING id`,
    [
      o.id ?? null,
      doc.rows[0]!.id,
      o.excerpt ?? "Synthetic fixture note: keep soil evenly moist during rhizome development.",
      o.mode ?? "synthetic",
      o.validation ?? "validated",
      o.level ?? "district",
      o.geographyIds ?? ["IN-KA-HAS"],
      o.cropIds ?? [GINGER_ID],
      o.topics ?? ["irrigation"],
      o.availableAt === undefined ? "2026-01-01T00:00:00Z" : o.availableAt,
      o.basis ?? "verified_publication",
    ],
  );
  return r.rows[0]!.id;
}

export async function seedRun(pool: Pool, ownerId: string, mode: "live" | "replay" | "synthetic" = "synthetic"): Promise<string> {
  return (await pool.query<{ id: string }>("INSERT INTO agent_runs (owner_id, mode, purpose, status) VALUES ($1,$2,'test','running') RETURNING id", [ownerId, mode])).rows[0]!.id;
}

export async function storeToolResult(pool: Pool, ownerId: string, runId: string, tool: string, result: unknown, status: "ok" | "error" | "unavailable" = "ok"): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      "INSERT INTO tool_results (owner_id, agent_run_id, tool_name, args_hash, result, status) VALUES ($1,$2,$3,'h',$4::jsonb,$5) RETURNING id",
      [ownerId, runId, tool, JSON.stringify(result), status],
    )
  ).rows[0]!.id;
}
