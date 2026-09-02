ALTER TABLE operation_state
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE operation_state
   SET updated_at = COALESCE(resolved_at, created_at)
 WHERE updated_at IS NULL;

ALTER TABLE operation_state
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS operation_state_unresolved_updated_idx
  ON operation_state (command, idempotency_scope, updated_at)
  WHERE state IN ('prepared', 'indeterminate');
