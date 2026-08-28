import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCommandError, commandFailure } from '../lib/command-response.js';
import { classifyOrchestrationFailure, deriveWorkerState } from '../lib/orchestration-failures.js';

const ERROR = 'PROJECT_GRAPH_READER_UNAVAILABLE';

test('missing project graph reader is setup-required without disabling the worker', () => {
  const semantic = classifyCommandError(ERROR);
  assert.equal(semantic.error_class, 'setup');
  assert.equal(semantic.retryable, false);
  assert.equal(semantic.rejection, false);

  const response = commandFailure('orchestration.horizon_resolve', {
    ok: false,
    error: ERROR,
    message: 'targeted horizon resolution requires an authoritative project graph reader',
    details: { project_ref: 'github:laurajoyhutchins/overcenter' },
  });
  assert.equal(response.body.error_class, 'setup');
  assert.equal(response.body.failure_state, 'RUNTIME_SETUP_REQUIRED');
  assert.equal(response.body.recommended_action, 'restore_runtime_capability');
  assert.equal(response.body.automatic_recovery_allowed, false);
  assert.equal(response.body.escalation_required, true);
  assert.equal(response.body.recovery_operation, null);

  const recovery = classifyOrchestrationFailure({
    command: 'orchestration.horizon_resolve',
    error_code: ERROR,
    details: { project_ref: 'github:laurajoyhutchins/overcenter' },
  });
  assert.equal(recovery.failure_state, 'RUNTIME_SETUP_REQUIRED');
  assert.equal(deriveWorkerState(recovery), 'degraded');
});