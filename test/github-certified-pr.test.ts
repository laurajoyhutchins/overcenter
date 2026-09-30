import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCertifiedGitHubPullRequestIdentity } from '../src/providers/github/certified-predicates.ts';
import { observeCertifiedGitHubRead } from '../src/providers/github/certified-read.ts';
import { observeCertifiedGitHubRepository } from '../src/providers/github/certified-repository.ts';
import type { GitHubJsonGet } from '../src/providers/github/rest.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const NODE = 'PR_node_37';

const expected = {
  node_id: NODE,
  state: 'open',
  head_sha: HEAD,
  base_ref: 'main',
  base_sha: BASE,
};

function repository(id = 42) {
  return {
    id,
    node_id: `R_${id}`,
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
    state: 'open',
    head: { sha: HEAD },
    base: { ref: 'main', sha: BASE },
    ...overrides,
  };
}

function provider(pullBody: unknown, repositoryId = 42): { get: GitHubJsonGet; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: (_token, path) => {
      calls.push(path);
      if (path === '/repos/acme/widget') return repository(repositoryId);
      if (path === '/repos/acme/widget/pulls/37') return pullBody;
      throw new Error(`unexpected provider path: ${path}`);
    },
  };
}

function certifiedPull(get: GitHubJsonGet) {
  const repositoryObservation = observeCertifiedGitHubRepository('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    get,
    observerId: 'github-pr-identity/v1',
  });
  return observeCertifiedGitHubRead('token', {
    repositoryFullName: repositoryObservation.fact.object.full_name,
    operation: 'pull_request',
    parameters: { pull_number: 37 },
    get,
    observerId: 'github-pr-identity/v1',
  });
}

test('certified PR is certified read plus identity predicate', () => {
  const p = provider(pull());
  const read = certifiedPull(p.get);
  const predicate = evaluateCertifiedGitHubPullRequestIdentity(read.value, 37, expected);

  assert.deepEqual(predicate.differences, []);
  assert.equal(predicate.actual.id, 3700);
  assert.equal(predicate.actual.node_id, NODE);
  assert.deepEqual(p.calls, ['/repos/acme/widget', '/repos/acme/widget/pulls/37']);
});

test('authoritative PR head drift is a predicate difference', () => {
  const p = provider(pull({ head: { sha: 'c'.repeat(40) } }));
  const predicate = evaluateCertifiedGitHubPullRequestIdentity(
    certifiedPull(p.get).value,
    37,
    expected,
  );
  assert.deepEqual(predicate.differences, ['head_sha']);
});

test('stable PR entity mismatch is explicit', () => {
  const p = provider(pull({ node_id: 'PR_other' }));
  const predicate = evaluateCertifiedGitHubPullRequestIdentity(
    certifiedPull(p.get).value,
    37,
    expected,
  );
  assert.ok(predicate.differences.includes('node_id'));
});

test('repository identity mismatch fails before the PR read', () => {
  const p = provider(pull(), 43);
  assert.throws(() => certifiedPull(p.get), /GITHUB_REPOSITORY_IDENTITY_MISMATCH/);
  assert.deepEqual(p.calls, ['/repos/acme/widget']);
});

test('malformed PR response fails structural certification', () => {
  const p = provider({ ...pull(), head: {} });
  assert.throws(() => certifiedPull(p.get), /RESPONSE_SLICE_REQUIRED_FIELD_MISSING:head\.sha/);
});

test('invalid expected identity is rejected by the predicate', () => {
  assert.throws(
    () => evaluateCertifiedGitHubPullRequestIdentity(pull(), 37, { ...expected, head_sha: 'main' }),
    /GITHUB_PR_HEAD_SHA_INVALID/,
  );
});
