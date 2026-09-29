import assert from 'node:assert/strict';
import test from 'node:test';

import { admitObservedSemanticDelta } from '../scripts/plan-semantic-change.ts';
import { GOLDEN_TRANSACTION_CASE } from './fixtures/golden-transaction.ts';

test('golden semantic transaction admits only its exact observed write set', () => {
  assert.deepEqual(
    admitObservedSemanticDelta(
      GOLDEN_TRANSACTION_CASE.expected_write_set,
      GOLDEN_TRANSACTION_CASE.expected_staged_delta,
    ),
    {
      state: 'ADMITTED',
      changed_artifacts: ['src/providers/github/status-effect.ts'],
    },
  );
});

test('semantic transaction replans when a planned write is absent', () => {
  assert.deepEqual(admitObservedSemanticDelta(GOLDEN_TRANSACTION_CASE.expected_write_set, []), {
    state: 'REPLAN_REQUIRED',
    reason: 'SEMANTIC_TRANSACTION_DIVERGED',
    missing_artifacts: ['src/providers/github/status-effect.ts'],
    unexpected_artifacts: [],
  });
});

test('semantic transaction replans when observation widens the write set', () => {
  assert.deepEqual(
    admitObservedSemanticDelta(GOLDEN_TRANSACTION_CASE.expected_write_set, [
      ...GOLDEN_TRANSACTION_CASE.expected_staged_delta,
      'src/source/source-integration.ts',
    ]),
    {
      state: 'REPLAN_REQUIRED',
      reason: 'SEMANTIC_TRANSACTION_DIVERGED',
      missing_artifacts: [],
      unexpected_artifacts: ['src/source/source-integration.ts'],
    },
  );
});
