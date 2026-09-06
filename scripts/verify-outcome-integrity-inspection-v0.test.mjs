import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadModule() {
  const source = await readFile(new URL('../src/semantic/outcome-integrity.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

const binding = {
  project_ref: 'github:acme/widget',
  authority_revision: '0123456789012345678901234567890123456789',
  graph_derivation: 'overcenter-project-graph-v1',
  semantic_identity: 'graph-semantic-v1:abc',
  review_contract_version: 'outcome-integrity-v0',
  horizon_root: 'ship-widget',
};

test('inspection is exact-revision bound and returns structured findings rather than a validity boolean', async () => {
  const { inspectOutcomeIntegrity } = await loadModule();
  const result = inspectOutcomeIntegrity({
    binding,
    root: 'ship-widget',
    obligations: [
      { id: 'build', kind: 'transition', requires: [], evidence: ['artifact'] },
      { id: 'ship-widget', kind: 'transition', requires: ['build'], evidence: ['deployment'] },
    ],
  });
  assert.deepEqual(result.binding, binding);
  assert.equal('semantically_valid' in result, false);
  assert.deepEqual(result.objective_violations, []);
  assert.deepEqual(result.positive_derivation, ['build', 'ship-widget']);
  assert.ok(Array.isArray(result.falsification_obligations));
});

test('deterministic analysis finds orphan work, missing producers, unowned assumptions, missing evidence, and cycles', async () => {
  const { inspectOutcomeIntegrity } = await loadModule();
  const result = inspectOutcomeIntegrity({
    binding,
    root: 'root',
    obligations: [
      { id: 'root', kind: 'transition', requires: ['missing'], evidence: [] },
      { id: 'orphan', kind: 'transition', requires: [], evidence: ['x'] },
      { id: 'assumption', kind: 'assumption', requires: [], evidence: ['declared'], owner: null },
      { id: 'a', kind: 'transition', requires: ['b'], evidence: ['x'] },
      { id: 'b', kind: 'transition', requires: ['a'], evidence: ['x'] },
    ],
  });
  const codes = result.objective_violations.map((finding) => finding.code);
  assert.ok(codes.includes('MISSING_PRODUCER'));
  assert.ok(codes.includes('MISSING_EVIDENCE_BINDING'));
  assert.ok(codes.includes('UNOWNED_ASSUMPTION'));
  assert.ok(codes.includes('ORPHAN_WORK'));
  assert.ok(codes.includes('SEMANTIC_JUSTIFICATION_CYCLE'));
});

test('review binding is stale when exact authority revision changes', async () => {
  const { isOutcomeIntegrityReviewCurrent } = await loadModule();
  assert.equal(isOutcomeIntegrityReviewCurrent(binding, { ...binding }), true);
  assert.equal(isOutcomeIntegrityReviewCurrent(binding, { ...binding, authority_revision: 'ffffffffffffffffffffffffffffffffffffffff' }), false);
});
