import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createSemanticDescriptorDiscoverer } from './semantic-descriptor-discoverer.mjs';

test('discovers current work.settle semantic input contract without inventing cross-source authority', async () => {
  const result = await createSemanticDescriptorDiscoverer({
    source:'src/semantic/semantic-command-descriptors.ts',
  }).discover({ repoRoot:process.cwd() });
  const contract = result.candidates.find((item) => item.source_identity === 'semantic-command:work.settle#input');
  assert.ok(contract);
  assert.equal(contract.structure.command, 'work.settle');
  assert.equal(contract.structure.surface, 'compatibility');
  assert.match(contract.structure.input_schema.syntax, /lease_ref/);
  assert.deepEqual(contract.observed_relationships, []);
});

test('records a source reference only when descriptor syntax proves one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contract-descriptor-'));
  try {
    await writeFile(join(root, 'descriptor.ts'), `
import { REQUEST_SCHEMA } from './request.js';
function descriptor(...args:any[]) { return args; }
export const DESCRIPTORS = {
  demo: descriptor('demo.command', 'demo.command', 'demo', REQUEST_SCHEMA, 'primary'),
};
`, 'utf8');
    const result = await createSemanticDescriptorDiscoverer({ source:'descriptor.ts' }).discover({ repoRoot:root });
    const contract = result.candidates.find((item) => item.source_identity === 'semantic-command:demo.command#input');
    assert.ok(contract);
    assert.deepEqual(contract.observed_relationships, [{
      kind:'source-reference',
      module:'./request.js',
      symbol:'REQUEST_SCHEMA',
    }]);
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});
