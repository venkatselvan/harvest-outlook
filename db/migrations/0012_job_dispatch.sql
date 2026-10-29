-- 0012_job_dispatch: paid-call dispatch markers (F6). Additive only.
-- A marker is committed BEFORE a provider call. A marker without an outcome at job (re)start means the call may have been
-- sent and its result lost (crash, lease expiry): the job must not dispatch again, the reservation is held as uncertain.
CREATE TABLE job_dispatches (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage_key text NOT NULL,
  reservation_id uuid REFERENCES usage_reservations(id) ON DELETE SET NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  provider_request_id text,
  outcome text CHECK (outcome IN ('completed','failed','uncertain')),
  PRIMARY KEY (job_id, stage_key)
);
CREATE INDEX job_dispatches_open_idx ON job_dispatches(job_id) WHERE outcome IS NULL OR outcome = 'uncertain';
