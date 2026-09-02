import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = new URL('../../packages/contract-evidence/', import.meta.url);

test('contract-evidence package exposes a repository-neutral public boundary', async () => {
  const packageDocument = JSON.parse(await readFile(new URL('package.json', PACKAGE_ROOT), 'utf8'));
  assert.equal(packageDocument.name, '@overcenter/contract-evidence');
  assert.equal(packageDocument.type, 'module');
  assert.equal(packageDocument.exports, './index.mjs');

  const api = await import(new URL('index.mjs', PACKAGE_ROOT).href);
  assert.equal(typeof api.compileCatalog, 'function');
  assert.equal(typeof api.fingerprintStructure, 'function');

  const discoverer = {
    name:'fixture-package-json',
    async discover() {
      return {
        complete:true,
        diagnostics:[],
        candidates:[{
          source_identity:'fixture:package-contracts.json#request',
          source_kind:'fixture-json',
          source_location:{ path:'package-contracts.json', anchor:'request' },
          symbol_or_boundary:'request',
          structural_fingerprint:api.fingerprintStructure({ fields:['id'] }),
          structure:{ fields:['id'] },
          observed_relationships:[],
        }],
      };
    },
  };
  const catalog = await api.compileCatalog({
    repoRoot:join(process.cwd(), 'another-managed-repo'),
    discoverers:[discoverer],
    classificationDocument:{ schema:'contract-evidence-classifications-v1', candidates:{} },
  });
  assert.equal(catalog.summary.discovered, 1);
  assert.deepEqual(catalog.unclassified_source_identities, ['fixture:package-contracts.json#request']);
});

test('contract-evidence package does not import Overcenter integration knowledge', async () => {
  const entries = await readdir(PACKAGE_ROOT, { withFileTypes:true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const source = await readFile(new URL(entry.name, PACKAGE_ROOT), 'utf8');
    assert.doesNotMatch(source, /scripts\/contract-evidence\/overcenter|src\/semantic|(?:\.\.\/)+lib\/|from ['\"]hatchable['\"]|\.overcenter\//, entry.name);
  }
});
