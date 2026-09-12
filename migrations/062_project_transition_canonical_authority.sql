BEGIN;

ALTER TABLE execution_state
  ADD COLUMN IF NOT EXISTS authority_derivation text,
  ADD COLUMN IF NOT EXISTS acquire_request_hash text;

COMMIT;
