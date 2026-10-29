-- 0009_vintages: source vintages for replay (F1, BUILD_SPEC 4 and 8.2). Additive only: existing rows become vintage 1.
-- A re-ingest that changes a value inserts a NEW row (vintage_seq + 1, revision_of -> prior row, its own available_at).
-- Values are never overwritten. Reads pick, per identity, the latest vintage available by the caller's cutoff.

-- ---------------------------------------------------------------- weather_observations
ALTER TABLE weather_observations
  ADD COLUMN IF NOT EXISTS vintage_seq integer NOT NULL DEFAULT 1 CHECK (vintage_seq >= 1),
  ADD COLUMN IF NOT EXISTS revision_of uuid REFERENCES weather_observations(id);
ALTER TABLE weather_observations DROP CONSTRAINT IF EXISTS weather_observations_location_key_observed_on_source_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS weather_obs_vintage_uq
  ON weather_observations(location_key, observed_on, source_id, vintage_seq);
CREATE INDEX IF NOT EXISTS weather_obs_vintage_avail_idx
  ON weather_observations(location_key, observed_on, source_id, available_at DESC);

-- ---------------------------------------------------------------- weather_forecasts
ALTER TABLE weather_forecasts
  ADD COLUMN IF NOT EXISTS vintage_seq integer NOT NULL DEFAULT 1 CHECK (vintage_seq >= 1),
  ADD COLUMN IF NOT EXISTS revision_of uuid REFERENCES weather_forecasts(id);
ALTER TABLE weather_forecasts DROP CONSTRAINT IF EXISTS weather_forecasts_location_key_issued_at_valid_on_source_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS weather_fc_vintage_uq
  ON weather_forecasts(location_key, issued_at, valid_on, source_id, vintage_seq);

-- ---------------------------------------------------------------- market_observations
ALTER TABLE market_observations
  ADD COLUMN IF NOT EXISTS vintage_seq integer NOT NULL DEFAULT 1 CHECK (vintage_seq >= 1),
  ADD COLUMN IF NOT EXISTS revision_of uuid REFERENCES market_observations(id),
  ADD COLUMN IF NOT EXISTS revised_at timestamptz,
  -- 'unverified_mapping': the source commodity -> product mapping has not been verified against real rows.
  -- Such rows are excluded from default reads (scope.ts includeUnverified=false).
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'valid'
    CHECK (validation_status IN ('valid', 'unverified_mapping'));
DROP INDEX IF EXISTS market_obs_identity_uq;
CREATE UNIQUE INDEX IF NOT EXISTS market_obs_vintage_uq
  ON market_observations(market_id, product_id, observed_on, source_id, variety_key, grade_key, vintage_seq);
CREATE INDEX IF NOT EXISTS market_obs_identity_idx
  ON market_observations(market_id, product_id, observed_on, source_id, variety_key, grade_key);
-- Backfill: rows stored before this migration from an unverified mapping carried only a flag.
UPDATE market_observations SET validation_status = 'unverified_mapping'
  WHERE flags ? 'commodity_mapping_unverified' AND validation_status = 'valid';
