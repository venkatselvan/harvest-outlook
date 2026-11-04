-- Photo coverage (docs/research/PHOTO_COVERAGE_SPEC.md): SAM 3.1 crop / weed-like / standing-water image fractions and a
-- Muse Spark summary of those numbers. One row per photo, image content (sha256 of the original) and prompt version.
-- Fractions are shares of the image, not field area; `method` records how they were measured ('box' = union of
-- proposal boxes, 'mask' = decoded mask pixels). `captured_on` and `crop_id` are the photo date and the cycle crop the
-- measurement was made for: when either changes the row is reported outdated and the next request re-measures it.
-- `classes[].phrases` records the SAM concept phrases actually sent for each class.
CREATE TABLE field_photo_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  cycle_id text NOT NULL,
  photo_id uuid NOT NULL REFERENCES field_photos(id) ON DELETE CASCADE,
  media_sha256 text NOT NULL,
  captured_on date NOT NULL,
  crop_id text NOT NULL,
  prompt_version text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','unavailable')),
  method text CHECK (method IN ('mask','box')),
  model_id text,
  summary_model_id text,
  classes jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text,
  limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_reason text,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_photo_coverage_key UNIQUE (photo_id, prompt_version, media_sha256)
);
CREATE INDEX field_photo_coverage_scope ON field_photo_coverage(owner_id, farm_id, cycle_id);
