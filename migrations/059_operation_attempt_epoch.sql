ALTER TABLE operation_state
  ADD COLUMN IF NOT EXISTS attempt_epoch bigint NOT NULL DEFAULT 1;

ALTER TABLE operation_state
  DROP CONSTRAINT IF EXISTS operation_state_attempt_epoch_check;

ALTER TABLE operation_state
  ADD CONSTRAINT operation_state_attempt_epoch_check CHECK (attempt_epoch >= 1);