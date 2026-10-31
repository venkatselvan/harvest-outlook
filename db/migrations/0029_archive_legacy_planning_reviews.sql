-- Retire the legacy planning review (2026-11-01): the year plan (farm_year_plans, 0028) is the live planning path.
-- Every legacy row is archived so no reader shows it; nothing is dropped (rows stay for audit and spend records).
UPDATE farm_planning_reviews SET archived_at = now() WHERE archived_at IS NULL;
