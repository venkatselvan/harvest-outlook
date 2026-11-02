-- Today overview by AI (TODAY_ECONOMICS_FOOTPRINT_SPEC.md section 9, 2026-11-02). One row per (farm, mode, context hash):
-- the code facts the overview is written from, the headline and points (Meta muse-spark, or the code-written version)
-- and a small invocation record. context_hash is sha256 of the crop, product and facts, so any changed fact gives a new
-- row. While status is 'pending' headline and points already hold the code-written overview; the worker replaces them
-- with the model answer only when it passes the gate. Same shape as farm_outlook_notes without product_id, harvest_week
-- and text, plus headline and points. invocation holds {origin, failure, model, usage, costUsd, responseDeleted,
-- generatedAt, enqueuedAt, retryAfter} and the prompt place names; never prompts, raw model output or keys.
CREATE TABLE farm_today_overviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK (mode IN ('live','synthetic','replay')),
 context_hash text NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','ready','unavailable','error')),
 headline text,
 points jsonb NOT NULL DEFAULT '[]'::jsonb,
 facts jsonb NOT NULL,
 invocation jsonb,
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX farm_today_overviews_key ON farm_today_overviews (farm_id, mode, context_hash);
CREATE INDEX farm_today_overviews_farm_recent ON farm_today_overviews (farm_id, mode, created_at DESC);
CREATE INDEX farm_today_overviews_owner ON farm_today_overviews (owner_id, farm_id);
CREATE TRIGGER farm_today_overviews_updated BEFORE UPDATE ON farm_today_overviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();
