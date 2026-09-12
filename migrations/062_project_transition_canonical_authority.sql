BEGIN;

ALTER TABLE execution_state
  ADD COLUMN IF NOT EXISTS authority_derivation text;

COMMIT;
