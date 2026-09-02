CREATE TABLE IF NOT EXISTS operation_state (
  operation_id uuid PRIMARY KEY,
  command text NOT NULL,
  idempotency_scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared', 'indeterminate', 'succeeded', 'no_effect', 'rejected')),
  subject_key text REFERENCES execution_state(subject_key),
  run_id text REFERENCES orchestration_runs(run_id),
  lease_epoch bigint CHECK (lease_epoch IS NULL OR lease_epoch >= 0),
  authority_revision text,
  may_have_mutated boolean NOT NULL,
  effect_kind text,
  effect_ref text,
  effect_sha256 text,
  result_sha256 text,
  recovery_payload jsonb,
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (command, idempotency_scope, idempotency_key),
  CHECK (state <> 'indeterminate' OR resolved_at IS NULL),
  CHECK (state IN ('prepared', 'indeterminate') OR recovery_payload IS NULL),
  CHECK (state <> 'no_effect' OR may_have_mutated = false),
  CHECK (state <> 'rejected' OR may_have_mutated = false),
  CHECK (state <> 'succeeded' OR NOT may_have_mutated OR effect_ref IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS operation_state_unresolved_run_idx
  ON operation_state (run_id, created_at)
  WHERE state IN ('prepared', 'indeterminate');

CREATE INDEX IF NOT EXISTS operation_state_subject_idx
  ON operation_state (subject_key, created_at)
  WHERE subject_key IS NOT NULL;
