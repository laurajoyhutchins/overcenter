import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { main } from './cli.mjs';

function dump(name, content) {
  const encoded = gzipSync(Buffer.from(content, 'utf8'), { level: 9 }).toString('base64');
  console.log(`CONTRACT_EVIDENCE_BLOB ${name} ${encoded}`);
}

test('emit exact candidate contract evidence for authority-bound repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contract-evidence-candidate-'));
  try {
    const catalog = join(root, 'generated/contracts/catalog.json');
    const docs = join(root, 'docs/generated/data-contracts.md');
    const atlas = join(root, 'docs/generated/data-contract-authority-atlas.md');
    await mkdir(join(root, 'generated/contracts'), { recursive:true });
    await mkdir(join(root, 'docs/generated'), { recursive:true });
    await main([
      'generate',
      '--repo-root', '.',
      '--config', 'scripts/contract-evidence/overcenter/config.mjs',
      '--catalog', catalog,
      '--docs', docs,
      '--atlas', atlas,
    ]);
    dump('generated/contracts/catalog.json', await readFile(catalog, 'utf8'));
    dump('docs/generated/data-contracts.md', await readFile(docs, 'utf8'));
    dump('docs/generated/data-contract-authority-atlas.md', await readFile(atlas, 'utf8'));
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});
