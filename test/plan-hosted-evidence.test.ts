import assert from 'node:assert/strict';
import test from 'node:test';

import { planHostedEvidence } from '../scripts/plan-hosted-evidence.ts';

test('documentation-only experiment changes do not require hosted proofs', () => {
  assert.deepEqual(
    planHostedEvidence('distributed-chaos', ['experiments/distributed-authority-chaos/README.md']),
    { required: false, reason: 'no-impact' },
  );
});

test('unrelated package scripts do not fan out specialized proofs', () => {
  const before = {
    name: 'overcenter-research',
    private: true,
    type: 'module',
    scripts: { 'test:unit': 'node old.ts' },
    devDependencies: { typescript: '7.0.2' },
  };
  const after = {
    ...before,
    scripts: {
      'test:unit': 'node new.ts',
      'prove:code-deletion': 'node scripts/prove-code-deletion.ts',
    },
  };

  assert.deepEqual(planHostedEvidence('authority-flow', ['package.json'], before, after), {
    required: false,
    reason: 'irrelevant-package',
  });
  assert.deepEqual(planHostedEvidence('distributed-chaos', ['package.json'], before, after), {
    required: false,
    reason: 'irrelevant-package',
  });
});

test('a proof script change requires its hosted evidence', () => {
  const before = { scripts: { 'test:distributed-authority-chaos': 'node old.ts' } };
  const after = { scripts: { 'test:distributed-authority-chaos': 'node new.ts' } };
  assert.deepEqual(planHostedEvidence('distributed-chaos', ['package.json'], before, after), {
    required: true,
    reason: 'package-runtime',
  });
});

test('toolchain dependency changes fail closed for every hosted proof', () => {
  const before = { scripts: {}, devDependencies: { typescript: '7.0.2' } };
  const after = { scripts: {}, devDependencies: { typescript: '7.0.3' } };
  assert.equal(planHostedEvidence('substrate', ['package.json'], before, after).required, true);
});

test('matching implementation paths require evidence', () => {
  assert.deepEqual(planHostedEvidence('authority-storage', ['src/authority/delegation.ts']), {
    required: true,
    reason: 'matching-path',
  });
});

test('deleted implementation paths still require evidence', () => {
  assert.deepEqual(planHostedEvidence('authority-storage', ['src/storage/git-store.ts']), {
    required: true,
    reason: 'matching-path',
  });
});

test('unknown package semantics fail closed', () => {
  const before = { scripts: {}, customRuntimePolicy: 'a' };
  const after = { scripts: {}, customRuntimePolicy: 'b' };
  assert.equal(
    planHostedEvidence('distributed-handoff', ['package.json'], before, after).required,
    true,
  );
});
