-- 0007: crop catalogue loader support (T06b). Additive, except that the coverage_records natural-key
-- unique constraint is replaced by a record_key (several screening rows per crop/region exist, one per context).
-- Catalogue rows are public reference data, mode-agnostic; each row records its sourceId and validation status.

ALTER TABLE crop_identities
  ADD COLUMN IF NOT EXISTS record jsonb,
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('validated','unsupported','pending','rejected'));

ALTER TABLE crop_products
  ADD COLUMN IF NOT EXISTS record jsonb,
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('validated','unsupported','pending','rejected'));

ALTER TABLE evidence_records
  ADD COLUMN IF NOT EXISTS evidence_key text UNIQUE,
  ADD COLUMN IF NOT EXISTS record jsonb,
  ADD COLUMN IF NOT EXISTS catalogue_source_id text;

ALTER TABLE crop_rules
  ADD COLUMN IF NOT EXISTS rule_key text UNIQUE,
  ADD COLUMN IF NOT EXISTS review_status text,
  ADD COLUMN IF NOT EXISTS reviewer text,
  ADD COLUMN IF NOT EXISTS rule_mode text,
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('validated','unsupported','pending','rejected')),
  ADD COLUMN IF NOT EXISTS evidence_keys text[] NOT NULL DEFAULT '{}';

ALTER TABLE stage_definitions
  ADD COLUMN IF NOT EXISTS record_key text UNIQUE,
  ADD COLUMN IF NOT EXISTS review_status text,
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('validated','unsupported','pending','rejected'));

ALTER TABLE coverage_records DROP CONSTRAINT IF EXISTS coverage_records_crop_id_region_code_capability_key;
ALTER TABLE coverage_records
  ADD COLUMN IF NOT EXISTS record_key text UNIQUE,
  ADD COLUMN IF NOT EXISTS record jsonb,
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('validated','unsupported','pending','rejected'));
CREATE INDEX IF NOT EXISTS coverage_crop_idx ON coverage_records(crop_id);

-- Crop profile (regional contexts) as one validated JSON document per crop.
CREATE TABLE IF NOT EXISTS crop_profiles (
  crop_id uuid PRIMARY KEY REFERENCES crop_identities(id) ON DELETE CASCADE,
  record jsonb NOT NULL,
  qualified boolean NOT NULL,
  source_id text NOT NULL,
  validation_status text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('validated','unsupported','pending','rejected')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- States, districts and agro-regions. Ids: IN-<ISO 3166-2 code>, IN-<code>-<district-slug>, IN-region-<name>.
CREATE TABLE IF NOT EXISTS districts (
  id text PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('national','region','state','district')),
  state_id text,
  names jsonb NOT NULL,
  source_id text NOT NULL,
  source jsonb,
  validation_status text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('validated','unsupported','pending','rejected')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS districts_state_idx ON districts(state_id);
