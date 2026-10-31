-- Geographic map boundary, farmer-entered history and multi-year crop tracking.
-- One row per farm; ownership is enforced through the parent farm on every read/write.
-- ON DELETE CASCADE preserves the existing hard-delete privacy procedure.
CREATE TABLE farm_workspaces (
  farm_id uuid PRIMARY KEY REFERENCES farms(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER farm_workspaces_set_updated_at BEFORE UPDATE ON farm_workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE farm_monitors (
  farm_id uuid PRIMARY KEY REFERENCES farms(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT false,
  meta_enabled boolean NOT NULL DEFAULT false,
  interval_hours integer NOT NULL DEFAULT 6 CHECK (interval_hours BETWEEN 6 AND 168),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  last_meta_at timestamptz,
  last_meta_attempt_at timestamptz,
  reviewed_fingerprint text,
  market_refresh_reason text,
  snapshot jsonb,
  changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta_review jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX farm_monitors_due ON farm_monitors(next_check_at) WHERE enabled;
CREATE TRIGGER farm_monitors_set_updated_at BEFORE UPDATE ON farm_monitors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
