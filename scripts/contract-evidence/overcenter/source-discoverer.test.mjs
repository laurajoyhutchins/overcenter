import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createSourceDiscoverer } from './source-discoverer.mjs';

async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), 'contract-evidence-source-'));
  await mkdir(join(root, 'src'), { recursive:true });
  await mkdir(join(root, 'lib'), { recursive:true });
  await writeFile(join(root, 'src/contracts.ts'), `
export interface RequestShape { repo: string; force?: boolean }
export type ResultShape = { ok: boolean; revision: string };
export const REQUEST_SCHEMA = Object.freeze({
  type:'object',
  required:['repo'],
  properties:{ repo:{type:'string'} },
  additionalProperties:false,
} as const);
export const SCALAR = 42;
const LocalOnly = { ignored:true };
`, 'utf8');
  await writeFile(join(root, 'lib/contracts.js'), `
export const REQUEST_SCHEMA = Object.freeze({
  type:'object',
  required:['repo'],
  properties:{repo:{type:'string'}},
  additionalProperties:false,
});
`, 'utf8');
  await writeFile(join(root, 'lib/manual-contracts.js'), `
export const RUNTIME_REQUEST = Object.freeze({
  required:['repo'],
  properties:{ repo:{type:'string'} },
});
export const RUNTIME_SCALAR = 'not-a-contract';
`, 'utf8');
  await writeFile(join(root, 'tsconfig.semantic.runtime.json'), JSON.stringify({
    compilerOptions:{ rootDir:'src', outDir:'dist/lib' },
    include:['src/contracts.ts'],
  }), 'utf8');
  return root;
}

async function discover(root) {
  const discoverer = createSourceDiscoverer({
    typescriptRoot:'src',
    javascriptRoot:'lib',
    runtimeTsconfig:'tsconfig.semantic.runtime.json',
  });
  return discoverer.discover({ repoRoot:root });
}

test('discovers exported TypeScript structured contracts but not scalars or local values', async () => {
  const root = await fixtureRepo();
  try {
    const result = await discover(root);
    assert.equal(result.complete, true);
    const ids = result.candidates.map((item) => item.source_identity);
    assert.ok(ids.includes('typescript:src/contracts.ts#RequestShape'));
    assert.ok(ids.includes('typescript:src/contracts.ts#ResultShape'));
    assert.ok(ids.includes('typescript:src/contracts.ts#REQUEST_SCHEMA'));
    assert.equal(ids.includes('typescript:src/contracts.ts#SCALAR'), false);
    assert.equal(ids.some((id) => id.endsWith('#LocalOnly')), false);
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});

test('discovers manually-authored JavaScript structured exports', async () => {
  const root = await fixtureRepo();
  try {
    const result = await discover(root);
    const ids = result.candidates.map((item) => item.source_identity);
    assert.ok(ids.includes('javascript:lib/manual-contracts.js#RUNTIME_REQUEST'));
    assert.equal(ids.includes('javascript:lib/manual-contracts.js#RUNTIME_SCALAR'), false);
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});

test('recognizes same-symbol committed runtime mirrors as generated projections', async () => {
  const root = await fixtureRepo();
  try {
    const result = await discover(root);
    const generated = result.candidates.find((item) => item.source_identity === 'javascript:lib/contracts.js#REQUEST_SCHEMA');
    assert.ok(generated);
    assert.deepEqual(generated.observed_relationships, [{
      kind:'generated-projection-of',
      target:'typescript:src/contracts.ts#REQUEST_SCHEMA',
    }]);
    assert.equal(result.candidates.some((item) => item.source_identity === 'javascript:lib/contracts.js#RequestShape'), false);
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});
