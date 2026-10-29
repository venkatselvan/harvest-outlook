-- 0010_journal: journal, observation analysis, confirmations, revisions, task completions (T13). Additive only.
-- Original farmer data is never modified: DB triggers reject updates to original columns and to original facts.

-- ---------------------------------------------------------------- entries
ALTER TABLE journal_entries
  ADD COLUMN mode text NOT NULL DEFAULT 'synthetic' CHECK (mode IN ('live','replay','synthetic')),
  ADD COLUMN observed_at timestamptz,
  ADD COLUMN uploaded_at timestamptz,
  ADD COLUMN activity text,
  ADD COLUMN quantity numeric(14,4),
  ADD COLUMN quantity_unit text,
  ADD COLUMN expense_inr numeric(12,2) CHECK (expense_inr IS NULL OR expense_inr >= 0),
  ADD COLUMN expense_category text,
  ADD COLUMN transcript jsonb,
  ADD COLUMN payload_hash text,
  ADD COLUMN processing_status text NOT NULL DEFAULT 'submitted' CHECK (processing_status IN ('draft','submitted','processing','ready','failed')),
  ADD COLUMN image_quality jsonb;

-- Everything the farmer typed or uploaded is immutable. Only workflow columns may change.
CREATE OR REPLACE FUNCTION journal_entries_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Cascades from a farm/owner deletion run at trigger depth > 1; a direct DELETE is refused.
    IF pg_trigger_depth() > 1 OR current_setting('harvest.allow_journal_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'journal entries are immutable records' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.owner_id, NEW.farm_id, NEW.plan_id, NEW.client_entry_id, NEW.entry_date, NEW.observed_at, NEW.uploaded_at, NEW.text_body, NEW.language,
      NEW.media_ids, NEW.activity, NEW.quantity, NEW.quantity_unit, NEW.expense_inr, NEW.expense_category, NEW.transcript, NEW.mode, NEW.payload_hash)
     IS DISTINCT FROM
     (OLD.owner_id, OLD.farm_id, OLD.plan_id, OLD.client_entry_id, OLD.entry_date, OLD.observed_at, OLD.uploaded_at, OLD.text_body, OLD.language,
      OLD.media_ids, OLD.activity, OLD.quantity, OLD.quantity_unit, OLD.expense_inr, OLD.expense_category, OLD.transcript, OLD.mode, OLD.payload_hash) THEN
    RAISE EXCEPTION 'original journal entry data cannot be modified; add a superseding record' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_entries_guard();
CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_entries_guard();

-- ---------------------------------------------------------------- analyses (one Meta image-understanding run)
CREATE TABLE journal_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  job_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','unavailable')),
  error_code text,
  provenance text CHECK (provenance IS NULL OR provenance IN ('meta_live','synthetic_fixture')),
  model text,
  prompt_version text,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  -- Validated, gate-filtered model output (never raw). Narrative is stored with its evidence state.
  result jsonb,
  ai_narrative text,
  narrative_evidence_state text CHECK (narrative_evidence_state IS NULL OR narrative_evidence_state IN ('derived','illustrative')),
  gate_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  quality jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_analyses_owner_idx ON journal_analyses(owner_id);
CREATE INDEX journal_analyses_entry_idx ON journal_analyses(entry_id, created_at);
-- At most one live or completed analysis per entry; failed/unavailable ones can be retried.
CREATE UNIQUE INDEX journal_analyses_active_uq ON journal_analyses(entry_id) WHERE status IN ('queued','running','succeeded');

-- ---------------------------------------------------------------- facts: original / proposed / confirmed
ALTER TABLE journal_facts DROP CONSTRAINT journal_facts_status_check;
ALTER TABLE journal_facts
  ADD COLUMN kind text NOT NULL DEFAULT 'proposed' CHECK (kind IN ('original','proposed','confirmed')),
  ADD COLUMN source text NOT NULL DEFAULT 'ai' CHECK (source IN ('farmer','ai')),
  ADD COLUMN requires_confirmation boolean NOT NULL DEFAULT true,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN supersedes_id uuid REFERENCES journal_facts(id),
  ADD COLUMN analysis_id uuid REFERENCES journal_analyses(id) ON DELETE SET NULL,
  ADD COLUMN unit text,
  ADD COLUMN evidence_state text NOT NULL DEFAULT 'derived' CHECK (evidence_state IN ('farmer_reported','derived','illustrative'));
ALTER TABLE journal_facts ADD CONSTRAINT journal_facts_status_check CHECK (status IN ('proposed','confirmed','rejected','recorded'));
-- An AI-sourced fact can never be an original, and only a farmer-confirmed row may carry the farmer_reported state.
ALTER TABLE journal_facts ADD CONSTRAINT journal_facts_ai_not_original_chk CHECK (NOT (source = 'ai' AND kind = 'original'));
ALTER TABLE journal_facts ADD CONSTRAINT journal_facts_ai_evidence_chk CHECK (source <> 'ai' OR evidence_state <> 'farmer_reported' OR kind = 'confirmed');
-- A proposed fact always requires confirmation; decisions always carry their timestamp.
ALTER TABLE journal_facts ADD CONSTRAINT journal_facts_proposed_confirm_chk CHECK (kind <> 'proposed' OR requires_confirmation);
ALTER TABLE journal_facts ADD CONSTRAINT journal_facts_confirmed_at_chk CHECK (kind <> 'confirmed' OR confirmed_at IS NOT NULL);
ALTER TABLE journal_facts ADD CONSTRAINT journal_facts_status_ts_chk CHECK ((status <> 'confirmed' OR confirmed_at IS NOT NULL) AND (status <> 'rejected' OR rejected_at IS NOT NULL));
ALTER TABLE journal_facts ADD CONSTRAINT journal_facts_original_status_chk CHECK ((kind = 'original') = (status = 'recorded'));
CREATE INDEX journal_facts_analysis_idx ON journal_facts(analysis_id);

CREATE OR REPLACE FUNCTION journal_facts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR current_setting('harvest.allow_journal_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'journal facts are immutable records' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.kind = 'original' THEN
    RAISE EXCEPTION 'original facts cannot be modified; add a superseding fact' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.owner_id, NEW.entry_id, NEW.fact_key, NEW.value, NEW.unit, NEW.kind, NEW.source, NEW.requires_confirmation, NEW.evidence_state, NEW.analysis_id, NEW.supersedes_id, NEW.agent_run_id)
     IS DISTINCT FROM
     (OLD.owner_id, OLD.entry_id, OLD.fact_key, OLD.value, OLD.unit, OLD.kind, OLD.source, OLD.requires_confirmation, OLD.evidence_state, OLD.analysis_id, OLD.supersedes_id, OLD.agent_run_id) THEN
    RAISE EXCEPTION 'fact content cannot be modified; add a superseding fact' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('confirmed','rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a confirmation decision is final' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_facts_no_update BEFORE UPDATE ON journal_facts FOR EACH ROW EXECUTE FUNCTION journal_facts_guard();
CREATE TRIGGER journal_facts_no_delete BEFORE DELETE ON journal_facts FOR EACH ROW EXECUTE FUNCTION journal_facts_guard();

-- ---------------------------------------------------------------- revisions made from confirmed facts
CREATE TABLE journal_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  from_plan_id uuid NOT NULL REFERENCES plans(id),
  to_plan_id uuid NOT NULL REFERENCES plans(id),
  fact_ids uuid[] NOT NULL,
  changes jsonb NOT NULL,
  change_summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_revisions_owner_idx ON journal_revisions(owner_id);
CREATE INDEX journal_revisions_farm_idx ON journal_revisions(farm_id, created_at);

-- ---------------------------------------------------------------- task completions (feeds the plan TaskCompletionSource)
CREATE TABLE journal_task_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  task_id text NOT NULL,
  completed_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, farm_id, task_id)
);
CREATE INDEX journal_task_completions_farm_idx ON journal_task_completions(owner_id, farm_id);
