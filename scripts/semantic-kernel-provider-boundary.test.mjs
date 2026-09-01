import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import * as providerBoundary from './semantic-kernel-provider-boundary.mjs';

const {
  findForbiddenProviderImports,
  findForbiddenRuntimeCompatibilityImports,
} = providerBoundary;

async function collectTypeScriptSources(directories, root = process.cwd(), { skipRuntime = false } = {}) {
  const files = new Map();
  const runtimeDirectory = path.join(root, 'src', 'runtime');
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (skipRuntime && absolute === runtimeDirectory) continue;
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.set(path.relative(root, absolute).split(path.sep).join('/'), await readFile(absolute, 'utf8'));
      }
    }
  }
  for (const directory of directories) await walk(path.join(root, directory));
  return files;
}

function providerNeutralSources(root = process.cwd()) {
  return collectTypeScriptSources(['src/semantic', 'src/ports'], root);
}

function architectureSources(root = process.cwd()) {
  return collectTypeScriptSources(['src', 'type-tests'], root, { skipRuntime: true });
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

test('rejects compatibility shims while allowing genuine runtime composition imports', () => {
  assert.deepEqual(
    findForbiddenRuntimeCompatibilityImports(new Map([
      ['type-tests/stale.ts', "import { createProjectAdvancePorts } from '../src/runtime/project-advance-runtime-adapter';\n"],
      ['type-tests/composition.ts', "import { createPortableRuntime } from '../src/runtime/portable-runtime';\n"],
      ['type-tests/host.ts', "import { createProductionPromotionRuntime } from '../src/runtime/production-promotion-overcenter-host';\n"],
    ])),
    [{
      path: 'type-tests/stale.ts',
      module: 'project-advance-runtime-adapter',
      specifier: '../src/runtime/project-advance-runtime-adapter',
    }],
  );
});

test('rejects nested and alternate-extension runtime modules', () => {
  assert.deepEqual(
    providerBoundary.findUnexpectedRuntimeEntries?.([
      'portable-runtime.ts',
      'production-promotion-overcenter-host.ts',
      'compatibility/',
      'project-inspect-mcp-binding.mjs',
    ]),
    ['compatibility/', 'project-inspect-mcp-binding.mjs'],
  );
});

test('the checked-in semantic kernel and ports contain no runtime provider imports', async () => {
  assert.deepEqual(findForbiddenProviderImports(await providerNeutralSources()), []);
});

test('checked-in TypeScript imports use runtime only for genuine composition', async () => {
  assert.deepEqual(findForbiddenRuntimeCompatibilityImports(await architectureSources()), []);
});

test('checked-in runtime modules are genuine composition modules', async () => {
  const entries = await readdir(path.join(process.cwd(), 'src', 'runtime'), { withFileTypes: true });
  const modules = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(modules, [
    'portable-runtime.ts',
    'production-promotion-overcenter-host.ts',
  ]);
});