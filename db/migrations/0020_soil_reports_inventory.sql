CREATE TABLE soil_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('field_report','reference_sample')),mode text NOT NULL CHECK(mode IN ('live','replay','synthetic')),
 status text NOT NULL CHECK(status IN ('pending','running','needs_review','confirmed','unavailable','error')),version integer NOT NULL DEFAULT 1,review_revision integer NOT NULL DEFAULT 1,
 filename text NOT NULL,content_type text NOT NULL,byte_size integer NOT NULL,sha256 text NOT NULL,original_key text NOT NULL,pages jsonb NOT NULL DEFAULT '[]',reference_source jsonb,
 extraction jsonb,reviewed jsonb,confirmed_sample_ids jsonb NOT NULL DEFAULT '[]',warnings jsonb NOT NULL DEFAULT '[]',job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 invocation jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,farm_id,kind,mode,sha256)
);
CREATE TRIGGER soil_reports_updated BEFORE UPDATE ON soil_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE soil_report_reviews(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),report_id uuid NOT NULL REFERENCES soil_reports(id) ON DELETE CASCADE,owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,revision integer NOT NULL,draft jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(report_id,revision));
CREATE TABLE soil_samples (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,report_id uuid NOT NULL REFERENCES soil_reports(id) ON DELETE CASCADE,
 source_sample_id text NOT NULL,review_revision integer NOT NULL,sample_label text,laboratory text,collection_date date,report_date date,depth_from numeric,depth_to numeric,depth_unit text CHECK(depth_unit IN ('cm','m','inch')),confirmed_at timestamptz NOT NULL DEFAULT now(),superseded_by uuid REFERENCES soil_samples(id),retired_at timestamptz,UNIQUE(report_id,source_sample_id,review_revision)
);
CREATE TABLE soil_markers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sample_id uuid NOT NULL REFERENCES soil_samples(id) ON DELETE CASCADE,source_marker_id text NOT NULL,
 parameter text NOT NULL,raw_label text NOT NULL,raw_value text NOT NULL,raw_unit text,numeric_value numeric,qualifier text NOT NULL CHECK(qualifier IN ('exact','less_than','less_or_equal','greater_than','greater_or_equal','range','below_detection','unreadable','text')),
 numeric_range jsonb,analyte_form text,method text,extractant text,soil_water_ratio text,temperature_c numeric,matrix text NOT NULL CHECK(matrix IN ('soil','water','plant','unknown')),mass_basis text,reported_rating text,
 evidence_page integer NOT NULL CHECK(evidence_page BETWEEN 1 AND 8),evidence_quote text NOT NULL,native_text_check text NOT NULL,extraction_confidence text NOT NULL,warnings jsonb NOT NULL,
 canonical_value numeric,canonical_unit text,canonical_conversion jsonb,canonical_missing_reason text,confirmed_at timestamptz NOT NULL DEFAULT now(),UNIQUE(sample_id,source_marker_id)
);
CREATE INDEX soil_samples_farm ON soil_samples(owner_id,farm_id,confirmed_at DESC);
CREATE TABLE commodity_inventory_snapshots(id text PRIMARY KEY,source_url text NOT NULL,checked_at timestamptz NOT NULL,complete boolean NOT NULL,metadata jsonb NOT NULL);
CREATE TABLE commodity_inventory(commodity_id text PRIMARY KEY,snapshot_id text NOT NULL REFERENCES commodity_inventory_snapshots(id),source_commodity text NOT NULL,grouping text NOT NULL DEFAULT 'unresolved',crop_id text,product_id text,profile_id text,record jsonb NOT NULL);
CREATE TABLE researched_crop_profiles(profile_id text PRIMARY KEY,botanical_name text,crop_id text,record jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
