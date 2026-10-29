-- 0005_agent: agent runtime (T09). Additive only; earlier migrations are never edited.
-- All statements are idempotent (IF NOT EXISTS) so a catalogue/evidence migration numbered 0004 may
-- already have added overlapping columns without conflict.

-- ---------------------------------------------------------------- agent_runs
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS session_id uuid,
  ADD COLUMN IF NOT EXISTS provenance text,
  ADD COLUMN IF NOT EXISTS limits jsonb,
  ADD COLUMN IF NOT EXISTS trace jsonb,
  ADD COLUMN IF NOT EXISTS gate_status text,
  ADD COLUMN IF NOT EXISTS tool_calls integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_calls integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage jsonb,
  ADD COLUMN IF NOT EXISTS estimated_usd numeric(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settled_usd numeric(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;
CREATE INDEX IF NOT EXISTS agent_runs_owner_created_idx ON agent_runs(owner_id, created_at);

-- ---------------------------------------------------------------- tool_results
-- `result` holds the validated tool output exactly as the model and the output gate see it.
-- `error` holds {status:'unavailable'|'error', ...} for non-ok outcomes. `redacted_args` never holds
-- raw photos or precise coordinates.
ALTER TABLE tool_results
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','unavailable','error')),
  ADD COLUMN IF NOT EXISTS call_id text,
  ADD COLUMN IF NOT EXISTS redacted_args jsonb,
  ADD COLUMN IF NOT EXISTS ordinal integer;
CREATE INDEX IF NOT EXISTS tool_results_run_ordinal_idx ON tool_results(agent_run_id, ordinal);

-- ---------------------------------------------------------------- prompt versions
CREATE TABLE IF NOT EXISTS prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version text NOT NULL,
  content_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

-- ---------------------------------------------------------------- evidence scope and availability
-- Flat, indexable scope columns used by retrieve_evidence and the output gate. Rows without
-- geography_ids cannot be scoped and are never returned or accepted.
ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','replay','synthetic')),
  ADD COLUMN IF NOT EXISTS geography_level text,
  ADD COLUMN IF NOT EXISTS geography_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS crop_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS product_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS topics text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS effective_available_at timestamptz,
  ADD COLUMN IF NOT EXISTS availability_basis text,
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('validated','unsupported','pending','rejected'));
CREATE INDEX IF NOT EXISTS evidence_crop_ids_idx ON evidence_records USING gin(crop_ids);
CREATE INDEX IF NOT EXISTS evidence_geo_ids_idx ON evidence_records USING gin(geography_ids);
CREATE INDEX IF NOT EXISTS evidence_topics_idx ON evidence_records USING gin(topics);
