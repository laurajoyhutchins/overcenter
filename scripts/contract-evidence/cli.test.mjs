import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { main } from './cli.mjs';

test('check can verify precomputed evidence without compiling the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contract-cli-check-'));
  try {
    const expectedCatalog = join(root, 'expected-catalog.json');
    const expectedDocs = join(root, 'expected-docs.md');
    const expectedAtlas = join(root, 'expected-atlas.md');
    const catalog = join(root, 'catalog.json');
    const docs = join(root, 'docs.md');
    const atlas = join(root, 'atlas.md');
    await Promise.all([
      writeFile(expectedCatalog, '{"schema":"contract-evidence-catalog-v1"}\n', 'utf8'),
      writeFile(catalog, '{"schema":"contract-evidence-catalog-v1"}\n', 'utf8'),
      writeFile(expectedDocs, '# Contracts\n', 'utf8'),
      writeFile(docs, '# Contracts\n', 'utf8'),
      writeFile(expectedAtlas, '# Atlas\n', 'utf8'),
      writeFile(atlas, '# Atlas\n', 'utf8'),
    ]);

    const result = await main([
      'check',
      '--expected-catalog', expectedCatalog,
      '--expected-docs', expectedDocs,
      '--expected-atlas', expectedAtlas,
      '--catalog', catalog,
      '--docs', docs,
      '--atlas', atlas,
    ]);
    assert.deepEqual(result, { ok:true });

    await writeFile(docs, '# Stale\n', 'utf8');
    await assert.rejects(
      () => main([
        'check',
        '--expected-catalog', expectedCatalog,
        '--expected-docs', expectedDocs,
        '--expected-atlas', expectedAtlas,
        '--catalog', catalog,
        '--docs', docs,
        '--atlas', atlas,
      ]),
      (error) => error?.code === 'CONTRACT_GENERATED_ARTIFACT_STALE'
        && error?.details?.stale?.length === 1
        && error.details.stale[0] === docs,
    );
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});