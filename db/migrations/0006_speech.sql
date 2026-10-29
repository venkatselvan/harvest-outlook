-- 0006: short-lived approved-answer hashes that gate text-to-speech. Additive only.
-- Only a sha256 of the approved answer text is stored, never the text itself.
CREATE TABLE speech_approved_texts (
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, hash)
);
CREATE INDEX speech_approved_texts_created_idx ON speech_approved_texts(created_at);
