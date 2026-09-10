import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTestFile, assertAuditIdentity, createAuditIdentity, isAuditedTestPath } from './test-audit-core.mjs';

const REVISION = '0123456789abcdef0123456789abcdef01234567';

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
  `, REVISION);
  assert.equal(identity.path, 'scripts/example.test.mjs');
  assert.equal(identity.kind, 'test-module');
  assert.equal(identity.expected_tests, 1);
  assert.equal(identity.expected_skips, 1);
  assert.equal(identity.expected_todos, 1);
  assert.equal(identity.expected_cases, 3);
  assert.equal(identity.revision, REVISION);
  assert.match(identity.source_sha256, /^[0-9a-f]{64}$/);
  assert.match(identity.audit_id, /^[0-9a-f]{64}$/);
});

test('binds stable audit identity to revision, path, and exact source', () => {
  const source = `test('a', () => {});`;
  const first = createAuditIdentity('scripts/example.test.mjs', source, REVISION);
  const same = createAuditIdentity('scripts/example.test.mjs', source, REVISION.toUpperCase());
  const changedSource = createAuditIdentity('scripts/example.test.mjs', `${source}\n`, REVISION);
  const changedRevision = createAuditIdentity('scripts/example.test.mjs', source, '1123456789abcdef0123456789abcdef01234567');
  assert.equal(first.audit_id, same.audit_id);
  assert.notEqual(first.audit_id, changedSource.audit_id);
  assert.notEqual(first.audit_id, changedRevision.audit_id);
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
]`, REVISION);
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
  const identity = createAuditIdentity('lib/test-run-hooks.mjs', 'export function install() {}', REVISION);
  assert.equal(identity.kind, 'runtime-hook');
  assert.match(identity.detail, /runtime hook/);
  assert.equal(identity.expected_cases, 0);
});

test('rejects malformed supposedly resolved identities', () => {
  assert.throws(() => assertAuditIdentity({ path: 'scripts/a.test.mjs', kind: 'test-module' }), /invalid audit identity field/);
});

test('rejects identities without an exact Git revision', () => {
  assert.throws(() => createAuditIdentity('scripts/example.test.mjs', `test('a', () => {});`, 'dev'), /exact 40-character Git revision/);
});
