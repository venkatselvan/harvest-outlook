-- Today view alerts and default-on monitoring (Stream B, 2026-11-01).
-- User decisions (2026-11-01): monitoring is on by default for every farm; one Meta grounded review per farm per
-- day is allowed; every alert must carry a dated source or it is dropped before it reaches this table.

-- (a) Default-on monitoring. A farmer's explicit disable is recorded so no backfill or default can override it.
ALTER TABLE farm_monitors ADD COLUMN disabled_by_farmer_at timestamptz;
ALTER TABLE farm_monitors ALTER COLUMN enabled SET DEFAULT true, ALTER COLUMN meta_enabled SET DEFAULT true;

-- Backfill rows that were never explicitly disabled by a farmer (every existing row: the column above is new).
-- The automatic review is farm-level from now on and is not billed to the guest session that toggled monitoring,
-- so the legacy session link is cleared. This also stops a still-running pre-0026 worker from starting the retired
-- session-billed agent review on a row whose meta_enabled flips to true here.
UPDATE farm_monitors
   SET enabled = true, meta_enabled = true, next_check_at = LEAST(next_check_at, now()), session_id = NULL
 WHERE disabled_by_farmer_at IS NULL;

-- Existing live farms without a monitor row get one (24 h interval, first check due now).
INSERT INTO farm_monitors (farm_id, enabled, meta_enabled, interval_hours, next_check_at)
SELECT f.id, true, true, 24, now() FROM farms f WHERE f.deleted_at IS NULL
ON CONFLICT (farm_id) DO NOTHING;

-- (b) Alerts. Ownership is stored and every read also joins the parent farm. Hard farm/owner deletion cascades.
CREATE TABLE farm_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('live', 'replay', 'synthetic')),
  type text NOT NULL CHECK (type IN ('weather', 'price', 'market_event', 'crop_threat')),
  severity text NOT NULL CHECK (severity IN ('info', 'watch', 'warning')),
  -- 'rule' = computed in code from stored data; 'grounded_review' = classified by Meta from cited web search results.
  origin text NOT NULL DEFAULT 'rule' CHECK (origin IN ('rule', 'grounded_review')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  detail text NOT NULL CHECK (char_length(detail) BETWEEN 1 AND 600),
  source jsonb NOT NULL CHECK (
    jsonb_typeof(source) = 'object'
    AND jsonb_typeof(source -> 'name') = 'string'
    AND jsonb_typeof(source -> 'url') = 'string'
    AND (source ->> 'url') ~ '^https?://'
    AND (source ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
  ),
  valid_from date NOT NULL,
  valid_to date NOT NULL CHECK (valid_to >= valid_from),
  suggested_step text CHECK (suggested_step IS NULL OR char_length(suggested_step) <= 300),
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,
  UNIQUE (farm_id, mode, fingerprint)
);
CREATE INDEX farm_alerts_active ON farm_alerts (owner_id, farm_id, valid_to DESC);
CREATE TRIGGER farm_alerts_set_updated_at BEFORE UPDATE ON farm_alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
