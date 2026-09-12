import test from 'node:test';
import { normalizeDefaultBranchMigrationRequest } from 'lib/github-default-branch.js';

function assert(condition, message) { if (!condition) throw new Error(message); }

test('normalizes exact migration request', async () => {
  const request = normalizeDefaultBranchMigrationRequest({ repo: 'laurajoyhutchins/plethora', from: 'master', to: 'main', expected_head: 'A'.repeat(40) });
  assert(request.expected_head === 'a'.repeat(40), 'SHA not normalized');
  assert(request.from === 'master' && request.to === 'main', 'branch names changed');
});

test('rejects same source and target', async () => {
  let failed = false;
  try { normalizeDefaultBranchMigrationRequest({ repo: 'owner/repo', from: 'main', to: 'main', expected_head: 'a'.repeat(40) }); }
  catch (error) { failed = error.code === 'INVALID_REQUEST'; }
  assert(failed, 'same source and target was accepted');
});

test('rejects arbitrary refs', async () => {
  let failed = false;
  try { normalizeDefaultBranchMigrationRequest({ repo: 'owner/repo', from: 'refs/heads/master', to: 'main', expected_head: 'a'.repeat(40) }); }
  catch (error) { failed = error.code === 'INVALID_BRANCH'; }
  assert(failed, 'refs/ branch was accepted');
});
