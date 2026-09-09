const SOURCE_ONLY_MIGRATION = '059_authoritative_state_freeze.sql';

function requiredText(value, name) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw Object.assign(new Error(`${name} is required`), { code:'REQUEST_INVALID', statusCode:400 });
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

export function createCloudRunAuthorityProofInspector({ db }) {
  if (!db || typeof db.connect !== 'function') throw new TypeError('db.connect is required');

  return async function inspect(input = {}) {
    const phase = requiredText(input.phase, 'phase');
    const projectRef = requiredText(input.project_ref, 'project_ref');
    const transitionId = typeof input.transition_id === 'string' ? input.transition_id.trim() : '';
    const observedAt = typeof input.observed_at === 'string' ? input.observed_at.trim() : '';
    const requestedRunId = typeof input.run_id === 'string' ? input.run_id.trim() : '';
    if (!requestedRunId && (!transitionId || !observedAt)) {
      throw Object.assign(new Error('transition_id and observed_at are required when run_id is absent'), { code:'REQUEST_INVALID', statusCode:400 });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const run = requestedRunId
        ? await one(client, `SELECT run_id,worker,status,disposition,started_at,deadline_at,finished_at,target FROM orchestration_runs WHERE run_id=$1 LIMIT 1`, [requestedRunId])
        : await one(client, `SELECT run_id,worker,status,disposition,started_at,deadline_at,finished_at,target
            FROM orchestration_runs
           WHERE worker='project.advance'
             AND target->>'project_ref'=$1
             AND target->'horizon'->>'kind'='transition'
             AND target->'horizon'->>'ref'=$2
             AND started_at >= $3::timestamptz - interval '30 minutes'
             AND started_at <= $3::timestamptz + interval '30 seconds'
           ORDER BY started_at DESC
           LIMIT 1`, [projectRef, transitionId, observedAt]);
      const runId = run?.run_id || null;
      const leases = runId ? await many(client, `SELECT lease_id,work_ref,gate,run_id,status,created_at,expires_at,hard_expires_at,settled_at,claim_idempotency_key,settle_idempotency_key,settle_plan,settle_receipt FROM work_leases WHERE run_id=$1 ORDER BY created_at,lease_id`, [runId]) : [];
      const executionState = transitionId ? await many(client, `SELECT subject_key,subject_kind,project_ref,transition_id,authority_epoch,lease_ref,run_id,authority_repository,authority_revision,expires_at,hard_expires_at,updated_at FROM execution_state WHERE (run_id=$1) OR (project_ref=$2 AND transition_id=$3 AND subject_kind='project_transition') ORDER BY subject_key`, [runId, projectRef, transitionId]) : (runId ? await many(client, `SELECT subject_key,subject_kind,project_ref,transition_id,authority_epoch,lease_ref,run_id,authority_repository,authority_revision,expires_at,hard_expires_at,updated_at FROM execution_state WHERE run_id=$1 ORDER BY subject_key`, [runId]) : []);
      const slots = runId ? await many(client, `SELECT s.work_ref,s.gate,s.lease_id,s.expires_at FROM work_lease_slots s JOIN work_leases l ON l.lease_id=s.lease_id WHERE l.run_id=$1 ORDER BY s.work_ref,s.gate`, [runId]) : [];
      const activeTransitionLeases = transitionId ? await many(client, `SELECT lease_id,run_id,status,created_at,expires_at FROM work_leases WHERE claim_receipt->>'subject'='project_transition' AND claim_receipt->'project_transition'->>'project_ref'=$1 AND claim_receipt->'project_transition'->>'transition_id'=$2 AND status='active' AND expires_at > now() ORDER BY created_at,lease_id`, [projectRef, transitionId]) : [];
      const epoch = await one(client, `SELECT to_regclass('overcenter_authority_freeze')::text AS freeze_table, to_regprocedure('overcenter_reject_source_writes_when_frozen()')::text AS freeze_function, (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'overcenter_source_freeze_%') AS freeze_triggers, (SELECT count(*)::int FROM overcenter_schema_migrations WHERE name=$1) AS source_only_migrations`, [SOURCE_ONLY_MIGRATION]);
      await client.query('COMMIT');
      return Object.freeze({
        schema:'overcenter-authority-proof-inspect-v1',
        phase,
        project_ref:projectRef,
        transition_id:transitionId || null,
        observed_at:observedAt || null,
        run,
        leases,
        execution_state:executionState,
        slots,
        active_transition_leases:activeTransitionLeases,
        counts:{ runs:run ? 1 : 0, leases:leases.length, execution_state:executionState.length, slots:slots.length, active_transition_leases:activeTransitionLeases.length },
        target_epoch:epoch,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
}
