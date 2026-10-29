import { createHash } from "node:crypto";
import type { Pool } from "../db/pool";

export const SYNTHETIC_SOURCE_ID = "synthetic-fixture";

export function manifestContentHash(manifestId: string): string {
  return createHash("sha256").update(`manifest-record:${manifestId}`).digest("hex");
}

export interface SourceFallback {
  title: string;
  publisher: string;
  url: string;
  licence: string;
  metadata?: Record<string, unknown>;
}

/**
 * Resolve the source_documents row for a manifest id, creating a minimal one if the manifest has not
 * been loaded. Never overwrites an existing, richer manifest-loaded row.
 */
export async function ensureSource(pool: Pool, manifestId: string, fallback: SourceFallback): Promise<string> {
  const found = await pool.query<{ id: string }>("SELECT id FROM source_documents WHERE manifest_id=$1", [manifestId]);
  if (found.rows[0]) return found.rows[0].id;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO source_documents (content_hash, manifest_id, title, publisher, url, licence, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (manifest_id) WHERE manifest_id IS NOT NULL DO UPDATE SET manifest_id = EXCLUDED.manifest_id
     RETURNING id`,
    [manifestContentHash(manifestId), manifestId, fallback.title, fallback.publisher, fallback.url, fallback.licence, JSON.stringify({ createdBy: "ensureSource", ...fallback.metadata })],
  );
  return r.rows[0]!.id;
}

export const OPENMETEO_SOURCES = {
  archive: {
    manifestId: "WEA-openmeteo-archive",
    fallback: { title: "Open-Meteo Historical Weather API (archive)", publisher: "Open-Meteo.com", url: "https://archive-api.open-meteo.com/v1/archive", licence: "CC BY 4.0" },
  },
  forecast: {
    manifestId: "WEA-openmeteo-forecast",
    fallback: { title: "Open-Meteo Forecast API", publisher: "Open-Meteo.com", url: "https://api.open-meteo.com/v1/forecast", licence: "CC BY 4.0" },
  },
} as const;

/** data.gov.in resource id -> manifest id. */
export const MANDI_RESOURCES: Record<string, { manifestId: string; title: string }> = {
  "9ef84268-d588-465a-a308-a864a43d0070": { manifestId: "MKT02-dgi-mandi-current", title: "Current Daily Price of Various Commodities from Various Markets (Mandi)" },
  "35985678-0d79-46b4-9ed6-6f13308a1d24": { manifestId: "MKT02-dgi-mandi-variety", title: "Variety-wise Daily Market Prices Data of Commodity" },
};
