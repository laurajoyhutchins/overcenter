import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';

// Production Hatchable modules use the runtime's `lib/...` module namespace.
// Reproduce that namespace for this portable Node regression instead of
// rewriting production imports just for the test harness.
await symlink('../lib', new URL('../node_modules/lib', import.meta.url), 'dir').catch((error) => {
  if (error?.code !== 'EEXIST') throw error;
});

const { commandFailure } = await import('../lib/command-response.js');
const { sanitizeWorkerBoundaryError } = await import('../lib/worker-boundary-errors.js');
const { applyGithubChangeset } = await import('../lib/github-apply-changeset.js');

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

test('untyped pre-mutation GitHub changeset failures become bounded no-effect diagnostics', async () => {
  const response = await applyGithubChangeset({ repo:'laurajoyhutchins/overcenter', base_sha:'a'.repeat(40), branch:'chore/native-failure-preflight', changes:[{ path:'README.md', operation:'update', content:'test\n' }], commit_message:'test: classify native preflight failure' }, { github:{ resolveCommit:async () => { throw new TypeError('synthetic preflight failure'); } } });
  assert.equal(response.ok, false);
  assert.equal(response.error, 'GITHUB_CHANGESET_UNEXPECTED_ERROR');
  assert.equal(response.phase, 'preflight.resolve_base');
  assert.equal(response.may_have_mutated, false);
});

test('untyped ref-update failures retain indeterminate mutation phase', async () => {
  let branchReads = 0;
  const response = await applyGithubChangeset({ repo:'laurajoyhutchins/overcenter', base_sha:'a'.repeat(40), branch:'chore/native-failure-ref-update', changes:[{ path:'README.md', operation:'update', content:'test\n' }], commit_message:'test: classify native ref failure' }, { github:{ resolveCommit:async () => ({ sha:'a'.repeat(40), tree_sha:'b'.repeat(40) }), getBranch:async () => { branchReads += 1; return null; }, getPathEntries:async () => new Map([['README.md', { type:'blob', mode:'100644' }]]), createTree:async () => 'c'.repeat(40), createCommit:async () => 'd'.repeat(40), createBranch:async () => { throw new TypeError('synthetic ref update failure'); } } });
  assert.equal(branchReads >= 2, true);
  assert.equal(response.ok, false);
  assert.equal(response.error, 'GITHUB_CHANGESET_UNEXPECTED_ERROR');
  assert.equal(response.phase, 'mutation.ref_update');
  assert.equal(response.may_have_mutated, true);
});

test('project.amend worker sanitization retains bounded GitHub failure phase', () => {
  const error = new Error('unexpected GitHub changeset provider failure');
  error.code = 'GITHUB_CHANGESET_UNEXPECTED_ERROR';
  error.may_have_mutated = false;
  error.details = { phase:'preflight.resolve_base', may_have_mutated:false };
  const sanitized = sanitizeWorkerBoundaryError('project.amend', error, { defaultError:'PROJECT_AMEND_ERROR', defaultMessage:'project.amend failed', logger:{ error() {} } });
  assert.equal(sanitized.code, 'GITHUB_CHANGESET_UNEXPECTED_ERROR');
  assert.equal(sanitized.details.phase, 'preflight.resolve_base');
  assert.equal(sanitized.details.may_have_mutated, false);
});
