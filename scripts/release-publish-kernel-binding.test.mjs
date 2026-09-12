import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('../', import.meta.url);

test('release publication is bound to the canonical execution transaction kernel', async () => {
  const host = await readFile(new URL('lib/release-publish-overcenter-host.js', repoRoot), 'utf8');
  const runtime = await readFile(new URL('lib/github-release-runtime.js', repoRoot), 'utf8');
  const worker = await readFile(new URL('lib/worker-transport.js', repoRoot), 'utf8');

  assert.match(host, /executeGithubRelease/);
  assert.match(host, /executionTransactionStore/);
  assert.match(host, /authority_epoch/);
  assert.doesNotMatch(runtime, /createCompactGithubReleaseReceiptStore/);
  assert.match(worker, /executionTransactionStore:runtime\.executionTransactionStore/);
});
