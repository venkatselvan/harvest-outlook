-- Retain previous expectations when photos, recorded dates or satellite evidence change.
ALTER TABLE journal_entries ADD COLUMN cycle_id text;
ALTER TABLE field_photos ADD COLUMN journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE CASCADE;
ALTER TABLE field_photo_predictions ADD COLUMN evidence_revision text NOT NULL DEFAULT '';
ALTER TABLE field_photo_predictions DROP CONSTRAINT field_photo_prediction_version;
ALTER TABLE field_photo_predictions ADD CONSTRAINT field_photo_prediction_revision UNIQUE (photo_id, source_date, target_date, prompt_version, evidence_revision);
ALTER TABLE future_look_assets ADD COLUMN evidence_revision text NOT NULL DEFAULT '';
ALTER TABLE future_look_assets DROP CONSTRAINT future_look_assets_tuple_key;
ALTER TABLE future_look_assets ADD CONSTRAINT future_look_assets_tuple_key UNIQUE NULLS NOT DISTINCT (farm_id, cycle_id, kind, stage_id, target_week, source_item_id, prompt_version, target_date, evidence_revision);
CREATE INDEX journal_entries_cycle ON journal_entries(owner_id, farm_id, cycle_id, entry_date);
