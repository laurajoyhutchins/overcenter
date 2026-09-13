ALTER TABLE orchestration_command_invocations
  ADD COLUMN IF NOT EXISTS origin_class text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS failure_invocation_id uuid,
  ADD COLUMN IF NOT EXISTS recovery_decision text,
  ADD COLUMN IF NOT EXISTS packet_schema text,
  ADD COLUMN IF NOT EXISTS reasoning_boundary boolean NOT NULL DEFAULT false;

ALTER TABLE orchestration_command_invocations
  DROP CONSTRAINT IF EXISTS orchestration_command_invocations_origin_class_check;

ALTER TABLE orchestration_command_invocations
  ADD CONSTRAINT orchestration_command_invocations_origin_class_check CHECK (
    origin_class IN ('system','scheduler','agent','operator','recovery','unknown')
  );

ALTER TABLE orchestration_command_invocations
  DROP CONSTRAINT IF EXISTS orchestration_command_invocations_recovery_correlation_check;

ALTER TABLE orchestration_command_invocations
  ADD CONSTRAINT orchestration_command_invocations_recovery_correlation_check CHECK (
    (failure_invocation_id IS NULL AND recovery_decision IS NULL)
    OR (failure_invocation_id IS NOT NULL AND recovery_decision IS NOT NULL)
  );

ALTER TABLE orchestration_command_invocations
  DROP CONSTRAINT IF EXISTS orchestration_command_invocations_failure_invocation_fk;

ALTER TABLE orchestration_command_invocations
  ADD CONSTRAINT orchestration_command_invocations_failure_invocation_fk
  FOREIGN KEY (failure_invocation_id)
  REFERENCES orchestration_command_invocations(invocation_id);