import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchGitHubWorkflowWithGitHubApp } from '../lib/github-workflow-dispatch.js';

const repo = 'laurajoyhutchins/overcenter';
const expectedHead = '0123456789abcdef0123456789abcdef01234567';

function fakeWithApp({ observedHead = expectedHead, dispatchStatus = 204, runs = [] } = {}) {
  const calls = [];
  const withApp = async (requestedRepo, callback, options) => {
    assert.equal(requestedRepo, repo);
    assert.equal(options.permissionProfile, 'workflow_dispatch');
    const apiClient = {
      async call(_service, request) {
        calls.push(request);
        if (request.method === 'GET' && request.path.includes('/git/ref/heads/')) {
          return { status: 200, body: { object: { sha: observedHead } } };
        }
        if (request.method === 'POST' && request.path.endsWith('/dispatches')) {
          return { status: dispatchStatus, body: null };
        }
        if (request.method === 'GET' && request.path.endsWith('/runs')) {
          return { status: 200, body: { workflow_runs: runs } };
        }
        throw new Error(`unexpected request ${request.method} ${request.path}`);
      },
    };
    return callback(apiClient);
  };
  return { withApp, calls };
}

test('dispatches only after exact branch-head preflight and confirms the run identity', async () => {
  const run = {
    id: 123,
    head_sha: expectedHead,
    head_branch: 'dev',
    event: 'workflow_dispatch',
    status: 'queued',
    conclusion: null,
    html_url: 'https://github.com/laurajoyhutchins/overcenter/actions/runs/123',
    created_at: new Date().toISOString(),
  };
  const { withApp, calls } = fakeWithApp({ runs: [run] });

  const result = await dispatchGitHubWorkflowWithGitHubApp({
    repo,
    workflow: 'codex-agent-execution.yml',
    ref: 'dev',
    expected_head: expectedHead,
    inputs: { transition_id: 'example-transition' },
  }, { withGitHubAppApiClient: withApp, sleep: async () => {} });

  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(result.workflow_run_id, 123);
  assert.equal(result.workflow_run_head_sha, expectedHead);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(calls.find(call => call.method === 'POST').body, {
    ref: 'dev',
    inputs: { transition_id: 'example-transition' },
  });
});

test('head mismatch fails closed before workflow dispatch', async () => {
  const { withApp, calls } = fakeWithApp({ observedHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

  await assert.rejects(
    dispatchGitHubWorkflowWithGitHubApp({
      repo,
      workflow: 'codex-agent-execution.yml',
      ref: 'dev',
      expected_head: expectedHead,
      inputs: { transition_id: 'example-transition' },
    }, { withGitHubAppApiClient: withApp }),
    error => error?.code === 'GITHUB_WORKFLOW_DISPATCH_HEAD_MISMATCH' && error?.may_have_mutated === false,
  );
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('unconfirmed post-dispatch identity is explicit mutation uncertainty', async () => {
  const { withApp, calls } = fakeWithApp({ runs: [] });

  await assert.rejects(
    dispatchGitHubWorkflowWithGitHubApp({
      repo,
      workflow: 'codex-agent-execution.yml',
      ref: 'dev',
      expected_head: expectedHead,
      inputs: { transition_id: 'example-transition' },
    }, { withGitHubAppApiClient: withApp, sleep: async () => {} }),
    error => error?.code === 'GITHUB_WORKFLOW_DISPATCH_IDENTITY_UNCONFIRMED' && error?.may_have_mutated === true,
  );
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('rejects unbounded or caller-shaped workflow coordinates', async () => {
  const { withApp } = fakeWithApp();
  await assert.rejects(
    dispatchGitHubWorkflowWithGitHubApp({ repo, workflow: '../evil.yml', ref: 'dev', expected_head: expectedHead }, { withGitHubAppApiClient: withApp }),
    error => error?.code === 'INVALID_WORKFLOW',
  );
  await assert.rejects(
    dispatchGitHubWorkflowWithGitHubApp({ repo, workflow: 'codex-agent-execution.yml', ref: 'dev', expected_head: expectedHead, surprise: true }, { withGitHubAppApiClient: withApp }),
    error => error?.code === 'INVALID_REQUEST',
  );
});