-- Soil reviews (ROUND2_SPEC.md section 5, 2026-11-01). One row per (farm, mode, context hash) while not archived: the
-- confirmed soil markers rated against cited bands (code, stored in result) and the Meta narrative written from code facts
-- (or the deterministic fallback). The hash covers confirmed marker ids and values, the current cycle, the next planned
-- crop and the ratings file version, so a new confirmation or a season change archives the row and builds a new one.
CREATE TABLE soil_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK (mode IN ('live','synthetic','replay')),
 context_hash text NOT NULL,
 ratings_version text NOT NULL,
 input_context jsonb NOT NULL,
 result jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','running','ready','unavailable','error')),
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 attempt integer NOT NULL DEFAULT 1,
 session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 started_at timestamptz,
 finished_at timestamptz,
 archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX soil_reviews_current ON soil_reviews (farm_id, mode, context_hash) WHERE archived_at IS NULL;
CREATE INDEX soil_reviews_owner_farm ON soil_reviews (owner_id, farm_id, created_at DESC);
CREATE TRIGGER soil_reviews_updated BEFORE UPDATE ON soil_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();
