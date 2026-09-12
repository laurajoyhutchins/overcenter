import assert from 'node:assert/strict';
import test from 'node:test';
import { auditTestSource } from './test-audit-lib.mjs';

const revision = 'a'.repeat(40);

test('audit IDs are stable and revision-bound for literal node:test cases', () => {
  const source = `import test from 'node:test';\ntest('alpha', () => {});\ntest.skip('beta', () => {});\n`;
  const first = auditTestSource({ source, path:'lib/example.test.js', revision });
  const replay = auditTestSource({ source, path:'lib/example.test.js', revision });
  const changed = auditTestSource({ source, path:'lib/example.test.js', revision:'b'.repeat(40) });
  assert.equal(first.unresolved.length, 0);
  assert.deepEqual(first.cases.map(({ name }) => name), ['alpha', 'beta']);
  assert.deepEqual(first.cases.map(({ audit_id }) => audit_id), replay.cases.map(({ audit_id }) => audit_id));
  assert.notDeepEqual(first.cases.map(({ audit_id }) => audit_id), changed.cases.map(({ audit_id }) => audit_id));
});

test('dynamic native test names fail the census closed', () => {
  const result = auditTestSource({
    source:`import { test } from 'node:test';\nconst name = 'dynamic';\ntest(name, () => {});\n`,
    path:'lib/dynamic.test.js',
    revision,
  });
  assert.equal(result.cases.length, 0);
  assert.deepEqual(result.unresolved.map(({ kind }) => kind), ['nonliteral-test-name']);
});

test('legacy test files remain explicitly unresolved instead of disappearing', () => {
  const result = auditTestSource({
    source:`export async function runLegacyTests() { return { ok:true }; }\n`,
    path:'lib/legacy.test.js',
    revision,
  });
  assert.equal(result.cases.length, 0);
  assert.deepEqual(result.unresolved.map(({ kind }) => kind), ['legacy-test-runner']);
});
