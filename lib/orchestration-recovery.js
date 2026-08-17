import { api, db } from 'hatchable';
import { createLinearAuthority } from 'lib/work-leases.js';

const CONTINUATIONS = Object.freeze([
  'recover_active_lease',
  'retry_same_request',
  'reconcile_authority',
  'recompute_frontier',
  'owner_action_required',
  'terminal_or_quiescent',
]);

function err(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeRunId(input) {
  const runId = typeof input?.run_id === 'string' ? input.run_id.trim() : '';
  if (!runId || runId.length > 512) throw err('REQUEST_INVALID', 'run_id must be a non-empty string of at most 512 characters', { field: 'run_id' });
  return runId;
}

function asObject(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return typeof value === 'object' ? value : null;
}

function laneOf(issue) {
  const lanes = (issue?.labels || []).filter((label) => String(label?.name || '').startsWith('lane:'));
  return lanes.length === 1 ? lanes[0]?.name || null : null;
}

function publicInvocation(row) {
  if (!row) return null;
  return {
    invocation_id: row.invocation_id,
    sequence: Number(row.sequence),
    command: row.command,
    target_kind: row.target_kind || null,
    target_ref: row.target_ref || null,
    started_at: row.started_at,
    completed_at: row.completed_at || null,
    outcome: row.outcome,
    error_code: row.error_code || null,
    retryable: row.retryable == null ? null : Boolean(row.retryable),
    rejection: row.rejection == null ? null : Boolean(row.rejection),
    may_have_mutated: row.may_have_mutated == null ? null : Boolean(row.may_have_mutated),
    request_projection: asObject(row.request_projection) || {},
    result_projection: asObject(row.result_projection) || {},
  };
}

function publicLease(lease, includeToken = false) {
  if (!lease) return null;
  return {
    lease_id: lease.lease_id,
    work_ref: lease.work_ref,
    gate: lease.gate,
    run_id: lease.run_id,
    status: lease.status,
    created_at: lease.created_at,
    expires_at: lease.expires_at,
    claim_idempotency_key: lease.claim_idempotency_key || null,
    settle_idempotency_key: lease.settle_idempotency_key || null,
    ...(includeToken ? { lease_token: lease.lease_token } : {}),
  };
}

export function createPostgresOrchestrationRecoveryStore(dbBinding = db) {
  async function row(sql, params) {
    const result = await dbBinding.query(sql, params);
    return result.rows?.[0] || null;
  }
  return {
    async lastInvocation(runId) {
      return row('SELECT * FROM orchestration_command_invocations WHERE run_id = $1 ORDER BY sequence DESC LIMIT 1', [runId]);
    },
    async unresolvedInvocation(runId) {
      return row("SELECT * FROM orchestration_command_invocations WHERE run_id = $1 AND outcome IN ('running','indeterminate') ORDER BY sequence DESC LIMIT 1", [runId]);
    },
    async latestLease(runId) {
      return row('SELECT * FROM work_leases WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1', [runId]);
    },
    async slot(workRef, gate) {
      return row('SELECT * FROM work_lease_slots WHERE work_ref = $1 AND gate = $2 LIMIT 1', [workRef, gate]);
    },
    async portfolioReceipt(idempotencyKey) {
      if (!idempotencyKey) return null;
      return row('SELECT * FROM portfolio_reconcile_receipts WHERE idempotency_key = $1 LIMIT 1', [idempotencyKey]);
    },
  };
}

export function createOrchestrationResumeService({
  store,
  authoritative,
  now = () => new Date().toISOString(),
} = {}) {
  if (!store || !authoritative) throw new TypeError('store and authoritative are required');

  async function resume(input) {
    const runId = normalizeRunId(input);
    const [last, unresolved, lease] = await Promise.all([
      store.lastInvocation(runId),
      store.unresolvedInvocation(runId),
      store.latestLease(runId),
    ]);
    const lastInvocation = publicInvocation(last);
    const historicalCorrelationMissing = !last;
    const evidence = [];
    const authoritativeObservations = [];

    if (lease && ['claiming', 'active', 'settling'].includes(lease.status)) {
      const slot = await store.slot(lease.work_ref, lease.gate);
      const unexpired = Date.parse(lease.expires_at) > Date.parse(now());
      const ownsSlot = Boolean(slot && slot.lease_id === lease.lease_id && Date.parse(slot.expires_at) > Date.parse(now()));
      evidence.push({ kind: 'work_lease', lease_id: lease.lease_id, status: lease.status, owns_slot: ownsSlot, unexpired });

      if (!unexpired || !ownsSlot) {
        return {
          ok: true,
          run_id: runId,
          continuation: 'recompute_frontier',
          last_invocation: lastInvocation,
          active_execution: publicLease(lease, false),
          unresolved_effect: unresolved ? publicInvocation(unresolved) : null,
          authoritative_observations: authoritativeObservations,
          evidence,
          historical_correlation_missing: historicalCorrelationMissing,
        };
      }

      let issue;
      try { issue = await authoritative.getIssue(lease.work_ref); }
      catch (error) {
        return {
          ok: true,
          run_id: runId,
          continuation: 'reconcile_authority',
          last_invocation: lastInvocation,
          active_execution: publicLease(lease, false),
          unresolved_effect: unresolved ? publicInvocation(unresolved) : null,
          authoritative_observations: [{ source: 'linear', work_ref: lease.work_ref, observed: false, error: String(error?.code || error?.message || 'read_failed') }],
          evidence,
          historical_correlation_missing: historicalCorrelationMissing,
        };
      }
      const state = issue?.state?.name || null;
      const lane = laneOf(issue);
      authoritativeObservations.push({ source: 'linear', work_ref: lease.work_ref, state, lane, authoritative_revision: issue?.updatedAt || null });
      if (state !== 'In Progress' || lane !== lease.gate) {
        return {
          ok: true,
          run_id: runId,
          continuation: 'owner_action_required',
          last_invocation: lastInvocation,
          active_execution: publicLease(lease, false),
          unresolved_effect: unresolved ? publicInvocation(unresolved) : null,
          authoritative_observations: authoritativeObservations,
          evidence: [...evidence, { kind: 'lease_authority_mismatch', expected_state: 'In Progress', expected_lane: lease.gate, actual_state: state, actual_lane: lane }],
          historical_correlation_missing: historicalCorrelationMissing,
        };
      }

      if (lease.status === 'active') {
        return {
          ok: true,
          run_id: runId,
          continuation: 'recover_active_lease',
          last_invocation: lastInvocation,
          active_execution: publicLease(lease, true),
          unresolved_effect: unresolved ? publicInvocation(unresolved) : null,
          authoritative_observations: authoritativeObservations,
          evidence,
          historical_correlation_missing: historicalCorrelationMissing,
        };
      }

      if (lease.status === 'claiming') {
        const claimRequest = asObject(lease.claim_request);
        return {
          ok: true,
          run_id: runId,
          continuation: claimRequest ? 'retry_same_request' : 'reconcile_authority',
          last_invocation: lastInvocation,
          active_execution: publicLease(lease, false),
          retry: claimRequest ? { command: 'work.claim', request: claimRequest } : null,
          unresolved_effect: unresolved ? publicInvocation(unresolved) : null,
          authoritative_observations: authoritativeObservations,
          evidence,
          historical_correlation_missing: historicalCorrelationMissing,
        };
      }

      const plan = asObject(lease.settle_plan);
      const replay = asObject(plan?.replay_request);
      const retryRequest = replay ? {
        lease_token: lease.lease_token,
        ...replay,
        idempotency_key: lease.settle_idempotency_key,
      } : null;
      return {
        ok: true,
        run_id: runId,
        continuation: retryRequest ? 'retry_same_request' : 'reconcile_authority',
        last_invocation: lastInvocation,
        active_execution: publicLease(lease, true),
        retry: retryRequest ? { command: 'work.settle', request: retryRequest, request_sha256: lease.settle_request_hash } : null,
        unresolved_effect: unresolved ? publicInvocation(unresolved) : null,
        authoritative_observations: authoritativeObservations,
        evidence,
        historical_correlation_missing: historicalCorrelationMissing,
      };
    }

    if (lease?.status === 'invalidated') {
      return {
        ok: true,
        run_id: runId,
        continuation: 'owner_action_required',
        last_invocation: lastInvocation,
        active_execution: publicLease(lease, false),
        unresolved_effect: unresolved ? publicInvocation(unresolved) : null,
        authoritative_observations: authoritativeObservations,
        evidence: [{ kind: 'invalidated_lease', reconciliation: asObject(lease.reconciliation) || {} }],
        historical_correlation_missing: historicalCorrelationMissing,
      };
    }

    if (unresolved) {
      const invocation = publicInvocation(unresolved);
      let continuation = 'reconcile_authority';
      if (unresolved.outcome === 'running' && unresolved.may_have_mutated !== true) continuation = 'retry_same_request';
      if (unresolved.command === 'portfolio.reconcile_work_surface' && unresolved.idempotency_key) {
        const receipt = await store.portfolioReceipt(unresolved.idempotency_key);
        evidence.push({
          kind: 'portfolio_reconcile_receipt',
          idempotency_key: unresolved.idempotency_key,
          state: receipt?.state || null,
          phase: receipt?.phase || null,
          progress: asObject(receipt?.progress) || null,
        });
      }
      return {
        ok: true,
        run_id: runId,
        continuation,
        last_invocation: lastInvocation,
        active_execution: null,
        unresolved_effect: invocation,
        authoritative_observations: authoritativeObservations,
        evidence,
        historical_correlation_missing: historicalCorrelationMissing,
      };
    }

    const terminalLease = lease && ['settled', 'rejected', 'expired'].includes(lease.status);
    return {
      ok: true,
      run_id: runId,
      continuation: terminalLease || last ? 'terminal_or_quiescent' : 'recompute_frontier',
      last_invocation: lastInvocation,
      active_execution: null,
      unresolved_effect: null,
      authoritative_observations: authoritativeObservations,
      evidence,
      historical_correlation_missing: historicalCorrelationMissing,
    };
  }

  return { resume };
}

export function createPostgresOrchestrationResumeService(options = {}) {
  return createOrchestrationResumeService({
    store: options.store || createPostgresOrchestrationRecoveryStore(options.db || db),
    authoritative: options.authoritative || createLinearAuthority(options.api || api),
    now: options.now,
  });
}

export async function orchestrationResumePacket(input, options = {}) {
  return createPostgresOrchestrationResumeService(options).resume(input);
}

export const orchestrationResumeConfig = Object.freeze({ continuations: CONTINUATIONS });