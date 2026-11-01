-- Harvest outlook in words (ROUND2_SPEC.md 2.2, packet P3, 2026-11-01). One row per (farm, mode, product, harvest week,
-- context hash): the code facts the sentence is written from, the sentence (Meta muse-spark, or the code-written fallback)
-- and a small invocation record. context_hash is sha256 of the facts, so new prices or a new harvest window give a new row.
-- While status is 'pending' the text column already holds the code-written fallback sentence; the worker replaces it with
-- the model sentence only when the sentence passes the digit gate. invocation holds {origin, failure, model, usage,
-- costUsd, responseDeleted, generatedAt}; it never holds prompts, model output other than the accepted text, or keys.
CREATE TABLE farm_outlook_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK (mode IN ('live','synthetic','replay')),
 product_id text NOT NULL,
 harvest_week text NOT NULL,
 context_hash text NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','ready','unavailable','error')),
 text text,
 facts jsonb NOT NULL,
 invocation jsonb,
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX farm_outlook_notes_key ON farm_outlook_notes (farm_id, mode, product_id, harvest_week, context_hash);
CREATE INDEX farm_outlook_notes_farm_recent ON farm_outlook_notes (farm_id, mode, created_at DESC);
CREATE INDEX farm_outlook_notes_owner ON farm_outlook_notes (owner_id, farm_id);
CREATE TRIGGER farm_outlook_notes_updated BEFORE UPDATE ON farm_outlook_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
