import { db } from 'hatchable';
import { orchestrationRunInternals } from 'lib/orchestration-runs.js';

export const ORCHESTRATION_STUCK_MINUTES = 5;
const STUCK_MINUTES = ORCHESTRATION_STUCK_MINUTES;
const RECENT_HOURS = 24;
const EXAMPLE_LIMIT = 5;

export const ORCHESTRATION_HEALTH_CONDITION_KEYS = Object.freeze([
  'overdue_active_runs',
  'expired_active_slots',
  'leases_stuck_claiming',
  'leases_stuck_settling',
  'journal_stuck_running',
  'journal_indeterminate',
  'github_changesets_processing',
  'github_changesets_prepared',
  'portfolio_reconcile_processing',
  'portfolio_reconcile_indeterminate',
]);

export const ORCHESTRATION_HISTORICAL_CONDITION_KEYS = Object.freeze([
  'journal_stuck_running',
  'journal_indeterminate',
  'github_changesets_prepared',
]);

export function orchestrationHealthFromConditionCounts(counts = {}) {
  let unhealthyCount = 0;
  for (const key of ORCHESTRATION_HEALTH_CONDITION_KEYS) {
    const value = Number(counts?.[key]);
    if (!Number.isInteger(value) || value < 0) return Object.freeze({ healthy:null, unhealthy_count:null });
    unhealthyCount += value;
  }
  return Object.freeze({ healthy:unhealthyCount === 0, unhealthy_count:unhealthyCount });
}

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

const runningInvocationRef = (row) => ({ invocation_id: row.invocation_id, run_id: row.run_id, command: row.command, started_at: row.started_at });
const indeterminateInvocationRef = (row) => ({ invocation_id: row.invocation_id, run_id: row.run_id, command: row.command, started_at: row.started_at, error_code: row.error_code });
const preparedChangesetRef = (row) => ({ repo: row.repo, idempotency_key: row.idempotency_key, branch: row.branch, commit_sha: row.commit_sha, updated_at: row.updated_at });

export function projectOrchestrationStatus(snapshot) {
  const conditions = {
    overdue_active_runs: condition(snapshot.overdue_active_runs, (row) => ({ run_id: row.run_id, worker: row.worker, mode: row.mode, deadline_at: row.deadline_at, updated_at: row.updated_at, last_work_ref: row.last_work_ref || null, last_gate: row.last_gate || null, last_durable_activity_at: row.last_durable_activity_at || null, last_durable_activity_type: row.last_durable_activity_type || null, has_live_lease: Boolean(row.has_live_lease) })),
    expired_active_slots: condition(snapshot.expired_active_slots, (row) => ({ work_ref: row.work_ref, gate: row.gate, lease_id: row.lease_id, expires_at: row.expires_at })),
    leases_stuck_claiming: condition(snapshot.leases_stuck_claiming, (row) => ({ work_ref: row.work_ref, lease_id: row.lease_id, run_id: row.run_id, updated_at: row.updated_at })),
    leases_stuck_settling: condition(snapshot.leases_stuck_settling, (row) => ({ work_ref: row.work_ref, lease_id: row.lease_id, run_id: row.run_id, updated_at: row.updated_at })),
    journal_stuck_running: condition(snapshot.journal_stuck_running, runningInvocationRef),
    journal_indeterminate: condition(snapshot.journal_indeterminate, indeterminateInvocationRef),
    github_changesets_processing: condition(snapshot.github_changesets_processing, (row) => ({ repo: row.repo, idempotency_key: row.idempotency_key, branch: row.branch, updated_at: row.updated_at })),
    github_changesets_prepared: condition(snapshot.github_changesets_prepared, preparedChangesetRef),
    portfolio_reconcile_processing: condition(snapshot.portfolio_reconcile_processing, (row) => ({ idempotency_key: row.idempotency_key, phase: row.phase || null, updated_at: row.updated_at })),
    portfolio_reconcile_indeterminate: condition(snapshot.portfolio_reconcile_indeterminate, (row) => ({ idempotency_key: row.idempotency_key, phase: row.phase || null, updated_at: row.updated_at })),
  };
  const historical_conditions = {
    journal_stuck_running: condition(snapshot.historical_journal_stuck_running, runningInvocationRef),
    journal_indeterminate: condition(snapshot.historical_journal_indeterminate, indeterminateInvocationRef),
    github_changesets_prepared: condition(snapshot.historical_github_changesets_prepared, preparedChangesetRef),
  };
  const health = orchestrationHealthFromConditionCounts(Object.fromEntries(
    ORCHESTRATION_HEALTH_CONDITION_KEYS.map((key) => [key, conditions[key]?.count]),
  ));
  return {
    ok: true,
    healthy: health.healthy === true,
    observed_window_hours: RECENT_HOURS,
    stuck_threshold_minutes: STUCK_MINUTES,
    conditions,
    historical_conditions,
    recent_command_outcomes: snapshot.recent_command_outcomes || [],
    recent_error_codes: snapshot.recent_error_codes || [],
    recent_expected_rejections: snapshot.recent_expected_rejections || [],
  };
}

async function rows(dbBinding, sql) {
  return (await dbBinding.query(sql)).rows || [];
}

function liveLeaseExistsSql(runAlias) {
  return `EXISTS (SELECT 1 FROM work_leases l WHERE l.run_id=${runAlias}.run_id AND l.status IN (${orchestrationRunInternals.liveLeaseStatusSql}) AND l.expires_at > now())`;
}

function matchingChangesetInvocationSql(receiptAlias, extraPredicate = 'TRUE') {
  return `SELECT 1
    FROM orchestration_command_invocations i
    LEFT JOIN orchestration_runs r ON r.run_id=i.run_id
    WHERE i.command='github.apply_changeset'
      AND i.idempotency_key=${receiptAlias}.idempotency_key
      AND COALESCE(i.target_ref, i.request_projection->>'repo')=${receiptAlias}.repo
      AND (${extraPredicate})`;
}

function historicalPreparedPredicate(receiptAlias) {
  const hasMatchingOwner = matchingChangesetInvocationSql(receiptAlias);
  const hasNonQuiescentOwner = matchingChangesetInvocationSql(receiptAlias, `r.run_id IS NULL OR r.status <> 'finished' OR ${liveLeaseExistsSql('r')}`);
  return `EXISTS (${hasMatchingOwner}) AND NOT EXISTS (${hasNonQuiescentOwner})`;
}

export function createPostgresOrchestrationStatusStore(dbBinding = db) {
  return {
    async snapshot() {
      const historicalPrepared = historicalPreparedPredicate('c');
      const [
        overdue_active_runs,
        expired_active_slots,
        leases_stuck_claiming,
        leases_stuck_settling,
        journal_stuck_running,
        journal_indeterminate,
        github_changesets_processing,
        github_changesets_prepared,
        portfolio_reconcile_processing,
        portfolio_reconcile_indeterminate,
        historical_journal_stuck_running,
        historical_journal_indeterminate,
        historical_github_changesets_prepared,
        recent_command_outcomes,
        recent_error_codes,
        recent_expected_rejections,
      ] = await Promise.all([
        rows(dbBinding, `SELECT r.run_id,r.worker,r.mode,r.deadline_at,r.updated_at,r.last_work_ref,r.last_gate,r.last_durable_activity_at,r.last_durable_activity_type,r.deadline_at AS observed_at,
            ${liveLeaseExistsSql('r')} AS has_live_lease
          FROM orchestration_runs r WHERE r.status='active' AND r.deadline_at <= now() ORDER BY r.deadline_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT s.work_ref, s.gate, s.lease_id, s.expires_at, s.expires_at AS observed_at
          FROM work_lease_slots s JOIN work_leases l ON l.lease_id = s.lease_id
          WHERE s.expires_at <= now() AND l.status IN ('claiming','active','settling') ORDER BY s.expires_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT work_ref, lease_id, run_id, updated_at, updated_at AS observed_at FROM work_leases
          WHERE status = 'claiming' AND updated_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT work_ref, lease_id, run_id, updated_at, updated_at AS observed_at FROM work_leases
          WHERE status = 'settling' AND updated_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT i.invocation_id, i.run_id, i.command, i.started_at, i.started_at AS observed_at
          FROM orchestration_command_invocations i LEFT JOIN orchestration_runs r ON r.run_id=i.run_id
          WHERE i.outcome = 'running' AND i.started_at < now() - interval '${STUCK_MINUTES} minutes'
            AND NOT EXISTS (SELECT 1 FROM orchestration_invocation_resolutions x WHERE x.invocation_id=i.invocation_id)
            AND (r.run_id IS NULL OR r.status <> 'finished' OR ${liveLeaseExistsSql('r')})
          ORDER BY i.started_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT i.invocation_id, i.run_id, i.command, i.started_at, i.error_code, i.started_at AS observed_at
          FROM orchestration_command_invocations i LEFT JOIN orchestration_runs r ON r.run_id=i.run_id
          WHERE i.outcome = 'indeterminate'
            AND NOT EXISTS (SELECT 1 FROM orchestration_invocation_resolutions x WHERE x.invocation_id=i.invocation_id)
            AND (r.run_id IS NULL OR r.status <> 'finished' OR ${liveLeaseExistsSql('r')})
          ORDER BY i.started_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT repo, idempotency_key, branch, updated_at, updated_at AS observed_at FROM github_changeset_receipts
          WHERE state = 'processing' AND updated_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT c.repo, c.idempotency_key, c.branch, c.commit_sha, c.updated_at, c.updated_at AS observed_at FROM github_changeset_receipts c
          WHERE c.state = 'prepared' AND c.updated_at < now() - interval '${STUCK_MINUTES} minutes' AND NOT (${historicalPrepared})
          ORDER BY c.updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT idempotency_key, phase, updated_at, updated_at AS observed_at FROM portfolio_reconcile_receipts
          WHERE state = 'processing' AND updated_at < now() - interval '${STUCK_MINUTES} minutes' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT idempotency_key, phase, updated_at, updated_at AS observed_at FROM portfolio_reconcile_receipts
          WHERE state = 'indeterminate' ORDER BY updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT i.invocation_id, i.run_id, i.command, i.started_at, i.started_at AS observed_at
          FROM orchestration_command_invocations i JOIN orchestration_runs r ON r.run_id=i.run_id
          WHERE i.outcome = 'running' AND i.started_at < now() - interval '${STUCK_MINUTES} minutes'
            AND NOT EXISTS (SELECT 1 FROM orchestration_invocation_resolutions x WHERE x.invocation_id=i.invocation_id)
            AND r.status='finished' AND NOT ${liveLeaseExistsSql('r')}
          ORDER BY i.started_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT i.invocation_id, i.run_id, i.command, i.started_at, i.error_code, i.started_at AS observed_at
          FROM orchestration_command_invocations i JOIN orchestration_runs r ON r.run_id=i.run_id
          WHERE i.outcome = 'indeterminate'
            AND NOT EXISTS (SELECT 1 FROM orchestration_invocation_resolutions x WHERE x.invocation_id=i.invocation_id)
            AND r.status='finished' AND NOT ${liveLeaseExistsSql('r')}
          ORDER BY i.started_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT c.repo, c.idempotency_key, c.branch, c.commit_sha, c.updated_at, c.updated_at AS observed_at FROM github_changeset_receipts c
          WHERE c.state = 'prepared' AND c.updated_at < now() - interval '${STUCK_MINUTES} minutes' AND (${historicalPrepared})
          ORDER BY c.updated_at ASC LIMIT 100`),
        rows(dbBinding, `SELECT command, outcome, count(*)::int AS count FROM orchestration_command_invocations
          WHERE started_at >= now() - interval '${RECENT_HOURS} hours' GROUP BY command, outcome ORDER BY command, outcome`),
        rows(dbBinding, `SELECT error_code, count(*)::int AS count, min(started_at) AS oldest_at, max(started_at) AS newest_at FROM orchestration_command_invocations
          WHERE started_at >= now() - interval '${RECENT_HOURS} hours' AND error_code IS NOT NULL GROUP BY error_code ORDER BY count(*) DESC, error_code LIMIT 20`),
        rows(dbBinding, `SELECT command, error_code, count(*)::int AS count, min(started_at) AS oldest_at, max(started_at) AS newest_at FROM orchestration_command_invocations
          WHERE started_at >= now() - interval '${RECENT_HOURS} hours' AND outcome = 'rejected' GROUP BY command, error_code ORDER BY count(*) DESC, command LIMIT 20`),
      ]);
      return {
        overdue_active_runs,
        expired_active_slots,
        leases_stuck_claiming,
        leases_stuck_settling,
        journal_stuck_running,
        journal_indeterminate,
        github_changesets_processing,
        github_changesets_prepared,
        portfolio_reconcile_processing,
        portfolio_reconcile_indeterminate,
        historical_journal_stuck_running,
        historical_journal_indeterminate,
        historical_github_changesets_prepared,
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