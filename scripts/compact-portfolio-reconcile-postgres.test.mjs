import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import { createCompactPortfolioReconcileReceiptStore } from '../lib/compact-portfolio-reconcile-receipt-store.js';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'compact_portfolio_reconcile_test';

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

test('portfolio reconcile idempotency survives with its bespoke receipt table physically absent', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await prepareSchema(client);
    const tables = await client.query(`SELECT to_regclass('portfolio_reconcile_receipts') AS receipts`);
    assert.equal(tables.rows[0].receipts, null);

    const times = [
      '2026-09-01T20:00:00.000Z',
      '2026-09-01T20:00:01.000Z',
      '2026-09-01T20:00:02.000Z',
      '2026-09-01T20:00:03.000Z',
      '2026-09-01T20:00:04.000Z',
      '2026-09-01T20:00:05.000Z',
      '2026-09-01T20:00:06.000Z',
      '2026-09-01T20:00:07.000Z',
      '2026-09-01T20:00:08.000Z',
      '2026-09-01T20:00:09.000Z',
    ];
    const store = createCompactPortfolioReconcileReceiptStore(binding(client), {
      now:() => times.shift() || '2026-09-01T20:00:10.000Z',
    });
    const key = 'portfolio-reconcile-compact-1';
    const requestSha = 'a'.repeat(64);

    const claimed = await store.claim(key, requestSha);
    assert.equal(claimed.kind, 'claimed');
    assert.deepEqual(claimed.progress, {
      version:'portfolio-reconcile-progress-v1',
      may_have_mutated:false,
      items:[],
    });

    const conflict = await store.claim(key, 'b'.repeat(64));
    assert.equal(conflict.kind, 'conflict');

    const preEffect = {
      version:'portfolio-reconcile-progress-v1',
      may_have_mutated:false,
      items:[{ index:0, phase:'linear.create.pending', may_have_mutated:false }],
    };
    await store.checkpoint(key, requestSha, 'linear.create.pending', preEffect);
    let operation = (await client.query(`SELECT * FROM operation_state WHERE idempotency_key=$1`, [key])).rows[0];
    assert.equal(operation.state, 'prepared');
    assert.equal(operation.may_have_mutated, false);

    const effectful = {
      version:'portfolio-reconcile-progress-v1',
      may_have_mutated:true,
      items:[{ index:0, phase:'linear.create.readback', may_have_mutated:true, linear_issue:'LJH-999' }],
    };
    await store.checkpoint(key, requestSha, 'linear.create.readback', effectful);
    operation = (await client.query(`SELECT * FROM operation_state WHERE idempotency_key=$1`, [key])).rows[0];
    assert.equal(operation.state, 'indeterminate');
    assert.equal(operation.may_have_mutated, true);
    assert.equal(operation.recovery_payload.progress.items[0].linear_issue, 'LJH-999');

    const recovered = await store.claim(key, requestSha);
    assert.equal(recovered.kind, 'recover');
    assert.deepEqual(recovered.progress, effectful);

    await store.markIndeterminate(key, requestSha, effectful, {
      error:'LINEAR_RESPONSE_LOST',
      message:'provider response was lost after a durable effect',
    });
    const afterError = (await client.query(`SELECT * FROM operation_state WHERE idempotency_key=$1`, [key])).rows[0];
    assert.equal(afterError.state, 'indeterminate');
    assert.equal(afterError.recovery_payload.last_error.error, 'LINEAR_RESPONSE_LOST');

    const receipt = {
      ok:true,
      project:'Portfolio Orchestration',
      items:[{ source:'github:laurajoyhutchins/test#issue:1', linear_issue:'LJH-999', result:'created' }],
    };
    await store.succeed(key, requestSha, receipt, effectful);

    operation = (await client.query(`SELECT * FROM operation_state WHERE idempotency_key=$1`, [key])).rows[0];
    assert.equal(operation.state, 'succeeded');
    assert.equal(operation.recovery_payload, null);
    assert.equal(operation.effect_kind, 'portfolio_work_surface_reconcile');
    assert.ok(operation.effect_ref);
    assert.ok(operation.result_sha256);

    const replay = await store.claim(key, requestSha);
    assert.equal(replay.kind, 'existing');
    assert.deepEqual(replay.receipt, receipt);

    const stillAbsent = await client.query(`SELECT to_regclass('portfolio_reconcile_receipts') AS receipts`);
    assert.equal(stillAbsent.rows[0].receipts, null);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
