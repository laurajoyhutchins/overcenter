import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import { createCompactProviderOperationPostgresStore } from '../lib/compact-provider-operation-store.js';
import { createCompactGithubChangesetReceiptStore } from '../lib/compact-github-changeset-receipt-store.js';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'compact_provider_operations_test';

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

function binding(client) {
  return { query:(text, values) => client.query(text, values) };
}

async function prepareSchema(client) {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query(await migration('025_orchestration_runs.sql'));
  await client.query(await migration('053_execution_state.sql'));
  await client.query(await migration('054_operation_state.sql'));
  await client.query(await migration('057_operation_state_updated_at.sql'));
}

test('provider mutation idempotency and recovery use operation_state with bespoke receipt tables absent', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await prepareSchema(client);
    const absent = await client.query(`
      SELECT to_regclass('github_changeset_receipts') AS changesets,
             to_regclass('github_release_receipts') AS releases,
             to_regclass('github_production_promotion_receipts') AS promotions,
             to_regclass('portfolio_reconcile_receipts') AS reconciles
    `);
    assert.deepEqual(absent.rows[0], { changesets:null, releases:null, promotions:null, reconciles:null });

    const store = createCompactProviderOperationPostgresStore(binding(client));
    const command = 'github.apply_changeset';
    const scope = 'repository:laurajoyhutchins/overcenter';
    const requestSha = 'a'.repeat(64);

    const first = await store.claim({ command, scope, idempotency_key:'changeset-1', request_sha256:requestSha, attempt_token:'attempt-1', created_at:'2026-09-01T21:00:00.000Z', stale_before:'2026-09-01T20:55:00.000Z', recovery_payload:{ phase:'claim' } });
    assert.equal(first.outcome, 'claimed');
    assert.equal(first.operation.state, 'prepared');
    assert.equal(first.operation.recovery_payload.attempt_token, 'attempt-1');

    const inProgress = await store.claim({ command, scope, idempotency_key:'changeset-1', request_sha256:requestSha, attempt_token:'attempt-2', created_at:'2026-09-01T21:01:00.000Z', stale_before:'2026-09-01T20:59:00.000Z', recovery_payload:{ phase:'claim' } });
    assert.equal(inProgress.outcome, 'in_progress');
    assert.equal(inProgress.operation.recovery_payload.attempt_token, 'attempt-1');

    const conflict = await store.claim({ command, scope, idempotency_key:'changeset-1', request_sha256:'b'.repeat(64), attempt_token:'attempt-conflict', created_at:'2026-09-01T21:01:30.000Z', stale_before:'2026-09-01T20:59:30.000Z', recovery_payload:{ phase:'claim' } });
    assert.equal(conflict.outcome, 'conflict');

    const takeover = await store.claim({ command, scope, idempotency_key:'changeset-1', request_sha256:requestSha, attempt_token:'attempt-2', created_at:'2026-09-01T21:10:00.000Z', stale_before:'2026-09-01T21:05:00.000Z', recovery_payload:{ phase:'recovered-claim' } });
    assert.equal(takeover.outcome, 'claimed');
    assert.equal(takeover.recovered, true);
    assert.equal(takeover.operation.recovery_payload.attempt_token, 'attempt-2');

    assert.equal(await store.heartbeat({ command, scope, idempotency_key:'changeset-1', attempt_token:'attempt-1', updated_at:'2026-09-01T21:11:00.000Z', phase:'stale-owner' }), false);
    assert.equal(await store.heartbeat({ command, scope, idempotency_key:'changeset-1', attempt_token:'attempt-2', updated_at:'2026-09-01T21:11:00.000Z', phase:'prepare-effect' }), true);

    const indeterminate = await store.markIndeterminate({ command, scope, idempotency_key:'changeset-1', attempt_token:'attempt-2', updated_at:'2026-09-01T21:12:00.000Z', recovery_payload:{ phase:'prepared', branch_name:'overcenter/test', base_sha:'c'.repeat(40), commit_sha:'d'.repeat(40) } });
    assert.equal(indeterminate.state, 'indeterminate');
    assert.equal(indeterminate.may_have_mutated, true);
    assert.equal(indeterminate.recovery_payload.commit_sha, 'd'.repeat(40));

    const succeeded = await store.succeed({ command, scope, idempotency_key:'changeset-1', attempt_token:'attempt-2', updated_at:'2026-09-01T21:13:00.000Z', effect_kind:'github_commit_branch', effect_ref:'overcenter/test@' + 'd'.repeat(40), effect_sha256:'e'.repeat(64), result_sha256:'f'.repeat(64), resolution:{ branch_name:'overcenter/test', commit_sha:'d'.repeat(40) } });
    assert.equal(succeeded.state, 'succeeded');
    assert.equal(succeeded.recovery_payload, null);

    const replay = await store.claim({ command, scope, idempotency_key:'changeset-1', request_sha256:requestSha, attempt_token:'attempt-3', created_at:'2026-09-01T21:14:00.000Z', stale_before:'2026-09-01T21:09:00.000Z', recovery_payload:{ phase:'claim' } });
    assert.equal(replay.outcome, 'terminal');
    assert.equal(replay.operation.state, 'succeeded');
    assert.equal(replay.operation.effect_kind, 'github_commit_branch');
    assert.equal(replay.operation.resolution.commit_sha, 'd'.repeat(40));
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

test('changeset compatibility receipts recover prepared work from operation_state only', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await prepareSchema(client);
    const times = [
      '2026-09-01T22:00:00.000Z',
      '2026-09-01T22:00:01.000Z',
      '2026-09-01T22:00:02.000Z',
      '2026-09-01T22:00:03.000Z',
      '2026-09-01T22:00:04.000Z',
      '2026-09-01T22:00:05.000Z',
      '2026-09-01T22:00:06.000Z',
    ];
    const receipts = createCompactGithubChangesetReceiptStore(binding(client), { now:() => times.shift() || '2026-09-01T22:00:07.000Z' });
    const normalized = {
      repo:'laurajoyhutchins/overcenter',
      branch:'feat/compact-receipts',
      idempotency_key:'changeset-compat-1',
      base_sha:'1'.repeat(40),
      base_ref:null,
      expected_head:null,
      commit_message:'test compact receipts',
      changes:[{ path:'README.md', operation:'update', content:'x' }],
      lease_token:null,
    };
    const digest = '9'.repeat(64);
    const claimed = await receipts.claim(normalized, digest, 'attempt-a');
    assert.equal(claimed.kind, 'claimed');
    assert.equal(claimed.row.state, 'processing');

    await receipts.savePlan(normalized, 'attempt-a', {
      baseSha:'1'.repeat(40),
      oldHead:'1'.repeat(40),
      createdBranch:false,
      preconditionVerified:false,
      changedPaths:[{ path:'README.md', operation:'update' }],
    });
    await receipts.saveTree(normalized, 'attempt-a', '2'.repeat(40));
    await receipts.saveCommit(normalized, 'attempt-a', '3'.repeat(40));

    const prepared = await receipts.claim(normalized, digest, 'attempt-b');
    assert.equal(prepared.kind, 'existing');
    assert.equal(prepared.row.state, 'prepared');
    assert.equal(prepared.row.base_sha, '1'.repeat(40));
    assert.equal(prepared.row.tree_sha, '2'.repeat(40));
    assert.equal(prepared.row.commit_sha, '3'.repeat(40));
    assert.deepEqual(prepared.row.changed_paths, [{ path:'README.md', operation:'update' }]);
    assert.equal(prepared.row.attempt_token, 'attempt-a');

    const receipt = { ok:true, repo:normalized.repo, branch:normalized.branch, commit_sha:'3'.repeat(40), idempotent_replay:true };
    assert.equal(await receipts.succeed(normalized, 'attempt-b', receipt), false);
    const stillPrepared = await receipts.claim(normalized, digest, 'attempt-c');
    assert.equal(stillPrepared.kind, 'existing');
    assert.equal(stillPrepared.row.state, 'prepared');
    assert.equal(await receipts.succeed(normalized, prepared.row.attempt_token, receipt), true);
    const succeeded = await receipts.claim(normalized, digest, 'attempt-c');
    assert.equal(succeeded.kind, 'existing');
    assert.equal(succeeded.row.state, 'succeeded');
    assert.deepEqual(succeeded.row.receipt, receipt);

    const tables = await client.query(`SELECT to_regclass('github_changeset_receipts') AS changesets`);
    assert.equal(tables.rows[0].changesets, null);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
