-- Keep old check history; new checks are tied to condition events rather than an interval.
ALTER TABLE field_check_completions DROP CONSTRAINT field_check_completions_check_kind_check;
ALTER TABLE field_check_completions ADD CONSTRAINT field_check_completions_check_kind_check CHECK (check_kind IN ('interval', 'recheck', 'condition'));
ALTER TABLE field_check_completions ADD COLUMN check_snapshot jsonb;
ALTER TABLE farm_alerts ADD COLUMN cycle_id text;
