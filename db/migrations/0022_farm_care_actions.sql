-- Farmer-confirmed crop establishment and care actions. GET schedules never create events.
CREATE TABLE farm_cycle_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
 cycle_id text NOT NULL,
 action_key text NOT NULL,
 client_entry_id text NOT NULL,
 payload_hash text NOT NULL,
 journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
 completed_on date NOT NULL,
 mode text NOT NULL CHECK(mode IN ('live','replay','synthetic')),
 source_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,client_entry_id),
 UNIQUE(farm_id,cycle_id,action_key,mode)
);
CREATE INDEX farm_cycle_actions_farm_idx ON farm_cycle_actions(owner_id,farm_id,mode);
