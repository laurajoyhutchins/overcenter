import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('generic worker project.advance composes the full targeted runtime like the dedicated MCP adapter', async () => {
  const worker = await source('lib/worker-transport.js');
  const mcp = await source('mcp/project.advance.js');

  assert.match(mcp, /createPostgresTargetAwareOrchestrationRunService/);
  assert.match(mcp, /createPostgresOrchestrationAdvanceService/);
  assert.match(mcp, /projectAdvanceFor\(\{\s*db,\s*runs,\s*advance\s*\}\)/s);

  assert.match(worker, /createPostgresTargetAwareOrchestrationRunService/,
    'worker transport must compose the targeted orchestration run service for project.advance');
  assert.match(worker, /createPostgresOrchestrationAdvanceService/,
    'worker transport must compose the orchestration advance service for project.advance');
  assert.match(worker, /projectAdvanceFor\(\{\s*db:\s*dbBinding,\s*runs,\s*advance\s*\}\)/s,
    'worker transport must pass db, runs, and advance into projectAdvanceFor');
  assert.doesNotMatch(worker, /projectAdvanceFor\(\{\s*db:runtime\.db\s*\|\|\s*hatchableDb\s*\}\)\.advance\(request\)/,
    'worker transport must not invoke projectAdvanceFor with only a database binding');
});
