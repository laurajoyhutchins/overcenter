import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url);
const SEMANTIC = new URL('../src/semantic/', import.meta.url);
const FORBIDDEN = /(?:from\s+|import\s*\()\s*['"](?:hatchable|@aws-sdk\/|@google-cloud\/|@azure\/)/;

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes:true });
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test('semantic kernel has no runtime-provider SDK imports', async () => {
  const violations = [];
  for (const path of await files(SEMANTIC)) {
    const source = await readFile(path, 'utf8');
    if (FORBIDDEN.test(source)) violations.push(relative(ROOT.pathname, path));
  }
  assert.deepEqual(violations, [], `provider imports crossed semantic boundary: ${violations.join(', ')}`);
});