CREATE TABLE operation_state (
  operation_id uuid PRIMARY KEY,
  command text NOT NULL,
  idempotency_scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('prepared', 'indeterminate', 'succeeded', 'no_effect', 'rejected')),
  subject_key text REFERENCES execution_state(subject_key),
  run_id text REFERENCES orchestration_runs(run_id),
  lease_epoch bigint CHECK (lease_epoch IS NULL OR lease_epoch >= 0),
  authority_revision text,
  may_have_mutated boolean NOT NULL,
  effect_kind text,
  effect_ref text,
  effect_sha256 text CHECK (effect_sha256 IS NULL OR effect_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 text CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  recovery_payload jsonb,
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (command, idempotency_scope, idempotency_key),
  CHECK (state <> 'indeterminate' OR (resolved_at IS NULL AND may_have_mutated)),
  CHECK (state NOT IN ('succeeded', 'no_effect', 'rejected') OR resolved_at IS NOT NULL),
  CHECK (state IN ('prepared', 'indeterminate') OR recovery_payload IS NULL),
  CHECK (state <> 'succeeded' OR NOT may_have_mutated OR effect_ref IS NOT NULL)
);

CREATE INDEX operation_state_run_idx ON operation_state (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX operation_state_subject_idx ON operation_state (subject_key) WHERE subject_key IS NOT NULL;
CREATE INDEX operation_state_unresolved_idx ON operation_state (state, created_at)
  WHERE state IN ('prepared', 'indeterminate');
