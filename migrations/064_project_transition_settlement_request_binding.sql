BEGIN;

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

    IF NEW.subject_kind = 'project_transition'
       AND (
         NEW.settlement_receipt->>'settlement_request_sha256' IS NULL
         OR NEW.settlement_receipt->>'settlement_request_sha256' !~ '^[0-9a-f]{64}$'
       ) THEN
      RAISE EXCEPTION 'SETTLEMENT_RECEIPT_REQUEST_BINDING_MISMATCH'
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

COMMIT;
