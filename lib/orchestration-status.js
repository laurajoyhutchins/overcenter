import { db } from 'hatchable';

const STUCK_MINUTES = 5;
const RECENT_HOURS = 24;
const EXAMPLE_LIMIT = 5;

function examples(rows, mapper) {
  return (rows || []).slice(0, EXAMPLE_LIMIT).map(mapper);
}

function condition(rows, mapper) {
  const list = rows || [];
  return {
    count: list.length,
    oldest_at: list[0]?.observed_at || list[0]?.updated_at || list[0]?.started_at || list[0]?.expires_at || null,
    oldest_refs: examples(list, mapper),
  };
}

export function projectOrchestrationStatus(snapshot) {
  const conditions = {
    expired_active_slots: condition(snapshot.expired_active_slots, (row) => ({ work_ref: row.work_ref, gate: row.gate, lease_id: row.lease_id, expires_at: row.expires_at })),
    leases_stuck_claiming: condition(snapshot.leases_stuck_claiming, (row) => ({ work_ref: row.work_ref, lease_id: row.lease_id, run_id: row.run_id, updated_at: row.updated_at })),
    leases_stuck_settling: condition(snapshot.leases_stuck_settling, (row) => ({ work_ref: row.work_ref, lease_id: row.lease_id, run_id: row.run_id, updated_at: row.updated_at })),
    journal_stuck_running: condition(snapshot.journal_stuck_running, (row) => ({ invocation_id: row.invocation_id, run_id: row.run_id, command: row.command, started_at: row.started_at })),
    journal_indeterminate: condition(snapshot.journal_indeterminate, (row) => ({ invocation_id: row.invocation_id, run_id: row.run_id, command: row.command, started_at: row.started_at, error_code: row.error_code })),
    github_changesets_processing: condition(snapshot.github_changesets_processing, (row) => ({ repo: row.repo, idempotency_key: row.idempotency_key, branch: row.branch, updated_at: row.updated_at })),
    github_changesets_prepared: condition(snapshot.github_changesets_prepared, (row) => ({ repo: row.repo, idempotency_key: row.idempotency_key, branch: row.branch, commit_sha: row.commit_sha, updated_at: row.updated_at })),
    portfolio_reconcile_processing: condition(snapshot.portfolio_reconcile_processing, (row) => ({ idempotency_key: row.idempotency_key, phase: row.phase || null, updated_at: row.updated_at })),
    portfolio_reconcile_indeterminate: condition(snapshot.portfolio_reconcile_indeterminate, (row) => ({ idempotency_key: row.idempotency_key, phase: row.phase || null, updated_at: row.updated_at })),
  };
  const unhealthyCount = Object.values(conditions).reduce((sum, entry) => sum + entry.count, 0);
  return {
    ok: true,
    healthy: unhealthyCount === 0,
    observed_window_hours: RECENT_HOURS,
    stuck_threshold_minutes: STUCK_MINUTES,
    conditions,
    recent_command_outcomes: snapshot.recent_command_outcomes || [],
    recent_error_codes: snapshot.recent_error_codes || [],
    recent_expected_rejections: snapshot.recent_expected_rejections || [],
  };
}

async function rows(dbBinding, sql) {
  return (await dbBinding.query(sql)).rows || [];
}

export function createPostgresOrchestrationStatusStore(dbBinding = db) {
  return {
    async snapshot() {
      const [
        expired_active_slots,
        leases_stuck_claiming,
        leases_stuck_settling,
        journal_stuck_running,
        journal_indeterminate,
        github_changesets_processing,
        github_changesets_prepared,
        portfolio_reconcile_processing,
        portfolio_reconcile_indeterminate,
        recent_command_outcomes,
        recent_error_codes,
        recent_expected_rejections,
      ] = await Promise.all([
        rows(dbBinding, `SELECT s.work_ref, s.gate, s.lease_id, s.expires_at, s.expires_at AS observed_at
          FROM work_lease_slots s JOIN work_leases l ON l.lease_id = s.lease_id
          WHERE s.expires_at <= now() AND l.status IN ('claiming','active','settling') ORDER BY s.expires_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT work_ref, lease_id, run_id, updated_at, updated_at AS observed_at FROM work_leases
          WHERE status = 'claiming' AND updated_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT work_ref, lease_id, run_id, updated_at, updated_at AS observed_at FROM work_leases
          WHERE status = 'settling' AND updated_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT invocation_id, run_id, command, started_at, started_at AS observed_at FROM orchestration_command_invocations
          WHERE outcome = 'running' AND started_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY started_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT invocation_id, run_id, command, started_at, error_code, started_at AS observed_at FROM orchestration_command_invocations
          WHERE outcome = 'indeterminate' ORDER BY started_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT repo, idempotency_key, branch, updated_at, updated_at AS observed_at FROM github_changeset_receipts
          WHERE state = 'processing' AND updated_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT repo, idempotency_key, branch, commit_sha, updated_at, updated_at AS observed_at FROM github_changeset_receipts
          WHERE state = 'prepared' AND updated_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT idempotency_key, phase, updated_at, updated_at AS observed_at FROM portfolio_reconcile_receipts
          WHERE state = 'processing' AND updated_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT idempotency_key, phase, updated_at, updated_at AS observed_at FROM portfolio_reconcile_receipts
          WHERE state = 'indeterminate' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT command, outcome, count(*)::int AS count FROM orchestration_command_invocations
          WHERE started_at >= now() - interval '${RECENT_HOURS} hours' GROUP BY command, outcome ORDER BY command, outcome`),
        rows(dbBinding, `SELECT error_code, count(*)::int AS count, min(started_at) AS oldest_at, max(started_at) AS newest_at FROM orchestration_command_invocations
          WHERE started_at >= now() - interval '${RECENT_HOURS} hours' AND error_code IS NOT NULL GROUP BY error_code ORDER BY count(*) DESC, error_code LIMIT 20`),
        rows(dbBinding, `SELECT command, error_code, count(*)::int AS count, min(started_at) AS oldest_at, max(started_at) AS newest_at FROM orchestration_command_invocations
          WHERE started_at >= now() - interval '${RECENT_HOURS} hours' AND outcome = 'rejected' GROUP BY command, error_code ORDER BY count(*) DESC, command LIMIT 20`),
      ]);
      return {
        expired_active_slots,
        leases_stuck_claiming,
        leases_stuck_settling,
        journal_stuck_running,
        journal_indeterminate,
        github_changesets_processing,
        github_changesets_prepared,
        portfolio_reconcile_processing,
        portfolio_reconcile_indeterminate,
        recent_command_outcomes,
        recent_error_codes,
        recent_expected_rejections,
      };
    },
  };
}

export function createOrchestrationStatusService({ store } = {}) {
  if (!store) throw new TypeError('store is required');
  return {
    async status() { return projectOrchestrationStatus(await store.snapshot()); },
  };
}

export function createPostgresOrchestrationStatusService(options = {}) {
  return createOrchestrationStatusService({ store: options.store || createPostgresOrchestrationStatusStore(options.db || db) });
}

export async function orchestrationStatus(options = {}) {
  return createPostgresOrchestrationStatusService(options).status();
}