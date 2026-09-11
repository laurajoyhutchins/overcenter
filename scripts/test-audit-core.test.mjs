import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyScriptTestLane,
  collectRunnerTestSelection,
  extractLiteralTestCases,
  stableAuditTestId,
} from './test-audit-core.mjs';

const REVISION = 'a'.repeat(40);

test('extracts literal node:test cases and reports dynamic names instead of inventing identity', () => {
  const source = `
    import test from 'node:test';
    test('ordinary', () => {});
    test.skip('skipped', () => {});
    test.todo('todo');
    const name = 'dynamic';
    test(name, () => {});
  `;
  const result = extractLiteralTestCases(source, { file:'scripts/example.test.mjs' });
  assert.deepEqual(result.cases.map((entry) => [entry.name, entry.modifier]), [
    ['ordinary', null],
    ['skipped', 'skip'],
    ['todo', 'todo'],
  ]);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].reason, 'non_literal_test_name');
});

test('stable audit ids are deterministic and bound to the exact repository revision', () => {
  const input = { revision:REVISION, file:'scripts/example.test.mjs', name:'ordinary', ordinal:0 };
  const first = stableAuditTestId(input);
  assert.match(first, /^test_[0-9a-f]{16}$/);
  assert.equal(first, stableAuditTestId(input));
  assert.notEqual(first, stableAuditTestId({ ...input, revision:'b'.repeat(40) }));
  assert.throws(() => stableAuditTestId({ ...input, revision:'main' }), /40-character Git SHA/);
});

test('script test lane classification fails closed on ambiguous runner membership', () => {
  assert.equal(classifyScriptTestLane('scripts/a.test.mjs', { maintained:['scripts/a.test.mjs'], integration:[] }), 'maintained');
  assert.equal(classifyScriptTestLane('scripts/b.test.mjs', { maintained:[], integration:['scripts/b.test.mjs'] }), 'integration');
  assert.equal(classifyScriptTestLane('scripts/c.test.mjs', { maintained:[], integration:[] }), 'unregistered');
  assert.throws(
    () => classifyScriptTestLane('scripts/a.test.mjs', { maintained:['scripts/a.test.mjs'], integration:['scripts/a.test.mjs'] }),
    /multiple execution lanes/,
  );
});

test('runner selection finds explicit test paths and dynamic prefix families without treating suffix predicates as files', () => {
  const source = `
    const maintainedTests = ['alpha.test.mjs', 'beta.test.mjs'];
    const scriptNames = await readdir(new URL('scripts/', root));
    for (const prefix of ['exact-revision', 'production-materialization']) {
      maintainedTests.push(...scriptNames.filter(name => name.startsWith(prefix) && name.endsWith('.test.mjs')));
    }
  `;
  const result = collectRunnerTestSelection(source);
  assert.deepEqual(result.explicit, ['alpha.test.mjs', 'beta.test.mjs']);
  assert.deepEqual(result.prefixes, ['exact-revision', 'production-materialization']);
  assert(!result.explicit.includes('.test.mjs'));
});

test('extracts await test calls used by historical custom suites without weakening literal-name requirements', () => {
  const source = `
    async function test(name, fn) { return fn(); }
    export async function runFixtureTests() {
      await test('custom regression case', async () => {});
    }
  `;
  const result = extractLiteralTestCases(source, { file:'lib/fixture.test.js' });
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].name, 'custom regression case');
});