import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCertifiedGitHubRef } from '../src/providers/github/certified-predicates.ts';
import { observeCertifiedGitHubRead } from '../src/providers/github/certified-read.ts';
import { observeCertifiedGitHubRepository } from '../src/providers/github/certified-repository.ts';
import type { GitHubJsonGet } from '../src/providers/github/rest.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function repository(id = 42) {
  return {
    id,
    node_id: `R_${id}`,
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
  };
}

function provider(refBody: unknown, repositoryId = 42): { get: GitHubJsonGet; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: (_token, path) => {
      calls.push(path);
      if (path === '/repos/acme/widget') return repository(repositoryId);
      if (path === '/repos/acme/widget/git/ref/heads%2Fmain') return refBody;
      throw new Error(`unexpected provider path: ${path}`);
    },
  };
}

function certifiedRef(get: GitHubJsonGet) {
  const repositoryObservation = observeCertifiedGitHubRepository('token', {
    repositoryId: 42,
    repositoryFullName: 'acme/widget',
    get,
    observerId: 'github-ref-fence/v1',
  });
  return observeCertifiedGitHubRead('token', {
    repositoryFullName: repositoryObservation.fact.object.full_name,
    operation: 'ref',
    parameters: { ref: 'heads/main' },
    get,
    observerId: 'github-ref-fence/v1',
  });
}

test('certified ref is certified read plus exact-binding predicate', () => {
  const p = provider({ ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } });
  const read = certifiedRef(p.get);
  assert.equal(read.state, 'observed');
  const predicate = evaluateCertifiedGitHubRef(read.value, 'refs/heads/main', SHA_A);

  assert.equal(predicate.current, true);
  assert.equal(predicate.actual_sha, SHA_A);
  assert.deepEqual(p.calls, ['/repos/acme/widget', '/repos/acme/widget/git/ref/heads%2Fmain']);
});

test('authoritative ref drift is a false predicate, not indeterminate evidence', () => {
  const p = provider({ ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } });
  const predicate = evaluateCertifiedGitHubRef(certifiedRef(p.get).value, 'refs/heads/main', SHA_B);
  assert.equal(predicate.current, false);
  assert.equal(predicate.actual_sha, SHA_A);
});

test('repository identity mismatch fails before the ref read', () => {
  const p = provider({ ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } }, 43);
  assert.throws(() => certifiedRef(p.get), /GITHUB_REPOSITORY_IDENTITY_MISMATCH/);
  assert.deepEqual(p.calls, ['/repos/acme/widget']);
});

test('malformed ref response fails structural certification', () => {
  const p = provider({ ref: 'refs/heads/main', object: { type: 'commit' } });
  assert.throws(() => certifiedRef(p.get), /RESPONSE_SLICE_REQUIRED_FIELD_MISSING:object\.sha/);
});

test('invalid expected SHA is rejected by the predicate', () => {
  assert.throws(
    () =>
      evaluateCertifiedGitHubRef(
        { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } },
        'refs/heads/main',
        'main',
      ),
    /GITHUB_REF_EXPECTED_SHA_INVALID/,
  );
});
