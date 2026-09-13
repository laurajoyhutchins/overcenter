function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stableFaultRef({ runId, classification, operation, execution }) {
  const details = asObject(classification?.details);
  return String(
    operation?.operation_id
    || details.operation_id
    || execution?.lease_ref
    || `${runId}:${classification?.command || 'unknown'}:${classification?.error_code || 'unknown'}`,
  );
}

export function recoveryReasoningDecision({ runId, classification, operation = null, execution = null, recoveryFailureCount = 0 } = {}) {
  if (!classification) {
    return Object.freeze({
      schema:'recovery-reasoning-decision-v1',
      triggered:false,
      route:'none',
      cause:'no_unresolved_fault',
      decision_id:`recovery:${runId}:none`,
      execution_id:runId,
      retry_lineage:Object.freeze({ attempt:Number(recoveryFailureCount || 0), request_sha256:null }),
      reasoning_packet:null,
    });
  }

  const faultRef = stableFaultRef({ runId, classification, operation, execution });
  const attempt = Number(recoveryFailureCount || classification.recovery_attempts || 0);
  const requestSha256 = operation?.request_sha256 || asObject(classification.details).request_sha256 || null;
  const authorityRevision = operation?.authority_revision || execution?.authority_revision || asObject(classification.details).authority_revision || null;
  const escalationRequired = Boolean(classification.escalation_required);
  const automaticRecoveryAllowed = Boolean(classification.automatic_recovery_allowed) && !escalationRequired;
  const route = automaticRecoveryAllowed ? 'automatic_recovery' : (escalationRequired ? 'reasoning_boundary' : 'deterministic_hold');
  const cause = automaticRecoveryAllowed
    ? 'deterministic_recovery_permitted'
    : (escalationRequired ? String(classification.escalation_reason || classification.failure_state || 'semantic_judgment_required') : 'automatic_recovery_not_permitted');
  const decisionId = `recovery:${runId}:${faultRef}:${route}`;
  const lineage = Object.freeze({ attempt, request_sha256:requestSha256 });

  return Object.freeze({
    schema:'recovery-reasoning-decision-v1',
    triggered:route === 'reasoning_boundary',
    route,
    cause,
    decision_id:decisionId,
    execution_id:runId,
    retry_lineage:lineage,
    reasoning_packet:route === 'reasoning_boundary' ? Object.freeze({
      schema:'recovery-reasoning-packet-v1',
      reasoning_boundary_id:decisionId,
      recovery_decision_id:decisionId,
      execution_id:runId,
      fault_ref:faultRef,
      command:classification.command || operation?.command || null,
      error_code:classification.error_code || null,
      failure_state:classification.failure_state || null,
      may_have_mutated:Boolean(classification.may_have_mutated),
      recovery_operation:classification.recovery_operation || null,
      authority_revision:authorityRevision,
      retry_lineage:lineage,
      evidence:Object.freeze([
        Object.freeze({ kind:'typed_failure', error_code:classification.error_code || null, failure_state:classification.failure_state || null }),
        Object.freeze({ kind:'mutation_certainty', may_have_mutated:Boolean(classification.may_have_mutated) }),
      ]),
      advisory_only:true,
      requires_authority_reacquisition:true,
    }) : null,
  });
}