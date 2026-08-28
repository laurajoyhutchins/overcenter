export const ORCHESTRATION_FAILURE_STATES = Object.freeze([
  'CLAIM_STATE_INVALID',
  'ACTIVE_LEASE_REMAINS',
  'HEARTBEAT_BUDGET_EXHAUSTED',
  'STALE_LEASE',
  'TRANSPORT_UNAVAILABLE',
  'RUNTIME_SETUP_REQUIRED',
  'WORKER_DISABLED',
  'RECOVERY_FAILED',
  'AUTHORITY_CONFLICT',
  'POLICY_REJECTION',
  'INDETERMINATE_EXTERNAL_EFFECT',
  'UNKNOWN',
]);

export const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 3;

const CLAIM_STATE_CODES = new Set([
  'STATE_MISMATCH',
  'LANE_MISMATCH',
  'WORK_STATE_CHANGED',
  'HORIZON_PRECONDITION_CHANGED',
]);
const STALE_LEASE_CODES = new Set([
  'LEASE_EXPIRED',
  'STALE_LEASE',
  'ORPHANED_LEASE',
]);
const TRANSPORT_CODES = new Set([
  'TRANSPORT_UNAVAILABLE',
  'GITHUB_TRANSPORT_UNAVAILABLE',
  'HATCHABLE_MCP_TRANSPORT_ERROR',
  'HATCHABLE_MCP_HTTP_ERROR',
]);
const RUNTIME_SETUP_CODES = new Set([
  'PROJECT_GRAPH_READER_UNAVAILABLE',
]);
const DISABLED_CODES = new Set([
  'WORKER_DISABLED',
  'GITHUB_APP_SETUP_REQUIRED',
  'LINEAR_SETUP_REQUIRED',
  'GOOGLE_DRIVE_SETUP_REQUIRED',
  'LINEAR_CONFIGURATION_ERROR',
  'INVALID_GITHUB_APP_ID',
  'INVALID_GITHUB_APP_PRIVATE_KEY',
]);
const AUTHORITY_CONFLICT_CODES = new Set([
  'PORTFOLIO_RECONCILE_RECOVERY_CONFLICT',
  'GITHUB_PROTECTION_CONFLICT',
  'GITHUB_STACK_CONFLICT',
  'GITHUB_DEFAULT_BRANCH_CONFLICT',
]);
const POLICY_REJECTION_CODES = new Set([
  'PUBLIC_METADATA_POLICY_VIOLATION',
]);

function recovery(command, input = null, extra = {}) {
  return {
    command,
    ...(input ? { input } : {}),
    ...extra,
  };
}

function base(failureState, automatic, operation, escalation = false, escalationReason = null, workerState = null) {
  return {
    failure_state: failureState,
    automatic_recovery_allowed: Boolean(automatic),
    recovery_operation: operation || null,
    escalation_required: Boolean(escalation),
    escalation_reason: escalationReason || null,
    ...(workerState ? { worker_state: workerState } : {}),
  };
}

export function classifyOrchestrationFailure(input = {}) {
  const command = String(input.command || '');
  const code = String(input.error_code || input.error || 'UNKNOWN');
  const details = input.details && typeof input.details === 'object' && !Array.isArray(input.details) ? input.details : {};
  const mayHaveMutated = Boolean(input.may_have_mutated);
  const recoveryAttempts = Math.max(0, Number(input.recovery_attempts || 0));

  let result;

  if (code === 'RECOVERY_FAILED') {
    result = base('RECOVERY_FAILED', false, null, true, 'automatic_recovery_failed_or_invariant_did_not_converge');
  } else if (mayHaveMutated) {
    result = base(
      'INDETERMINATE_EXTERNAL_EFFECT',
      false,
      recovery('orchestration.diagnose', null, { mode: 'reconcile_authoritative_effect' }),
      true,
      'potential_external_mutation_requires_authoritative_reconciliation',
    );
  } else if (command === 'work.claim' && CLAIM_STATE_CODES.has(code)) {
    const revision = details.actual_revision || details.authoritative_revision || null;
    result = base(
      'CLAIM_STATE_INVALID',
      true,
      recovery('work.claim', {
        ...(details.work_ref ? { work_ref: details.work_ref } : {}),
        ...(revision ? { observed_revision: revision } : {}),
      }, {
        use_original_request: true,
        ...(revision ? {} : { requires: ['observed_revision'] }),
      }),
    );
  } else if (code === 'RUN_HAS_ACTIVE_LEASE') {
    result = base(
      'ACTIVE_LEASE_REMAINS',
      true,
      recovery('orchestration.finish', null, {
        mode: 'settlement_aware_retry',
        use_original_request: true,
        requires: ['active_lease_settlement.disposition'],
      }),
    );
  } else if (command === 'work.heartbeat' && (code === 'HEARTBEAT_LIMIT_REACHED' || code === 'RUN_BUDGET_EXHAUSTED')) {
    const leaseRef = details.lease_ref || null;
    const checkpointDurable = details.checkpoint_already_durable === true;
    result = base(
      'HEARTBEAT_BUDGET_EXHAUSTED',
      checkpointDurable && Boolean(leaseRef),
      recovery('work.settle', {
        ...(leaseRef ? { lease_ref: leaseRef } : {}),
        disposition: 'requeue',
        requeue_class: 'resume_progress',
      }, checkpointDurable && leaseRef ? {} : { requires: ['lease_ref', 'durable_checkpoint'] }),
      !(checkpointDurable && leaseRef),
      checkpointDurable && leaseRef ? null : 'heartbeat_exhaustion_missing_safe_settlement_evidence',
    );
  } else if (STALE_LEASE_CODES.has(code)) {
    result = base(
      'STALE_LEASE',
      true,
      recovery('orchestration.maintain', null, { mode: 'reconcile_expired_lease' }),
    );
  } else if (RUNTIME_SETUP_CODES.has(code)) {
    result = base(
      'RUNTIME_SETUP_REQUIRED',
      false,
      null,
      true,
      'required_runtime_capability_is_not_bound',
      'degraded',
    );
  } else if (DISABLED_CODES.has(code)) {
    result = base(
      'WORKER_DISABLED',
      false,
      null,
      true,
      'persistent_setup_or_configuration_requires_operator_action',
      'disabled',
    );
  } else if (TRANSPORT_CODES.has(code) || (code.endsWith('_TRANSPORT_ERROR') && !mayHaveMutated)) {
    result = base(
      'TRANSPORT_UNAVAILABLE',
      true,
      recovery(command || 'orchestration.diagnose', null, {
        mode: 'bounded_retry_same_request',
        use_original_request: true,
        max_attempts: MAX_AUTOMATIC_RECOVERY_ATTEMPTS,
      }),
      false,
      null,
      'degraded',
    );
  } else if (AUTHORITY_CONFLICT_CODES.has(code)) {
    result = base(
      'AUTHORITY_CONFLICT',
      false,
      null,
      true,
      'conflicting_authority_requires_reasoning_or_operator_resolution',
    );
  } else if (POLICY_REJECTION_CODES.has(code)) {
    result = base('POLICY_REJECTION', false, null, false, null);
  } else {
    result = base('UNKNOWN', false, null, true, 'unknown_or_unencoded_failure_class');
  }

  if (result.automatic_recovery_allowed && recoveryAttempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
    return base(
      'RECOVERY_FAILED',
      false,
      null,
      true,
      'automatic_recovery_budget_exhausted',
      result.worker_state || null,
    );
  }
  return result;
}

export function deriveWorkerState(classification = null) {
  if (!classification) return 'enabled';
  if (classification.failure_state === 'TRANSPORT_UNAVAILABLE') return 'degraded';
  if (classification.failure_state === 'RUNTIME_SETUP_REQUIRED') return 'degraded';
  if (classification.failure_state === 'WORKER_DISABLED') return 'disabled';
  if (classification.failure_state === 'RECOVERY_FAILED' && classification.worker_state === 'degraded') return 'degraded';
  return 'enabled';
}