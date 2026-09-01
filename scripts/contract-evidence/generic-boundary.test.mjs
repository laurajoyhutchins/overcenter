import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprintStructure } from './canonical.mjs';
import { compileCatalog } from './compiler.mjs';

const ROOT = new URL('.', import.meta.url);

test('generic protocol modules do not import Overcenter runtime knowledge', async () => {
  const entries = await readdir(ROOT, { withFileTypes:true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs') || entry.name.endsWith('.test.mjs')) continue;
    const source = await readFile(new URL(entry.name, ROOT), 'utf8');
    assert.doesNotMatch(source, /from ['\"]hatchable['\"]|(?:\.\.\/)+lib\/|src\/semantic|\.\/overcenter\//, entry.name);
  }
});

test('generic compiler accepts a technology-neutral repository discoverer', async () => {
  const discoverer = {
    name:'fixture-json',
    async discover() {
      return {
        complete:true,
        diagnostics:[],
        candidates:[{
          source_identity:'fixture:contracts.json#request',
          source_kind:'fixture-json',
          source_location:{ path:'contracts.json', anchor:'request' },
          symbol_or_boundary:'request',
          structural_fingerprint:fingerprintStructure({ fields:['id'] }),
          structure:{ fields:['id'] },
          observed_relationships:[],
        }],
      };
    },
  };
  const catalog = await compileCatalog({
    repoRoot:join(process.cwd(), 'some-managed-repo'),
    discoverers:[discoverer],
    classificationDocument:{ schema:'contract-evidence-classifications-v1', candidates:{} },
  });
  assert.equal(catalog.summary.discovered, 1);
  assert.deepEqual(catalog.unclassified_source_identities, ['fixture:contracts.json#request']);
});
