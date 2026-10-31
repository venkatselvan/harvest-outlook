-- Year plan reviews (Stream A packet 2, 2026-11-01; docs/research/ROTATION_SCORING.md). One row per (farm, mode, context
-- hash) while not archived: code-scored crop sequences, the Meta selection (or the deterministic fallback) and farmer
-- edits. Nothing here changes the farmer's saved seasons; apply appends through the workspace path.
-- input_context holds the scenario, candidate ids, the prefetched inputs summary, the scoring norm (so farmer edits are
-- rescored on the same scale) and the latest farmer edit per option (key "<optionId>:edit"), which apply reads.
CREATE TABLE farm_year_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK (mode IN ('live','synthetic','replay')),
 context_hash text NOT NULL,
 input_versions jsonb NOT NULL,
 input_context jsonb NOT NULL,
 result jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','running','partial','ready','unavailable','error')),
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 attempt integer NOT NULL DEFAULT 1,
 session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 started_at timestamptz,
 finished_at timestamptz,
 archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX farm_year_plans_current ON farm_year_plans (farm_id, mode, context_hash) WHERE archived_at IS NULL;
CREATE INDEX farm_year_plans_owner_farm ON farm_year_plans (owner_id, farm_id, created_at DESC);
CREATE TRIGGER farm_year_plans_updated BEFORE UPDATE ON farm_year_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
