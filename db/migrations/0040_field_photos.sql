ALTER TABLE media_objects ADD COLUMN exif_created_at date;
CREATE TABLE field_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  cycle_id text NOT NULL,
  field_id text,
  media_id uuid NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  captured_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, cycle_id, media_id)
);
CREATE INDEX field_photos_scope ON field_photos(owner_id, farm_id, cycle_id);
CREATE TABLE field_photo_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  cycle_id text NOT NULL,
  photo_id uuid NOT NULL REFERENCES field_photos(id) ON DELETE CASCADE,
  source_date date NOT NULL,
  target_date date NOT NULL CHECK (target_date > source_date),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','unavailable')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  storage_key text,
  failure_reason text,
  prompt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (photo_id, source_date, target_date)
);
CREATE INDEX field_photo_predictions_scope ON field_photo_predictions(owner_id, farm_id, cycle_id);
