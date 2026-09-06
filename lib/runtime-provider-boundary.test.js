import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const HATCHABLE_IMPORT = /from\s+['"]hatchable['"]|import\(['"]hatchable['"]\)/;

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('semantic command entrypoints do not import Hatchable directly', async () => {
  const entries = (await readdir(new URL('../mcp/', import.meta.url)))
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