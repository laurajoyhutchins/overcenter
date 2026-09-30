import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITHUB_PR_REVIEW_ATTESTATION_POLICY,
  observeCertifiedGitHubPullRequestReviewAttestation,
  type GitHubPullRequestReviewAttestation,
} from '../src/providers/github/review-attestation.ts';
import type { GitHubJsonGet } from '../src/providers/github/rest.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const NODE = 'PR_node_37';

const expected: GitHubPullRequestReviewAttestation = {
  repository_id: 42,
  repository_full_name: 'acme/widget',
  pull_number: 37,
  pull_node_id: NODE,
  head_sha: HEAD,
  base_ref: 'main',
  base_sha: BASE,
  reviewer_login: 'reviewer',
  acceptance_policy: GITHUB_PR_REVIEW_ATTESTATION_POLICY,
};

function repository() {
  return {
    id: 42,
    node_id: 'R_42',
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
  };
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    id: 3700,
    node_id: NODE,
    number: 37,
    state: 'closed',
    head: { sha: HEAD },
    base: { ref: 'main', sha: BASE },
    merged: true,
    merge_commit_sha: MERGE,
    merged_at: '2026-09-23T17:14:15Z',
    merged_by: { login: 'reviewer' },
    ...overrides,
  };
}

function provider(pullBody: unknown = pull()): GitHubJsonGet {
  return (_token, path) => {
    if (path === '/repos/acme/widget') return repository();
    if (path === '/repos/acme/widget/pulls/37') return pullBody;
    throw new Error(`UNEXPECTED_GITHUB_PATH:${path}`);
  };
}

test('exact merged reviewer attestation binds the accepted artifact', () => {
  const result = observeCertifiedGitHubPullRequestReviewAttestation('token', expected, {
    get: provider(),
    clock: () => '2026-09-23T17:15:00Z',
  });

  assert.equal(result.state, 'CURRENT');
  assert.equal(result.reason, 'AUTHORITATIVE_REVIEW_ATTESTATION_MATCHES');
  assert.deepEqual(result.differences, []);
  assert.equal(result.actual?.head_sha, HEAD);
  assert.equal(result.actual?.reviewer_login, 'reviewer');
  assert.equal(result.actual?.merge_commit_sha, MERGE);
  assert.equal(result.evidence?.operation_id, 'pulls/get');
  assert.equal(result.evidence?.reviewer_login, 'reviewer');
});

test('different reviewer does not satisfy the attestation', () => {
  const result = observeCertifiedGitHubPullRequestReviewAttestation('token', expected, {
    get: provider(pull({ merged_by: { login: 'someone-else' } })),
  });

  assert.equal(result.state, 'STALE');
  assert.deepEqual(result.differences, ['reviewer_login']);
});

test('different accepted head does not satisfy the attestation', () => {
  const result = observeCertifiedGitHubPullRequestReviewAttestation('token', expected, {
    get: provider(pull({ head: { sha: 'd'.repeat(40) } })),
  });

  assert.equal(result.state, 'STALE');
  assert.deepEqual(result.differences, ['head_sha']);
});

test('unmerged PR does not satisfy the attestation', () => {
  const result = observeCertifiedGitHubPullRequestReviewAttestation('token', expected, {
    get: provider(
      pull({
        merge_commit_sha: null,
        merged_at: null,
        merged_by: null,
      }),
    ),
  });

  assert.equal(result.state, 'STALE');
  assert.deepEqual(result.differences, ['merged']);
});

test('missing merge provenance is indeterminate rather than acceptance', () => {
  const result = observeCertifiedGitHubPullRequestReviewAttestation('token', expected, {
    get: provider(pull({ merged_by: null })),
  });

  assert.equal(result.state, 'INDETERMINATE');
  assert.equal(result.reason, 'OBSERVATION_FAILED');
  assert.match(
    String(result.observation_error),
    /GITHUB_REVIEW_ATTESTATION_MERGE_PROVENANCE_INVALID/,
  );
});

test('invalid expected identity fails before provider access', () => {
  let calls = 0;
  const get: GitHubJsonGet = () => {
    calls += 1;
    return {};
  };

  assert.throws(
    () =>
      observeCertifiedGitHubPullRequestReviewAttestation(
        'token',
        { ...expected, head_sha: 'main' },
        { get },
      ),
    /GITHUB_REVIEW_ATTESTATION_HEAD_INVALID/,
  );
  assert.equal(calls, 0);
});
