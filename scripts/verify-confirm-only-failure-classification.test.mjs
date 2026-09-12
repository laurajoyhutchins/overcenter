import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOrchestrationFailure } from '../lib/orchestration-failures.js';

test('mutation-uncertain project authoring is confirm-only and escalated', () => {
  const result = classifyOrchestrationFailure({
    command:'project.amend',
    error_code:'PROJECT_AUTHORING_INTEGRATION_PENDING',
    error_class:'precondition',
    may_have_mutated:true,
    details:{ staged_revision:'a'.repeat(40) },
  });
  assert.equal(result.failure_state, 'INDETERMINATE_EXTERNAL_EFFECT');
  assert.equal(result.automatic_recovery_allowed, false);
  assert.equal(result.escalation_required, true);
  assert.equal(result.recovery_operation.command, 'orchestration.diagnose');
  assert.equal(result.recovery_operation.mode, 'reconcile_authoritative_effect');
});

test('non-mutating source verification wait remains a wait', () => {
  const result = classifyOrchestrationFailure({
    command:'production.reconcile',
    error_code:'PRODUCTION_RECONCILIATION_SOURCE_NOT_VERIFIED',
    error_class:'precondition',
    may_have_mutated:false,
  });
  assert.equal(result.failure_state, 'WAITING_EXTERNAL_VERIFICATION');
  assert.equal(result.automatic_recovery_allowed, false);
  assert.equal(result.escalation_required, false);
});
