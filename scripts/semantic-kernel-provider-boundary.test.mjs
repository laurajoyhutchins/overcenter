import assert from 'node:assert/strict';
import test from 'node:test';

import { findForbiddenProviderImports } from './semantic-kernel-provider-boundary.mjs';

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