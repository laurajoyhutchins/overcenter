import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryReasoningDecision } from '../lib/recovery-reasoning-boundary.js';

test('known-safe unresolved fault remains inside deterministic recovery', () => {
  const decision = recoveryReasoningDecision({
    runId:'run-safe',
    recoveryFailureCount:1,
    classification:{
      command:'work.heartbeat',
      error_code:'LEASE_EXPIRED',
      failure_state:'recoverable',
      automatic_recovery_allowed:true,
      escalation_required:false,
      recovery_operation:'orchestration.resume_packet',
      may_have_mutated:false,
      details:{ request_sha256:'safe-request' },
    },
  });
  assert.equal(decision.triggered, false);
  assert.equal(decision.route, 'automatic_recovery');
  assert.equal(decision.cause, 'deterministic_recovery_permitted');
  assert.equal(decision.reasoning_packet, null);
  assert.deepEqual(decision.retry_lineage, { attempt:1, request_sha256:'safe-request' });
});

test('ambiguous unresolved fault crosses one self-contained reasoning boundary', () => {
  const decision = recoveryReasoningDecision({
    runId:'run-ambiguous',
    recoveryFailureCount:2,
    operation:{ operation_id:'op-7', request_sha256:'request-7', authority_revision:'abc123' },
    classification:{
      command:'production.reconcile',
      error_code:'MUTATION_STATE_INDETERMINATE',
      failure_state:'indeterminate',
      automatic_recovery_allowed:false,
      escalation_required:true,
      escalation_reason:'mutation certainty requires semantic judgment',
      may_have_mutated:true,
    },
  });
  assert.equal(decision.triggered, true);
  assert.equal(decision.route, 'reasoning_boundary');
  assert.equal(decision.reasoning_packet.execution_id, 'run-ambiguous');
  assert.equal(decision.reasoning_packet.fault_ref, 'op-7');
  assert.equal(decision.reasoning_packet.authority_revision, 'abc123');
  assert.deepEqual(decision.reasoning_packet.retry_lineage, { attempt:2, request_sha256:'request-7' });
  assert.equal(decision.reasoning_packet.advisory_only, true);
  assert.equal(decision.reasoning_packet.requires_authority_reacquisition, true);
  assert.equal('actions' in decision.reasoning_packet, false);
});

test('absence of an unresolved fault exposes an explicit not-triggered decision', () => {
  const decision = recoveryReasoningDecision({ runId:'run-clean' });
  assert.equal(decision.triggered, false);
  assert.equal(decision.route, 'none');
  assert.equal(decision.cause, 'no_unresolved_fault');
});