-- 0001_init: core schema (BUILD_SPEC section 6).
-- PostGIS is optional. Locations are stored as lon/lat plus GeoJSON; nothing requires PostGIS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    CREATE EXTENSION IF NOT EXISTS postgis;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- identity
CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'guest' CHECK (kind IN ('guest')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_hash text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_owner_idx ON sessions(owner_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- ---------------------------------------------------------------- farms
CREATE TABLE farms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name text NOT NULL,
  state_code text,
  district_code text,
  lon double precision CHECK (lon BETWEEN -180 AND 180),
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  location_geojson jsonb,
  area_hectares numeric(12,4) CHECK (area_hectares IS NULL OR area_hectares > 0),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX farms_owner_idx ON farms(owner_id);

CREATE TABLE farm_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  fact_key text NOT NULL,
  value jsonb NOT NULL,
  unit text,
  provenance text NOT NULL CHECK (provenance IN ('user_entered','user_confirmed','ai_proposed','public_data','default')),
  source_ref jsonb,
  supersedes_id uuid REFERENCES farm_facts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX farm_facts_owner_idx ON farm_facts(owner_id);
CREATE INDEX farm_facts_farm_key_idx ON farm_facts(farm_id, fact_key);

-- ---------------------------------------------------------------- public catalogue
CREATE TABLE crop_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  scientific_name text,
  names jsonb NOT NULL DEFAULT '{}'::jsonb,
  category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crop_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crop_id uuid NOT NULL REFERENCES crop_identities(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  form text,
  grade text,
  unit text NOT NULL DEFAULT 'quintal',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crop_products_crop_idx ON crop_products(crop_id);

CREATE TABLE source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash text NOT NULL UNIQUE,
  title text,
  publisher text,
  url text,
  licence text,
  access_class text NOT NULL DEFAULT 'public' CHECK (access_class IN ('public','private','restricted')),
  retrieved_at timestamptz,
  published_on date,
  storage_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  locator text,
  excerpt text,
  claim jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_grade text,
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(excerpt, ''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_source_idx ON evidence_records(source_id);
CREATE INDEX evidence_tsv_idx ON evidence_records USING gin(search_tsv);

CREATE TABLE crop_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crop_id uuid NOT NULL REFERENCES crop_identities(id) ON DELETE CASCADE,
  region_code text,
  rule_kind text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  rule jsonb NOT NULL,
  evidence_id uuid REFERENCES evidence_records(id),
  effective_from date,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (crop_id, region_code, rule_kind, version)
);

CREATE TABLE stage_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crop_id uuid NOT NULL REFERENCES crop_identities(id) ON DELETE CASCADE,
  region_code text,
  stage_key text NOT NULL,
  ordinal integer NOT NULL,
  typical_days_min integer,
  typical_days_max integer,
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_id uuid REFERENCES evidence_records(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (crop_id, region_code, stage_key, version)
);

CREATE TABLE coverage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crop_id uuid NOT NULL REFERENCES crop_identities(id) ON DELETE CASCADE,
  region_code text NOT NULL,
  capability text NOT NULL,
  status text NOT NULL CHECK (status IN ('supported','partial','unsupported','unknown')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_id uuid REFERENCES evidence_records(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (crop_id, region_code, capability)
);

CREATE TABLE market_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL,
  product_id uuid NOT NULL REFERENCES crop_products(id),
  observed_on date NOT NULL,
  source_id uuid NOT NULL REFERENCES source_documents(id),
  price_min numeric(14,4),
  price_modal numeric(14,4),
  price_max numeric(14,4),
  arrivals numeric(14,4),
  unit text NOT NULL DEFAULT 'quintal',
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, product_id, observed_on, source_id)
);
CREATE INDEX market_obs_product_date_idx ON market_observations(product_id, observed_on);

CREATE TABLE weather_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_key text NOT NULL,
  lon double precision,
  lat double precision,
  observed_on date NOT NULL,
  variables jsonb NOT NULL,
  source_id uuid REFERENCES source_documents(id),
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_key, observed_on, source_id)
);

CREATE TABLE weather_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_key text NOT NULL,
  lon double precision,
  lat double precision,
  issued_at timestamptz NOT NULL,
  valid_on date NOT NULL,
  variables jsonb NOT NULL,
  source_id uuid REFERENCES source_documents(id),
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_key, issued_at, valid_on, source_id)
);

CREATE TABLE regional_production (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crop_id uuid NOT NULL REFERENCES crop_identities(id),
  region_code text NOT NULL,
  season_year integer NOT NULL,
  season text,
  area_hectares numeric(16,4),
  production_tonnes numeric(16,4),
  yield_t_per_ha numeric(12,4),
  source_id uuid NOT NULL REFERENCES source_documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (crop_id, region_code, season_year, season, source_id)
);

CREATE TABLE feature_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  content_hash text NOT NULL UNIQUE,
  data_version text,
  storage_key text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE forecast_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  training_cutoff date,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TABLE forecast_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid REFERENCES forecast_models(id),
  mode text NOT NULL CHECK (mode IN ('live','replay','synthetic')),
  crop_id uuid REFERENCES crop_identities(id),
  region_code text,
  cutoff_date date,
  input_hash text NOT NULL,
  output jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, mode, input_hash)
);

-- ---------------------------------------------------------------- media
CREATE TABLE media_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid REFERENCES farms(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('image','audio','derivative')),
  storage_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL,
  width integer,
  height integer,
  duration_seconds numeric(8,2),
  region_polygon jsonb,
  region_transform jsonb,
  parent_media_id uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (owner_id, storage_key)
);
CREATE INDEX media_owner_idx ON media_objects(owner_id);
CREATE INDEX media_farm_idx ON media_objects(farm_id);

-- ---------------------------------------------------------------- jobs and usage
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES owners(id) ON DELETE CASCADE,
  type text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  idempotency_key text,
  payload_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error jsonb,
  retryable boolean,
  cancel_requested boolean NOT NULL DEFAULT false,
  progress numeric(5,4) NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_owner_idx ON jobs(owner_id);
CREATE INDEX jobs_claim_idx ON jobs(state, run_after) WHERE state IN ('queued','running');
CREATE UNIQUE INDEX jobs_owner_idempotency_uq ON jobs(owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  request_id text,
  provider text NOT NULL,
  model text,
  estimated_usd numeric(12,6) NOT NULL CHECK (estimated_usd >= 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','settled','released','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_res_owner_idx ON usage_reservations(owner_id);
CREATE INDEX usage_res_state_idx ON usage_reservations(state);

CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES usage_reservations(id) ON DELETE SET NULL,
  request_id text,
  provider text NOT NULL,
  model text,
  estimated_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (estimated_usd >= 0),
  settled_usd numeric(12,6) CHECK (settled_usd IS NULL OR settled_usd >= 0),
  cost_basis text NOT NULL DEFAULT 'estimated' CHECK (cost_basis IN ('estimated','billed')),
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_owner_idx ON usage_ledger(owner_id);
CREATE INDEX usage_ledger_provider_idx ON usage_ledger(provider, created_at);

-- ---------------------------------------------------------------- plans (immutable snapshots)
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  crop_id uuid NOT NULL REFERENCES crop_identities(id),
  parent_plan_id uuid REFERENCES plans(id),
  mode text NOT NULL CHECK (mode IN ('live','replay','synthetic')),
  content_hash text NOT NULL,
  snapshot jsonb NOT NULL,
  data_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  forecast_artifact_id uuid REFERENCES forecast_artifacts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, content_hash)
);
CREATE INDEX plans_owner_idx ON plans(owner_id);
CREATE INDEX plans_farm_idx ON plans(farm_id);
CREATE INDEX plans_parent_idx ON plans(parent_plan_id);

-- Plans are append-only: reject UPDATE and DELETE of historical snapshots
-- (owner deletion cascades are performed via the farm/owner deletion procedure, which sets the
-- session variable below inside its own transaction).
CREATE OR REPLACE FUNCTION plans_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('harvest.allow_plan_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'plans are immutable; create a superseding plan instead' USING ERRCODE = 'restrict_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER plans_no_update BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION plans_immutable();
CREATE TRIGGER plans_no_delete BEFORE DELETE ON plans FOR EACH ROW EXECUTE FUNCTION plans_immutable();

CREATE TABLE plan_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  kind text NOT NULL,
  content_hash text NOT NULL,
  output jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, kind, content_hash)
);
CREATE INDEX plan_outputs_owner_idx ON plan_outputs(owner_id);

-- ---------------------------------------------------------------- journal
CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES plans(id),
  client_entry_id text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  entry_date date NOT NULL,
  text_body text,
  language text CHECK (language IS NULL OR language IN ('en','ta','hi')),
  media_ids uuid[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, client_entry_id)
);
CREATE INDEX journal_entries_owner_idx ON journal_entries(owner_id);
CREATE INDEX journal_entries_farm_date_idx ON journal_entries(farm_id, entry_date);

CREATE TABLE journal_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  fact_key text NOT NULL,
  value jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected')),
  confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  agent_run_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_facts_owner_idx ON journal_facts(owner_id);
CREATE INDEX journal_facts_entry_idx ON journal_facts(entry_id);

CREATE TABLE actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES plans(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','skipped')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actions_owner_idx ON actions(owner_id);
CREATE INDEX actions_farm_due_idx ON actions(farm_id, due_on);

-- ---------------------------------------------------------------- agent traces and visuals
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('live','replay','synthetic')),
  purpose text NOT NULL,
  provider text,
  model text,
  prompt_version text,
  request_id text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled')),
  input_hash text,
  output jsonb,
  error jsonb,
  rounds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_owner_idx ON agent_runs(owner_id);

ALTER TABLE journal_facts
  ADD CONSTRAINT journal_facts_agent_run_fk FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;

CREATE TABLE tool_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  args_hash text NOT NULL,
  result jsonb,
  error jsonb,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_results_owner_idx ON tool_results(owner_id);
CREATE INDEX tool_results_run_idx ON tool_results(agent_run_id);

CREATE TABLE visual_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  source_media_id uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  media_id uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('live','replay','synthetic')),
  stage_key text,
  scenario text,
  cache_key text NOT NULL,
  model text,
  label text NOT NULL DEFAULT 'illustrative',
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, cache_key)
);
CREATE INDEX visual_assets_owner_idx ON visual_assets(owner_id);
CREATE INDEX visual_assets_plan_idx ON visual_assets(plan_id);

-- ---------------------------------------------------------------- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = current_schema() AND c.column_name = 'updated_at' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_set_updated_at', t);
  END LOOP;
END
$$;
