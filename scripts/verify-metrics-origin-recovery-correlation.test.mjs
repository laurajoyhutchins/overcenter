import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostgresOrchestrationJournal,
  invocationCorrelationFacts,
} from '../lib/orchestration-journal.js';

test('execution origin is low-cardinality and preserves unknown history', () => {
  for (const origin of ['system','scheduler','agent','operator','recovery']) {
    assert.equal(invocationCorrelationFacts({ origin }).execution_origin, origin);
  }
  assert.equal(invocationCorrelationFacts({}).execution_origin, 'unknown');
  assert.throws(() => invocationCorrelationFacts({ origin:'chatgpt' }), /REQUEST_INVALID|origin/);
});

test('operator paperwork is distinguishable from automated recovery without inventing a reasoning boundary', () => {
  const operator = invocationCorrelationFacts({ origin:'operator', reasoning_boundary_id:'reasoning:operator-1' });
  const recovery = invocationCorrelationFacts({
    origin:'recovery',
    recovery_decision_id:'decision-1',
    recovery_attempt_id:'attempt-1',
  });
  assert.equal(operator.execution_origin, 'operator');
  assert.equal(operator.reasoning_boundary_id, 'reasoning:operator-1');
  assert.equal(recovery.execution_origin, 'recovery');
  assert.equal(recovery.reasoning_boundary_id, null);
  assert.equal(recovery.recovery_decision_id, 'decision-1');
  assert.equal(recovery.recovery_attempt_id, 'attempt-1');
});

test('recovery correlation and reasoning boundary facts are bounded identifiers', () => {
  assert.deepEqual(invocationCorrelationFacts({
    origin:'recovery',
    reasoning_boundary_id:'reasoning:42',
    recovery_decision_id:'recovery-decision:run-1:7',
    recovery_attempt_id:'recovery-attempt:run-1:8',
    packet_schema:'agent-execution-packet-v2',
  }), {
    run_id:null,
    execution_origin:'recovery',
    reasoning_boundary_id:'reasoning:42',
    recovery_decision_id:'recovery-decision:run-1:7',
    recovery_attempt_id:'recovery-attempt:run-1:8',
    packet_schema:'agent-execution-packet-v2',
  });
});

test('journal persists recovery facts on the existing invocation identity', async () => {
  let observed = null;
  const db = {
    async query(sql, params) {
      observed = { sql, params };
      return { rows:[{ invocation_id:'00000000-0000-0000-0000-000000000001', sequence:1, started_at:'2026-09-06T00:00:00Z' }] };
    },
  };
  const journal = createPostgresOrchestrationJournal(db);
  await journal.start({
    run_id:'run-1', command:'work.settle', request_sha256:'a'.repeat(64),
    request_projection:{ disposition:'requeue' }, target_kind:'project_transition', target_ref:'t1',
    correlation:{ execution_origin:'recovery', reasoning_boundary_id:null, recovery_decision_id:'decision-1', recovery_attempt_id:'attempt-1', packet_schema:null },
  });
  assert.match(observed.sql, /execution_origin/);
  assert.match(observed.sql, /recovery_decision_id/);
  assert.match(observed.sql, /recovery_attempt_id/);
  assert.ok(observed.params.includes('recovery'));
  assert.ok(observed.params.includes('decision-1'));
  assert.ok(observed.params.includes('attempt-1'));
});
