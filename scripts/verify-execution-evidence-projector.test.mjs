import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedEvidenceProjection, boundedEvidenceText } from '../lib/bounded-evidence.js';
import { deriveMutationCertainty, projectExecutionEvidence } from '../lib/execution-evidence.js';
import { createPostgresExecutionEvidenceStore } from '../lib/execution-evidence-store.js';

test('bounded execution evidence projection drops secret-bearing and body/content keys', () => {
  const projected = boundedEvidenceProjection({ safe: 'yes', token: 'drop', credential: 'drop', nested: { password: 'drop', body: 'drop', keep: 'ok' } });
  assert.equal(projected.safe, 'yes');
  assert.equal(projected.token, undefined);
  assert.equal(projected.credential, undefined);
  assert.equal(projected.nested.keep, 'ok');
  assert.equal(projected.nested.password, undefined);
  assert.equal(projected.nested.body, undefined);
});

test('bounded execution evidence projection enforces string array object and depth bounds', () => {
  const projected = boundedEvidenceProjection({
    long: 'x'.repeat(5000),
    list: Array.from({ length: 40 }, (_, index) => index),
    ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${String(index).padStart(2, '0')}`, index])),
  });
  assert.equal(projected.long.length, 1024);
  assert.equal(projected.list.length, 25);
  assert.ok(Object.keys(projected).length <= 30);
  const deep = boundedEvidenceProjection({ a: { b: { c: { d: { e: 'value' } } } } });
  assert.equal(typeof deep.a.b.c.d, 'string');
});

test('bounded execution evidence text is normalized consistently', () => {
  assert.equal(boundedEvidenceText('  abc  ', 10), 'abc');
  assert.equal(boundedEvidenceText('', 10), null);
  assert.equal(boundedEvidenceText('abcdefghijk', 4), 'abcd');
});

test('pre-mutation failure is definitively absent and fabricates no authority', () => {
  const source = {
    run: { run_id: 'run-blocked', worker: 'worker', mode: 'interactive', status: 'finished', disposition: 'blocked', started_at: '2026-08-27T16:00:00Z', deadline_at: '2026-08-27T17:00:00Z' },
    leases: [], checkpoints: [], heartbeats: [], resolutions: [], verifications: [],
    invocations: [{ invocation_id: 'inv-2', sequence: 2, command: 'work.claim', outcome: 'failed', error_code: 'REQUEST_INVALID', error_class: 'validation', retryable: false, rejection: false, may_have_mutated: false, request_projection: { work_ref: 'LJH-466' } }],
  };
  const projected = projectExecutionEvidence(source);
  assert.equal(projected.commands[0].outcome, 'failed');
  assert.equal(projected.commands[0].effect.mutation_certainty, 'definitively_absent');
  assert.deepEqual(projected.leases, []);
  assert.deepEqual(projected.settlements, []);
});

test('indeterminate command keeps historical outcome when later externally confirmed', () => {
  const invocation = { invocation_id: 'inv-3', sequence: 3, command: 'github.apply_changeset', outcome: 'indeterminate', may_have_mutated: true, request_projection: { repo: 'owner/repo' } };
  const resolutions = [{ resolution_id: 'res-1', invocation_id: 'inv-3', resolution_kind: 'externally_confirmed', evidence: { commit_sha: 'a'.repeat(40) }, created_at: '2026-08-27T16:10:00Z' }];
  assert.equal(deriveMutationCertainty(invocation, resolutions), 'confirmed_present');
  const projected = projectExecutionEvidence({ run: { run_id: 'run-3', status: 'active' }, leases: [], checkpoints: [], heartbeats: [], invocations: [invocation], resolutions, verifications: [] });
  assert.equal(projected.commands[0].outcome, 'indeterminate');
  assert.equal(projected.commands[0].effect.mutation_certainty, 'confirmed_present');
  assert.deepEqual(projected.commands[0].resolution_refs, ['resolution:res-1']);
  assert.equal(projected.recoveries[0].resolution_kind, 'externally_confirmed');
});

test('indeterminate command can be resolved definitively absent without rewriting outcome', () => {
  const invocation = { invocation_id: 'inv-4', sequence: 4, command: 'github.apply_changeset', outcome: 'indeterminate', may_have_mutated: true };
  const resolutions = [{ resolution_id: 'res-2', invocation_id: 'inv-4', resolution_kind: 'definitively_not_applied', evidence: {}, created_at: '2026-08-27T16:11:00Z' }];
  const projected = projectExecutionEvidence({ run: { run_id: 'run-4', status: 'active' }, leases: [], checkpoints: [], heartbeats: [], invocations: [invocation], resolutions, verifications: [] });
  assert.equal(projected.commands[0].outcome, 'indeterminate');
  assert.equal(projected.commands[0].effect.mutation_certainty, 'definitively_absent');
});

test('unresolved potentially mutating command remains unknown', () => {
  assert.equal(deriveMutationCertainty({ invocation_id: 'inv-5', command: 'github.apply_changeset', outcome: 'indeterminate', may_have_mutated: true }, []), 'unknown');
  assert.equal(deriveMutationCertainty({ invocation_id: 'inv-6', command: 'github.apply_changeset', outcome: 'succeeded', may_have_mutated: true }, []), 'unknown');
});

test('known observational commands have no mutation effect', () => {
  assert.equal(deriveMutationCertainty({ invocation_id: 'inv-read', command: 'github.review_packet', outcome: 'succeeded' }, []), 'not_applicable');
});

test('clean command effect and resulting-state verification remain separate evidence', () => {
  const source = {
    run: { run_id: 'run-success', worker: 'worker', mode: 'scheduled', status: 'finished', disposition: 'completed', started_at: '2026-08-27T15:00:00Z', deadline_at: '2026-08-27T16:00:00Z', finished_at: '2026-08-27T15:30:00Z', target: { kind: 'work', work_ref: 'WORK-1' }, target_sha256: 'b'.repeat(64) },
    leases: [{ lease_id: 'lease-1', run_id: 'run-success', work_ref: 'WORK-1', gate: 'execute', status: 'settled', created_at: '2026-08-27T15:01:00Z', settled_at: '2026-08-27T15:29:00Z', lease_token: 'never-show', token_hash: 'never-show-either', settle_receipt: { disposition: 'completed', execution_precondition_verified: true, current_state: 'Done', current_lane: 'done' } }],
    checkpoints: [], heartbeats: [], resolutions: [],
    invocations: [{ invocation_id: 'inv-1', sequence: 1, command: 'github.repository_metadata.ensure', outcome: 'succeeded', may_have_mutated: true, result_projection: { verified: true, changed: true } }],
    verifications: [{ predicate_key: 'work:WORK-1:acceptance', work_ref: 'WORK-1', predicate_kind: 'acceptance', satisfied_at: '2026-08-27T15:28:00Z', evidence_sha256: 'c'.repeat(64), evidence: { run_id: 'run-success', result: 'verified' } }],
  };
  const projected = projectExecutionEvidence(source);
  assert.equal(projected.commands[0].effect.mutation_certainty, 'confirmed_present');
  assert.equal(projected.verifications[0].status, 'verified');
  assert.equal(projected.settlements[0].settlement_disposition, 'completed');
  assert.equal(JSON.stringify(projected).includes('never-show'), false);
});

test('projection ordering and output are deterministic and defensively redacted', () => {
  const source = {
    run: { run_id: 'run-order', status: 'finished', disposition: 'blocked' },
    leases: [
      { lease_id: 'lease-b', created_at: '2026-08-27T16:02:00Z', status: 'expired', lease_token: 'secret-b' },
      { lease_id: 'lease-a', created_at: '2026-08-27T16:01:00Z', status: 'expired', token_hash: 'secret-a' },
    ],
    checkpoints: [
      { checkpoint_id: 'cp-b', lease_id: 'lease-a', created_at: '2026-08-27T16:04:00Z', checkpoint_sha256: '2'.repeat(64), checkpoint: { phase: 'two', body: 'drop' } },
      { checkpoint_id: 'cp-a', lease_id: 'lease-a', created_at: '2026-08-27T16:03:00Z', checkpoint_sha256: '1'.repeat(64), checkpoint: { phase: 'one', token: 'drop' } },
    ],
    heartbeats: [],
    invocations: [
      { invocation_id: 'inv-b', sequence: 2, command: 'github.review_packet', outcome: 'succeeded', request_projection: { safe: 'b', credential: 'drop' } },
      { invocation_id: 'inv-a', sequence: 1, command: 'github.review_packet', outcome: 'succeeded', result_projection: { safe: 'a', content: 'drop' } },
    ],
    resolutions: [],
    verifications: [
      { predicate_key: 'z', satisfied_at: '2026-08-27T16:06:00Z', evidence: { run_id: 'run-order', body: 'drop' } },
      { predicate_key: 'a', satisfied_at: '2026-08-27T16:05:00Z', evidence: { run_id: 'run-order', safe: 'ok' } },
    ],
  };
  const first = projectExecutionEvidence(source);
  const second = projectExecutionEvidence({ ...source, leases: [...source.leases].reverse(), checkpoints: [...source.checkpoints].reverse(), invocations: [...source.invocations].reverse(), verifications: [...source.verifications].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(first.leases.map((item) => item.lease_id), ['lease-a', 'lease-b']);
  assert.deepEqual(first.checkpoints.map((item) => item.checkpoint_id), ['cp-a', 'cp-b']);
  assert.deepEqual(first.commands.map((item) => item.invocation_id), ['inv-a', 'inv-b']);
  assert.deepEqual(first.verifications.map((item) => item.predicate_key), ['a', 'z']);
  assert.equal(Object.hasOwn(first, 'generated_at'), false);
  assert.equal(/secret-a|secret-b|credential|content|token|body/.test(JSON.stringify(first)), false);
});

test('execution evidence store stops after exact missing-run lookup', async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  const store = createPostgresExecutionEvidenceStore(db);
  assert.equal(await store.loadRunEvidence('run-missing'), null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM orchestration_runs WHERE run_id\s*=\s*\$1/i);
  assert.deepEqual(calls[0].params, ['run-missing']);
});

test('execution evidence store fences every durable source to the exact run', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM orchestration_runs/i.test(sql)) return { rows: [{ run_id: 'run-1', status: 'finished' }] };
      if (/FROM work_leases WHERE run_id/i.test(sql)) return { rows: [{ lease_id: 'lease-1', run_id: 'run-1', work_ref: 'WORK-1' }] };
      if (/work_lease_checkpoints/i.test(sql)) return { rows: [{ checkpoint_id: 'cp-1', lease_id: 'lease-1' }] };
      if (/work_lease_heartbeats/i.test(sql)) return { rows: [{ heartbeat_id: 'hb-1', lease_id: 'lease-1' }] };
      if (/FROM orchestration_command_invocations WHERE run_id/i.test(sql)) return { rows: [{ invocation_id: 'inv-1', run_id: 'run-1', sequence: 1 }] };
      if (/orchestration_invocation_resolutions/i.test(sql)) return { rows: [{ resolution_id: 'res-1', invocation_id: 'inv-1' }] };
      if (/portfolio_verification_receipts/i.test(sql)) return { rows: [{ predicate_key: 'verify-1', evidence: { run_id: 'run-1' } }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const store = createPostgresExecutionEvidenceStore(db);
  const source = await store.loadRunEvidence('run-1');
  assert.equal(source.run.run_id, 'run-1');
  assert.equal(source.leases.length, 1);
  assert.equal(source.checkpoints.length, 1);
  assert.equal(source.heartbeats.length, 1);
  assert.equal(source.invocations.length, 1);
  assert.equal(source.resolutions.length, 1);
  assert.equal(source.verifications.length, 1);

  const checkpointCall = calls.find((call) => /work_lease_checkpoints/i.test(call.sql));
  const heartbeatCall = calls.find((call) => /work_lease_heartbeats/i.test(call.sql));
  const resolutionCall = calls.find((call) => /orchestration_invocation_resolutions/i.test(call.sql));
  for (const call of [checkpointCall, heartbeatCall, resolutionCall]) {
    assert.match(call.sql, /run_id\s*=\s*\$1/i);
    assert.equal(call.params[0], 'run-1');
  }
});

test('verification receipts require exact execution attribution, never work-ref coincidence', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM orchestration_runs/i.test(sql)) return { rows: [{ run_id: 'run-verify' }] };
      if (/FROM work_leases WHERE run_id/i.test(sql)) return { rows: [{ lease_id: 'lease-v', run_id: 'run-verify', work_ref: 'WORK-SHARED' }] };
      if (/work_lease_checkpoints|work_lease_heartbeats|orchestration_invocation_resolutions/i.test(sql)) return { rows: [] };
      if (/FROM orchestration_command_invocations WHERE run_id/i.test(sql)) return { rows: [{ invocation_id: 'inv-v', run_id: 'run-verify', sequence: 1 }] };
      if (/portfolio_verification_receipts/i.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await createPostgresExecutionEvidenceStore(db).loadRunEvidence('run-verify');
  const verificationCall = calls.find((call) => /portfolio_verification_receipts/i.test(call.sql));
  assert.ok(verificationCall);
  assert.match(verificationCall.sql, /evidence->>'run_id'/i);
  assert.match(verificationCall.sql, /evidence->>'lease_id'/i);
  assert.match(verificationCall.sql, /evidence->>'invocation_id'/i);
  assert.doesNotMatch(verificationCall.sql, /work_ref\s*=/i);
  assert.deepEqual(verificationCall.params, ['run-verify', ['lease-v'], ['inv-v']]);
});
