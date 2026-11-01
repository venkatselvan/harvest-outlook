-- Open-source comparison (2026-11-01): the daily monitor raises a code-rule 'satellite' alert when the field's own
-- Sentinel-2 NDVI falls between two clear scenes while the 1 km neighbourhood does not (services/today/alerts.ts
-- satelliteAlerts). The contract FarmAlertType gained the value; the CHECK from 0026 must admit it or every write
-- fails with 23514. No row is changed.
ALTER TABLE farm_alerts DROP CONSTRAINT farm_alerts_type_check;
ALTER TABLE farm_alerts ADD CONSTRAINT farm_alerts_type_check CHECK (type IN ('weather', 'price', 'market_event', 'crop_threat', 'satellite'));
