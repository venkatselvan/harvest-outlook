-- Whole-farm summaries have their own explicit scope and writer version; Today field overviews are not reused.
CREATE TABLE farm_summaries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK(mode IN ('live','synthetic','replay')),
 scope text NOT NULL DEFAULT 'farm' CHECK(scope='farm'),
 writer_version text NOT NULL,
 context_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','ready','error')),
 origin text NOT NULL DEFAULT 'deterministic' CHECK(origin IN ('model','deterministic')),
 headline text NOT NULL,
 points jsonb NOT NULL,
 facts jsonb NOT NULL,
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 enqueued_at timestamptz,
 generated_at timestamptz,
 retry_after timestamptz,
 failure text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,farm_id,mode,scope,writer_version,context_hash)
);
CREATE INDEX farm_summaries_owner_enqueues ON farm_summaries(owner_id,mode,enqueued_at DESC) WHERE enqueued_at IS NOT NULL;
CREATE INDEX farm_summaries_farm_enqueues ON farm_summaries(owner_id,farm_id,mode,enqueued_at DESC) WHERE enqueued_at IS NOT NULL;
CREATE TRIGGER farm_summaries_updated BEFORE UPDATE ON farm_summaries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
