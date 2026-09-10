import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTestFile, assertAuditIdentity, createAuditIdentity, isAuditedTestPath } from './test-audit-core.mjs';

test('recognizes every declared audit inventory path family', () => {
  assert.equal(isAuditedTestPath('lib/example.test.mjs'), true);
  assert.equal(isAuditedTestPath('lib/regression-tests-example.mjs'), true);
  assert.equal(isAuditedTestPath('lib/test-example.mjs'), true);
  assert.equal(isAuditedTestPath('scripts/example.test.mjs'), true);
  assert.equal(isAuditedTestPath('api/example.test.mjs'), false);
});

test('classifies native tests, skips, and todos exactly', () => {
  const identity = createAuditIdentity('scripts/example.test.mjs', `
    test('a', () => {});
    test.skip('b', () => {});
    test.todo('c');
  `);
  assert.deepEqual(identity, {
    path: 'scripts/example.test.mjs',
    kind: 'test-module',
    expected_tests: 1,
    expected_skips: 1,
    expected_todos: 1,
    expected_cases: 3,
  });
});

test('classifies a statically enumerable regression module', () => {
  const identity = createAuditIdentity('lib/regression-tests-example.mjs', `[
  {
    name: 'first',
    test: () => true
  },
  {
    name: 'second',
    test: () => true
  }
]`);
  assert.equal(identity.kind, 'regression-module');
  assert.equal(identity.expected_tests, 2);
  assert.equal(identity.expected_cases, 2);
});

test('fails closed when a test shape cannot be statically resolved', () => {
  const identity = auditTestFile('scripts/dynamic.test.mjs', 'registerTests(cases);');
  assert.equal(identity.kind, 'unresolved');
  assert.equal(identity.code, 'TEST_SHAPE_UNRESOLVED');
  assert.throws(() => assertAuditIdentity(identity), /TEST_SHAPE_UNRESOLVED/);
});

test('explicit dynamic-form exemptions remain structurally auditable', () => {
  const identity = createAuditIdentity('lib/test-run-hooks.mjs', 'export function install() {}');
  assert.equal(identity.kind, 'runtime-hook');
  assert.match(identity.detail, /runtime hook/);
  assert.equal(identity.expected_cases, 0);
});

test('rejects malformed supposedly resolved identities', () => {
  assert.throws(() => assertAuditIdentity({ path: 'scripts/a.test.mjs', kind: 'test-module' }), /invalid audit identity field/);
});
