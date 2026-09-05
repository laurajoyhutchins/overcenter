import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CONTEXT = 2;
import { main } from './cli.mjs';

function emitLineDelta(name, committed, candidate) {
  const before = committed.split('\n');
  const after = candidate.split('\n');
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const emitted = new Set();
  console.log(`CONTRACT_EVIDENCE_DIFF ${name}`);
  for (let index = 0; index < before.length; index += 1) {
    if (afterSet.has(before[index])) continue;
    for (let cursor = Math.max(0, index - CONTEXT); cursor <= Math.min(before.length - 1, index + CONTEXT); cursor += 1) {
      const key = `-${cursor}`;
      if (!emitted.has(key)) {
        emitted.add(key);
        console.log(`BEFORE ${cursor + 1}: ${before[cursor]}`);
      }
    }
  }
  emitted.clear();
  for (let index = 0; index < after.length; index += 1) {
    if (beforeSet.has(after[index])) continue;
    for (let cursor = Math.max(0, index - CONTEXT); cursor <= Math.min(after.length - 1, index + CONTEXT); cursor += 1) {
      const key = `+${cursor}`;
      if (!emitted.has(key)) {
        emitted.add(key);
        console.log(`AFTER ${cursor + 1}: ${after[cursor]}`);
      }
    }
  }
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
    emitLineDelta('generated/contracts/catalog.json', await readFile('generated/contracts/catalog.json', 'utf8'), await readFile(catalog, 'utf8'));
    emitLineDelta('docs/generated/data-contracts.md', await readFile('docs/generated/data-contracts.md', 'utf8'), await readFile(docs, 'utf8'));
    emitLineDelta('docs/generated/data-contract-authority-atlas.md', await readFile('docs/generated/data-contract-authority-atlas.md', 'utf8'), await readFile(atlas, 'utf8'));
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});
