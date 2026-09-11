BEGIN;

ALTER TABLE execution_state
  ADD COLUMN IF NOT EXISTS execution_id text,
  ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'prepared',
  ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_attempt_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS operation_id uuid,
  ADD COLUMN IF NOT EXISTS settled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS settlement_receipt jsonb,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS mutation_certainty text NOT NULL DEFAULT 'definitely_not_mutATED',
  ADD COLUMN IF NOT EXISTS effect_ref text,
  ADD COLUMN IF NOT EXISTS operation_kind text,
  ADD COLUMN IF NOT EXISTS idempotency_scope text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS intent_sha256 text;

ALTER TABLE operation_state
  ADD COLUMN IF NOT EXISTS execution_id text,
  ADD COLUMN IF NOT EXISTS attempt_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mutation_certainty text NOT NULL DEFAULT 'definitely_not_mutated',
  ADD COLUMN IF NOT EXISTS authority_epoch bigint,
  ADD COLUMN IF NOT EXISTS response_facts jsonb,
  ADD COLUMN IF NOT EXISTS confirmation_predicate text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

ALTER TABLE proof_state
  ADD COLUMN IF NOT EXISTS execution_id text,
  ADD COLUMN IF NOT EXISTS operation_id uuid,
  ADD COLUMN IF NOT EXISTS attempt_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS authority_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO execution_state (
  subject_key,
  subject_kind,
  execution_id,
  lifecycle,
  lease_epoch,
  current_attempt_epoch
)
SELECT
  'legacy-operation:' || operation_id::text,
  'legacy_work',
  md5('execution:legacy-operation:' || operation_id::text),
  'prepared',
  0,
  0
FROM operation_state
WHERE subject_key IS NULL
ON CONFLICT (subject_key) DO NOTHING;

INSERT INTO execution_state (
  subject_key,
  subject_kind,
  execution_id,
  lifecycle,
  lease_epoch,
  current_attempt_epoch
)
SELECT DISTINCT
  proof.subject_key,
  'legacy_work',
  md5('execution:' || proof.subject_key),
  'prepared',
  0,
  0
FROM proof_state AS proof
LEFT JOIN execution_state AS execution
  ON execution.subject_key = proof.subject_key
WHERE execution.subject_key IS NULL
ON CONFLICT (subject_key) DO NOTHING;

UPDATE operation_state
SET subject_key = 'legacy-operation:' || operation_id::text
WHERE subject_key IS NULL;

UPDATE execution_state
SET execution_id = md5('execution:' || subject_key)
WHERE execution_id IS NULL;

UPDATE execution_state
SET lifecycle = CASE
  WHEN settled THEN 'settled'
  WHEN lease_ref IS NOT NULL THEN 'executing'
  ELSE 'prepared'
END
WHERE lifecycle = 'prepared';

UPDATE execution_state
SET lease_epoch = authority_epoch
WHERE lease_ref IS NOT NULL
  AND lease_epoch = 0
  AND authority_epoch > 0;

UPDATE execution_state AS execution
SET
  operation_kind = operation.effect_kind,
  idempotency_scope = operation.idempotency_scope,
  idempotency_key = operation.idempotency_key,
  intent_sha256 = operation.request_sha256
FROM operation_state AS operation
WHERE operation.execution_id = execution.execution_id
  AND execution.operation_kind IS NULL;

UPDATE operation_state AS operation
SET
  execution_id = execution.execution_id,
  authority_epoch = execution.authority_epoch
FROM execution_state AS execution
WHERE operation.subject_key = execution.subject_key
  AND operation.execution_id IS NULL;

UPDATE operation_state
SET mutation_certainty = CASE
  WHEN may_have_mutated THEN 'may_have_mutated'
  WHEN state = 'succeeded' AND effect_ref IS NOT NULL THEN 'confirmed_mutated'
  ELSE 'definitely_not_mutated'
END
WHERE mutation_certainty = 'definitely_not_mutated';

UPDATE proof_state AS proof
SET
  execution_id = execution.execution_id,
  authority_epoch = execution.authority_epoch
FROM execution_state AS execution
WHERE proof.subject_key = execution.subject_key
  AND proof.execution_id IS NULL;

UPDATE execution_state AS execution
SET
  mutation_certainty = operation.mutation_certainty,
  effect_ref = operation.effect_ref
FROM operation_state AS operation
WHERE operation.execution_id = execution.execution_id
  AND operation.attempt_epoch = (
    SELECT max(candidate.attempt_epoch)
    FROM operation_state AS candidate
    WHERE candidate.execution_id = execution.execution_id
  );

ALTER TABLE execution_state
  ALTER COLUMN execution_id SET NOT NULL;

ALTER TABLE operation_state
  ALTER COLUMN execution_id SET NOT NULL;

ALTER TABLE proof_state
  ALTER COLUMN execution_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_state_execution_id_key'
  ) THEN
    ALTER TABLE execution_state
      ADD CONSTRAINT execution_state_execution_id_key UNIQUE (execution_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_state_lifecycle_check'
  ) THEN
    ALTER TABLE execution_state
      ADD CONSTRAINT execution_state_lifecycle_check
      CHECK (lifecycle IN (
        'prepared',
        'executing',
        'effect_uncertain',
        'effect_confirmed',
        'effect_absent',
        'settled',
        'rejected',
        'escalated'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_state_lease_epoch_check'
  ) THEN
    ALTER TABLE execution_state
      ADD CONSTRAINT execution_state_lease_epoch_check CHECK (lease_epoch >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_state_attempt_epoch_check'
  ) THEN
    ALTER TABLE execution_state
      ADD CONSTRAINT execution_state_attempt_epoch_check CHECK (current_attempt_epoch >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_state_mutation_certainty_check'
  ) THEN
    ALTER TABLE execution_state
      ADD CONSTRAINT execution_state_mutation_certainty_check
      CHECK (mutation_certainty IN (
        'definitely_not_mutated',
        'may_have_mutated',
        'confirmed_mutated'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_state_settled_lifecycle_check'
  ) THEN
    ALTER TABLE execution_state
      ADD CONSTRAINT execution_state_settled_lifecycle_check
      CHECK (settled = (lifecycle = 'settled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_state_mutation_certainty_check'
  ) THEN
    ALTER TABLE operation_state
      ADD CONSTRAINT operation_state_mutation_certainty_check
      CHECK (mutation_certainty IN (
        'definitely_not_mutated',
        'may_have_mutated',
        'confirmed_mutated'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_state_attempt_epoch_check'
  ) THEN
    ALTER TABLE operation_state
      ADD CONSTRAINT operation_state_attempt_epoch_check CHECK (attempt_epoch >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operation_state_execution_id_fkey'
  ) THEN
    ALTER TABLE operation_state
      ADD CONSTRAINT operation_state_execution_id_fkey
      FOREIGN KEY (execution_id) REFERENCES execution_state (execution_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proof_state_execution_id_fkey'
  ) THEN
    ALTER TABLE proof_state
      ADD CONSTRAINT proof_state_execution_id_fkey
      FOREIGN KEY (execution_id) REFERENCES execution_state (execution_id)
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE operation_state
  VALIDATE CONSTRAINT operation_state_execution_id_fkey;

ALTER TABLE proof_state
  VALIDATE CONSTRAINT proof_state_execution_id_fkey;

CREATE INDEX IF NOT EXISTS execution_state_active_lifecycle_idx
  ON execution_state (lifecycle, updated_at);

CREATE INDEX IF NOT EXISTS operation_state_execution_id_idx
  ON operation_state (execution_id, attempt_epoch);

CREATE UNIQUE INDEX IF NOT EXISTS proof_state_execution_identity_uidx
  ON proof_state (execution_id, operation_id, predicate_kind, authority_revision, evidence_sha256);

CREATE OR REPLACE FUNCTION overcenter_operation_certainty_rank(value text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE value
    WHEN 'definitely_not_mutated' THEN 0
    WHEN 'may_have_mutated' THEN 1
    WHEN 'confirmed_mutated' THEN 2
    ELSE -1
  END
$$;

CREATE OR REPLACE FUNCTION overcenter_enforce_operation_certainty()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF overcenter_operation_certainty_rank(NEW.mutation_certainty)
     < overcenter_operation_certainty_rank(OLD.mutation_certainty) THEN
    RAISE EXCEPTION 'OPERATION_MUTATION_CERTAINTY_REGRESSION'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state IN ('no_effect', 'rejected')
     AND NEW.mutation_certainty <> 'definitely_not_mutated' THEN
    RAISE EXCEPTION 'OPERATION_UNCERTAIN_TERMINAL_STATE'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'succeeded'
     AND NEW.mutation_certainty = 'confirmed_mutated'
     AND NEW.effect_ref IS NULL THEN
    RAISE EXCEPTION 'OPERATION_CONFIRMED_EFFECT_MISSING_REFERENCE'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS overcenter_operation_certainty_guard ON operation_state;
CREATE TRIGGER overcenter_operation_certainty_guard
BEFORE UPDATE ON operation_state
FOR EACH ROW
EXECUTE FUNCTION overcenter_enforce_operation_certainty();

CREATE OR REPLACE FUNCTION overcenter_validate_proof_execution_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution execution_state%ROWTYPE;
  operation operation_state%ROWTYPE;
BEGIN
  SELECT * INTO execution
  FROM execution_state
  WHERE execution_id = NEW.execution_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROOF_EXECUTION_NOT_FOUND'
      USING ERRCODE = '23503';
  END IF;

  IF execution.authority_repository IS NOT NULL
     AND NEW.authority_repository <> execution.authority_repository THEN
    RAISE EXCEPTION 'PROOF_AUTHORITY_REPOSITORY_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  IF execution.authority_revision IS NOT NULL
     AND NEW.authority_revision <> execution.authority_revision THEN
    RAISE EXCEPTION 'PROOF_AUTHORITY_REVISION_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.authority_epoch <> execution.authority_epoch THEN
    RAISE EXCEPTION 'PROOF_AUTHORITY_EPOCH_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.operation_id IS NOT NULL THEN
    SELECT * INTO operation
    FROM operation_state
    WHERE operation_id = NEW.operation_id;
    IF NOT FOUND OR operation.execution_id <> NEW.execution_id THEN
      RAISE EXCEPTION 'PROOF_OPERATION_EXECUTION_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS overcenter_proof_execution_identity_guard ON proof_state;
CREATE TRIGGER overcenter_proof_execution_identity_guard
BEFORE INSERT OR UPDATE ON proof_state
FOR EACH ROW
EXECUTE FUNCTION overcenter_validate_proof_execution_identity();

COMMIT;
