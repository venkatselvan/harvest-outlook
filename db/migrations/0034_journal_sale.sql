-- 0034_journal_sale: farmer-reported sale proceeds on a journal entry (beside quantity and expense). Additive only.
-- Like every other piece of farmer content, the sale amount and its note are immutable once saved.
ALTER TABLE journal_entries
  ADD COLUMN sale_inr numeric(12,2) CHECK (sale_inr IS NULL OR sale_inr >= 0),
  ADD COLUMN sale_note text;

-- Replaces the guard from 0010 with the same behaviour plus sale_inr and sale_note in the protected tuple.
CREATE OR REPLACE FUNCTION journal_entries_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Cascades from a farm/owner deletion run at trigger depth > 1; a direct DELETE is refused.
    IF pg_trigger_depth() > 1 OR current_setting('harvest.allow_journal_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'journal entries are immutable records' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.owner_id, NEW.farm_id, NEW.plan_id, NEW.client_entry_id, NEW.entry_date, NEW.observed_at, NEW.uploaded_at, NEW.text_body, NEW.language,
      NEW.media_ids, NEW.activity, NEW.quantity, NEW.quantity_unit, NEW.expense_inr, NEW.expense_category, NEW.sale_inr, NEW.sale_note, NEW.transcript, NEW.mode, NEW.payload_hash)
     IS DISTINCT FROM
     (OLD.owner_id, OLD.farm_id, OLD.plan_id, OLD.client_entry_id, OLD.entry_date, OLD.observed_at, OLD.uploaded_at, OLD.text_body, OLD.language,
      OLD.media_ids, OLD.activity, OLD.quantity, OLD.quantity_unit, OLD.expense_inr, OLD.expense_category, OLD.sale_inr, OLD.sale_note, OLD.transcript, OLD.mode, OLD.payload_hash) THEN
    RAISE EXCEPTION 'original journal entry data cannot be modified; add a superseding record' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
