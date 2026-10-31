-- "Future look" illustrations for the Today satellite view (Stream B, 2026-11-01; TODAY_VIEW_SPEC section 4).
-- One row per (farm, crop cycle, future stage, source Sentinel-2 scene, prompt version): a Muse Image edit of the latest
-- usable observed scene that shows a typical look of that stage inside the field outline. Generated illustrations are
-- labelled as such; they are never observations or predictions.
--
-- Rows are created only in live mode, on an explicit request. Budget bound (enforced in services/today/future-look.ts
-- under a per-farm-cycle advisory lock): at most one queued/running/ready row per stage and at most 6 rows per farm cycle
-- that are queued, running, ready or billed (an image was returned, or the outcome is unknown).
--
-- Columns beyond the packet's list, and why: attempt (a non-billed failure may be re-armed, at most 3 times; the job
-- idempotency key is fl:{id}:{attempt}); job_id (status reads reconcile a row whose job died); billed (counts toward the
-- cap); stage_name / crop_name (the prompt inputs captured at request time, so a later edit of the cycle cannot change
-- what a queued job generates); source_acquired_at (the real scene date the illustration is labelled with);
-- provider_request_id (audit).
-- storage_key is an owner-private key future-look/{farm_id}/{id}.png. ON DELETE CASCADE preserves the hard-delete privacy
-- procedure for rows; deleteFarm must also collect storage_key values before the cascade (see the service header).
CREATE TABLE future_look_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  cycle_id text NOT NULL CHECK (char_length(cycle_id) BETWEEN 1 AND 120),
  source_item_id text NOT NULL CHECK (source_item_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  source_acquired_at timestamptz,
  stage_id text NOT NULL CHECK (char_length(stage_id) BETWEEN 1 AND 80),
  stage_name text NOT NULL CHECK (char_length(stage_name) BETWEEN 1 AND 80),
  crop_id text NOT NULL CHECK (char_length(crop_id) BETWEEN 1 AND 120),
  crop_name text NOT NULL CHECK (char_length(crop_name) BETWEEN 1 AND 120),
  prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 40),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'unavailable')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  billed boolean NOT NULL DEFAULT false,
  storage_key text,
  qa jsonb CHECK (qa IS NULL OR jsonb_typeof(qa) = 'object'),
  failure_reason text CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 80),
  model text,
  provider_request_id text,
  -- NULL = not applicable: POST /images/edits returns no response id, so there is no stored response to delete.
  response_deleted boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, cycle_id, stage_id, source_item_id, prompt_version),
  CHECK (status <> 'ready' OR storage_key IS NOT NULL)
);
CREATE INDEX future_look_assets_owner_farm ON future_look_assets (owner_id, farm_id);
CREATE TRIGGER future_look_assets_set_updated_at BEFORE UPDATE ON future_look_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
