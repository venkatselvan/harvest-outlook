import { contentHash } from "@harvest/domain";
import type { Pool } from "../db/pool";

export const payloadHash = (payload: unknown): string => contentHash(payload);

/** Freshness window per job type: a succeeded run with the same payload hash inside it is reused (idempotency). */
export const RUN_FRESHNESS_SECONDS: Record<string, number> = {
  "ingest.weather_archive": 24 * 3600,
  "ingest.weather_forecast": 3 * 3600,
  "ingest.market_prices": 6 * 3600,
};

export async function findReusableRun(pool: Pool, jobType: string, hash: string, ttlSeconds: number): Promise<{ id: string; counts: unknown; detail: unknown } | null> {
  const r = await pool.query<{ id: string; counts: unknown; detail: unknown }>(
    `SELECT id, counts, detail FROM ingest_runs
     WHERE job_type=$1 AND payload_hash=$2 AND status='succeeded' AND finished_at > now() - make_interval(secs => $3)
     ORDER BY finished_at DESC LIMIT 1`,
    [jobType, hash, ttlSeconds],
  );
  return r.rows[0] ?? null;
}

export async function startRun(pool: Pool, a: { jobId: string | null; jobType: string; hash: string; provider: string; mode: string }): Promise<string> {
  const r = await pool.query<{ id: string }>(
    "INSERT INTO ingest_runs (job_id, job_type, payload_hash, provider, mode) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [a.jobId, a.jobType, a.hash, a.provider, a.mode],
  );
  return r.rows[0]!.id;
}

export async function finishRun(pool: Pool, id: string, status: "succeeded" | "failed" | "cancelled" | "unavailable", counts: unknown, detail: unknown): Promise<void> {
  await pool.query("UPDATE ingest_runs SET status=$2, finished_at=now(), counts=$3::jsonb, detail=$4::jsonb WHERE id=$1", [id, status, JSON.stringify(counts), JSON.stringify(detail)]);
}
