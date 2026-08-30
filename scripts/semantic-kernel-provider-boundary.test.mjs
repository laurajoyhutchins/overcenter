import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { findForbiddenProviderImports } from './semantic-kernel-provider-boundary.mjs';

async function semanticSources(root = process.cwd()) {
  const files = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.set(path.relative(root, absolute).split(path.sep).join('/'), await readFile(absolute, 'utf8'));
      }
    }
  }
  await walk(path.join(root, 'src', 'semantic'));
  return files;
}

test('rejects Hatchable imports from semantic kernel source', () => {
  assert.deepEqual(
    findForbiddenProviderImports(new Map([
      ['src/semantic/portable.ts', "import type { db } from 'hatchable';\n"],
    ])),
    [{ path: 'src/semantic/portable.ts', provider: 'hatchable' }],
  );
});

test('rejects cloud-provider SDK imports from semantic kernel source', () => {
  assert.deepEqual(
    findForbiddenProviderImports(new Map([
      ['src/semantic/aws.ts', "import { S3Client } from '@aws-sdk/client-s3';\n"],
      ['src/semantic/gcp.ts', "import { Storage } from '@google-cloud/storage';\n"],
    ])),
    [
      { path: 'src/semantic/aws.ts', provider: '@aws-sdk/client-s3' },
      { path: 'src/semantic/gcp.ts', provider: '@google-cloud/storage' },
    ],
  );
});

test('allows provider-neutral semantic imports', () => {
  assert.deepEqual(
    findForbiddenProviderImports(new Map([
      ['src/semantic/runtime-provenance.ts', "import type { GitSha } from './semantic-identities.js';\n"],
    ])),
    [],
  );
});

test('the checked-in semantic kernel contains no runtime provider imports', async () => {
  assert.deepEqual(findForbiddenProviderImports(await semanticSources()), []);
});