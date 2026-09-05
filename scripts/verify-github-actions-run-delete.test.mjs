import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deleteGithubActionsRun } from '../lib/github-actions-run-delete.js';

const EXPECTED = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (head_sha = EXPECTED) => ({ id:123, head_sha, status:'completed', conclusion:'success', workflow_id:77 });

function client(steps, calls) {
  return {
    async call(_service, request) {
      calls.push(request);
      const next = steps.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('matching exact workflow run is deleted and authoritative absence is verified', async () => {
  const calls = [];
  const result = await deleteGithubActionsRun(
    { repo:'owner/repo', workflow_run_id:123, expected_head_sha:EXPECTED },
    { apiClient:client([
      { status:200, body:run() },
      { status:204, body:null },
      { status:404, body:{ message:'Not Found' } },
    ], calls) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'deleted');
  assert.equal(result.run_absent, true);
  assert.equal(result.precondition_verified, true);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
});

test('workflow run head identity mismatch fails closed before DELETE', async () => {
  const calls = [];
  const result = await deleteGithubActionsRun(
    { repo:'owner/repo', workflow_run_id:123, expected_head_sha:EXPECTED },
    { apiClient:client([{ status:200, body:run(OTHER) }], calls) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'HEAD_MISMATCH');
  assert.equal(result.actual_head_sha, OTHER);
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);
});

test('already absent exact workflow run is idempotent success', async () => {
  const calls = [];
  const result = await deleteGithubActionsRun(
    { repo:'owner/repo', workflow_run_id:123, expected_head_sha:EXPECTED },
    { apiClient:client([{ status:404, body:{ message:'Not Found' } }], calls) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'already_absent');
  assert.equal(result.run_absent, true);
  assert.equal(calls.some((call) => call.method === 'DELETE'), false);
});

test('lost DELETE response reconciles to success only after authoritative absence readback', async () => {
  const calls = [];
  const result = await deleteGithubActionsRun(
    { repo:'owner/repo', workflow_run_id:123, expected_head_sha:EXPECTED },
    { apiClient:client([
      { status:200, body:run() },
      new Error('connection reset after dispatch'),
      { status:404, body:{ message:'Not Found' } },
    ], calls) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'deleted');
  assert.equal(result.reconciled_after_uncertainty, true);
  assert.equal(result.run_absent, true);
});

test('GitHub App runtime reuses the existing actions:write permission profile', async () => {
  const source = await readFile(new URL('../lib/github-actions-run-delete-runtime.js', import.meta.url), 'utf8');
  assert.match(source, /withGitHubAppApiClient/);
  assert.match(source, /permissionProfile:'actions_storage_delete'/);
});