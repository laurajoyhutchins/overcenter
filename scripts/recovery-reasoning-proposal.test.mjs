import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecoveryReasoningProposal } from '../lib/recovery-reasoning-proposal.js';

const packet = Object.freeze({
  schema:'recovery-reasoning-packet-v1',
  reasoning_boundary_id:'recovery:run-1:op-1:reasoning_boundary',
  fault_ref:'op-1',
  authority_revision:'abc123',
  advisory_only:true,
  requires_authority_reacquisition:true,
  invocation_context:Object.freeze({
    run_id:'run-1', origin:'recovery', reasoning_boundary_id:'recovery:run-1:op-1:reasoning_boundary',
    recovery_decision_id:'recovery:run-1:op-1:reasoning_boundary', recovery_attempt_id:'attempt-1', packet_schema:'recovery-reasoning-packet-v1',
  }),
});

function proposal(overrides = {}) {
  return {
    schema:'recovery-reasoning-proposal-v1',
    reasoning_boundary_id:packet.reasoning_boundary_id,
    fault_ref:packet.fault_ref,
    authority_revision:packet.authority_revision,
    disposition:'recover',
    semantic_intent:{ command:'orchestration.reconcile', input:{ run_id:'run-1' } },
    reason:'reconcile the indeterminate operation before any retry',
    ...overrides,
  };
}

test('valid reasoning output remains advisory semantic intent with durable correlation', () => {
  const validated = validateRecoveryReasoningProposal({ packet, proposal:proposal(), current_authority_revision:'abc123' });
  assert.equal(validated.disposition, 'recover');
  assert.equal(validated.verified, false);
  assert.equal(validated.requires_authority_reacquisition, true);
  assert.equal(validated.invocation_context.recovery_decision_id, packet.invocation_context.recovery_decision_id);
});

test('authority movement while reasoning is in flight invalidates the proposal', () => {
  assert.throws(
    () => validateRecoveryReasoningProposal({ packet, proposal:proposal(), current_authority_revision:'def456' }),
    (error) => error.code === 'RECOVERY_PROPOSAL_AUTHORITY_STALE',
  );
});

test('reasoning cannot carry execution authority or claim healing', () => {
  assert.throws(
    () => validateRecoveryReasoningProposal({ packet, proposal:proposal({ semantic_intent:{ command:'orchestration.reconcile', authority_epoch:4 } }), current_authority_revision:'abc123' }),
    (error) => error.code === 'RECOVERY_PROPOSAL_AUTHORITY_FORBIDDEN',
  );
  assert.throws(
    () => validateRecoveryReasoningProposal({ packet, proposal:proposal({ healed:true }), current_authority_revision:'abc123' }),
    (error) => error.code === 'RECOVERY_PROPOSAL_VERIFICATION_FORBIDDEN',
  );
});

test('reasoning returns one semantic intent rather than an executable action list', () => {
  assert.throws(
    () => validateRecoveryReasoningProposal({ packet, proposal:proposal({ actions:[{ command:'project.advance' }] }), current_authority_revision:'abc123' }),
    (error) => error.code === 'RECOVERY_PROPOSAL_ACTIONS_FORBIDDEN',
  );
});
