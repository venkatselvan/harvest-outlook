-- Boundary-assessment feature (public context + Sentinel RGB snapshot + Meta suggestions) retired 2026-11-01 by user decision.
-- Drops only the assessment cache table created in 0016 (image_key added in 0017). ai_invocations and demo_farms from 0016 are still in use.
DROP INDEX IF EXISTS boundary_assessments_cache;
DROP TABLE IF EXISTS boundary_assessments;
