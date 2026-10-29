-- 0011_review_fixes: independent review R1 fixes (F2). Additive; requires PostgreSQL >= 15 (NULLS NOT DISTINCT).

-- H2: link idempotency rows to the resources whose response they store so deletion can purge them.
ALTER TABLE idempotency_keys
  ADD COLUMN farm_id uuid,
  ADD COLUMN media_id uuid;
CREATE INDEX idempotency_keys_farm_idx ON idempotency_keys(farm_id) WHERE farm_id IS NOT NULL;
CREATE INDEX idempotency_keys_media_idx ON idempotency_keys(media_id) WHERE media_id IS NOT NULL;

-- M4: overrun accounting and per-IP-day cap (salted hash only, never a raw IP).
ALTER TABLE usage_reservations ADD COLUMN overrun_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (overrun_usd >= 0);
ALTER TABLE usage_ledger ADD COLUMN overrun_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (overrun_usd >= 0);
ALTER TABLE sessions ADD COLUMN ip_hash text;
CREATE INDEX sessions_ip_hash_idx ON sessions(ip_hash) WHERE ip_hash IS NOT NULL;

-- M5: NULL owners (system jobs) must still dedupe on idempotency_key.
DROP INDEX jobs_owner_idempotency_uq;
CREATE UNIQUE INDEX jobs_owner_idempotency_uq ON jobs(owner_id, idempotency_key) NULLS NOT DISTINCT WHERE idempotency_key IS NOT NULL;

-- L4: agent runs can be tied to the farm they were about, so farm deletion removes them (and their tool_results).
ALTER TABLE agent_runs ADD COLUMN farm_id uuid;
CREATE INDEX agent_runs_farm_idx ON agent_runs(farm_id) WHERE farm_id IS NOT NULL;
