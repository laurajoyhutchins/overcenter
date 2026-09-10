ALTER TABLE operation_state
  ADD COLUMN attempt_epoch BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT operation_state_attempt_epoch_positive CHECK (attempt_epoch >= 1);
