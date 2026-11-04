-- Crop journey (docs/research/EVARA_ACTIONS_SPEC.md section 3.2, 2026-11-04): an arbitrary crop's growth cycle on one field
-- as up to five generated stage illustrations. Additive only: a new crop_journeys table and a nullable future_look_assets
-- column. Generated illustrations are labelled as such; they are never observations or predictions of yield or health.
--
-- Numbered 0046, not 0040 as the packet named it: 0040_field_photos.sql already exists and the runner applies files in name
-- order, so the next free number keeps the order of this schema change after everything it depends on (0027, 0037, 0043).
--
-- One row per (farm, field, crop, IST day): a repeat request that day returns the existing journey (`deduplicated`), so the
-- unique key below is the dedup rule. An `unavailable` row (no source image, daily cap, budget, field required) is re-evaluated
-- in place on the next request; any other status is final for the day. Rows are written in live mode only (synthetic and
-- replay return an unstored `unavailable` journey). `stages` is the code-decided stage list frozen at request time (ids,
-- names, dates, guidance, which stages are illustrated and their asset ids), so a queued job renders exactly what was decided.
-- Budget bound (services/today/crop-journey.ts, under a per-farm advisory lock): at most 5 illustrated stages per journey and
-- at most 3 journeys per farm per IST day that are not `unavailable`.
CREATE TABLE crop_journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  field_id text CHECK (field_id IS NULL OR char_length(field_id) BETWEEN 1 AND 120),
  crop_id text NOT NULL CHECK (char_length(crop_id) BETWEEN 1 AND 120),
  crop_name text NOT NULL CHECK (char_length(crop_name) BETWEEN 1 AND 120),
  product_id text CHECK (product_id IS NULL OR char_length(product_id) BETWEEN 1 AND 200),
  establishment_method text CHECK (establishment_method IS NULL OR char_length(establishment_method) <= 80),
  sowing_date date NOT NULL,
  -- Where the sowing date came from: the request, the stored crop-fit candidate, or today (IST).
  sowing_basis text NOT NULL CHECK (sowing_basis IN ('request', 'crop_fit', 'today')),
  ist_day date NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'partial', 'failed', 'unavailable')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 80),
  source_kind text NOT NULL CHECK (source_kind IN ('satellite', 'photo', 'none')),
  -- Satellite: the Sentinel-2 item id. Photo: the field_photos id.
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  source_media_id uuid,
  source_region_version integer,
  source_date date,
  source_acquired_at timestamptz,
  stages jsonb NOT NULL CHECK (jsonb_typeof(stages) = 'array'),
  -- The stage calendar's basis label (stage-timeline.ts), quoted in the journey's limitations.
  calendar_basis text CHECK (calendar_basis IS NULL OR char_length(calendar_basis) <= 200),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crop_journeys_day_key UNIQUE NULLS NOT DISTINCT (farm_id, field_id, crop_id, ist_day),
  CHECK (source_kind <> 'none' OR status = 'unavailable')
);
CREATE INDEX crop_journeys_owner_farm_day ON crop_journeys (owner_id, farm_id, ist_day);
CREATE TRIGGER crop_journeys_set_updated_at BEFORE UPDATE ON crop_journeys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Journey stage images are future_look_assets rows of kind 'journey' with the owning journey; their cycle_id is
-- 'journey:<journey id>', so the per-cycle caps, lists and pending counts of the Today future look never see them.
-- ON DELETE CASCADE: journeys go only with their farm, and deleteFarm collects every future_look_assets storage_key first.
ALTER TABLE future_look_assets
  ADD COLUMN journey_id uuid REFERENCES crop_journeys(id) ON DELETE CASCADE;
CREATE INDEX future_look_assets_journey ON future_look_assets (journey_id) WHERE journey_id IS NOT NULL;
ALTER TABLE future_look_assets DROP CONSTRAINT future_look_assets_kind_check;
ALTER TABLE future_look_assets
  ADD CONSTRAINT future_look_assets_kind_check CHECK (kind IN ('stage', 'gap', 'journey')),
  ADD CONSTRAINT future_look_assets_journey_owner CHECK ((kind = 'journey') = (journey_id IS NOT NULL));
