import type { Pool } from "../db/pool";
import type { PoolClient } from "pg";

type Db = Pool | PoolClient;

export type DispatchOutcome = "completed" | "failed" | "uncertain";

export interface DispatchRow {
  job_id: string;
  stage_key: string;
  reservation_id: string | null;
  outcome: DispatchOutcome | null;
}

/**
 * Commits a marker BEFORE a paid provider call (own statement, autocommit). Returns false when this job already has an
 * unresolved marker (no outcome, or `uncertain`) for the stage: a call may be in flight or its result lost, so the
 * caller must not dispatch again. A marker whose outcome is `completed` or `failed` is re-armed (a deliberate retry).
 */
export async function claimDispatch(db: Db, jobId: string, stageKey: string, reservationId: string | null): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO job_dispatches (job_id, stage_key, reservation_id) VALUES ($1,$2,$3)
     ON CONFLICT (job_id, stage_key) DO UPDATE SET reservation_id = EXCLUDED.reservation_id, dispatched_at = now(), provider_request_id = NULL, outcome = NULL
       WHERE job_dispatches.outcome IN ('completed','failed')
     RETURNING stage_key`,
    [jobId, stageKey, reservationId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function finishDispatch(db: Db, jobId: string, stageKey: string, outcome: DispatchOutcome, providerRequestId: string | null = null): Promise<void> {
  await db.query("UPDATE job_dispatches SET outcome=$3, provider_request_id=COALESCE($4, provider_request_id) WHERE job_id=$1 AND stage_key=$2", [jobId, stageKey, outcome, providerRequestId]);
}

/** Markers that block a re-dispatch: still open (process died mid-call) or already judged uncertain. */
export async function unresolvedDispatches(db: Db, jobId: string): Promise<DispatchRow[]> {
  const r = await db.query<DispatchRow>("SELECT job_id, stage_key, reservation_id, outcome FROM job_dispatches WHERE job_id=$1 AND (outcome IS NULL OR outcome = 'uncertain')", [jobId]);
  return r.rows;
}
