-- 0004_plans: plan engine (T08). Additive only.

-- Plans: input hash for idempotent creation/revision, product reference, linear revision history.
ALTER TABLE plans ADD COLUMN input_hash text;
ALTER TABLE plans ADD COLUMN product_ref text;
CREATE UNIQUE INDEX plans_owner_input_hash_uq ON plans(owner_id, input_hash) WHERE input_hash IS NOT NULL;
-- At most one revision per parent: an offline draft or stale proposal cannot fork history.
CREATE UNIQUE INDEX plans_single_child_uq ON plans(parent_plan_id) WHERE parent_plan_id IS NOT NULL;

-- Plan outputs: method version per output; outputs are append-only like plans.
ALTER TABLE plan_outputs ADD COLUMN method_version text;
CREATE INDEX plan_outputs_plan_kind_idx ON plan_outputs(plan_id, kind);

CREATE OR REPLACE FUNCTION plan_outputs_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('harvest.allow_plan_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'plan outputs are immutable; revise the plan instead' USING ERRCODE = 'restrict_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER plan_outputs_no_update BEFORE UPDATE ON plan_outputs FOR EACH ROW EXECUTE FUNCTION plan_outputs_immutable();
CREATE TRIGGER plan_outputs_no_delete BEFORE DELETE ON plan_outputs FOR EACH ROW EXECUTE FUNCTION plan_outputs_immutable();

-- Timeline cache: computed once per (plan, scenario, data version); the client slider reads it locally.
CREATE TABLE plan_timelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  data_version text NOT NULL,
  timeline jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, scenario_id, data_version)
);
CREATE INDEX plan_timelines_owner_idx ON plan_timelines(owner_id);
