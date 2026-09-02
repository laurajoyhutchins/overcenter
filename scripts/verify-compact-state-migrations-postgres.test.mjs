import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'compact_state_migration_test';

async function sql(name) {
  return readFile(new URL(`migrations/${name}`, root), 'utf8');
}

async function connect() {
  const client = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
  await client.connect();
  return client;
}

test('compact state migrations apply and enforce current-state invariants on PostgreSQL', async () => {
  const client = await connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);

    for (const name of [
      '025_orchestration_runs.sql',
      '053_execution_state.sql',
      '054_operation_state.sql',
      '055_proof_state.sql',
      '056_orchestration_run_compaction.sql',
    ]) {
      await client.query(await sql(name));
    }

    const runId = 'scheduled:2026-09-01T19:00Z:repository-implementation';
    await client.query(
      `INSERT INTO orchestration_runs (
         run_id, worker, mode, continuation_key, scope, scope_sha256, deadline_at
       ) VALUES ($1, 'repository-implementation', 'scheduled', 'cycle', '{}'::jsonb, $2, now() + interval '1 hour')`,
      [runId, 'a'.repeat(64)],
    );

    await client.query(
      `INSERT INTO execution_state (
         subject_key, subject_kind, authority_epoch, lease_ref, run_id,
         authority_repository, authority_revision, expires_at, hard_expires_at
       ) VALUES ($1, 'project_transition', 1, '00000000-0000-4000-8000-000000000001', $2, $3, $4, now() + interval '10 minutes', now() + interval '20 minutes')`,
      ['project:overcenter#transition:ship', runId, 'laurajoyhutchins/overcenter', 'b'.repeat(40)],
    );

    await assert.rejects(
      client.query(
        `INSERT INTO execution_state (
           subject_key, subject_kind, authority_epoch, lease_ref, run_id,
           authority_repository, authority_revision, expires_at
         ) VALUES ('bad-active', 'legacy_work', 1, '00000000-0000-4000-8000-000000000002', $1, 'laurajoyhutchins/overcenter', $2, now())`,
        [runId, 'c'.repeat(40)],
      ),
      error => error?.code === '23514',
    );

    await assert.rejects(
      client.query(
        `INSERT INTO operation_state (
           operation_id, command, idempotency_scope, idempotency_key, request_sha256,
           state, run_id, may_have_mutated
         ) VALUES ('00000000-0000-0000-0000-000000000001', 'github.apply_changeset',
           'repository:laurajoyhutchins/overcenter', 'idem-bad', $1, 'no_effect', $2, true)`,
        ['d'.repeat(64), runId],
      ),
      error => error?.code === '23514',
    );

    await client.query(
      `INSERT INTO operation_state (
         operation_id, command, idempotency_scope, idempotency_key, request_sha256,
         state, subject_key, run_id, lease_epoch, authority_revision, may_have_mutated,
         effect_kind, effect_ref, resolved_at
       ) VALUES ('00000000-0000-0000-0000-000000000002', 'github.apply_changeset',
         'repository:laurajoyhutchins/overcenter', 'idem-good', $1, 'succeeded', $2, $3, 1, $4,
         true, 'github_commit', 'commit:abc', now())`,
      ['e'.repeat(64), 'project:overcenter#transition:ship', runId, 'b'.repeat(40)],
    );

    await client.query(
      `INSERT INTO proof_state (
         proof_key, subject_key, predicate_kind, authority_repository, authority_revision,
         evidence_sha256, evidence_refs, satisfied_at
       ) VALUES ('proof-1', $1, 'required_checks_satisfied', $2, $3, $4, '[]'::jsonb, now())`,
      ['project:overcenter#transition:ship', 'laurajoyhutchins/overcenter', 'b'.repeat(40), 'f'.repeat(64)],
    );

    await client.query(
      `UPDATE orchestration_runs
          SET active_subject_key=$1,
              unresolved_operation_id='00000000-0000-0000-0000-000000000002'
        WHERE run_id=$2`,
      ['project:overcenter#transition:ship', runId],
    );

    const row = (await client.query(
      `SELECT active_subject_key, unresolved_operation_id::text AS unresolved_operation_id
         FROM orchestration_runs WHERE run_id=$1`,
      [runId],
    )).rows[0];
    assert.equal(row.active_subject_key, 'project:overcenter#transition:ship');
    assert.equal(row.unresolved_operation_id, '00000000-0000-0000-0000-000000000002');
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
