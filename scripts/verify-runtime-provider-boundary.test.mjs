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

test('GitHub changeset auth is an explicit composition-root dependency', async () => {
  const text = await source('lib/github-apply-changeset.js');
  assert.equal(text.includes("githubAppChangesetPermissionProfile, withGitHubAppApiClient"), false, 'changeset helper imports an ambient GitHub App provider');
  assert.equal(text.includes('options.withGitHubAppApiClient || withGitHubAppApiClient'), false, 'changeset helper retains an ambient provider fallback');
  assert.equal(text.includes('const withApp = options.withGitHubAppApiClient;'), true, 'changeset helper does not consume the injected provider explicitly');
  assert.equal(text.includes("code:'RUNTIME_PROVIDER_MISSING'"), true, 'missing changeset provider does not fail explicitly');
  assert.equal(text.includes('withGitHubAppApiClient:withApp'), true, 'execution authority construction does not retain the injected provider');
});