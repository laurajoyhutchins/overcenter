import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const apiSource = await readFile('api/github-apply-changeset.js', 'utf8');
const leaseScopedSource = await readFile('lib/github-lease-scoped-changeset.js', 'utf8');

test('github.apply_changeset remains an internal authority-aware capability without a secret lease token', () => {
  assert.match(apiSource, /createPostgresExecutionAuthorityService/);
  assert.match(apiSource, /lease_ref/);
  assert.match(apiSource, /applyGithubLeaseScopedChangeset/);
  assert.match(leaseScopedSource, /executionAuthority\.require/);
  assert.doesNotMatch(apiSource, /lease_token/);
});

test('github.apply_changeset is not registered as an ordinary MCP tool', async () => {
  await assert.rejects(readFile('mcp/github_apply_changeset.js', 'utf8'), /ENOENT/);
});
