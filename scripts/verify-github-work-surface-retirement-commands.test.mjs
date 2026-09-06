import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';
import { closeGithubIssue, closeGithubPullRequest } from '../lib/github-work-surface-retirement.js';

async function source(path) { return readFile(new URL(`../${path}`, import.meta.url), 'utf8'); }

function apiClient(sequence) {
  const calls = [];
  return {
    calls,
    async call(_provider, request) {
      calls.push(request);
      const next = sequence.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const ISSUE = { repo:'laurajoyhutchins/overcenter', issue:42, expected_state:'open' };
const PR = { repo:'laurajoyhutchins/overcenter', pull_request:43, expected_state:'open', expected_head:'0123456789abcdef0123456789abcdef01234567' };

test('retirement descriptors expose only narrow advanced worker commands', async () => {
  const issue = semanticCommandDescriptor('github.issue.close');
  assert.equal(issue.surface, 'advanced');
  assert.deepEqual(issue.exposure, { worker:true, mcp:false });
  assert.deepEqual(issue.required_fields, ['repo', 'issue', 'expected_state']);
  assert.deepEqual(issue.semantic_fields, ['repo', 'issue', 'expected_state', 'run_id']);

  const pullRequest = semanticCommandDescriptor('github.pull_request.close');
  assert.equal(pullRequest.surface, 'advanced');
  assert.deepEqual(pullRequest.exposure, { worker:true, mcp:false });
  assert.deepEqual(pullRequest.required_fields, ['repo', 'pull_request', 'expected_state', 'expected_head']);
  assert.deepEqual(pullRequest.semantic_fields, ['repo', 'pull_request', 'expected_state', 'expected_head', 'run_id']);

  const worker = await source('lib/worker-transport.js');
  assert.match(worker, /github\.issue\.close/);
  assert.match(worker, /github\.pull_request\.close/);
  await assert.rejects(source('mcp/github_issue_close.js'), /ENOENT/);
  await assert.rejects(source('mcp/github_pull_request_close.js'), /ENOENT/);
});

test('github.issue.close is idempotent when the exact issue is already closed', async () => {
  const github = apiClient([{ status:200, body:{ number:42, state:'closed', html_url:'https://example/42' } }]);
  const result = await closeGithubIssue(ISSUE, { apiClient:github, maxAttempts:1 });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'already_closed');
  assert.equal(result.mutation_attempted, false);
  assert.equal(github.calls.length, 1);
  assert.equal(github.calls[0].method, 'GET');
});

test('github.issue.close refuses a pull request returned through the issues API', async () => {
  const github = apiClient([{ status:200, body:{ number:42, state:'open', pull_request:{ url:'x' } } }]);
  const result = await closeGithubIssue(ISSUE, { apiClient:github, maxAttempts:1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'GITHUB_ISSUE_IDENTITY_MISMATCH');
  assert.equal(github.calls.length, 1);
});

test('github.issue.close mutates once and confirms closed state through fresh readback', async () => {
  const github = apiClient([
    { status:200, body:{ number:42, state:'open' } },
    { status:200, body:{ number:42, state:'closed' } },
    { status:200, body:{ number:42, state:'closed' } },
  ]);
  const result = await closeGithubIssue(ISSUE, { apiClient:github, maxAttempts:1 });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'closed');
  assert.equal(result.reconciled_after_indeterminate, false);
  assert.deepEqual(github.calls.map((call) => call.method), ['GET', 'PATCH', 'GET']);
});

test('transport loss after issue close reconciles instead of retrying the mutation', async () => {
  const github = apiClient([
    { status:200, body:{ number:42, state:'open' } },
    new Error('socket lost'),
    { status:200, body:{ number:42, state:'closed' } },
  ]);
  const result = await closeGithubIssue(ISSUE, { apiClient:github, maxAttempts:1 });
  assert.equal(result.ok, true);
  assert.equal(result.reconciled_after_indeterminate, true);
  assert.deepEqual(github.calls.map((call) => call.method), ['GET', 'PATCH', 'GET']);
});

test('unresolved issue-close transport loss remains indeterminate and is never retried', async () => {
  const github = apiClient([
    { status:200, body:{ number:42, state:'open' } },
    new Error('socket lost'),
    { status:200, body:{ number:42, state:'open' } },
  ]);
  const result = await closeGithubIssue(ISSUE, { apiClient:github, maxAttempts:1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'GITHUB_ISSUE_CLOSE_INDETERMINATE');
  assert.equal(result.may_have_mutated, true);
  assert.deepEqual(github.calls.map((call) => call.method), ['GET', 'PATCH', 'GET']);
});

test('github.pull_request.close fails closed before mutation on exact-head drift', async () => {
  const github = apiClient([{ status:200, body:{ number:43, state:'open', head:{ sha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } } }]);
  const result = await closeGithubPullRequest(PR, { apiClient:github, maxAttempts:1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'HEAD_MISMATCH');
  assert.equal(result.may_have_mutated, false);
  assert.equal(github.calls.length, 1);
});

test('github.pull_request.close is exact-head idempotent and confirms closure after mutation', async () => {
  const already = apiClient([{ status:200, body:{ number:43, state:'closed', head:{ sha:PR.expected_head } } }]);
  const alreadyResult = await closeGithubPullRequest(PR, { apiClient:already, maxAttempts:1 });
  assert.equal(alreadyResult.ok, true);
  assert.equal(alreadyResult.outcome, 'already_closed');
  assert.equal(already.calls.length, 1);

  const github = apiClient([
    { status:200, body:{ number:43, state:'open', head:{ sha:PR.expected_head } } },
    { status:200, body:{ number:43, state:'closed', head:{ sha:PR.expected_head } } },
    { status:200, body:{ number:43, state:'closed', head:{ sha:PR.expected_head } } },
  ]);
  const result = await closeGithubPullRequest(PR, { apiClient:github, maxAttempts:1 });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'closed');
  assert.deepEqual(github.calls.map((call) => call.method), ['GET', 'PATCH', 'GET']);
});