CREATE TABLE IF NOT EXISTS overcenter_authority_freeze (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  frozen boolean NOT NULL DEFAULT false,
  frozen_at timestamptz,
  source_revision text,
  freeze_manifest_sha256 text,
  CHECK ((NOT frozen AND frozen_at IS NULL) OR (frozen AND frozen_at IS NOT NULL))
);

INSERT INTO overcenter_authority_freeze (singleton, frozen)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION overcenter_reject_source_writes_when_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM overcenter_authority_freeze
    WHERE singleton = true
      AND frozen = true
  ) THEN
    RAISE EXCEPTION 'OVERCENTER_SOURCE_FROZEN'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION overcenter_freeze_control_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OVERCENTER_FREEZE_CONTROL_DELETE_FORBIDDEN'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.frozen = true AND NEW.frozen = false THEN
    RAISE EXCEPTION 'OVERCENTER_SOURCE_UNFREEZE_FORBIDDEN'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION overcenter_freeze_control_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'OVERCENTER_FREEZE_CONTROL_TRUNCATE_FORBIDDEN'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS overcenter_freeze_control_guard ON overcenter_authority_freeze;
CREATE TRIGGER overcenter_freeze_control_guard
BEFORE UPDATE OR DELETE ON overcenter_authority_freeze
FOR EACH ROW
EXECUTE FUNCTION overcenter_freeze_control_guard();

DROP TRIGGER IF EXISTS overcenter_freeze_control_truncate_guard ON overcenter_authority_freeze;
CREATE TRIGGER overcenter_freeze_control_truncate_guard
BEFORE TRUNCATE ON overcenter_authority_freeze
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_freeze_control_truncate_guard();

DROP TRIGGER IF EXISTS overcenter_source_freeze_execution_state ON execution_state;
CREATE TRIGGER overcenter_source_freeze_execution_state
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON execution_state
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_github_changeset_receipts ON github_changeset_receipts;
CREATE TRIGGER overcenter_source_freeze_github_changeset_receipts
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON github_changeset_receipts
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_github_production_promotion_receipts ON github_production_promotion_receipts;
CREATE TRIGGER overcenter_source_freeze_github_production_promotion_receipts
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON github_production_promotion_receipts
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_github_release_receipts ON github_release_receipts;
CREATE TRIGGER overcenter_source_freeze_github_release_receipts
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON github_release_receipts
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_github_required_check_observations ON github_required_check_observations;
CREATE TRIGGER overcenter_source_freeze_github_required_check_observations
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON github_required_check_observations
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_operation_state ON operation_state;
CREATE TRIGGER overcenter_source_freeze_operation_state
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON operation_state
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_orchestration_command_invocations ON orchestration_command_invocations;
CREATE TRIGGER overcenter_source_freeze_orchestration_command_invocations
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON orchestration_command_invocations
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_orchestration_horizons ON orchestration_horizons;
CREATE TRIGGER overcenter_source_freeze_orchestration_horizons
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON orchestration_horizons
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_orchestration_invocation_resolutions ON orchestration_invocation_resolutions;
CREATE TRIGGER overcenter_source_freeze_orchestration_invocation_resolutions
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON orchestration_invocation_resolutions
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_orchestration_runs ON orchestration_runs;
CREATE TRIGGER overcenter_source_freeze_orchestration_runs
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON orchestration_runs
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_orchestration_skill_activations ON orchestration_skill_activations;
CREATE TRIGGER overcenter_source_freeze_orchestration_skill_activations
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON orchestration_skill_activations
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_portfolio_reconcile_receipts ON portfolio_reconcile_receipts;
CREATE TRIGGER overcenter_source_freeze_portfolio_reconcile_receipts
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON portfolio_reconcile_receipts
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_portfolio_repository_branch_roles ON portfolio_repository_branch_roles;
CREATE TRIGGER overcenter_source_freeze_portfolio_repository_branch_roles
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON portfolio_repository_branch_roles
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_portfolio_repository_disposition ON portfolio_repository_disposition;
CREATE TRIGGER overcenter_source_freeze_portfolio_repository_disposition
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON portfolio_repository_disposition
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_portfolio_verification_receipts ON portfolio_verification_receipts;
CREATE TRIGGER overcenter_source_freeze_portfolio_verification_receipts
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON portfolio_verification_receipts
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_portfolio_work_identity ON portfolio_work_identity;
CREATE TRIGGER overcenter_source_freeze_portfolio_work_identity
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON portfolio_work_identity
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_proof_state ON proof_state;
CREATE TRIGGER overcenter_source_freeze_proof_state
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON proof_state
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_scheduled_cycle_events ON scheduled_cycle_events;
CREATE TRIGGER overcenter_source_freeze_scheduled_cycle_events
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON scheduled_cycle_events
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_work_lease_checkpoints ON work_lease_checkpoints;
CREATE TRIGGER overcenter_source_freeze_work_lease_checkpoints
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON work_lease_checkpoints
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_work_lease_heartbeats ON work_lease_heartbeats;
CREATE TRIGGER overcenter_source_freeze_work_lease_heartbeats
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON work_lease_heartbeats
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_work_lease_slots ON work_lease_slots;
CREATE TRIGGER overcenter_source_freeze_work_lease_slots
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON work_lease_slots
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_work_leases ON work_leases;
CREATE TRIGGER overcenter_source_freeze_work_leases
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON work_leases
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();

DROP TRIGGER IF EXISTS overcenter_source_freeze_hatchable_migrations ON __hatchable_migrations;
CREATE TRIGGER overcenter_source_freeze_hatchable_migrations
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON __hatchable_migrations
FOR EACH STATEMENT
EXECUTE FUNCTION overcenter_reject_source_writes_when_frozen();