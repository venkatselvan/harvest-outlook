-- Field operations (2026-11-03, docs/research/FIELD_OPERATIONS_SPEC.md sections 4.4 and 5.1): field check completions, the
-- farmer's issue log and its events. Additive only. Every row references the immutable journal entry written with it in the
-- same transaction (services/scouting/journal-writes.ts), so the farm timeline and the assistant briefing see every write.
-- field_id and cycle_id are workspace ids (FarmField.id, CropCycle.id), not foreign keys: both live in farm_workspaces.state
-- jsonb. NULL field_id = farm-wide (a farm without fields, or a cycle recorded before the fields were drawn). Ownership is
-- stored and every read also joins the parent farm; rows are deleted only with the farm or the owner (cascades).
-- The schedule itself is computed on read; GET never creates rows.

CREATE TABLE field_check_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('live', 'replay', 'synthetic')),
  -- Deterministic check id: 'check:<cycleId>:<dueOn>' or 'recheck:<issueId>:<dueOn>'.
  check_id text NOT NULL CHECK (char_length(check_id) BETWEEN 1 AND 160),
  check_kind text NOT NULL CHECK (check_kind IN ('interval', 'recheck')),
  field_id text CHECK (field_id IS NULL OR char_length(field_id) BETWEEN 1 AND 120),
  cycle_id text,
  issue_id uuid,
  due_on date NOT NULL,
  completed_on date NOT NULL,
  result text NOT NULL CHECK (result IN ('nothing_found', 'issues_found')),
  issue_ids uuid[] NOT NULL DEFAULT '{}',
  client_entry_id text NOT NULL,
  payload_hash text NOT NULL,
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, client_entry_id),
  UNIQUE (farm_id, mode, check_id)
);
CREATE INDEX field_check_completions_farm ON field_check_completions (owner_id, farm_id, mode, completed_on DESC);

CREATE TABLE field_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('live', 'replay', 'synthetic')),
  field_id text CHECK (field_id IS NULL OR char_length(field_id) BETWEEN 1 AND 120),
  cycle_id text,
  crop_id text,
  observed_on date NOT NULL,
  -- Farmer-reported category, severity and status; never a diagnosis.
  category text NOT NULL CHECK (category IN ('pest', 'disease', 'weed', 'water_stress', 'nutrient', 'weather_damage', 'animal_damage', 'other')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'treating', 'resolved', 'dismissed')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 2000),
  location_lat double precision CHECK (location_lat IS NULL OR location_lat BETWEEN -90 AND 90),
  location_lon double precision CHECK (location_lon IS NULL OR location_lon BETWEEN -180 AND 180),
  media_ids uuid[] NOT NULL DEFAULT '{}',
  photo_marks jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(photo_marks) = 'array'),
  from_fact_id uuid,
  client_entry_id text NOT NULL,
  payload_hash text NOT NULL,
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  -- Set by a response_recorded event with recheckOn; cleared when the status changes to resolved or dismissed.
  recheck_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((location_lat IS NULL) = (location_lon IS NULL)),
  UNIQUE (owner_id, client_entry_id)
);
CREATE INDEX field_issues_farm ON field_issues (owner_id, farm_id, mode, observed_on DESC);
CREATE TRIGGER field_issues_set_updated_at BEFORE UPDATE ON field_issues FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE field_issue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES field_issues(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reported', 'status_changed', 'response_recorded', 'recheck_scheduled', 'note_added')),
  occurred_on date NOT NULL,
  status text CHECK (status IS NULL OR status IN ('open', 'treating', 'resolved', 'dismissed')),
  -- The farmer's own response (IssueResponse): what was done, in the farmer's words; never a recommendation.
  response jsonb CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  media_ids uuid[] NOT NULL DEFAULT '{}',
  client_entry_id text NOT NULL,
  payload_hash text NOT NULL,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, client_entry_id)
);
CREATE INDEX field_issue_events_issue ON field_issue_events (issue_id, occurred_on);
