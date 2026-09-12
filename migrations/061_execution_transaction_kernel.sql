BEGIN;

-- Generic execution ownership is fenced by explicit run identity, not by a
-- foreign key into the orchestration projection.
ALTER TABLE execution_state DROP CONSTRAINT IF EXISTS execution_state_run_id_fkey;
ALTER TABLE operation_state DROP CONSTRAINT IF EXISTS operation_state_run_id_fkey;

-- The execution kernel also owns provider-scoped effects.
ALTER TABLE execution_state DROP CONSTRAINT IF EXISTS execution_state_subject_kind_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_state_subject_kind_kernel_check'
  ) THEN
    ALTER TABLE execution_state
      ADD CONSTRAINT execution_state_subject_kind_kernel_check
      CHECK (subject_kind IN ('project_transition', 'legacy_work', 'provider_operation'));
  END IF;
END
$$;

-- Provider-specific receipt ledgers are superseded by operation_state,
-- proof_state, and execution_state settlement receipts.
DROP TABLE IF EXISTS github_changeset_receipts CASCADE;
DROP TABLE IF EXISTS github_release_receipts CASCADE;
DROP TABLE IF EXISTS github_production_promotion_receipts CASCADE;
DROP TABLE IF EXISTS portfolio_reconcile_receipts CASCADE;

ALTER TABLE operation_state
  ADD CONSTRAINT operation_state_request_sha256_kernel_check
  CHECK (request_sha256 ~ '^[0-9a-f]{64}$')
  NOT VALID;

ALTER TABLE proof_state
  ADD CONSTRAINT proof_state_evidence_sha256_kernel_check
  CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$')
  NOT VALID;

CREATE OR REPLACE FUNCTION overcenter_validate_proof_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF jsonb_typeof(NEW.evidence) <> 'object'
     OR NEW.evidence->>'schema' <> 'execution-proof-evidence-v1'
     OR NEW.evidence->>'execution_id' <> NEW.execution_id
     OR NEW.evidence->>'operation_id' <> NEW.operation_id::text
     OR NEW.evidence->>'attempt_epoch' <> NEW.attempt_epoch::text
     OR NEW.evidence->'authority'->>'repository' <> NEW.authority_repository
     OR NEW.evidence->'authority'->>'revision' <> NEW.authority_revision
     OR NEW.evidence->'authority'->>'epoch' <> NEW.authority_epoch::text
     OR NEW.evidence->>'predicate' <> NEW.predicate_kind THEN
    RAISE EXCEPTION 'PROOF_EVIDENCE_IDENTITY_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS overcenter_proof_evidence_binding_guard ON proof_state;
CREATE TRIGGER overcenter_proof_evidence_binding_guard
BEFORE INSERT OR UPDATE ON proof_state
FOR EACH ROW
EXECUTE FUNCTION overcenter_validate_proof_evidence_binding();

CREATE OR REPLACE FUNCTION overcenter_validate_settlement_receipt_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lifecycle = 'settled' THEN
    IF NEW.settlement_receipt IS NULL
       OR NEW.settlement_receipt->>'schema' <> 'settlement-receipt-v1'
       OR NEW.settlement_receipt->>'execution_id' <> NEW.execution_id
       OR NEW.settlement_receipt->>'operation_id' <> NEW.operation_id::text
       OR NEW.settlement_receipt->>'authority_revision' <> NEW.authority_revision
       OR NEW.settlement_receipt->>'authority_epoch' <> NEW.authority_epoch::text
       OR NEW.settlement_receipt->>'lifecycle' <> 'settled' THEN
      RAISE EXCEPTION 'SETTLEMENT_RECEIPT_IDENTITY_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS overcenter_settlement_receipt_binding_guard ON execution_state;
CREATE TRIGGER overcenter_settlement_receipt_binding_guard
BEFORE INSERT OR UPDATE ON execution_state
FOR EACH ROW
EXECUTE FUNCTION overcenter_validate_settlement_receipt_binding();

CREATE OR REPLACE FUNCTION overcenter_enforce_operation_certainty()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND overcenter_operation_certainty_rank(NEW.mutation_certainty)
       < overcenter_operation_certainty_rank(OLD.mutation_certainty) THEN
    RAISE EXCEPTION 'OPERATION_MUTATION_CERTAINTY_REGRESSION'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state IN ('no_effect', 'rejected')
     AND NEW.mutation_certainty <> 'definitely_not_mutATED' THEN
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
BEFORE INSERT OR UPDATE ON operation_state
FOR EACH ROW
EXECUTE FUNCTION overcenter_enforce_operation_certainty();

COMMIT;
