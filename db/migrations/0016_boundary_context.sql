CREATE TABLE boundary_assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK(mode IN('live','replay','synthetic')),
 input_hash text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boundary_assessments_cache ON boundary_assessments(owner_id,mode,input_hash,created_at DESC);
CREATE TABLE ai_invocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
 session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 provider text NOT NULL CHECK(provider='meta'),
 requested_model text NOT NULL,model text,purpose text NOT NULL,
 status text NOT NULL CHECK(status IN('running','succeeded','failed')),
 started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 processing text NOT NULL DEFAULT 'standard' CHECK(processing='standard')
);
CREATE INDEX ai_invocations_active ON ai_invocations(owner_id,started_at DESC) WHERE status='running';
CREATE TABLE demo_farms (
 owner_id uuid PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
 farm_id uuid NOT NULL UNIQUE REFERENCES farms(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
