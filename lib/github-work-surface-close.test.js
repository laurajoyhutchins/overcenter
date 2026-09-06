import test from 'node:test';
import assert from 'node:assert/strict';
import { closeGithubIssue, closeGithubPullRequest } from './github-work-surface-close.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function restClient(sequence) {
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

function response(body, status = 200) { return { status, body }; }

test('pull request close fences exact head before mutation', async () => {
  const client = restClient([response({ number: 7, state: 'open', merged: false, head: { sha: 'f'.repeat(40) } })]);
  const result = await closeGithubPullRequest({ repo:'acme/widgets', pull_request:7, expected_head:SHA, expected_state:'open', artifact_ref:'project-transition:retire-7' }, { apiClient:client });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'HEAD_MISMATCH');
  assert.equal(result.may_have_mutated, false);
  assert.equal(client.calls.length, 1);
});

test('pull request close is idempotent when authoritative state is already closed at the same head', async () => {
  const client = restClient([response({ number:7, state:'closed', merged:false, head:{ sha:SHA } })]);
  const result = await closeGithubPullRequest({ repo:'acme/widgets', pull_request:7, expected_head:SHA, expected_state:'open', artifact_ref:'project-transition:retire-7' }, { apiClient:client });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'already_closed');
  assert.equal(result.mutation_attempted, false);
  assert.equal(client.calls.length, 1);
});

test('pull request close reconciles an uncertain mutation through fresh authoritative readback', async () => {
  const client = restClient([
    response({ number:7, state:'open', merged:false, head:{ sha:SHA } }),
    new Error('transport lost after write'),
    response({ number:7, state:'closed', merged:false, head:{ sha:SHA } }),
  ]);
  const result = await closeGithubPullRequest({ repo:'acme/widgets', pull_request:7, expected_head:SHA, expected_state:'open', artifact_ref:'project-transition:retire-7' }, { apiClient:client });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'closed');
  assert.equal(result.reconciled_after_indeterminate, true);
  assert.equal(client.calls.length, 3);
});

test('issue close is idempotent and binds exact numeric provider identity', async () => {
  const client = restClient([response({ number:19, state:'closed', pull_request:undefined })]);
  const result = await closeGithubIssue({ repo:'acme/widgets', issue:19, expected_state:'open', artifact_ref:'project-transition:retire-19' }, { apiClient:client });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'already_closed');
  assert.equal(result.issue, 19);
  assert.equal(result.mutation_attempted, false);
});

test('issue close rejects a pull request number before mutation', async () => {
  const client = restClient([response({ number:19, state:'open', pull_request:{ url:'https://api.github.test/pulls/19' } })]);
  const result = await closeGithubIssue({ repo:'acme/widgets', issue:19, expected_state:'open', artifact_ref:'project-transition:retire-19' }, { apiClient:client });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'GITHUB_ISSUE_IDENTITY_MISMATCH');
  assert.equal(result.may_have_mutated, false);
  assert.equal(client.calls.length, 1);
});

test('issue close reconciles an uncertain mutation through fresh authoritative readback', async () => {
  const client = restClient([
    response({ number:19, state:'open' }),
    new Error('transport lost after write'),
    response({ number:19, state:'closed' }),
  ]);
  const result = await closeGithubIssue({ repo:'acme/widgets', issue:19, expected_state:'open', artifact_ref:'project-transition:retire-19' }, { apiClient:client });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'closed');
  assert.equal(result.reconciled_after_indeterminate, true);
  assert.equal(client.calls.length, 3);
});