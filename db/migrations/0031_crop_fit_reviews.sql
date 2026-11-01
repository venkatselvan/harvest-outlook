-- Crop fit reviews (ROUND2_SPEC.md section 4, 2026-11-01). One row per (farm, runtime mode, context hash) while not
-- archived: every pool crop scored by code for one sowing date (mode next | season | date), compared with the confirmed
-- soil markers, and the top three picks (Meta, or code when Meta is unavailable). Mirrors farm_year_plans.
-- mode is the runtime mode (live | synthetic | replay); fit_mode and request_key carry the farmer's request
-- ({mode, season, sowing}); the context hash covers the request, so the unique index needs no fit mode column.
-- A newer hash for the same request_key archives the older row; rows for other requests stay cached.
CREATE TABLE crop_fit_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK (mode IN ('live','synthetic','replay')),
 fit_mode text NOT NULL CHECK (fit_mode IN ('next','season','date')),
 request_key text NOT NULL,
 context_hash text NOT NULL,
 request jsonb NOT NULL,
 input_context jsonb NOT NULL DEFAULT '{}'::jsonb,
 result jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','running','ready','unavailable','error')),
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 invocation jsonb,
 started_at timestamptz,
 finished_at timestamptz,
 archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crop_fit_reviews_current ON crop_fit_reviews (farm_id, mode, context_hash) WHERE archived_at IS NULL;
CREATE INDEX crop_fit_reviews_request ON crop_fit_reviews (farm_id, mode, request_key, created_at DESC);
CREATE INDEX crop_fit_reviews_owner_farm ON crop_fit_reviews (owner_id, farm_id, created_at DESC);
CREATE TRIGGER crop_fit_reviews_updated BEFORE UPDATE ON crop_fit_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();
