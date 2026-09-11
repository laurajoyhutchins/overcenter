import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {
  createNodePostgresTransactionExecutor,
} from '../dist/portable/adapters/postgres/node-postgres-runtime.js';
import {
  createPostgresExecutionTransactionStore,
} from '../dist/portable/adapters/postgres/execution-transaction-store.js';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'execution_transaction_store_test';

async function migration(name) {
  return readFile(new URL(`migrations/${name}`, root), 'utf8');
}

function postgresClient() {
  return new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'overcenter',
    user: process.env.PGUSER || 'overcenter',
    password: process.env.PGPASSWORD || 'overcenter',
  });
}

function identity() {
  return {
    execution_id: 'execution-1',
    operation_id: '00000000-0000-0000-0000-000000000001',
    project_ref: 'github:laurajoyhutchins/overcenter',
    subject_key: 'project:overcenter#transition:ship',
    subject_kind: 'project_transition',
    run_id: 'run-1',
    lease_ref: '00000000-0000-4000-8000-000000000001',
    lease_epoch: 1,
    authority_epoch: 1,
    authority_repository: 'laurajoyhutchins/overcenter',
    authority_revision: 'a'.repeat(40),
    graph_fingerprint: 'graph-hash',
    transition_fingerprint: 'transition-hash',
    operation_kind: 'github.apply_changeset',
    idempotency_scope: 'repository:laurajoyhutchins/overcenter',
    idempotency_key: 'intent-1',
    intent_sha256: 'intent-hash',
  };
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
    '060_execution_transaction_identity.sql',
  ]) {
    await client.query(await migration(name));
  }
}

async function seedRun(client) {
  await client.query(
    `INSERT INTO orchestration_runs (
       run_id, worker, mode, continuation_key, scope, scope_sha256, deadline_at
     ) VALUES ('run-1', 'repository-implementation', 'scheduled', 'cycle', '{}'::jsonb, $1, now() + interval '1 hour')`,
    ['b'.repeat(64)],
  );
}

test('postgres transaction store fences claims and binds proof to exact execution identity', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await prepareSchema(client);
    await seedRun(client);
    const store = createPostgresExecutionTransactionStore(createNodePostgresTransactionExecutor(client));
    const exactIdentity = identity();

    const prepared = await store.prepareExecution({
      identity: exactIdentity,
      lifecycle: 'prepared',
    });
    assert.equal(prepared.lifecycle, 'prepared');

    const claimed = await store.claimExecution({
      execution_id: exactIdentity.execution_id,
      lease_ref: exactIdentity.lease_ref,
      lease_epoch: exactIdentity.lease_epoch,
      authority_epoch: exactIdentity.authority_epoch,
      lease_expires_at: '2999-01-01T00:00:00.000Z',
    });
    assert.equal(claimed.kind, 'claimed');

    const busy = await store.claimExecution({
      execution_id: exactIdentity.execution_id,
      lease_ref: '00000000-0000-4000-8000-000000000002',
      lease_epoch: 2,
      authority_epoch: exactIdentity.authority_epoch,
      lease_expires_at: '2999-01-01T00:00:00.000Z',
    });
    assert.equal(busy.kind, 'busy');

    await store.recordAttempt({
      identity: exactIdentity,
      attempt_epoch: 1,
      request_sha256: 'c'.repeat(64),
    });
    await store.recordInvocation({
      identity: exactIdentity,
      attempt_epoch: 1,
      facts: {
        transport: 'unknown',
        committed: null,
        effect_ref: null,
        response_sha256: null,
        evidence: null,
      },
    });

    await assert.rejects(
      store.appendProof({
        proof_id: 'proof-1',
        execution_id: exactIdentity.execution_id,
        operation_id: exactIdentity.operation_id,
        attempt_epoch: 1,
        authority_repository: exactIdentity.authority_repository,
        authority_revision: 'b'.repeat(40),
        authority_epoch: exactIdentity.authority_epoch,
        predicate: 'exact-effect',
        evidence_sha256: 'd'.repeat(64),
        evidence: {},
      }),
      /PROOF_AUTHORITY_REVISION_MISMATCH/,
    );

    await assert.rejects(
      store.settleExecution({
        identity: exactIdentity,
        attempt_epoch: 1,
        disposition: 'completed',
        effect_ref: null,
        evidence_sha256: 'd'.repeat(64),
      }),
      /UNCERTAIN|MUTATION/,
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
