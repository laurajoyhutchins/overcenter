ALTER TABLE orchestration_command_invocations
  ADD COLUMN IF NOT EXISTS execution_origin text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS reasoning_boundary_id text,
  ADD COLUMN IF NOT EXISTS recovery_decision_id text,
  ADD COLUMN IF NOT EXISTS recovery_attempt_id text,
  ADD COLUMN IF NOT EXISTS packet_schema text;

ALTER TABLE orchestration_command_invocations
  DROP CONSTRAINT IF EXISTS orchestration_command_invocations_execution_origin_check;

ALTER TABLE orchestration_command_invocations
  ADD CONSTRAINT orchestration_command_invocations_execution_origin_check CHECK (
    execution_origin IN ('system','scheduler','agent','operator','recovery','unknown')
  );

CREATE INDEX IF NOT EXISTS orchestration_command_invocations_reasoning_boundary_idx
  ON orchestration_command_invocations (reasoning_boundary_id, started_at)
  WHERE reasoning_boundary_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS orchestration_command_invocations_recovery_decision_idx
  ON orchestration_command_invocations (recovery_decision_id, recovery_attempt_id, started_at)
  WHERE recovery_decision_id IS NOT NULL;