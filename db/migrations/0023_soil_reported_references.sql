-- Printed lab limits and receipt dates are provenance, never universal crop requirements.
ALTER TABLE soil_markers ADD COLUMN reported_reference jsonb;
ALTER TABLE soil_samples ADD COLUMN received_date date;
