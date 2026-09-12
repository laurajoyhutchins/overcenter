import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const HATCHABLE_IMPORT = /from\s+['"]hatchable['"]|import\(['"]hatchable['"]\)/;

async function source(path) {
  return readFile(path, 'utf8');
}

test('semantic command entrypoints do not import Hatchable directly', async () => {
  const entries = (await readdir('mcp'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `mcp/${name}`)
    .sort();
  const offenders = [];
  for (const path of entries) {
    if (HATCHABLE_IMPORT.test(await source(path))) offenders.push(path);
  }
  assert.deepEqual(offenders, [], `ambient Hatchable imports remain at semantic entrypoints: ${offenders.join(', ')}`);
});

test('worker semantic transport does not resolve an ambient Hatchable database', async () => {
  const text = await source('lib/worker-transport.js');
  assert.equal(HATCHABLE_IMPORT.test(text), false, 'worker transport imports Hatchable directly');
  assert.equal(text.includes('runtime.db || hatchableDb'), false, 'worker transport retains an ambient DB fallback');
});

test('provider-neutral GitHub auth does not resolve Hatchable config', async () => {
  const text = await source('lib/github-app-auth.js');
  assert.equal(HATCHABLE_IMPORT.test(text), false, 'GitHub auth imports Hatchable directly');
  assert.equal(text.includes('config.get('), false, 'GitHub auth reads ambient Hatchable config');
});

test('canonical external-effect MCP entrypoints forward the durable execution store', async () => {
  const entries = [
    'mcp/production.promote.js',
    'mcp/production.reconcile.js',
    'mcp/project.define.js',
    'mcp/project.amend.js',
  ];
  for (const path of entries) {
    const text = await source(path);
    assert.match(text, /executionTransactionStore/ , `${path} does not receive the canonical execution store`);
  }
});
