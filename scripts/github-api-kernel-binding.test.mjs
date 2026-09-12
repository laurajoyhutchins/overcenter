import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('../', import.meta.url);

test('standalone GitHub changeset endpoint uses the canonical mutation runtime', async () => {
  const source = await readFile(new URL('api/github-apply-changeset.js', repoRoot), 'utf8');

  assert.match(source, /createGithubWorkerMutationRuntime/);
  assert.match(source, /executionTransactionStore/);
  assert.doesNotMatch(source, /applyGithubLeaseScopedChangeset/);
  assert.doesNotMatch(source, /createPostgresExecutionAuthorityService/);
});
