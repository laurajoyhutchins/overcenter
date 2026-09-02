import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import { createProjectTransitionLeasePostgresStore } from '../lib/project-transition-lease-store.js';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'project_transition_compact_authority_test';

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

function transactionalBinding(client) {
  return {
    query(text, values) {
      return client.query(text, values);
    },
    async transaction(steps) {
      await client.query('BEGIN');
      try {
        const results = [];
        for (const step of steps) results.push(await client.query(step.sql, step.params));
        await client.query('COMMIT');
        return { results };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  };
}

async function prepareSchema(client) {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query(await migration('025_orchestration_runs.sql'));
  await client.query(`
    CREATE TABLE work_leases (
      lease_id uuid PRIMARY KEY,
      work_ref text NOT NULL,
      gate text NOT NULL,
      run_id text NOT NULL REFERENCES orchestration_runs(run_id),
      lease_token text NOT NULL,
      token_hash text NOT NULL,
      claim_idempotency_key text NOT NULL UNIQUE,
      claim_request_hash text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      previous_state text,
      previous_state_id text,
      previous_lane text,
      previous_lane_id text,
      claim_revision text,
      active_revision text,
      claim_receipt jsonb,
      claim_request jsonb,
      hard_expires_at timestamptz,
      settle_idempotency_key text,
      settle_plan jsonb,
      settle_receipt jsonb,
      settled_at timestamptz,
      reconciliation jsonb,
      last_heartbeat_at timestamptz,
      heartbeat_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE work_lease_slots (
      work_ref text NOT NULL,
      gate text NOT NULL,
      lease_id uuid NOT NULL REFERENCES work_leases(lease_id),
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (work_ref, gate)
    );
  `);
  await client.query(await migration('053_execution_state.sql'));
  await client.query(await migration('054_operation_state.sql'));
}

async function seedRun(client, runId) {
  await client.query(
    `INSERT INTO orchestration_runs (
       run_id,worker,mode,continuation_key,scope,scope_sha256,deadline_at
     ) VALUES ($1,'repository-implementation','scheduled','cycle','{}'::jsonb,$2,$3)`,
    [runId, 'a'.repeat(64), '2026-09-01T23:00:00.000Z'],
  );
}

function leaseRow({ leaseId, runId, idempotencyKey }) {
  return {
    lease_id:leaseId,
    run_id:runId,
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'ship',
    repository:'laurajoyhutchins/overcenter',
    authority_revision:'b'.repeat(40),
    authority_derivation:'overcenter-project-graph-v1',
    graph_fingerprint:'c'.repeat(64),
    transition_definition_fingerprint:'d'.repeat(64),
    transition_revision_fingerprint:'e'.repeat(64),
    transition_dependency_fingerprint:'f'.repeat(64),
    slot_key:'project_transition:github:laurajoyhutchins/overcenter:ship',
    status:'active',
    created_at:'2026-09-01T21:00:00.000Z',
    expires_at:'2026-09-01T21:30:00.000Z',
    hard_expires_at:'2026-09-01T22:30:00.000Z',
    acquire_idempotency_key:idempotencyKey,
    acquire_request_hash:'1'.repeat(64),
  };
}

function settlement(row, authorityEpoch, key) {
  return {
    lease_id:row.lease_id,
    slot_key:row.slot_key,
    run_id:row.run_id,
    authority_epoch:authorityEpoch,
    project_ref:row.project_ref,
    transition_id:row.transition_id,
    repository:row.repository,
    authority_revision:row.authority_revision,
    authority_derivation:row.authority_derivation,
    graph_fingerprint:row.graph_fingerprint,
    transition_definition_fingerprint:row.transition_definition_fingerprint,
    transition_revision_fingerprint:row.transition_revision_fingerprint,
    transition_dependency_fingerprint:row.transition_dependency_fingerprint,
    disposition:'completed',
    settle_idempotency_key:key,
    settled_at:'2026-09-01T21:10:00.000Z',
    graph_revision_change:null,
  };
}

test('project transition bridge advances and enforces compact authority epochs atomically', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await prepareSchema(client);
    const runId = 'scheduled:2026-09-01T21:00Z:repository-implementation';
    await seedRun(client, runId);
    const store = createProjectTransitionLeasePostgresStore(transactionalBinding(client), {
      capabilityFactory:() => 'ptl_test_capability',
    });

    const firstInput = leaseRow({
      leaseId:'11111111-1111-4111-8111-111111111111',
      runId,
      idempotencyKey:'acquire-1',
    });
    const first = await store.acquireLeaseAtomically(firstInput);
    assert.equal(first.authority_epoch, 1);
    assert.equal(first.lease_id, firstInput.lease_id);

    let execution = await store.getExecutionState(firstInput.slot_key);
    assert.equal(execution.authority_epoch, 1);
    assert.equal(execution.lease_ref, firstInput.lease_id);
    assert.equal(execution.run_id, runId);
    const slot1 = await store.getSlot(firstInput.slot_key);
    assert.equal(slot1.lease_id, firstInput.lease_id);

    const settled1 = await store.settleLeaseAtomically(settlement(firstInput, 1, 'settle-1'));
    assert.equal(settled1.status, 'settled');
    execution = await store.getExecutionState(firstInput.slot_key);
    assert.equal(execution.authority_epoch, 1);
    assert.equal(execution.lease_ref, null);
    assert.equal(await store.getSlot(firstInput.slot_key), null);

    const secondInput = leaseRow({
      leaseId:'22222222-2222-4222-8222-222222222222',
      runId,
      idempotencyKey:'acquire-2',
    });
    const second = await store.acquireLeaseAtomically(secondInput);
    assert.equal(second.authority_epoch, 2);
    execution = await store.getExecutionState(secondInput.slot_key);
    assert.equal(execution.authority_epoch, 2);
    assert.equal(execution.lease_ref, secondInput.lease_id);

    await assert.rejects(
      store.settleLeaseAtomically(settlement(secondInput, 1, 'settle-stale')),
      error => error?.code === 'PROJECT_TRANSITION_LEASE_STALE' || error?.code === '22012',
    );
    execution = await store.getExecutionState(secondInput.slot_key);
    assert.equal(execution.authority_epoch, 2);
    assert.equal(execution.lease_ref, secondInput.lease_id);
    assert.equal((await store.getLease(secondInput.lease_id)).status, 'active');
    assert.equal((await store.getSlot(secondInput.slot_key)).lease_id, secondInput.lease_id);

    const settled2 = await store.settleLeaseAtomically(settlement(secondInput, 2, 'settle-2'));
    assert.equal(settled2.status, 'settled');
    execution = await store.getExecutionState(secondInput.slot_key);
    assert.equal(execution.authority_epoch, 2);
    assert.equal(execution.lease_ref, null);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

test('project transition progress and continuation use compact state with legacy history tables absent', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await prepareSchema(client);
    const missing = await client.query(
      `SELECT to_regclass('work_lease_checkpoints') AS checkpoints,
              to_regclass('work_lease_heartbeats') AS heartbeats`,
    );
    assert.equal(missing.rows[0].checkpoints, null);
    assert.equal(missing.rows[0].heartbeats, null);

    const runId = 'scheduled:2026-09-01T22:00Z:repository-implementation';
    await seedRun(client, runId);
    const store = createProjectTransitionLeasePostgresStore(transactionalBinding(client), {
      capabilityFactory:() => 'ptl_progress_capability',
    });
    const firstInput = leaseRow({
      leaseId:'33333333-3333-4333-8333-333333333333',
      runId,
      idempotencyKey:'acquire-progress-1',
    });
    const first = await store.acquireLeaseAtomically(firstInput);
    assert.equal(first.authority_epoch, 1);

    const checkpoint = { cursor:1, phase:'execute' };
    const checkpointSaved = await store.insertCheckpoint(
      firstInput.lease_id,
      'checkpoint-1',
      '2'.repeat(64),
      checkpoint,
      '3'.repeat(64),
      '2026-09-01T21:01:00.000Z',
    );
    assert.equal(checkpointSaved.checkpoint_sha256, '3'.repeat(64));
    assert.deepEqual((await store.getLatestCheckpoint(firstInput.lease_id)).checkpoint, checkpoint);

    const heartbeat = await store.extendLeaseWithHeartbeat({
      lease_id:firstInput.lease_id,
      slot_key:firstInput.slot_key,
      authority_epoch:1,
      idempotency_key:'heartbeat-1',
      request_sha256:'4'.repeat(64),
      progress_sha256:'3'.repeat(64),
      previous_expires_at:firstInput.expires_at,
      new_expires_at:'2026-09-01T21:40:00.000Z',
      created_at:'2026-09-01T21:02:00.000Z',
    });
    assert.equal(heartbeat.progress_sha256, '3'.repeat(64));
    assert.equal(heartbeat.heartbeat_count, 1);

    let execution = await store.getExecutionState(firstInput.slot_key);
    assert.equal(execution.checkpoint_sha256, '3'.repeat(64));
    assert.deepEqual(execution.recent_progress_sha256, ['3'.repeat(64)]);
    assert.equal(execution.heartbeat_count, 1);
    assert.equal(new Date(execution.last_heartbeat_at).toISOString(), '2026-09-01T21:02:00.000Z');

    const recent = await store.listRecentHeartbeats(firstInput.lease_id, 2);
    assert.deepEqual(recent.map((entry) => entry.progress_sha256), ['3'.repeat(64)]);
    const replay = await store.getHeartbeatByIdempotency(firstInput.lease_id, 'heartbeat-1');
    assert.equal(replay.request_sha256, '4'.repeat(64));
    assert.equal(replay.new_expires_at, '2026-09-01T21:40:00.000Z');

    await store.settleLeaseAtomically(settlement(firstInput, 1, 'settle-progress-1'));
    execution = await store.getExecutionState(firstInput.slot_key);
    assert.equal(execution.lease_ref, null);
    assert.deepEqual(execution.continuation, checkpoint);
    assert.equal(execution.continuation_sha256, '3'.repeat(64));
    assert.match(execution.continuation_execution_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(execution.no_progress_streak, 0);

    await client.query('DELETE FROM work_leases WHERE lease_id=$1', [firstInput.lease_id]);
    assert.equal(await store.getLease(firstInput.lease_id), null);

    const secondInput = leaseRow({
      leaseId:'44444444-4444-4444-8444-444444444444',
      runId,
      idempotencyKey:'acquire-progress-2',
    });
    const second = await store.acquireLeaseAtomically(secondInput);
    assert.equal(second.authority_epoch, 2);
    execution = await store.getExecutionState(secondInput.slot_key);
    assert.deepEqual(execution.continuation, checkpoint);
    assert.equal(execution.continuation_sha256, '3'.repeat(64));
    const continuationFingerprint = execution.continuation_execution_fingerprint;

    await store.insertCheckpoint(
      secondInput.lease_id,
      'checkpoint-2',
      '5'.repeat(64),
      checkpoint,
      '3'.repeat(64),
      '2026-09-01T21:03:00.000Z',
    );
    await store.settleLeaseAtomically(settlement(secondInput, 2, 'settle-progress-2'));
    execution = await store.getExecutionState(secondInput.slot_key);
    assert.equal(execution.continuation_execution_fingerprint, continuationFingerprint);
    assert.equal(execution.no_progress_streak, 1);

    const thirdInput = leaseRow({
      leaseId:'55555555-5555-4555-8555-555555555555',
      runId,
      idempotencyKey:'acquire-progress-3',
    });
    const third = await store.acquireLeaseAtomically(thirdInput);
    assert.equal(third.authority_epoch, 3);
    await store.insertCheckpoint(
      thirdInput.lease_id,
      'checkpoint-3',
      '6'.repeat(64),
      checkpoint,
      '3'.repeat(64),
      '2026-09-01T21:04:00.000Z',
    );
    await store.settleLeaseAtomically(settlement(thirdInput, 3, 'settle-progress-3'));
    execution = await store.getExecutionState(thirdInput.slot_key);
    assert.equal(execution.no_progress_streak, 2);
    assert.deepEqual(execution.continuation, checkpoint);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
