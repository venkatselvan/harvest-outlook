import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Pool } from "../db/pool";
import { withTransaction } from "../db/pool";
import { purgeExpiredIdempotencyKeys } from "../services/idempotency";
import { ingestHandlers, registerWorkerHandlers } from "./handlers";

export interface JobRow {
  id: string;
  owner_id: string | null;
  type: string;
  attempt: number;
  max_attempts: number;
  payload: unknown;
}

export interface JobContext {
  heartbeat: (progress?: number) => Promise<void>;
  pool: Pool;
  /** True once cancellation was requested; handlers check this between units of work. */
  isCancelled: () => Promise<boolean>;
}

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<unknown>;

export class RetryableError extends Error {
  readonly retryable = true;
}

export const handlers: Record<string, JobHandler> = {
  noop: async () => ({ ok: true }),
  ...ingestHandlers,
};

export const LEASE_SECONDS = 30;

/** Claim one runnable job. Also reclaims jobs whose lease expired (abandoned work). */
export async function claimJob(pool: Pool, workerId: string, leaseSeconds = LEASE_SECONDS): Promise<JobRow | null> {
  return withTransaction(pool, async (c) => {
    // An expired lease on a job that has used all its attempts is a crash loop: fail it instead of re-running.
    await c.query(
      `UPDATE jobs SET state = 'failed', retryable = false, finished_at = now(), lease_owner = NULL, lease_expires_at = NULL,
         error = jsonb_build_object('code', 'lease_expired_max_attempts', 'message', 'lease expired after the maximum number of attempts')
       WHERE state = 'running' AND lease_expires_at < now() AND attempt >= max_attempts`,
    );
    const picked = await c.query<{ id: string }>(
      `SELECT id FROM jobs
       WHERE (state = 'queued' AND run_after <= now())
          OR (state = 'running' AND lease_expires_at < now())
       ORDER BY run_after, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const id = picked.rows[0]?.id;
    if (!id) return null;
    const r = await c.query<JobRow & { cancel_requested: boolean }>(
      `UPDATE jobs SET state = 'running', attempt = attempt + 1, lease_owner = $2,
         lease_expires_at = now() + make_interval(secs => $3), heartbeat_at = now()
       WHERE id = $1
       RETURNING id, owner_id, type, attempt, max_attempts, payload, cancel_requested`,
      [id, workerId, leaseSeconds],
    );
    const job = r.rows[0]!;
    if (job.cancel_requested) {
      await c.query("UPDATE jobs SET state='cancelled', finished_at=now(), lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [id]);
      return null;
    }
    return job;
  });
}

export async function runJob(pool: Pool, job: JobRow, workerId: string, leaseSeconds = LEASE_SECONDS): Promise<"succeeded" | "failed" | "retry"> {
  const heartbeat = async (progress?: number) => {
    await pool.query(
      `UPDATE jobs SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => $3),
         progress = COALESCE($4, progress)
       WHERE id = $1 AND lease_owner = $2 AND state = 'running'`,
      [job.id, workerId, leaseSeconds, progress ?? null],
    );
  };
  const handler = handlers[job.type];
  // Keep the lease alive while the handler runs (e.g. a long provider call) so no second worker re-executes it.
  const timer = setInterval(() => void heartbeat().catch(() => undefined), Math.max(50, (leaseSeconds * 1000) / 3));
  timer.unref?.();
  try {
    if (!handler) throw Object.assign(new Error(`no handler for job type ${job.type}`), { retryable: false });
    const isCancelled = async () => {
      const r = await pool.query<{ cancel_requested: boolean }>("SELECT cancel_requested FROM jobs WHERE id=$1", [job.id]);
      return r.rows[0]?.cancel_requested === true;
    };
    const result = await handler(job, { heartbeat, pool, isCancelled });
    const r = await pool.query(
      `UPDATE jobs SET state='succeeded', result=$3, progress=1, finished_at=now(), lease_owner=NULL, lease_expires_at=NULL
       WHERE id=$1 AND lease_owner=$2 AND state='running'`,
      [job.id, workerId, JSON.stringify(result ?? null)],
    );
    return r.rowCount ? "succeeded" : "failed"; // lost lease or cancelled meanwhile: do not overwrite
  } catch (e) {
    const err = e as Error & { retryable?: boolean };
    const retryable = err.retryable === true && job.attempt < job.max_attempts;
    const backoff = Math.min(300, 2 ** job.attempt * 5);
    await pool.query(
      `UPDATE jobs SET
         state = CASE WHEN $3 THEN 'queued' ELSE 'failed' END,
         run_after = CASE WHEN $3 THEN now() + make_interval(secs => $5) ELSE run_after END,
         retryable = $3, error = $4::jsonb,
         finished_at = CASE WHEN $3 THEN NULL ELSE now() END,
         lease_owner = NULL, lease_expires_at = NULL
       WHERE id=$1 AND lease_owner=$2 AND state='running'`,
      [job.id, workerId, retryable, JSON.stringify({ message: err.message, name: err.name }), backoff],
    );
    return retryable ? "retry" : "failed";
  } finally {
    clearInterval(timer);
  }
}

export async function pollOnce(pool: Pool, workerId: string, leaseSeconds = LEASE_SECONDS): Promise<boolean> {
  const job = await claimJob(pool, workerId, leaseSeconds);
  if (!job) return false;
  await runJob(pool, job, workerId, leaseSeconds);
  return true;
}

async function main() {
  await import("../env");
  const { loadConfig } = await import("../config");
  const { createPool } = await import("../db/pool");
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const { FsStorage } = await import("../storage/fs");
  const { Budget } = await import("../services/budget");
  registerWorkerHandlers(handlers, { config, pool, storage: new FsStorage(config.STORAGE_FS_ROOT), budget: Budget.fromConfig(pool, config) });
  const workerId = `worker-${randomUUID()}`;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(JSON.stringify({ msg: "worker started", workerId, mode: config.RUNTIME_MODE }));
  const PURGE_EVERY_MS = 10 * 60_000;
  let lastPurge = 0;
  while (!stopping) {
    if (Date.now() - lastPurge >= PURGE_EVERY_MS) {
      lastPurge = Date.now();
      await purgeExpiredIdempotencyKeys(pool, config.IDEMPOTENCY_TTL_HOURS).catch((e) => console.error(JSON.stringify({ msg: "idempotency purge failed", error: (e as Error).message })));
    }
    const worked = await pollOnce(pool, workerId, config.JOB_LEASE_SECONDS).catch((e) => {
      console.error(JSON.stringify({ msg: "poll failed", error: (e as Error).message }));
      return false;
    });
    if (!worked) await new Promise((r) => setTimeout(r, 1000));
  }
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
