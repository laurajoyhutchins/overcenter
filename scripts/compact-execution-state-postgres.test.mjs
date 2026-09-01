import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createPostgresCompactExecutionStateStore } from '../dist/portable/adapters/postgres/compact-execution-state-store.js';

const { Client } = pg;

function postgresClient() {
  return new Client({
    host:process.env.PGHOST || '127.0.0.1',
    port:Number(process.env.PGPORT || 5432),
    database:process.env.PGDATABASE || 'overcenter',
    user:process.env.PGUSER || 'overcenter',
    password:process.env.PGPASSWORD || 'overcenter',
  });
}

async function apply(client, name) {
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  await client.query(sql);
}

const sha = (character) => character.repeat(64);

function acquisition(overrides = {}) {
  return {
    subject_key:'project:overcenter#transition:ship',
    subject_kind:'project_transition',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'ship',
    lease_ref:'lease-1',
    run_id:'run-1',
    authority_repository:'laurajoyhutchins/overcenter',
    authority_revision:'a'.repeat(40),
    graph_fingerprint:sha('b'),
    transition_revision_fingerprint:sha('c'),
    transition_dependency_fingerprint:sha('d'),
    expires_at:'2026-09-01T18:30:00.000Z',
    hard_expires_at:'2026-09-01T18:45:00.000Z',
    active_capability_material:'opaque-capability',
    observed_at:'2026-09-01T18:00:00.000Z',
    ...overrides,
  };
}

test('compact Postgres state is fenced, bounded, idempotent, and exact-revision', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS proof_state, operation_state, execution_state, orchestration_runs CASCADE');
    await client.query(`CREATE TABLE orchestration_runs (
      run_id text PRIMARY KEY,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query("INSERT INTO orchestration_runs (run_id) VALUES ('run-1'),('run-2')");
    for (const name of ['053_execution_state.sql','054_operation_state.sql','055_proof_state.sql','056_orchestration_run_compaction.sql']) {
      await apply(client, name);
    }

    const store = createPostgresCompactExecutionStateStore(client);
    const first = await store.acquireExecution(acquisition());
    assert.equal(first.authority_epoch, 1);

    await assert.rejects(
      store.acquireExecution(acquisition({ lease_ref:'lease-racing' })),
      (error) => error?.code === 'EXECUTION_AUTHORITY_CONFLICT',
    );

    const checkpoint1 = await store.writeCheckpoint({
      subject_key:first.subject_key, lease_ref:'lease-1', authority_epoch:1,
      checkpoint:{ cursor:1 }, checkpoint_sha256:sha('e'), updated_at:'2026-09-01T18:05:00.000Z',
    });
    assert.deepEqual(checkpoint1.checkpoint, { cursor:1 });
    const checkpoint2 = await store.writeCheckpoint({
      subject_key:first.subject_key, lease_ref:'lease-1', authority_epoch:1,
      checkpoint:{ cursor:2 }, checkpoint_sha256:sha('f'), updated_at:'2026-09-01T18:06:00.000Z',
    });
    assert.deepEqual(checkpoint2.checkpoint, { cursor:2 });

    await store.heartbeatExecution({ subject_key:first.subject_key, lease_ref:'lease-1', authority_epoch:1, progress_sha256:sha('1'), expires_at:'2026-09-01T18:31:00.000Z', heartbeat_at:'2026-09-01T18:10:00.000Z' });
    await store.heartbeatExecution({ subject_key:first.subject_key, lease_ref:'lease-1', authority_epoch:1, progress_sha256:sha('2'), expires_at:'2026-09-01T18:32:00.000Z', heartbeat_at:'2026-09-01T18:11:00.000Z' });
    const heartbeat = await store.heartbeatExecution({ subject_key:first.subject_key, lease_ref:'lease-1', authority_epoch:1, progress_sha256:sha('3'), expires_at:'2026-09-01T18:33:00.000Z', heartbeat_at:'2026-09-01T18:12:00.000Z' });
    assert.deepEqual(heartbeat.recent_progress_sha256, [sha('2'), sha('3')]);
    assert.equal(heartbeat.heartbeat_count, 3);

    const operationInput = {
      operation_id:'00000000-0000-0000-0000-000000000001',
      command:'github.apply_changeset', idempotency_scope:'repository:laurajoyhutchins/overcenter', idempotency_key:'idem-1',
      request_sha256:sha('4'), subject_key:first.subject_key, run_id:'run-1', lease_epoch:1,
      authority_revision:'a'.repeat(40), recovery_payload:{ repository:'laurajoyhutchins/overcenter' }, created_at:'2026-09-01T18:12:00.000Z',
    };
    const prepared = await store.prepareOperation(operationInput);
    const replay = await store.prepareOperation({ ...operationInput, operation_id:'00000000-0000-0000-0000-000000000002' });
    assert.equal(replay.operation_id, prepared.operation_id);
    await assert.rejects(
      store.prepareOperation({ ...operationInput, operation_id:'00000000-0000-0000-0000-000000000003', request_sha256:sha('5') }),
      (error) => error?.code === 'OPERATION_IDEMPOTENCY_CONFLICT',
    );
    const indeterminate = await store.markOperationIndeterminate({ operation_id:prepared.operation_id, recovery_payload:{ repository:'laurajoyhutchins/overcenter', branch:'attempt' } });
    assert.equal(indeterminate.state, 'indeterminate');
    await assert.rejects(
      store.resolveOperation({ operation_id:prepared.operation_id, state:'succeeded', may_have_mutated:true, effect_kind:'github_commit', effect_ref:null, effect_sha256:null, result_sha256:null, resolution:null, resolved_at:'2026-09-01T18:13:00.000Z' }),
      (error) => error?.code === 'OPERATION_EFFECT_UNPROVEN',
    );
    const resolved = await store.resolveOperation({ operation_id:prepared.operation_id, state:'succeeded', may_have_mutated:true, effect_kind:'github_commit', effect_ref:'commit:abc', effect_sha256:sha('6'), result_sha256:sha('7'), resolution:{ kind:'readback_match' }, resolved_at:'2026-09-01T18:13:00.000Z' });
    assert.equal(resolved.state, 'succeeded');
    assert.equal(resolved.recovery_payload, null);

    const proofInput = {
      proof_key:'required-checks:head', subject_key:first.subject_key, predicate_kind:'required_checks_satisfied',
      authority_repository:'laurajoyhutchins/overcenter', authority_revision:'a'.repeat(40), evidence_sha256:sha('8'),
      evidence_refs:[{ kind:'github_check_suite', ref:'checks:1234' }], satisfied_at:'2026-09-01T18:14:00.000Z', consumed_at:null,
    };
    const proof = await store.putProof(proofInput);
    assert.equal(proof.authority_revision, 'a'.repeat(40));
    assert.equal((await store.putProof(proofInput)).evidence_sha256, sha('8'));
    await assert.rejects(
      store.putProof({ ...proofInput, authority_revision:'b'.repeat(40) }),
      (error) => error?.code === 'PROOF_STATE_CONFLICT',
    );

    const settled = await store.settleExecution({
      subject_key:first.subject_key, lease_ref:'lease-1', authority_epoch:1,
      continuation:{ next:'confirm' }, continuation_sha256:sha('9'), continuation_execution_fingerprint:sha('a'),
      no_progress_streak:0, updated_at:'2026-09-01T18:20:00.000Z',
    });
    assert.equal(settled.lease_ref, null);
    assert.equal(settled.authority_epoch, 1);

    const second = await store.acquireExecution(acquisition({
      lease_ref:'lease-2', run_id:'run-2', authority_revision:'b'.repeat(40), observed_at:'2026-09-01T18:21:00.000Z',
    }));
    assert.equal(second.authority_epoch, 2);
    await assert.rejects(
      store.settleExecution({ subject_key:first.subject_key, lease_ref:'lease-1', authority_epoch:1, continuation:null, continuation_sha256:null, continuation_execution_fingerprint:null, no_progress_streak:0, updated_at:'2026-09-01T18:22:00.000Z' }),
      (error) => error?.code === 'EXECUTION_AUTHORITY_STALE',
    );

    await store.compactRun({ run_id:'run-1', active_subject_key:null, unresolved_operation_id:null, final_effect_refs:['commit:abc'], final_evidence_sha256:sha('b') });
    const run = await client.query("SELECT final_effect_refs, final_evidence_sha256 FROM orchestration_runs WHERE run_id='run-1'");
    assert.deepEqual(run.rows[0].final_effect_refs, ['commit:abc']);
    assert.equal(run.rows[0].final_evidence_sha256, sha('b'));
  } finally {
    await client.query('DROP TABLE IF EXISTS proof_state, operation_state, execution_state, orchestration_runs CASCADE');
    await client.end();
  }
});
