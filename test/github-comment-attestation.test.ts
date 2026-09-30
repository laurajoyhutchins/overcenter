import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/digest.ts';
import {
  GITHUB_ISSUE_COMMENT_ATTESTATION_POLICY,
  observeCertifiedGitHubIssueCommentAttestation,
  type GitHubIssueCommentAttestation,
} from '../src/providers/github/comment-attestation.ts';
import type { GitHubJsonGet } from '../src/providers/github/rest.ts';

const BODY = 'architectural judgment remains explicit';
const expected: GitHubIssueCommentAttestation = {
  repository_id: 42,
  repository_full_name: 'acme/widget',
  issue_number: 460,
  comment_id: 5903129961,
  comment_node_id: 'IC_example',
  author_login: 'reviewer',
  body_sha256: sha256(BODY),
  acceptance_policy: GITHUB_ISSUE_COMMENT_ATTESTATION_POLICY,
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

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: expected.comment_id,
    node_id: expected.comment_node_id,
    user: { login: expected.author_login },
    body: BODY,
    created_at: '2026-09-30T02:53:12Z',
    updated_at: '2026-09-30T02:53:12Z',
    ...overrides,
  };
}

function provider(pages: Record<number, unknown[]>): GitHubJsonGet {
  return (_token, path) => {
    if (path === '/repos/acme/widget') return repository();
    const match = path.match(
      /^\/repos\/acme\/widget\/issues\/460\/comments\?page=(\d+)&per_page=30$/,
    );
    if (match) return pages[Number(match[1])] ?? [];
    throw new Error(`UNEXPECTED_GITHUB_PATH:${path}`);
  };
}

test('exact issue-comment attestation binds author, node identity, and body digest', () => {
  const result = observeCertifiedGitHubIssueCommentAttestation('token', expected, {
    get: provider({ 1: [comment()] }),
    clock: () => '2026-09-30T03:00:00Z',
  });

  assert.equal(result.state, 'CURRENT');
  assert.equal(result.reason, 'AUTHORITATIVE_JUDGMENT_ATTESTATION_MATCHES');
  assert.deepEqual(result.differences, []);
  assert.equal(result.actual?.author_login, 'reviewer');
  assert.equal(result.actual?.body_sha256, sha256(BODY));
  assert.equal(result.evidence?.pages.length, 1);
});

test('different comment author does not satisfy the attestation', () => {
  const result = observeCertifiedGitHubIssueCommentAttestation('token', expected, {
    get: provider({ 1: [comment({ user: { login: 'someone-else' } })] }),
  });

  assert.equal(result.state, 'STALE');
  assert.deepEqual(result.differences, ['author_login']);
});

test('different comment body does not satisfy the attestation', () => {
  const result = observeCertifiedGitHubIssueCommentAttestation('token', expected, {
    get: provider({ 1: [comment({ body: 'different judgment' })] }),
  });

  assert.equal(result.state, 'STALE');
  assert.deepEqual(result.differences, ['body_sha256']);
});

test('complete collection without the comment is a certified non-match', () => {
  const result = observeCertifiedGitHubIssueCommentAttestation('token', expected, {
    get: provider({ 1: [] }),
  });

  assert.equal(result.state, 'STALE');
  assert.equal(result.reason, 'AUTHORITATIVE_JUDGMENT_ATTESTATION_NOT_FOUND');
  assert.deepEqual(result.differences, ['comment_id']);
});

test('matching comment with unavailable author fails closed', () => {
  const result = observeCertifiedGitHubIssueCommentAttestation('token', expected, {
    get: provider({ 1: [comment({ user: null })] }),
  });

  assert.equal(result.state, 'INDETERMINATE');
  assert.equal(result.reason, 'OBSERVATION_FAILED');
  assert.equal(result.observation_error, 'GITHUB_JUDGMENT_ATTESTATION_COMMENT_FIELDS_UNAVAILABLE');
});

test('attestation scan traverses certified pages before matching', () => {
  const filler = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1,
    node_id: `IC_${index + 1}`,
    user: { login: 'other' },
    body: 'other',
    created_at: '2026-09-30T02:00:00Z',
    updated_at: '2026-09-30T02:00:00Z',
  }));
  const result = observeCertifiedGitHubIssueCommentAttestation('token', expected, {
    get: provider({ 1: filler, 2: [comment()] }),
  });

  assert.equal(result.state, 'CURRENT');
  assert.equal(result.evidence?.pages.length, 2);
});

test('invalid expected body digest fails before provider access', () => {
  let calls = 0;
  const get: GitHubJsonGet = () => {
    calls += 1;
    return {};
  };

  assert.throws(
    () =>
      observeCertifiedGitHubIssueCommentAttestation(
        'token',
        { ...expected, body_sha256: 'not-a-digest' },
        { get },
      ),
    /GITHUB_JUDGMENT_ATTESTATION_BODY_DIGEST_INVALID/,
  );
  assert.equal(calls, 0);
});
