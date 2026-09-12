import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverNativeLibTests, discoverScriptTests } from './test-discovery.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'overcenter-test-discovery-'));
  await mkdir(path.join(root, 'scripts', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'lib', 'nested'), { recursive: true });
  return root;
}

test('discovers every script node:test file recursively without a maintained allowlist', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'scripts', 'alpha.test.mjs'), '');
  await writeFile(path.join(root, 'scripts', 'nested', 'beta.test.mjs'), '');
  await writeFile(path.join(root, 'scripts', 'nested', 'not-a-test.mjs'), '');
  assert.deepEqual(await discoverScriptTests(root), [
    'scripts/alpha.test.mjs',
    'scripts/nested/beta.test.mjs',
  ]);
});

test('includes only lib tests already migrated to native node:test', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'lib', 'native.test.js'), "import test from 'node:test';\n");
  await writeFile(path.join(root, 'lib', 'nested', 'legacy.test.js'), 'export async function runLegacyTests() {}\n');
  await writeFile(path.join(root, 'lib', 'ordinary.js'), "import test from 'node:test';\n");
  assert.deepEqual(await discoverNativeLibTests(root), ['lib/native.test.js']);
});