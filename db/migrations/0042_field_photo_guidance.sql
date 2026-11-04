-- Keep older previews readable, but allow an explicit replacement with the corrected growth/weather guidance.
ALTER TABLE field_photo_predictions ADD COLUMN prompt_version text NOT NULL DEFAULT 'field-photo-v1';
ALTER TABLE field_photo_predictions ADD COLUMN guidance jsonb;
ALTER TABLE field_photo_predictions DROP CONSTRAINT field_photo_predictions_photo_id_source_date_target_date_key;
ALTER TABLE field_photo_predictions ADD CONSTRAINT field_photo_prediction_version UNIQUE (photo_id, source_date, target_date, prompt_version);
