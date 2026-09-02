import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {
  createNodePostgresTransactionExecutor,
} from '../dist/portable/adapters/postgres/node-postgres-runtime.js';
import {
  createPostgresCompactExecutionStateStore,
} from '../dist/portable/adapters/postgres/compact-execution-state-store.js';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'compact_execution_state_store_test';
const LEASE_ONE = '00000000-0000-4000-8000-000000000011';
const LEASE_TWO = '00000000-0000-4000-8000-000000000012';
const LEASE_OPERATION = '00000000-0000-4000-8000-000000000013';

async function migration(name) {
  return readFile(new URL(`migrations/${name}`, root), 'utf8');
}

function postgresClient() {
  return new Client({
    host:process.env.PGHOST || '127.0.0.1',
    port:Number(process.env.PGPORT || 5432),
    database:process.env.PGDATABASE || 'overcenter',
    user:process.env.PGUSER || 'overcenter',
    password:process.env.PGPASSWORD || 'overcenter',
  });
}

async function prepareSchema(client) {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  for (const name of [
    '025_orchestration_runs.sql',
    '053_execution_state.sql',
    '054_operation_state.sql',
    '055_proof_state.sql',
    '056_orchestration_run_compaction.sql',
  ]) await client.query(await migration(name));
}

async function seedRun(client, runId) {
  await client.query(
    `INSERT INTO orchestration_runs (
       run_id,worker,mode,continuation_key,scope,scope_sha256,deadline_at
     ) VALUES ($1,'repository-implementation','scheduled','cycle','{}'::jsonb,$2,now()+interval '1 hour')`,
    [runId, 'a'.repeat(64)],
  );
}

function acquisition(runId, leaseRef) {
  return {
    subject_key:'project:overcenter#transition:ship',
    subject_kind:'project_transition',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'ship',
    lease_ref:leaseRef,
    run_id:runId,
    authority_repository:'laurajoyhutchins/overcenter',
    authority_revision:'b'.repeat(40),
    graph_fingerprint:'c'.repeat(64),
    transition_revision_fingerprint:'d'.repeat(64),
    transition_dependency_fingerprint:'e'.repeat(64),
    expires_at:'2026-09-01T20:30:00.000Z',
    hard_expires_at:'2026-09-01T20:45:00.000Z',
    active_capability_material:'opaque-capability',
  };
}

test('compact postgres store fences execution and keeps only current progress state', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await prepareSchema(client);
    const runId = 'scheduled:2026-09-01T20:00Z:repository-implementation';
    await seedRun(client, runId);
    const store = createPostgresCompactExecutionStateStore(createNodePostgresTransactionExecutor(client));

    const first = await store.acquireExecution(acquisition(runId, LEASE_ONE));
    assert.equal(first.authority_epoch, 1);
    assert.equal(first.lease_ref, LEASE_ONE);

    const checkpointed = await store.writeCheckpoint({
      subject_key:first.subject_key,
      lease_ref:LEASE_ONE,
      authority_epoch:1,
      checkpoint:{ cursor:2 },
      checkpoint_sha256:'f'.repeat(64),
      updated_at:'2026-09-01T20:05:00.000Z',
    });
    assert.deepEqual(checkpointed.checkpoint, { cursor:2 });

    for (const [index, hash] of ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)].entries()) {
      await store.heartbeatExecution({
        subject_key:first.subject_key,
        lease_ref:LEASE_ONE,
        authority_epoch:1,
        progress_sha256:hash,
        expires_at:`2026-09-01T20:${10 + index}:00.000Z`,
        heartbeat_at:`2026-09-01T20:0${6 + index}:00.000Z`,
      });
    }
    const progressed = await store.getExecution(first.subject_key);
    assert.deepEqual(progressed.recent_progress_sha256, ['2'.repeat(64), '3'.repeat(64)]);
    assert.equal(progressed.heartbeat_count, 3);

    const settled = await store.settleExecution({
      subject_key:first.subject_key,
      lease_ref:LEASE_ONE,
      authority_epoch:1,
      continuation:{ next:'confirm' },
      continuation_sha256:'4'.repeat(64),
      continuation_execution_fingerprint:'5'.repeat(64),
      no_progress_streak:1,
      updated_at:'2026-09-01T20:10:00.000Z',
    });
    assert.equal(settled.lease_ref, null);
    assert.deepEqual(settled.continuation, { next:'confirm' });

    const second = await store.acquireExecution(acquisition(runId, LEASE_TWO));
    assert.equal(second.authority_epoch, 2);
    assert.equal(second.lease_ref, LEASE_TWO);

    await assert.rejects(
      store.settleExecution({
        subject_key:first.subject_key,
        lease_ref:LEASE_ONE,
        authority_epoch:1,
        continuation:null,
        continuation_sha256:null,
        continuation_execution_fingerprint:null,
        no_progress_streak:0,
        updated_at:'2026-09-01T20:11:00.000Z',
      }),
      error => error?.code === 'EXECUTION_AUTHORITY_STALE',
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

test('compact postgres store enforces idempotency and exact proof lookup', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await prepareSchema(client);
    const runId = 'scheduled:2026-09-01T21:00Z:repository-implementation';
    await seedRun(client, runId);
    const store = createPostgresCompactExecutionStateStore(createNodePostgresTransactionExecutor(client));
    const execution = await store.acquireExecution(acquisition(runId, LEASE_OPERATION));

    const prepared = await store.prepareOperation({
      operation_id:'00000000-0000-0000-0000-000000000010',
      command:'github.apply_changeset',
      idempotency_scope:'repository:laurajoyhutchins/overcenter',
      idempotency_key:'idem-1',
      request_sha256:'6'.repeat(64),
      subject_key:execution.subject_key,
      run_id:runId,
      lease_epoch:execution.authority_epoch,
      authority_revision:'b'.repeat(40),
      created_at:'2026-09-01T21:01:00.000Z',
    });
    assert.equal(prepared.state, 'prepared');

    const replay = await store.prepareOperation({ ...prepared, created_at:'2026-09-01T21:02:00.000Z' });
    assert.equal(replay.operation_id, prepared.operation_id);

    await assert.rejects(
      store.prepareOperation({ ...prepared, request_sha256:'7'.repeat(64) }),
      error => error?.code === 'OPERATION_IDEMPOTENCY_CONFLICT',
    );

    const uncertain = await store.markOperationIndeterminate({
      operation_id:prepared.operation_id,
      recovery_payload:{ repository:'laurajoyhutchins/overcenter' },
      effect_kind:'github_commit',
      effect_ref:null,
      effect_sha256:null,
    });
    assert.equal(uncertain.state, 'indeterminate');
    assert.equal(uncertain.may_have_mutated, true);

    const resolved = await store.resolveOperation({
      operation_id:prepared.operation_id,
      state:'succeeded',
      may_have_mutated:true,
      effect_kind:'github_commit',
      effect_ref:'commit:abc',
      effect_sha256:'8'.repeat(64),
      result_sha256:'9'.repeat(64),
      resolution:{ source:'authoritative_readback' },
      resolved_at:'2026-09-01T21:03:00.000Z',
    });
    assert.equal(resolved.state, 'succeeded');
    assert.equal(resolved.recovery_payload, null);

    await store.putProof({
      proof_key:'checks:exact-head',
      subject_key:execution.subject_key,
      predicate_kind:'required_checks_satisfied',
      authority_repository:'laurajoyhutchins/overcenter',
      authority_revision:'b'.repeat(40),
      evidence_sha256:'0'.repeat(64),
      evidence_refs:[{ kind:'github_check_suite', ref:'checks:1234' }],
      satisfied_at:'2026-09-01T21:04:00.000Z',
      consumed_at:null,
    });
    const proof = await store.getProof('checks:exact-head');
    assert.equal(proof.authority_revision, 'b'.repeat(40));
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
