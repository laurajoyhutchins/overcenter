ALTER TABLE operation_state
  ADD COLUMN attempt_epoch bigint NOT NULL DEFAULT 1 CHECK (attempt_epoch > 0);