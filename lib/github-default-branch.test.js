import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDefaultBranchMigrationRequest } from 'lib/github-default-branch.js';

test('normalizes exact migration request', () => {
  const request = normalizeDefaultBranchMigrationRequest({ repo: 'laurajoyhutchins/plethora', from: 'master', to: 'main', expected_head: 'A'.repeat(40) });
  assert.equal(request.expected_head, 'a'.repeat(40));
  assert.equal(request.from, 'master');
  assert.equal(request.to, 'main');
});

test('rejects same source and target', () => {
  assert.throws(
    () => normalizeDefaultBranchMigrationRequest({ repo: 'owner/repo', from: 'main', to: 'main', expected_head: 'a'.repeat(40) }),
    (error) => error?.code === 'INVALID_REQUEST',
  );
});

test('rejects arbitrary refs', () => {
  assert.throws(
    () => normalizeDefaultBranchMigrationRequest({ repo: 'owner/repo', from: 'refs/heads/master', to: 'main', expected_head: 'a'.repeat(40) }),
    (error) => error?.code === 'INVALID_BRANCH',
  );
});