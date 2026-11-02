-- AI-predicted satellite looks between scenes (FIELDS_MULTICROP_SOIL_SPEC.md section 11.3, 2026-11-03).
-- future_look_assets gains a kind: 'stage' (the existing typical look of a stage) or 'gap' (the predicted look of the field
-- on a date after the latest real Sentinel-2 scene). Both are Muse Image edits of a real scene guided by a code-written
-- sentence (`guidance`, the exact text that went into the prompt, at most 400 characters, never an NDVI number). Prompt
-- versions future-look-v2 and later (v3 is current) write kind, target_date and guidance; rows made before it keep kind 'stage' with a NULL
-- target_date and guidance and stay readable (the worker builds the v1 prompt for a row without guidance).
--
-- target_week buckets gap looks by calendar week (Monday start, ISO). It is NULL for stage looks so their uniqueness stays
-- per stage. The cast to timestamp keeps the generation expression immutable (date_trunc on timestamptz is only stable).
-- The unique key uses NULLS NOT DISTINCT so two stage rows with a NULL target_week still collide (PostgreSQL 15 or later).
-- Budget bound (services/today/future-look.ts, under the per-farm-cycle advisory lock): at most one queued, running or
-- ready gap look per cycle per week; at most 10 rows per farm cycle that are queued, running, ready or billed (was 6);
-- at most 2 automatic gap requests per farm in any 24 hours, counted here by created_at.
ALTER TABLE future_look_assets
  ADD COLUMN kind text NOT NULL DEFAULT 'stage' CHECK (kind IN ('stage', 'gap')),
  ADD COLUMN target_date date,
  ADD COLUMN guidance text CHECK (guidance IS NULL OR char_length(guidance) BETWEEN 1 AND 400),
  ADD COLUMN target_week date GENERATED ALWAYS AS (CASE WHEN kind = 'gap' THEN date_trunc('week', target_date::timestamp)::date END) STORED,
  ADD CONSTRAINT future_look_assets_gap_target CHECK (kind <> 'gap' OR target_date IS NOT NULL);

-- Replace the v1 unique key (farm_id, cycle_id, stage_id, source_item_id, prompt_version), whatever its generated name.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = 'future_look_assets'::regclass AND con.contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE future_look_assets DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE future_look_assets
  ADD CONSTRAINT future_look_assets_tuple_key UNIQUE NULLS NOT DISTINCT (farm_id, cycle_id, kind, stage_id, target_week, source_item_id, prompt_version);
-- The automatic-request count (gap rows of a farm created in the last 24 hours) and the weekly lookup.
CREATE INDEX future_look_assets_gap_recent ON future_look_assets (farm_id, created_at) WHERE kind = 'gap';
