import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import { createPostgresOrchestrationCurrentFailureStore } from '../lib/orchestration-current-failure.js';
import {
  createOrchestrationDiagnosisService,
  createOrchestrationResumeService,
  createPostgresOrchestrationRecoveryStore,
} from '../lib/orchestration-recovery.js';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'compact_recovery_test';

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

test('recovery decisions use compact current state with historical substrate physically absent', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    for (const name of [
      '008_work_leases.sql',
      '009_work_lease_slots.sql',
      '025_orchestration_runs.sql',
      '053_execution_state.sql',
      '054_operation_state.sql',
      '056_orchestration_run_compaction.sql',
      '058_orchestration_run_current_failure.sql',
    ]) await client.query(await migration(name));

    for (const table of [
      'orchestration_command_invocations',
      'orchestration_invocation_resolutions',
      'orchestration_horizons',
      'work_lease_checkpoints',
      'work_lease_heartbeats',
      'portfolio_reconcile_receipts',
      'portfolio_verification_receipts',
    ]) {
      assert.equal((await client.query('SELECT to_regclass($1) AS relation', [table])).rows[0].relation, null, `${table} unexpectedly exists`);
    }

    const dbBinding = { query:(text, values) => client.query(text, values) };
    const store = createPostgresOrchestrationRecoveryStore(dbBinding);

    const mutationRunId = 'scheduled:2026-09-01T23:00Z:repository-implementation';
    await client.query(
      `INSERT INTO orchestration_runs (
         run_id,worker,mode,continuation_key,scope,scope_sha256,deadline_at
       ) VALUES ($1,'repository-implementation','scheduled','cycle','{}'::jsonb,$2,now()+interval '1 hour')`,
      [mutationRunId, 'a'.repeat(64)],
    );
    await client.query(
      `INSERT INTO operation_state (
         operation_id,command,idempotency_scope,idempotency_key,request_sha256,state,
         run_id,may_have_mutated,effect_kind,recovery_payload,created_at
       ) VALUES ($1,'github.production.promote','repository:laurajoyhutchins/overcenter','idem-recovery',$2,
         'indeterminate',$3,true,'github_production_promotion',$4::jsonb,now())`,
      [
        '00000000-0000-0000-0000-000000000099',
        'b'.repeat(64),
        mutationRunId,
        JSON.stringify({ phase:'production_ref_update_dispatched', request_json:{ repo:'laurajoyhutchins/overcenter' } }),
      ],
    );

    const resume = createOrchestrationResumeService({
      store,
      authoritative:{ async getIssue(){ throw new Error('Linear must not be consulted for repository operation recovery'); } },
      now:() => '2026-09-01T23:05:00.000Z',
    });
    const packet = await resume.resume({ run_id:mutationRunId });
    assert.equal(packet.continuation, 'reconcile_authority');
    assert.equal(packet.unresolved_effect?.operation_id, '00000000-0000-0000-0000-000000000099');
    assert.equal(packet.unresolved_effect?.may_have_mutated, true);
    assert.equal(packet.historical_correlation_missing, false);

    const executionRunId = 'scheduled:2026-09-01T23:12Z:verification';
    await client.query(
      `INSERT INTO orchestration_runs (
         run_id,worker,mode,continuation_key,scope,scope_sha256,deadline_at
       ) VALUES ($1,'verification','scheduled','cycle','{}'::jsonb,$2,now()+interval '1 hour')`,
      [executionRunId, 'c'.repeat(64)],
    );
    await client.query(
      `INSERT INTO execution_state (
         subject_key,subject_kind,authority_epoch,lease_ref,run_id,
         authority_repository,authority_revision,expires_at,hard_expires_at,
         checkpoint,checkpoint_sha256,active_capability_material
       ) VALUES ($1,'project_transition',7,$2,$3,'laurajoyhutchins/overcenter',$4,
         now()+interval '20 minutes',now()+interval '40 minutes',$5::jsonb,$6,'wlt_test_capability')`,
      [
        'github:laurajoyhutchins/overcenter:transition:verify',
        '00000000-0000-4000-8000-000000000370',
        executionRunId,
        'd'.repeat(40),
        JSON.stringify({ schema:'work-checkpoint-v1', phase:'verification', next_action_kind:'continue' }),
        'e'.repeat(64),
      ],
    );

    const failures = createPostgresOrchestrationCurrentFailureStore(dbBinding);
    await failures.record(executionRunId, 'work.heartbeat', {
      ok:false,
      error:'HEARTBEAT_LIMIT_REACHED',
      error_class:'validation',
      retryable:false,
      rejection:true,
      may_have_mutated:false,
    });

    const diagnosis = createOrchestrationDiagnosisService({
      store,
      authoritative:{ async getIssue(){ throw new Error('compact transition diagnosis must not consult Linear'); } },
      now:() => new Date(Date.now()).toISOString(),
    });
    const heartbeat = await diagnosis.diagnose({ run_id:executionRunId });
    assert.equal(heartbeat.failure_state, 'HEARTBEAT_BUDGET_EXHAUSTED');
    assert.equal(heartbeat.recovery_operation?.command, 'work.settle');
    assert.equal(heartbeat.recovery_operation?.input?.lease_ref, '00000000-0000-4000-8000-000000000370');
    assert.equal(heartbeat.recovery_operation?.input?.requeue_class, 'resume_progress');
    assert.equal(heartbeat.automatic_recovery_allowed, true);
    assert.equal(heartbeat.recovery_failure_count, 1);

    await failures.record(executionRunId, 'work.settle', { ok:true });
    assert.equal((await client.query('SELECT current_failure_streak FROM orchestration_runs WHERE run_id=$1', [executionRunId])).rows[0].current_failure_streak, 0);

    await client.query(`UPDATE execution_state SET
      lease_ref=NULL,run_id=NULL,expires_at=NULL,hard_expires_at=NULL,active_capability_material=NULL
      WHERE subject_key=$1`, ['github:laurajoyhutchins/overcenter:transition:verify']);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await failures.record(executionRunId, 'work.claim', {
        ok:false,
        error:'HATCHABLE_MCP_TRANSPORT_ERROR',
        error_class:'transport',
        retryable:true,
        rejection:false,
        may_have_mutated:false,
      });
    }
    const exhausted = await diagnosis.diagnose({ run_id:executionRunId });
    assert.equal(exhausted.failure_state, 'RECOVERY_FAILED');
    assert.equal(exhausted.escalation_required, true);
    assert.equal(exhausted.recovery_failure_count, 3);

    await failures.record(executionRunId, 'work.claim', { ok:true });
    const recovered = await diagnosis.diagnose({ run_id:executionRunId });
    assert.equal(recovered.failure_state, null);
    assert.equal(recovered.worker_state, 'enabled');
    assert.equal(recovered.recovery_failure_count, 0);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
