-- Fields inside a farm, second round (2026-11-03, docs/research/FIELDS_MULTICROP_SOIL_SPEC.md 12.4): the daily monitor
-- raises crop-threat alerts per cycle and satellite greenness-drop alerts per field polygon, each naming the field.
-- field_id is the workspace field id (FarmField.id, not a foreign key: fields live in farm_workspaces.state jsonb).
-- NULL = a farm-wide alert (weather, price, news review, a cycle recorded without a field). Existing rows stay NULL,
-- which is exactly what they were: farm-wide. The fingerprint (services/today/alerts.ts alertFingerprint) includes the
-- field when set, so the existing unique (farm_id, mode, fingerprint) keeps two fields' alerts apart.
ALTER TABLE farm_alerts ADD COLUMN field_id text CHECK (field_id IS NULL OR length(field_id) BETWEEN 1 AND 120);
CREATE INDEX farm_alerts_farm_field ON farm_alerts (farm_id, field_id);
