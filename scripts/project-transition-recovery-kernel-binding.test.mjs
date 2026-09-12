import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostgresOrchestrationRecoveryStore } from '../lib/orchestration-recovery.js';

test('orchestration recovery selects only nonterminal canonical executions', async () => {
  const calls = [];
  const store = createPostgresOrchestrationRecoveryStore({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows:[] };
    },
  });

  await store.currentExecution('run-project-transition');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /lifecycle IN \('prepared', 'executing', 'effect_uncertain', 'effect_confirmed', 'effect_absent'\)/);
  assert.match(calls[0].sql, /settled\s*=\s*false/);
});
