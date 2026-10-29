-- 0003_ingest: public-data ingestion (T05a). Additive changes only.
-- `mode` separates synthetic fixtures from real rows by construction (BUILD_SPEC 3).

-- ---------------------------------------------------------------- source_documents: manifest identity
ALTER TABLE source_documents ADD COLUMN IF NOT EXISTS manifest_id text;
CREATE UNIQUE INDEX IF NOT EXISTS source_documents_manifest_id_uq ON source_documents(manifest_id) WHERE manifest_id IS NOT NULL;

-- ---------------------------------------------------------------- mode on observation tables
ALTER TABLE market_observations
  ADD COLUMN mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','replay','synthetic')),
  ADD COLUMN evidence_state text NOT NULL DEFAULT 'observed',
  ADD COLUMN market_name text,
  ADD COLUMN state_name text,
  ADD COLUMN district_name text,
  ADD COLUMN variety text,
  ADD COLUMN grade text,
  ADD COLUMN variety_key text NOT NULL DEFAULT '',
  ADD COLUMN grade_key text NOT NULL DEFAULT '',
  ADD COLUMN price_min_inr_per_kg numeric(14,6),
  ADD COLUMN price_modal_inr_per_kg numeric(14,6),
  ADD COLUMN price_max_inr_per_kg numeric(14,6),
  ADD COLUMN arrivals_unit text,
  ADD COLUMN flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN raw jsonb,
  ADD COLUMN available_at timestamptz;
ALTER TABLE market_observations ALTER COLUMN unit SET DEFAULT 'INR/quintal';

-- Replace the (market, product, date, source) unique constraint so variety/grade rows can coexist.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'market_observations'::regclass AND con.contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE market_observations DROP CONSTRAINT %I', c);
  END LOOP;
END
$$;
CREATE UNIQUE INDEX market_obs_identity_uq
  ON market_observations(market_id, product_id, observed_on, source_id, variety_key, grade_key);

ALTER TABLE weather_observations
  ADD COLUMN mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','replay','synthetic')),
  ADD COLUMN evidence_state text NOT NULL DEFAULT 'observed',
  ADD COLUMN measurement_kind text,
  ADD COLUMN available_at timestamptz,
  ADD COLUMN revised_at timestamptz,
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE weather_forecasts
  ADD COLUMN mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','replay','synthetic')),
  ADD COLUMN evidence_state text NOT NULL DEFAULT 'forecast',
  ADD COLUMN available_at timestamptz,
  ADD COLUMN horizon_days integer,
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX weather_obs_loc_date_idx ON weather_observations(location_key, observed_on);
CREATE INDEX weather_fc_loc_valid_idx ON weather_forecasts(location_key, valid_on, issued_at);

-- Defence in depth: is_synthetic and mode may never disagree.
ALTER TABLE market_observations ADD CONSTRAINT market_obs_mode_synth_ck CHECK ((mode = 'synthetic') = is_synthetic);
ALTER TABLE weather_observations ADD CONSTRAINT weather_obs_mode_synth_ck CHECK ((mode = 'synthetic') = is_synthetic);
ALTER TABLE weather_forecasts ADD CONSTRAINT weather_fc_mode_synth_ck CHECK ((mode = 'synthetic') = is_synthetic);

-- ---------------------------------------------------------------- provider response cache
CREATE TABLE provider_cache (
  key text PRIMARY KEY,
  provider text NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_cache_expiry_idx ON provider_cache(provider, expires_at);

-- ---------------------------------------------------------------- ingest run ledger
CREATE TABLE ingest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  job_type text NOT NULL,
  payload_hash text NOT NULL,
  provider text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('live','replay','synthetic')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled','unavailable')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingest_runs_hash_idx ON ingest_runs(job_type, payload_hash, finished_at);

CREATE TRIGGER provider_cache_set_updated_at BEFORE UPDATE ON provider_cache FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ingest_runs_set_updated_at BEFORE UPDATE ON ingest_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
