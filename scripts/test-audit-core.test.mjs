import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyScriptTestLane,
  extractLiteralTestCases,
  stableAuditTestId,
} from './test-audit-core.mjs';

test('test audit extracts literal node-test and regression-suite cases without losing skip/todo state', () => {
  const source = [
    "test('ordinary case', () => {});",
    "test.skip('skipped case', () => {});",
    "test.todo('todo case');",
    "await test('custom regression case', async () => {});",
  ].join('\n');
  const result = extractLiteralTestCases(source, { file:'fixture.test.mjs' });
  assert.deepEqual(
    result.cases.map(({ name, modifier }) => ({ name, modifier })),
    [
      { name:'ordinary case', modifier:null },
      { name:'skipped case', modifier:'skip' },
      { name:'todo case', modifier:'todo' },
      { name:'custom regression case', modifier:null },
    ],
  );
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(result.cases.map((entry) => entry.line), [1, 2, 3, 4]);
});

test('test audit fails closed on dynamically named cases instead of pretending the census is complete', () => {
  const result = extractLiteralTestCases("const name='dynamic';\ntest(name, () => {});", { file:'dynamic.test.mjs' });
  assert.equal(result.cases.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].line, 2);
  assert.equal(result.unresolved[0].reason, 'non_literal_test_name');
});

test('test audit IDs are deterministic and bound to the exact repository revision', () => {
  const input = { revision:'1'.repeat(40), file:'scripts/example.test.mjs', name:'proof', ordinal:0 };
  const first = stableAuditTestId(input);
  const second = stableAuditTestId(input);
  const movedRevision = stableAuditTestId({ ...input, revision:'2'.repeat(40) });
  assert.equal(first, second);
  assert.match(first, /^test_[0-9a-f]{16}$/);
  assert.notEqual(first, movedRevision);
});

test('test audit makes maintained, integration, and unregistered script-test lanes explicit', () => {
  const maintained = new Set(['scripts/maintained.test.mjs']);
  const integration = new Set(['scripts/integration.test.mjs']);
  assert.equal(classifyScriptTestLane('scripts/maintained.test.mjs', { maintained, integration }), 'maintained');
  assert.equal(classifyScriptTestLane('scripts/integration.test.mjs', { maintained, integration }), 'integration');
  assert.equal(classifyScriptTestLane('scripts/other.test.mjs', { maintained, integration }), 'unregistered');
  assert.throws(
    () => classifyScriptTestLane('scripts/both.test.mjs', {
      maintained:new Set(['scripts/both.test.mjs']),
      integration:new Set(['scripts/both.test.mjs']),
    }),
    /multiple execution lanes/,
  );
});