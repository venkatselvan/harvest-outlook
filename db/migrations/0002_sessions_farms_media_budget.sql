-- 0002: idempotency keys, farm location/provenance columns, media region/orientation, budget state.
-- Additive only; 0001 is never edited.

-- ---------------------------------------------------------------- idempotency
-- status_code/response are NULL while the first request is still in flight.
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  key text NOT NULL,
  route text NOT NULL,
  payload_hash text NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, key, route)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys(created_at);

-- ---------------------------------------------------------------- farms
ALTER TABLE farms
  ADD COLUMN district_name text,
  ADD COLUMN location_precision text NOT NULL DEFAULT 'district'
    CHECK (location_precision IN ('district','approximate','precise'));

-- ---------------------------------------------------------------- farm facts: per-field provenance
-- 0001 `provenance` is kept (mapped from basis/confirmed by the application) for compatibility.
ALTER TABLE farm_facts
  ADD COLUMN basis text NOT NULL DEFAULT 'unknown'
    CHECK (basis IN ('farmer_reported','lab_test','district_proxy','derived','unknown')),
  ADD COLUMN confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN source text,
  ADD COLUMN recorded_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN superseded_by uuid REFERENCES farm_facts(id) ON DELETE SET NULL;
-- At most one current (non-superseded) fact per farm and key.
CREATE UNIQUE INDEX farm_facts_current_uq ON farm_facts(farm_id, fact_key) WHERE superseded_by IS NULL;

-- ---------------------------------------------------------------- media
ALTER TABLE media_objects
  ADD COLUMN exif_orientation smallint,
  ADD COLUMN region_source text CHECK (region_source IS NULL OR region_source IN ('manual','sam_confirmed')),
  ADD COLUMN region_version integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------- budget
CREATE TABLE budget_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  total_usd numeric(12,6) NOT NULL CHECK (total_usd >= 0),
  dev_allocation_usd numeric(12,6) NOT NULL CHECK (dev_allocation_usd >= 0),
  demo_reserve_usd numeric(12,6) NOT NULL CHECK (demo_reserve_usd >= 0),
  reserved_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  settled_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (settled_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER budget_state_set_updated_at BEFORE UPDATE ON budget_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE usage_reservations
  ADD COLUMN settled_usd numeric(12,6) CHECK (settled_usd IS NULL OR settled_usd >= 0),
  ADD COLUMN provider_request_id text;
CREATE INDEX usage_res_session_idx ON usage_reservations(session_id);
CREATE INDEX usage_res_owner_created_idx ON usage_reservations(owner_id, created_at);

ALTER TABLE usage_ledger ADD COLUMN provider_request_id text;
