import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSourceAuthorityWritable,
  fenceSourceApiProvider,
  fenceSourceGitHubAppAuth,
} from '../lib/source-authority-fence.js';

function dbWith(row) {
  return { query:async () => ({ rows:row ? [row] : [] }) };
}

test('unfrozen source permits provider effects', async () => {
  const db = dbWith({ frozen:false, frozen_at:null, source_revision:null, freeze_manifest_sha256:null });
  await assert.doesNotReject(() => assertSourceAuthorityWritable(db));
  let githubCalls = 0;
  const auth = fenceSourceGitHubAppAuth({
    async withApiClient(_repo, callback) {
      return callback({ call:async () => { githubCalls += 1; return { status:200 }; } });
    },
  }, db);
  await auth.withApiClient('owner/repo', client => client.call('github', { method:'GET', path:'/repos/owner/repo' }));
  assert.equal(githubCalls, 1);
});

test('frozen source rejects GitHub before provider dispatch', async () => {
  const db = dbWith({
    frozen:true,
    frozen_at:'2026-09-07T16:00:00Z',
    source_revision:'a'.repeat(40),
    freeze_manifest_sha256:`sha256:${'b'.repeat(64)}`,
  });
  let providerCalls = 0;
  const auth = fenceSourceGitHubAppAuth({
    async withApiClient(_repo, callback) {
      providerCalls += 1;
      return callback({ call:async () => ({ status:200 }) });
    },
  }, db);
  await assert.rejects(
    () => auth.withApiClient('owner/repo', client => client.call('github', {})),
    error => error?.code === 'SOURCE_AUTHORITY_FROZEN' && error?.may_have_mutated === false,
  );
  assert.equal(providerCalls, 0);
});

test('freeze is rechecked at every GitHub API call', async () => {
  let frozen = false;
  const db = { query:async () => ({ rows:[{ frozen }] }) };
  let providerCalls = 0;
  const auth = fenceSourceGitHubAppAuth({
    async withApiClient(_repo, callback) {
      return callback({ call:async () => { providerCalls += 1; return { status:200 }; } });
    },
  }, db);
  await auth.withApiClient('owner/repo', async client => {
    await client.call('github', { method:'GET' });
    frozen = true;
    await assert.rejects(() => client.call('github', { method:'POST' }), error => error?.code === 'SOURCE_AUTHORITY_FROZEN');
  });
  assert.equal(providerCalls, 1);
});

test('frozen source rejects generic provider calls before dispatch', async () => {
  const db = dbWith({ frozen:true });
  let calls = 0;
  const api = fenceSourceApiProvider({ call:async () => { calls += 1; } }, db);
  await assert.rejects(() => api.call('linear', { method:'POST' }), error => error?.code === 'SOURCE_AUTHORITY_FROZEN');
  assert.equal(calls, 0);
});

test('missing cutover authority state fails closed', async () => {
  await assert.rejects(
    () => assertSourceAuthorityWritable(dbWith(null)),
    error => error?.code === 'SOURCE_AUTHORITY_STATE_UNAVAILABLE' && error?.may_have_mutated === false,
  );
});
