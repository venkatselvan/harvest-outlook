import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Pool } from "../db/pool";
import { manifestContentHash } from "./sources";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST_PATH = resolve(here, "../../../../data/manifests/sources.json");

export const manifestRecordSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().min(1),
    publisher: z.string().min(1),
    title: z.string().min(1),
    accessRoute: z.string().min(1),
    licence: z.string().min(1),
    retrievedAt: z.string().datetime({ offset: true }).nullable(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    rowOrPageCount: z.number().int().nullable().optional(),
    coverage: z.record(z.string(), z.unknown()).optional(),
    availabilityPolicy: z.string().optional(),
    validation: z.string().min(1),
    notes: z.string().optional(),
    httpStatus: z.number().int().nullable().optional(),
    rawArtifact: z.string().nullable().optional(),
  })
  .passthrough();

export const manifestFileSchema = z
  .object({ schemaVersion: z.number().int(), records: z.array(manifestRecordSchema).min(1) })
  .passthrough()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.records.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: "custom", path: ["records", i, "id"], message: `duplicate manifest id ${r.id}` });
      seen.add(r.id);
    });
  });

export type ManifestRecord = z.infer<typeof manifestRecordSchema>;
export type ManifestFile = z.infer<typeof manifestFileSchema>;

export async function readManifest(path = DEFAULT_MANIFEST_PATH): Promise<ManifestFile> {
  const parsed = manifestFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error(`invalid source manifest: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** Access class from the route: restricted/permission-gated sources are not public artifacts. */
export function accessClassFor(route: string): "public" | "restricted" {
  return /restricted|permission|blocked|private/i.test(route) ? "restricted" : "public";
}

/** Idempotent: upserts by manifest id; re-running changes nothing unless the manifest changed. */
export async function loadManifest(pool: Pool, file?: ManifestFile): Promise<{ total: number; inserted: number; updated: number }> {
  const m = file ?? (await readManifest());
  let inserted = 0;
  let updated = 0;
  for (const r of m.records) {
    const { id, url, publisher, title, licence, retrievedAt, sha256, ...rest } = r;
    const metadata = { sha256, ...rest };
    const res = await pool.query<{ inserted: boolean }>(
      `INSERT INTO source_documents (content_hash, manifest_id, title, publisher, url, licence, access_class, retrieved_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (manifest_id) WHERE manifest_id IS NOT NULL DO UPDATE SET
         title=EXCLUDED.title, publisher=EXCLUDED.publisher, url=EXCLUDED.url, licence=EXCLUDED.licence,
         access_class=EXCLUDED.access_class, retrieved_at=EXCLUDED.retrieved_at, metadata=EXCLUDED.metadata
         WHERE (source_documents.title, source_documents.publisher, source_documents.url, source_documents.licence,
                source_documents.access_class, source_documents.retrieved_at, source_documents.metadata)
               IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.publisher, EXCLUDED.url, EXCLUDED.licence,
                EXCLUDED.access_class, EXCLUDED.retrieved_at, EXCLUDED.metadata)
       RETURNING (xmax = 0) AS inserted`,
      [manifestContentHash(id), id, title, publisher, url, licence, accessClassFor(r.accessRoute), retrievedAt, JSON.stringify(metadata)],
    );
    if (res.rows[0]) res.rows[0].inserted ? inserted++ : updated++;
  }
  return { total: m.records.length, inserted, updated };
}
