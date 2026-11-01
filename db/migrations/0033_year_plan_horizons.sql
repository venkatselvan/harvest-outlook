-- Round 3 (ROUND3_SPEC.md section 1, 2026-11-01): multi-year plans. A year-plan review covers one 12-month horizon:
-- horizon_from is NULL for the current horizon (and for every row written before this round, which are current-horizon
-- reviews) and the start date of a later horizon (years 1 to 3) otherwise. Every read, archive and apply path filters by
-- the resolved horizon with IS NOT DISTINCT FROM. The context hash already differs per horizon, so the unique index on
-- (farm_id, mode, context_hash) is unchanged.
ALTER TABLE farm_year_plans ADD COLUMN horizon_from date;
CREATE INDEX farm_year_plans_horizon ON farm_year_plans (owner_id, farm_id, mode, horizon_from, created_at DESC) WHERE archived_at IS NULL;
