import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('../', import.meta.url);

test('project amendment does not use the obsolete GCP semantic relay', async () => {
  const mcp = await readFile(new URL('mcp/project.amend.js', repoRoot), 'utf8');
  const host = await readFile(new URL('lib/project-authoring-overcenter-host.js', repoRoot), 'utf8');

  assert.doesNotMatch(mcp, /gcp-semantic-project-amend-relay/);
  assert.match(mcp, /executeSemanticWorkerCommand/);
  assert.match(host, /executionTransactionStore/);
  assert.match(host, /executeProjectAuthoring/);
});
