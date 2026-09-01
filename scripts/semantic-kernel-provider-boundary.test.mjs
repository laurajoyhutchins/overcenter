import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { findForbiddenProviderImports } from './semantic-kernel-provider-boundary.mjs';

async function providerNeutralSources(root = process.cwd()) {
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
  await walk(path.join(root, 'src', 'ports'));
  return files;
}

test('rejects Hatchable imports from provider-neutral source', () => {
  assert.deepEqual(
    findForbiddenProviderImports(new Map([
      ['src/ports/portable.ts', "import type { db } from 'hatchable';\n"],
    ])),
    [{ path: 'src/ports/portable.ts', provider: 'hatchable' }],
  );
});

test('rejects cloud-provider SDK imports from provider-neutral source', () => {
  assert.deepEqual(
    findForbiddenProviderImports(new Map([
      ['src/semantic/aws.ts', "import { S3Client } from '@aws-sdk/client-s3';\n"],
      ['src/ports/gcp.ts', "import { Storage } from '@google-cloud/storage';\n"],
    ])),
    [
      { path: 'src/ports/gcp.ts', provider: '@google-cloud/storage' },
      { path: 'src/semantic/aws.ts', provider: '@aws-sdk/client-s3' },
    ],
  );
});

test('allows provider-neutral semantic and port imports', () => {
  assert.deepEqual(
    findForbiddenProviderImports(new Map([
      ['src/semantic/runtime-provenance.ts', "import type { GitSha } from './semantic-identities.js';\n"],
      ['src/ports/runtime.ts', "import type { RuntimePublisher } from '../semantic/runtime-provenance.js';\n"],
    ])),
    [],
  );
});

test('the checked-in semantic kernel and ports contain no runtime provider imports', async () => {
  assert.deepEqual(findForbiddenProviderImports(await providerNeutralSources()), []);
});