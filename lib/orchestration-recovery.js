import { api, db } from 'hatchable';
import { createLinearAuthority } from 'lib/work-leases.js';
import { classifyOrchestrationFailure, deriveWorkerState } from 'lib/orchestration-failures.js';

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

function expectedOwnedState(lease) {
  const receipt = asObject(lease?.claim_receipt) || {};
  if (receipt.ownership_protocol === 'lease-slot-v2') {
    return receipt.current_state || lease?.previous_state || 'Todo';
  }
  return receipt.current_state || 'In Progress';
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

function publicCheckpoint(row) {
  if (!row) return null;
  const checkpoint = asObject(row.checkpoint) || {};
  return {
    checkpoint_sha256: row.checkpoint_sha256 || null,
    created_at: row.created_at || null,
    phase: checkpoint.phase || null,
    next_action_kind: checkpoint.next_action_kind || null,
  };
}

function publicLease(lease, includeToken = false, checkpoint = null) {
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
    checkpoint: publicCheckpoint(checkpoint),
    ...(includeToken ? { lease_token: lease.lease_token } : {}),
  };
}

export function createPostgresOrchestrationRecoveryStore(dbBinding = db) {
  async function row(sql, params) {
    const result = await dbBinding.query(sql, params);
    return result.rows?.[0] || null;
  }
  return {
    async getRun(runId) {
      return row('SELECT * FROM orchestration_runs WHERE run_id = $1 LIMIT 1', [runId]);
    },
    async lastSuccessfulInvocation(runId) {
      return row("SELECT * FROM orchestration_command_invocations WHERE run_id = $1 AND outcome = 'succeeded' ORDER BY sequence DESC LIMIT 1", [runId]);
    },
    async recentFailures(runId, limit = 10) {
      const bounded = Math.min(25, Math.max(1, Number(limit) || 10));
      const result = await dbBinding.query(`SELECT * FROM orchestration_command_invocations WHERE run_id = $1 AND outcome IN ('rejected','failed','indeterminate') ORDER BY sequence DESC LIMIT ${bounded}`, [runId]);
      return result.rows || [];
    },
    async lastInvocation(runId) {
      return row('SELECT * FROM orchestration_command_invocations WHERE run_id = $1 ORDER BY sequence DESC LIMIT 1', [runId]);
    },
    async unresolvedInvocation(runId) {
      return row("SELECT * FROM orchestration_command_invocations WHERE run_id = $1 AND outcome IN ('running','indeterminate') ORDER BY sequence DESC LIMIT 1", [runId]);
    },
    async latestLease(runId) {
      return row('SELECT * FROM work_leases WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1', [runId]);
    },
    async latestCheckpoint(leaseId) {
      if (!leaseId) return null;
      return row('SELECT * FROM work_lease_checkpoints WHERE lease_id = $1 ORDER BY created_at DESC LIMIT 1', [leaseId]);
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

function publicRunState(run) {
  if (!run) return null;
  return {
    run_id: run.run_id,
    worker: run.worker || null,
    mode: run.mode || null,
    status: run.status || null,
    disposition: run.disposition || null,
    last_work_ref: run.last_work_ref || null,
    last_gate: run.last_gate || null,
    stop_reason: run.stop_reason || null,
    started_at: run.started_at || null,
    deadline_at: run.deadline_at || null,
    finished_at: run.finished_at || null,
  };
}

function publicWorkState(issue, workRef, readError = null) {
  if (!workRef) return null;
  if (readError) return { work_ref: workRef, observed: false, error: readError };
  if (!issue) return { work_ref: workRef, observed: false, error: 'WORK_NOT_FOUND' };
  return {
    work_ref: issue.identifier || workRef,
    observed: true,
    state: issue.state?.name || null,
    lane: laneOf(issue),
    authoritative_revision: issue.updatedAt || null,
  };
}

function isHistoricalUnobservableTermination(run) {
  if (run?.status !== 'finished' || run?.disposition !== 'abandoned') return false;
  const reason = String(run?.stop_reason || '');
  return reason.startsWith('UNOBSERVABLE_SESSION_TERMINATION') || reason.startsWith('RUN_DEADLINE_ELAPSED_NO_CLEAN_FINISH');
}

function failureDetails(row) {
  const result = asObject(row?.result_projection) || {};
  return asObject(result.details) || result;
}

export function createOrchestrationDiagnosisService({
  store,
  authoritative,
  now = () => new Date().toISOString(),
} = {}) {
  if (!store || !authoritative) throw new TypeError('store and authoritative are required');

  async function diagnose(input) {
    const runId = normalizeRunId(input);
    const run = typeof store.getRun === 'function' ? await store.getRun(runId) : null;
    if (!run) throw err('RUN_NOT_FOUND', `orchestration run ${runId} was not found`);

    const [lastSuccess, recentFailures, latestLease] = await Promise.all([
      typeof store.lastSuccessfulInvocation === 'function' ? store.lastSuccessfulInvocation(runId) : null,
      typeof store.recentFailures === 'function' ? store.recentFailures(runId, 10) : [],
      typeof store.latestLease === 'function' ? store.latestLease(runId) : null,
    ]);
    const failures = Array.isArray(recentFailures) ? recentFailures : [];
    const checkpoint = latestLease && typeof store.latestCheckpoint === 'function' ? await store.latestCheckpoint(latestLease.lease_id) : null;
    const observedAt = now();
    let slot = null;
    let activeLease = null;
    let staleLease = false;
    if (latestLease && ['claiming','active','settling'].includes(latestLease.status)) {
      slot = typeof store.slot === 'function' ? await store.slot(latestLease.work_ref, latestLease.gate) : null;
      const leaseUnexpired = Date.parse(latestLease.expires_at) > Date.parse(observedAt);
      const slotOwned = Boolean(slot && slot.lease_id === latestLease.lease_id && Date.parse(slot.expires_at) > Date.parse(observedAt));
      staleLease = !leaseUnexpired || !slotOwned;
      if (!staleLease) activeLease = latestLease;
    }

    const requestedWorkRef = typeof input?.work_ref === 'string' && input.work_ref.trim() ? input.work_ref.trim() : null;
    const workRef = requestedWorkRef || activeLease?.work_ref || latestLease?.work_ref || run.last_work_ref || null;
    let workIssue = null;
    let workReadError = null;
    if (workRef) {
      try { workIssue = await authoritative.getIssue(workRef); }
      catch (error) { workReadError = String(error?.code || error?.message || 'authority_read_failed'); }
    }
    const workState = publicWorkState(workIssue, workRef, workReadError);

    const lastSuccessSequence = Number(lastSuccess?.sequence || 0);
    const latestFailure = failures[0] || null;
    const latestFailureSequence = Number(latestFailure?.sequence || 0);
    const activeFailure = latestFailure && latestFailureSequence > lastSuccessSequence ? latestFailure : null;

    let recoveryFailureCount = 0;
    let currentClassification = null;
    if (staleLease) {
      currentClassification = classifyOrchestrationFailure({ command:'work.claim', error_code:'LEASE_EXPIRED', details:{ lease_ref:latestLease.lease_id, work_ref:latestLease.work_ref } });
      recoveryFailureCount = 1;
    } else if (activeFailure) {
      const baseDetails = {
        ...failureDetails(activeFailure),
        ...(activeLease ? { lease_ref: activeLease.lease_id, work_ref: activeLease.work_ref } : {}),
        ...(checkpoint ? { checkpoint_already_durable: true, checkpoint_sha256: checkpoint.checkpoint_sha256 || null } : {}),
        ...(workState?.observed ? { work_ref: workState.work_ref, authoritative_revision: workState.authoritative_revision, actual_revision: workState.authoritative_revision } : {}),
      };
      const base = classifyOrchestrationFailure({
        command: activeFailure.command,
        error_code: activeFailure.error_code,
        retryable: activeFailure.retryable,
        rejection: activeFailure.rejection,
        may_have_mutated: activeFailure.may_have_mutated,
        details: baseDetails,
      });
      recoveryFailureCount = failures.filter((row) => {
        if (Number(row.sequence || 0) <= lastSuccessSequence) return false;
        const classified = classifyOrchestrationFailure({
          command: row.command,
          error_code: row.error_code,
          retryable: row.retryable,
          rejection: row.rejection,
          may_have_mutated: row.may_have_mutated,
          details: failureDetails(row),
        });
        return classified.failure_state === base.failure_state;
      }).length;
      currentClassification = classifyOrchestrationFailure({
        command: activeFailure.command,
        error_code: activeFailure.error_code,
        retryable: activeFailure.retryable,
        rejection: activeFailure.rejection,
        may_have_mutated: activeFailure.may_have_mutated,
        details: baseDetails,
        recovery_attempts: recoveryFailureCount,
      });
    }

    const latestTypedFailure = latestFailure ? classifyOrchestrationFailure({
      command: latestFailure.command,
      error_code: latestFailure.error_code,
      retryable: latestFailure.retryable,
      rejection: latestFailure.rejection,
      may_have_mutated: latestFailure.may_have_mutated,
      details: {
        ...failureDetails(latestFailure),
        ...(activeLease ? { lease_ref: activeLease.lease_id, work_ref: activeLease.work_ref } : {}),
        ...(checkpoint ? { checkpoint_already_durable:true } : {}),
        ...(workState?.observed ? { authoritative_revision:workState.authoritative_revision, actual_revision:workState.authoritative_revision, work_ref:workState.work_ref } : {}),
      },
    }) : null;

    const historicalUnobservable = isHistoricalUnobservableTermination(run);
    if (historicalUnobservable) currentClassification = null;
    const workerState = historicalUnobservable ? 'enabled' : deriveWorkerState(currentClassification);
    const automaticRecoveryAllowed = Boolean(currentClassification?.automatic_recovery_allowed);
    const escalationRequired = Boolean(currentClassification?.escalation_required);

    return {
      ok: true,
      schema: 'orchestration-diagnosis-v1',
      run_id: runId,
      observed_at: observedAt,
      current_run_state: publicRunState(run),
      current_work_state: workState,
      active_lease: publicLease(activeLease, false, checkpoint),
      latest_lease: publicLease(latestLease, false, checkpoint),
      worker_state: workerState,
      worker_state_source: 'derived_from_control_plane_evidence',
      last_successful_command: publicInvocation(lastSuccess),
      last_typed_failure: latestFailure ? { ...publicInvocation(latestFailure), ...latestTypedFailure } : null,
      recovery_failure_count: historicalUnobservable ? 0 : recoveryFailureCount,
      failure_state: historicalUnobservable ? null : (currentClassification?.failure_state || null),
      automatic_recovery_allowed: historicalUnobservable ? false : automaticRecoveryAllowed,
      recovery_operation: historicalUnobservable ? null : (currentClassification?.recovery_operation || null),
      escalation_required: historicalUnobservable ? false : escalationRequired,
      human_or_reasoning_escalation_required: historicalUnobservable ? false : escalationRequired,
      escalation_reason: historicalUnobservable ? null : (currentClassification?.escalation_reason || null),
      historical_classification: historicalUnobservable ? 'UNOBSERVABLE_SESSION_TERMINATION' : null,
      investigation_required: historicalUnobservable ? false : escalationRequired,
    };
  }

  return { diagnose };
}

export function createPostgresOrchestrationDiagnosisService(options = {}) {
  return createOrchestrationDiagnosisService({
    store: options.store || createPostgresOrchestrationRecoveryStore(options.db || db),
    authoritative: options.authoritative || createLinearAuthority(options.api || api),
    now: options.now,
  });
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
    const checkpoint = lease && typeof store.latestCheckpoint === 'function' ? await store.latestCheckpoint(lease.lease_id) : null;
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
          active_execution: publicLease(lease, false, checkpoint),
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
          active_execution: publicLease(lease, false, checkpoint),
          unresolved_effect: unresolved ? publicInvocation(unresolved) : null,
          authoritative_observations: [{ source: 'linear', work_ref: lease.work_ref, observed: false, error: String(error?.code || error?.message || 'read_failed') }],
          evidence,
          historical_correlation_missing: historicalCorrelationMissing,
        };
      }
      const state = issue?.state?.name || null;
      const lane = laneOf(issue);
      const expectedState = expectedOwnedState(lease);
      authoritativeObservations.push({ source: 'linear', work_ref: lease.work_ref, state, lane, authoritative_revision: issue?.updatedAt || null });
      if (state !== expectedState || lane !== lease.gate) {
        return {
          ok: true,
          run_id: runId,
          continuation: 'owner_action_required',
          last_invocation: lastInvocation,
          active_execution: publicLease(lease, false, checkpoint),
          unresolved_effect: unresolved ? publicInvocation(unresolved) : null,
          authoritative_observations: authoritativeObservations,
          evidence: [...evidence, { kind: 'lease_authority_mismatch', expected_state: expectedState, expected_lane: lease.gate, actual_state: state, actual_lane: lane }],
          historical_correlation_missing: historicalCorrelationMissing,
        };
      }

      if (lease.status === 'active') {
        return {
          ok: true,
          run_id: runId,
          continuation: 'recover_active_lease',
          last_invocation: lastInvocation,
          active_execution: publicLease(lease, true, checkpoint),
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
          active_execution: publicLease(lease, false, checkpoint),
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
        active_execution: publicLease(lease, true, checkpoint),
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
        active_execution: publicLease(lease, false, checkpoint),
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