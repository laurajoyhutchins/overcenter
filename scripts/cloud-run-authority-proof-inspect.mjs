import pg from 'pg';

import { resolveCloudRunConfig } from './cloud-run-host.mjs';

const PROJECT_REF = process.env.PROOF_PROJECT_REF || 'github:laurajoyhutchins/overcenter';
const PHASE = process.env.PROOF_INSPECT_PHASE || 'failed-attempt';
const TRANSITION_ID = process.env.PROOF_TRANSITION_ID || '';
const OBSERVED_AT = process.env.PROOF_OBSERVED_AT || '';
const RUN_ID = process.env.PROOF_RUN_ID || '';
const SOURCE_ONLY_MIGRATION = '059_authoritative_state_freeze.sql';

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows?.[0] || null;
}

async function many(client, sql, params = []) {
  const result = await client.query(sql, params);
  return Array.isArray(result.rows) ? result.rows : [];
}

async function resolveRun(client) {
  if (RUN_ID) {
    return one(
      client,
      `SELECT run_id,worker,status,disposition,started_at,deadline_at,finished_at,target
         FROM orchestration_runs
        WHERE run_id=$1
        LIMIT 1`,
      [RUN_ID],
    );
  }
  const transitionId = required(TRANSITION_ID, 'PROOF_TRANSITION_ID');
  const observedAt = required(OBSERVED_AT, 'PROOF_OBSERVED_AT');
  return one(
    client,
    `SELECT run_id,worker,status,disposition,started_at,deadline_at,finished_at,target
       FROM orchestration_runs
      WHERE worker='project.advance'
        AND target->>'project_ref'=$1
        AND target->'horizon'->>'kind'='transition'
        AND target->'horizon'->>'ref'=$2
        AND started_at >= $3::timestamptz - interval '30 minutes'
        AND started_at <= $3::timestamptz + interval '30 seconds'
      ORDER BY started_at DESC
      LIMIT 1`,
    [PROJECT_REF, transitionId, observedAt],
  );
}

let pool;
try {
  const config = resolveCloudRunConfig(process.env);
  pool = new pg.Pool(config.postgres);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const run = await resolveRun(client);
    const runId = run?.run_id || null;
    const leases = runId ? await many(
      client,
      `SELECT lease_id,work_ref,gate,run_id,status,created_at,expires_at,hard_expires_at,settled_at,
              claim_idempotency_key,settle_idempotency_key,settle_plan,settle_receipt
         FROM work_leases
        WHERE run_id=$1
        ORDER BY created_at,lease_id`,
      [runId],
    ) : [];
    const execution = runId ? await many(
      client,
      `SELECT subject_key,subject_kind,project_ref,transition_id,authority_epoch,lease_ref,run_id,
              authority_repository,authority_revision,expires_at,hard_expires_at,updated_at
         FROM execution_state
        WHERE run_id=$1
        ORDER BY subject_key`,
      [runId],
    ) : [];
    const slots = runId ? await many(
      client,
      `SELECT s.work_ref,s.gate,s.lease_id,s.expires_at
         FROM work_lease_slots s
         JOIN work_leases l ON l.lease_id=s.lease_id
        WHERE l.run_id=$1
        ORDER BY s.work_ref,s.gate`,
      [runId],
    ) : [];
    const activeTransitionLeases = TRANSITION_ID ? await many(
      client,
      `SELECT lease_id,run_id,status,created_at,expires_at
         FROM work_leases
        WHERE claim_receipt->>'subject'='project_transition'
          AND claim_receipt->'project_transition'->>'project_ref'=$1
          AND claim_receipt->'project_transition'->>'transition_id'=$2
          AND status='active'
          AND expires_at > now()
        ORDER BY created_at,lease_id`,
      [PROJECT_REF, TRANSITION_ID],
    ) : [];
    const epoch = await one(
      client,
      `SELECT
         to_regclass('overcenter_authority_freeze')::text AS freeze_table,
         to_regprocedure('overcenter_reject_source_writes_when_frozen()')::text AS freeze_function,
         (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'overcenter_source_freeze_%') AS freeze_triggers,
         (SELECT count(*)::int FROM overcenter_schema_migrations WHERE name=$1) AS source_only_migrations`,
      [SOURCE_ONLY_MIGRATION],
    );
    await client.query('COMMIT');
    console.log(`OVERCENTER_AUTHORITY_PROOF_INSPECT=${JSON.stringify({
      schema:'overcenter-authority-proof-inspect-v1',
      phase:PHASE,
      project_ref:PROJECT_REF,
      transition_id:TRANSITION_ID || null,
      observed_at:OBSERVED_AT || null,
      run,
      leases,
      execution_state:execution,
      slots,
      active_transition_leases:activeTransitionLeases,
      counts:{
        runs:run ? 1 : 0,
        leases:leases.length,
        execution_state:execution.length,
        slots:slots.length,
        active_transition_leases:activeTransitionLeases.length,
      },
      target_epoch:epoch,
    })}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error(`OVERCENTER_AUTHORITY_PROOF_INSPECT_ERROR=${JSON.stringify({
    phase:PHASE,
    error:error?.code || 'AUTHORITY_PROOF_INSPECT_FAILED',
    message:error?.message || 'authority proof inspection failed',
  })}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => {});
}
