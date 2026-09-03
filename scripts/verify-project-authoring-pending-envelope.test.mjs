import test from 'node:test';
import assert from 'node:assert/strict';
import { commandFailure } from '../lib/command-response.js';
import { sanitizeWorkerBoundaryError } from '../lib/worker-boundary-errors.js';

const STAGED_SHA = 'f'.repeat(40);

function pendingError() {
  const error = new Error('project authoring candidate is staged and awaiting authoritative GitHub integration');
  error.code = 'PROJECT_AUTHORING_INTEGRATION_PENDING';
  error.may_have_mutated = true;
  error.details = {
    repository: 'laurajoyhutchins/overcenter',
    base: 'dev',
    head: 'chore/project-authoring-amend-test',
    staged_revision: STAGED_SHA,
    integration: {
      ok: true,
      outcome: 'waiting_for_checks',
      pull_request: 999,
      expected_head: STAGED_SHA,
    },
    may_have_mutated: true,
  };
  return error;
}

test('pending project authoring preserves staged coordinates and retry semantics', () => {
  const error = pendingError();
  const sanitized = sanitizeWorkerBoundaryError('project.amend', error, {
    defaultError: 'PROJECT_AMEND_ERROR',
    defaultMessage: 'project.amend failed',
    logger: { error() {} },
  });

  assert.equal(sanitized, error);

  const response = commandFailure('project.amend', sanitized, { flattenDetails: true });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'PROJECT_AUTHORING_INTEGRATION_PENDING');
  assert.equal(response.body.error_class, 'precondition');
  assert.equal(response.body.retryable, true);
  assert.equal(response.body.rejection, true);
  assert.equal(response.body.may_have_mutated, true);
  assert.equal(response.body.recommended_action, 'retry_same_request');
  assert.equal(response.body.failure_state, 'WAITING_EXTERNAL_VERIFICATION');
  assert.equal(response.body.automatic_recovery_allowed, false);
  assert.equal(response.body.escalation_required, false);
  assert.equal(response.body.details.staged_revision, STAGED_SHA);
  assert.equal(response.body.staged_revision, STAGED_SHA);
  assert.equal(response.body.integration.pull_request, 999);
  assert.equal(response.body.integration.expected_head, STAGED_SHA);
  assert.equal(response.body.recovery_operation.command, 'project.amend');
  assert.equal(response.body.recovery_operation.mode, 'retry_same_request_after_external_verification');
  assert.equal(response.body.recovery_operation.use_original_request, true);
});
