-- A proposal never mutates the farmer's rotation calendar until explicitly applied.
CREATE TABLE farm_planning_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 mode text NOT NULL CHECK(mode IN ('live','synthetic','replay')),
 context_hash text NOT NULL,
 input_versions jsonb NOT NULL,
 input_context jsonb NOT NULL,
 result jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','running','partial','ready','unavailable','error')),
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 attempt integer NOT NULL DEFAULT 1,
 started_at timestamptz,
 finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(farm_id,mode,context_hash)
);
CREATE INDEX farm_planning_reviews_owner_farm ON farm_planning_reviews(owner_id,farm_id,created_at DESC);
CREATE TRIGGER farm_planning_reviews_updated BEFORE UPDATE ON farm_planning_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();
