import type { Pool } from "../db/pool";
import type { PoolClient } from "pg";
import { ApiError } from "./errors";
import { payloadHash } from "./hash";

type Db = Pool | PoolClient;

export interface JobRecord {
  id: string;
  type: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  attempt: number;
  maxAttempts: number;
  retryable: boolean | null;
  cancelRequested: boolean;
  result: unknown;
  error: { code: string; retryable: boolean } | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface JobDbRow {
  id: string;
  type: string;
  state: JobRecord["state"];
  progress: string;
  attempt: number;
  max_attempts: number;
  retryable: boolean | null;
  cancel_requested: boolean;
  result: unknown;
  error: unknown;
  payload_hash: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

const COLS = "id, type, state, progress, attempt, max_attempts, retryable, cancel_requested, result, error, payload_hash, created_at, updated_at, finished_at";

/** Sanitised view: raw worker error text and the input payload are never returned to clients. */
export function toJobRecord(r: JobDbRow): JobRecord {
  return {
    id: r.id,
    type: r.type,
    state: r.state,
    progress: Number(r.progress),
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    retryable: r.retryable,
    cancelRequested: r.cancel_requested,
    result: r.state === "succeeded" ? r.result : null,
    error: r.state === "failed" ? { code: "job_failed", retryable: r.retryable === true } : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  };
}

/** Enqueue; a duplicate (ownerId, idempotencyKey) returns the existing job. Same key with another payload is a 422. */
export async function enqueue(
  db: Db,
  type: string,
  payload: unknown,
  ownerId: string | null,
  idempotencyKey?: string,
): Promise<{ job: JobRecord; created: boolean }> {
  const hash = payloadHash({ type, payload });
  const ins = await db.query<JobDbRow>(
    `INSERT INTO jobs (owner_id, type, payload, payload_hash, idempotency_key) VALUES ($1,$2,$3::jsonb,$4,$5)
     ON CONFLICT (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING ${COLS}`,
    [ownerId, type, JSON.stringify(payload ?? {}), hash, idempotencyKey ?? null],
  );
  if (ins.rows[0]) return { job: toJobRecord(ins.rows[0]), created: true };
  const ex = await db.query<JobDbRow>(`SELECT ${COLS} FROM jobs WHERE owner_id = $1 AND idempotency_key = $2`, [ownerId, idempotencyKey]);
  const row = ex.rows[0];
  if (!row) throw new ApiError(409, "job_conflict", "Job could not be created; retry");
  if (row.payload_hash !== hash) throw new ApiError(422, "idempotency_payload_mismatch", "Idempotency-Key was already used with a different payload");
  return { job: toJobRecord(row), created: false };
}

export async function getJob(db: Db, ownerId: string, id: string): Promise<JobRecord | null> {
  const r = await db.query<JobDbRow>(`SELECT ${COLS} FROM jobs WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
  return r.rows[0] ? toJobRecord(r.rows[0]) : null;
}

export async function requestCancel(db: Db, ownerId: string, id: string): Promise<JobRecord | null> {
  const r = await db.query<JobDbRow>(
    `UPDATE jobs SET cancel_requested = true WHERE id = $1 AND owner_id = $2 AND state IN ('queued','running') RETURNING ${COLS}`,
    [id, ownerId],
  );
  if (r.rows[0]) return toJobRecord(r.rows[0]);
  const cur = await getJob(db, ownerId, id);
  if (!cur) return null;
  throw new ApiError(409, "job_finished", `Job already ${cur.state}`);
}
