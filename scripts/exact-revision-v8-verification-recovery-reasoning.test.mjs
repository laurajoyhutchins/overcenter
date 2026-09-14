import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryReasoningDecision } from '../lib/recovery-reasoning-boundary.js';
import { validateRecoveryReasoningProposal } from '../lib/recovery-reasoning-proposal.js';

test('known-safe unresolved fault remains inside deterministic recovery', () => {
  const decision = recoveryReasoningDecision({ runId:'run-safe', recoveryFailureCount:1, classification:{ command:'work.heartbeat', error_code:'LEASE_EXPIRED', failure_state:'recoverable', automatic_recovery_allowed:true, escalation_required:false, recovery_operation:'orchestration.resume_packet', may_have_mutated:false, details:{ request_sha256:'safe-request' } } });
  assert.equal(decision.triggered, false);
  assert.equal(decision.route, 'automatic_recovery');
  assert.equal(decision.reasoning_packet, null);
  assert.deepEqual(decision.retry_lineage, { attempt:1, request_sha256:'safe-request' });
});

test('ambiguous unresolved fault crosses one self-contained reasoning boundary', () => {
  const decision = recoveryReasoningDecision({ runId:'run-ambiguous', recoveryFailureCount:2, operation:{ operation_id:'op-7', request_sha256:'request-7', authority_revision:'abc123' }, classification:{ command:'production.reconcile', error_code:'MUTATION_STATE_INDETERMINATE', failure_state:'indeterminate', automatic_recovery_allowed:false, escalation_required:true, escalation_reason:'mutation certainty requires semantic judgment', may_have_mutated:true } });
  assert.equal(decision.triggered, true);
  assert.equal(decision.route, 'reasoning_boundary');
  assert.equal(decision.reasoning_packet.fault_ref, 'op-7');
  assert.equal(decision.reasoning_packet.authority_revision, 'abc123');
  assert.equal(decision.reasoning_packet.advisory_only, true);
  assert.equal(decision.reasoning_packet.requires_authority_reacquisition, true);
  assert.equal('actions' in decision.reasoning_packet, false);
});

test('reasoning proposal is advisory, authority-bound, and cannot smuggle execution authority', () => {
  const packet = { schema:'recovery-reasoning-packet-v1', reasoning_boundary_id:'recovery:run-1:op-1:reasoning_boundary', fault_ref:'op-1', authority_revision:'abc123', advisory_only:true, requires_authority_reacquisition:true, invocation_context:{ run_id:'run-1', origin:'recovery', reasoning_boundary_id:'recovery:run-1:op-1:reasoning_boundary', recovery_decision_id:'recovery:run-1:op-1:reasoning_boundary', recovery_attempt_id:'attempt-1', packet_schema:'recovery-reasoning-packet-v1' } };
  const proposal = { schema:'recovery-reasoning-proposal-v1', reasoning_boundary_id:packet.reasoning_boundary_id, fault_ref:packet.fault_ref, authority_revision:packet.authority_revision, disposition:'recover', semantic_intent:{ command:'orchestration.reconcile', input:{ run_id:'run-1' } }, reason:'reconcile first' };
  const validated = validateRecoveryReasoningProposal({ packet, proposal, current_authority_revision:'abc123' });
  assert.equal(validated.verified, false);
  assert.equal(validated.requires_authority_reacquisition, true);
  assert.throws(() => validateRecoveryReasoningProposal({ packet, proposal, current_authority_revision:'def456' }), (error) => error.code === 'RECOVERY_PROPOSAL_AUTHORITY_STALE');
  assert.throws(() => validateRecoveryReasoningProposal({ packet, proposal:{ ...proposal, semantic_intent:{ command:'orchestration.reconcile', authority_epoch:4 } }, current_authority_revision:'abc123' }), (error) => error.code === 'RECOVERY_PROPOSAL_AUTHORITY_FORBIDDEN');
  assert.throws(() => validateRecoveryReasoningProposal({ packet, proposal:{ ...proposal, actions:[{ command:'project.advance' }] }, current_authority_revision:'abc123' }), (error) => error.code === 'RECOVERY_PROPOSAL_ACTIONS_FORBIDDEN');
});
