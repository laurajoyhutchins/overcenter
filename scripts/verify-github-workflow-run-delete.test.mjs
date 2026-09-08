import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteGithubActionsRun } from '../lib/github-actions-run-delete.js';
import { deleteGithubActionsRunWithGitHubApp } from '../lib/github-actions-run-delete-runtime.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = '89abcdef0123456789abcdef0123456789abcdef';
const input = { repo:'laurajoyhutchins/chirograph', workflow_run_id:4242, expected_head_sha:SHA };

function transport(responses) {
  const calls = [];
  return {
    calls,
    apiClient: { async call(_provider, request) { calls.push(request); const next = responses.shift(); if (next instanceof Error) throw next; return next; } },
  };
}

test('deletes only the exact matching workflow run and proves authoritative absence', async () => {
  const h = transport([{ status:200, body:{ id:4242, head_sha:SHA } }, { status:204 }, { status:404, body:{ message:'Not Found' } }]);
  const result = await deleteGithubActionsRun(input, { apiClient:h.apiClient });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'deleted');
  assert.equal(result.run_absent, true);
  assert.equal(result.observed_head_sha, SHA);
  assert.deepEqual(h.calls.map(({ method }) => method), ['GET','DELETE','GET']);
});

test('head identity mismatch fails closed before DELETE', async () => {
  const h = transport([{ status:200, body:{ id:4242, head_sha:OTHER_SHA } }]);
  const result = await deleteGithubActionsRun(input, { apiClient:h.apiClient });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'HEAD_MISMATCH');
  assert.equal(result.may_have_mutated, false);
  assert.deepEqual(h.calls.map(({ method }) => method), ['GET']);
});

test('already-absent exact workflow run is idempotent success', async () => {
  const h = transport([{ status:404, body:{ message:'Not Found' } }]);
  const result = await deleteGithubActionsRun(input, { apiClient:h.apiClient });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'already_absent');
  assert.equal(result.run_absent, true);
  assert.equal(result.precondition_verified, false);
  assert.deepEqual(h.calls.map(({ method }) => method), ['GET']);
});

test('transport loss after DELETE reconciles to success only when readback proves absence', async () => {
  const h = transport([{ status:200, body:{ id:4242, head_sha:SHA } }, new Error('socket lost'), { status:404, body:{ message:'Not Found' } }]);
  const result = await deleteGithubActionsRun(input, { apiClient:h.apiClient });
  assert.equal(result.ok, true);
  assert.equal(result.run_absent, true);
  assert.equal(result.reconciled_after_uncertainty, true);
  assert.deepEqual(h.calls.map(({ method }) => method), ['GET','DELETE','GET']);
});

test('transport loss remains indeterminate when readback cannot prove absence', async () => {
  const h = transport([{ status:200, body:{ id:4242, head_sha:SHA } }, new Error('socket lost'), { status:200, body:{ id:4242, head_sha:SHA } }]);
  const result = await deleteGithubActionsRun(input, { apiClient:h.apiClient });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'GITHUB_ACTIONS_RUN_DELETE_INDETERMINATE');
  assert.equal(result.may_have_mutated, true);
});

test('GitHub App wrapper uses the existing actions:write storage profile without caller identity', async () => {
  const h = transport([{ status:404, body:{ message:'Not Found' } }]);
  let observed;
  const withGitHubAppApiClient = async (repo, callback, options) => { observed = { repo, options }; return callback(h.apiClient); };
  const result = await deleteGithubActionsRunWithGitHubApp(input, { withGitHubAppApiClient });
  assert.equal(result.ok, true);
  assert.deepEqual(observed, { repo:'laurajoyhutchins/chirograph', options:{ permissionProfile:'actions_storage_delete' } });
});