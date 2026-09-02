CREATE TABLE IF NOT EXISTS proof_state (
  proof_key text PRIMARY KEY,
  subject_key text NOT NULL,
  predicate_kind text NOT NULL,
  authority_repository text NOT NULL,
  authority_revision text NOT NULL,
  evidence_sha256 text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  satisfied_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (jsonb_typeof(evidence_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS proof_state_exact_authority_idx
  ON proof_state (predicate_kind, authority_repository, authority_revision);

CREATE INDEX IF NOT EXISTS proof_state_subject_idx
  ON proof_state (subject_key, satisfied_at DESC);
