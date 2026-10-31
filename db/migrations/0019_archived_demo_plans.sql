-- Preserve immutable plan snapshots while keeping retired demo seed journeys out of active views.
CREATE TABLE archived_plans (
 plan_id uuid PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 reason text NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX archived_plans_owner_farm ON archived_plans(owner_id,farm_id);
ALTER TABLE farm_planning_reviews ADD COLUMN archived_at timestamptz;
ALTER TABLE farm_planning_reviews DROP CONSTRAINT farm_planning_reviews_farm_id_mode_context_hash_key;
CREATE UNIQUE INDEX farm_planning_reviews_active_context ON farm_planning_reviews(farm_id,mode,context_hash) WHERE archived_at IS NULL;
