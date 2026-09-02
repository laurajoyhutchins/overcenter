import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExecutionState,
  assertTerminalOperationCompactable,
} from '../lib/compact-execution-state.js';

function activeExecution(overrides = {}) {
  return {
    subject_key:'project:overcenter#transition:ship',
    subject_kind:'project_transition',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'ship',
    authority_epoch:3,
    lease_ref:'00000000-0000-0000-0000-000000000001',
    run_id:'00000000-0000-0000-0000-000000000002',
    authority_repository:'laurajoyhutchins/overcenter',
    authority_revision:'a'.repeat(40),
    graph_fingerprint:'b'.repeat(64),
    transition_revision_fingerprint:'c'.repeat(64),
    transition_dependency_fingerprint:'d'.repeat(64),
    expires_at:'2026-09-01T18:30:00.000Z',
    hard_expires_at:'2026-09-01T18:45:00.000Z',
    active_capability_material:'opaque-capability',
    checkpoint:null,
    checkpoint_sha256:null,
    recent_progress_sha256:[],
    heartbeat_count:0,
    last_heartbeat_at:null,
    continuation:null,
    continuation_sha256:null,
    continuation_execution_fingerprint:null,
    no_progress_streak:0,
    updated_at:'2026-09-01T18:00:00.000Z',
    ...overrides,
  };
}

test('indeterminate operations cannot compact', () => {
  assert.throws(
    () => assertTerminalOperationCompactable({ state:'indeterminate', may_have_mutated:true, effect_ref:null }),
    error => error?.code === 'OPERATION_NOT_COMPACTABLE',
  );
});

test('successful mutating operations require a proven effect identity before compaction', () => {
  assert.throws(
    () => assertTerminalOperationCompactable({ state:'succeeded', may_have_mutated:true, effect_ref:null }),
    error => error?.code === 'OPERATION_EFFECT_UNPROVEN',
  );
});

test('execution state accepts one active lease with at most two progress hashes', () => {
  assert.doesNotThrow(() => assertExecutionState(activeExecution({
    recent_progress_sha256:['e'.repeat(64), 'f'.repeat(64)],
  })));
});

test('execution state rejects negative counters and more than two progress hashes', () => {
  assert.throws(
    () => assertExecutionState(activeExecution({ authority_epoch:-1 })),
    error => error?.code === 'EXECUTION_STATE_INVALID',
  );
  assert.throws(
    () => assertExecutionState(activeExecution({ heartbeat_count:-1 })),
    error => error?.code === 'EXECUTION_STATE_INVALID',
  );
  assert.throws(
    () => assertExecutionState(activeExecution({ no_progress_streak:-1 })),
    error => error?.code === 'EXECUTION_STATE_INVALID',
  );
  assert.throws(
    () => assertExecutionState(activeExecution({ recent_progress_sha256:['a', 'b', 'c'] })),
    error => error?.code === 'EXECUTION_STATE_INVALID',
  );
});

test('active execution state requires run revision and expiry coordinates', () => {
  for (const field of ['run_id', 'authority_repository', 'authority_revision', 'expires_at', 'hard_expires_at']) {
    assert.throws(
      () => assertExecutionState(activeExecution({ [field]:null })),
      error => error?.code === 'EXECUTION_STATE_INVALID',
      field,
    );
  }
});
