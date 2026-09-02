import { api, db } from 'hatchable';
import { createLinearAuthority } from 'lib/work-leases.js';
import { classifyOrchestrationFailure, deriveWorkerState } from 'lib/orchestration-failures.js';
import { createPostgresSkillExecutionService, projectSkillState } from 'lib/skill-execution.js';

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
  if (!runId || runId.length > 512) throw err('REQUEST_INVALID', 'run_id must be a non-empty string of at most 512 characters', { field:'run_id' });
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
  if (receipt.ownership_protocol === 'lease-slot-v2') return receipt.current_state || lease?.previous_state || 'Todo';
  return receipt.current_state || 'In Progress';
}

function oneCurrent(rows, code, message, details = {}) {
  const values = Array.isArray(rows) ? rows : [];
  if (values.length > 1) throw err(code, message, { ...details, count:values.length });
  return values[0] || null;
}

function publicRunState(run) {
  if (!run) return null;
  return {
    run_id:run.run_id,
    worker:run.worker || null,
    mode:run.mode || null,
    status:run.status || null,
    disposition:run.disposition || null,
    last_work_ref:run.last_work_ref || null,
    last_gate:run.last_gate || null,
    active_subject_key:run.active_subject_key || null,
    unresolved_operation_id:run.unresolved_operation_id || null,
    stop_reason:run.stop_reason || null,
    started_at:run.started_at || null,
    deadline_at:run.deadline_at || null,
    finished_at:run.finished_at || null,
  };
}

function publicWorkState(issue, workRef, readError = null) {
  if (!workRef) return null;
  if (readError) return { work_ref:workRef, observed:false, error:readError };
  if (!issue) return { work_ref:workRef, observed:false, error:'WORK_NOT_FOUND' };
  return {
    work_ref:issue.identifier || workRef,
    observed:true,
    state:issue.state?.name || null,
    lane:laneOf(issue),
    authoritative_revision:issue.updatedAt || null,
  };
}

function publicCompactExecution(execution, includeToken = false) {
  if (!execution) return null;
  return {
    lease_id:execution.lease_ref,
    lease_ref:execution.lease_ref,
    subject_key:execution.subject_key,
    subject_kind:execution.subject_kind,
    run_id:execution.run_id,
    status:'active',
    authority_epoch:Number(execution.authority_epoch || 0),
    authority_repository:execution.authority_repository || null,
    authority_revision:execution.authority_revision || null,
    expires_at:execution.expires_at || null,
    hard_expires_at:execution.hard_expires_at || null,
    checkpoint:execution.checkpoint == null ? null : {
      checkpoint_sha256:execution.checkpoint_sha256 || null,
      phase:asObject(execution.checkpoint)?.phase || null,
      next_action_kind:asObject(execution.checkpoint)?.next_action_kind || null,
    },
    continuation_sha256:execution.continuation_sha256 || null,
    no_progress_streak:Number(execution.no_progress_streak || 0),
    ...(includeToken && execution.active_capability_material ? { lease_token:execution.active_capability_material } : {}),
  };
}

function publicLegacyLease(lease, includeToken = false) {
  if (!lease) return null;
  return {
    lease_id:lease.lease_id,
    work_ref:lease.work_ref,
    gate:lease.gate,
    run_id:lease.run_id,
    status:lease.status,
    created_at:lease.created_at,
    expires_at:lease.expires_at,
    claim_idempotency_key:lease.claim_idempotency_key || null,
    settle_idempotency_key:lease.settle_idempotency_key || null,
    ...(includeToken ? { lease_token:lease.lease_token } : {}),
  };
}

function publicOperation(operation) {
  if (!operation) return null;
  const recovery = asObject(operation.recovery_payload) || {};
  const result = asObject(operation.resolution) || {};
  return {
    invocation_id:operation.operation_id,
    operation_id:operation.operation_id,
    sequence:null,
    command:operation.command,
    target_kind:null,
    target_ref:operation.subject_key || operation.idempotency_scope || null,
    started_at:operation.created_at || null,
    completed_at:operation.resolved_at || null,
    outcome:operation.state === 'prepared' ? 'running' : operation.state,
    error_code:operation.state === 'indeterminate' ? 'MUTATION_STATE_INDETERMINATE' : null,
    retryable:operation.state === 'prepared',
    rejection:operation.state === 'rejected',
    may_have_mutated:Boolean(operation.may_have_mutated),
    request_projection:asObject(recovery.request_json) || {},
    result_projection:result,
  };
}

function isHistoricalUnobservableTermination(run) {
  if (run?.status !== 'finished' || run?.disposition !== 'abandoned') return false;
  const reason = String(run?.stop_reason || '');
  return reason.startsWith('UNOBSERVABLE_SESSION_TERMINATION') || reason.startsWith('RUN_DEADLINE_ELAPSED_NO_CLEAN_FINISH');
}

function operationClassification(operation) {
  if (!operation) return null;
  const recovery = asObject(operation.recovery_payload) || {};
  return classifyOrchestrationFailure({
    command:operation.command,
    error_code:operation.state === 'indeterminate' ? 'MUTATION_STATE_INDETERMINATE' : 'OPERATION_IN_PROGRESS',
    retryable:operation.state === 'prepared',
    rejection:false,
    may_have_mutated:Boolean(operation.may_have_mutated),
    details:{
      ...recovery,
      operation_id:operation.operation_id,
      request_sha256:operation.request_sha256,
      authority_revision:operation.authority_revision || null,
      lease_epoch:operation.lease_epoch == null ? null : Number(operation.lease_epoch),
    },
  });
}

function currentFailureClassification(run, execution, legacyLease) {
  const errorCode = typeof run?.current_failure_error_code === 'string' ? run.current_failure_error_code.trim() : '';
  if (!errorCode) return null;
  const command = String(run.current_failure_command || 'unknown');
  const details = {};
  if (command === 'work.heartbeat') {
    const leaseRef = execution?.lease_ref || legacyLease?.lease_id || null;
    if (leaseRef) details.lease_ref = leaseRef;
    details.checkpoint_already_durable = Boolean(execution?.checkpoint_sha256);
  }
  return classifyOrchestrationFailure({
    command,
    error_code:errorCode,
    error_class:run.current_failure_error_class || null,
    retryable:Boolean(run.current_failure_retryable),
    rejection:Boolean(run.current_failure_rejection),
    may_have_mutated:Boolean(run.current_failure_may_have_mutated),
    recovery_attempts:Number(run.current_failure_streak || 0),
    details,
  });
}

function publicCurrentFailure(run) {
  if (!run?.current_failure_error_code) return null;
  return {
    invocation_id:null,
    operation_id:null,
    sequence:null,
    command:run.current_failure_command || null,
    outcome:'failed',
    error_code:run.current_failure_error_code,
    error_class:run.current_failure_error_class || null,
    retryable:Boolean(run.current_failure_retryable),
    rejection:Boolean(run.current_failure_rejection),
    may_have_mutated:Boolean(run.current_failure_may_have_mutated),
    recovery_attempts:Number(run.current_failure_streak || 0),
  };
}

export function createPostgresOrchestrationRecoveryStore(dbBinding = db) {
  async function row(sql, params) {
    const result = await dbBinding.query(sql, params);
    return result.rows?.[0] || null;
  }
  async function rows(sql, params) {
    const result = await dbBinding.query(sql, params);
    return result.rows || [];
  }
  return {
    async getRun(runId) {
      return row('SELECT * FROM orchestration_runs WHERE run_id = $1 LIMIT 1', [runId]);
    },
    async currentExecution(runId) {
      return oneCurrent(
        await rows('SELECT * FROM execution_state WHERE run_id = $1 AND lease_ref IS NOT NULL LIMIT 2', [runId]),
        'COMPACT_EXECUTION_AMBIGUOUS',
        'run has more than one active compact execution authority',
        { run_id:runId },
      );
    },
    async unresolvedOperation(runId) {
      return oneCurrent(
        await rows("SELECT * FROM operation_state WHERE run_id = $1 AND state IN ('prepared','indeterminate') LIMIT 2", [runId]),
        'COMPACT_OPERATION_AMBIGUOUS',
        'run has more than one unresolved compact operation',
        { run_id:runId },
      );
    },
    async currentLegacyLease(runId) {
      return oneCurrent(
        await rows("SELECT * FROM work_leases WHERE run_id = $1 AND status IN ('claiming','active','settling','invalidated') LIMIT 2", [runId]),
        'LEGACY_EXECUTION_AMBIGUOUS',
        'run has more than one current legacy execution authority',
        { run_id:runId },
      );
    },
    async slot(workRef, gate) {
      return row('SELECT * FROM work_lease_slots WHERE work_ref = $1 AND gate = $2 LIMIT 1', [workRef, gate]);
    },
  };
}

async function currentRecoveryState(store, runId) {
  const run = await store.getRun(runId);
  if (!run) throw err('RUN_NOT_FOUND', `orchestration run ${runId} was not found`);
  const [execution, operation, legacyLease] = await Promise.all([
    typeof store.currentExecution === 'function' ? store.currentExecution(runId) : null,
    typeof store.unresolvedOperation === 'function' ? store.unresolvedOperation(runId) : null,
    typeof store.currentLegacyLease === 'function' ? store.currentLegacyLease(runId) : null,
  ]);
  if (execution && legacyLease) {
    throw err('EXECUTION_AUTHORITY_AMBIGUOUS', 'run has both compact and legacy current execution authority', { run_id:runId });
  }
  return { run, execution, operation, legacyLease };
}

export function createOrchestrationDiagnosisService({ store, authoritative, now = () => new Date().toISOString() } = {}) {
  if (!store || !authoritative) throw new TypeError('store and authoritative are required');

  async function diagnose(input) {
    const runId = normalizeRunId(input);
    const { run, execution, operation, legacyLease } = await currentRecoveryState(store, runId);
    const observedAt = now();
    const historicalUnobservable = isHistoricalUnobservableTermination(run);
    let currentClassification = historicalUnobservable ? null : operationClassification(operation);
    let activeExecution = null;
    let workState = null;

    if (execution) {
      const unexpired = Date.parse(execution.expires_at) > Date.parse(observedAt);
      if (unexpired) activeExecution = publicCompactExecution(execution, false);
      else if (!currentClassification) {
        currentClassification = classifyOrchestrationFailure({
          command:'project.advance',
          error_code:'LEASE_EXPIRED',
          details:{ lease_ref:execution.lease_ref, subject_key:execution.subject_key, authority_epoch:Number(execution.authority_epoch || 0) },
        });
      }
    } else if (legacyLease) {
      const slot = legacyLease.status === 'invalidated' ? null : await store.slot(legacyLease.work_ref, legacyLease.gate);
      const unexpired = Date.parse(legacyLease.expires_at) > Date.parse(observedAt);
      const ownsSlot = Boolean(slot && slot.lease_id === legacyLease.lease_id && Date.parse(slot.expires_at) > Date.parse(observedAt));
      if (legacyLease.status !== 'invalidated' && unexpired && ownsSlot) activeExecution = publicLegacyLease(legacyLease, false);
      else if (!currentClassification) {
        currentClassification = classifyOrchestrationFailure({
          command:'work.claim',
          error_code:legacyLease.status === 'invalidated' ? 'LEASE_INVALIDATED' : 'LEASE_EXPIRED',
          details:{ lease_ref:legacyLease.lease_id, work_ref:legacyLease.work_ref },
        });
      }
      let issue = null;
      let readError = null;
      try { issue = await authoritative.getIssue(legacyLease.work_ref); }
      catch (error) { readError = String(error?.code || error?.message || 'authority_read_failed'); }
      workState = publicWorkState(issue, legacyLease.work_ref, readError);
    } else {
      const requestedWorkRef = typeof input?.work_ref === 'string' && input.work_ref.trim() ? input.work_ref.trim() : null;
      if (requestedWorkRef) {
        let issue = null;
        let readError = null;
        try { issue = await authoritative.getIssue(requestedWorkRef); }
        catch (error) { readError = String(error?.code || error?.message || 'authority_read_failed'); }
        workState = publicWorkState(issue, requestedWorkRef, readError);
      }
    }

    if (!historicalUnobservable && !currentClassification) {
      currentClassification = currentFailureClassification(run, execution, legacyLease);
    }

    const workerState = historicalUnobservable ? 'enabled' : deriveWorkerState(currentClassification);
    const escalationRequired = Boolean(currentClassification?.escalation_required);
    const typedFailure = operation
      ? { ...publicOperation(operation), ...operationClassification(operation) }
      : (publicCurrentFailure(run) ? { ...publicCurrentFailure(run), ...currentFailureClassification(run, execution, legacyLease) } : null);
    const recoveryFailureCount = historicalUnobservable
      ? 0
      : (run.current_failure_error_code ? Number(run.current_failure_streak || 0) : (currentClassification ? 1 : 0));

    return {
      ok:true,
      schema:'orchestration-diagnosis-v1',
      run_id:runId,
      observed_at:observedAt,
      current_run_state:publicRunState(run),
      current_work_state:workState,
      active_lease:activeExecution,
      latest_lease:activeExecution,
      worker_state:workerState,
      worker_state_source:'derived_from_compact_current_state',
      last_successful_command:null,
      last_typed_failure:historicalUnobservable ? null : typedFailure,
      recovery_failure_count:recoveryFailureCount,
      failure_state:historicalUnobservable ? null : (currentClassification?.failure_state || null),
      automatic_recovery_allowed:historicalUnobservable ? false : Boolean(currentClassification?.automatic_recovery_allowed),
      recovery_operation:historicalUnobservable ? null : (currentClassification?.recovery_operation || null),
      escalation_required:historicalUnobservable ? false : escalationRequired,
      human_or_reasoning_escalation_required:historicalUnobservable ? false : escalationRequired,
      escalation_reason:historicalUnobservable ? null : (currentClassification?.escalation_reason || null),
      historical_classification:historicalUnobservable ? 'UNOBSERVABLE_SESSION_TERMINATION' : null,
      investigation_required:historicalUnobservable ? false : escalationRequired,
    };
  }

  return { diagnose };
}

export function createPostgresOrchestrationDiagnosisService(options = {}) {
  return createOrchestrationDiagnosisService({
    store:options.store || createPostgresOrchestrationRecoveryStore(options.db || db),
    authoritative:options.authoritative || createLinearAuthority(options.api || api),
    now:options.now,
  });
}

function baseResume(runId, run, operation, fields = {}) {
  return {
    ok:true,
    run_id:runId,
    continuation:fields.continuation,
    last_invocation:null,
    active_execution:fields.active_execution || null,
    ...(fields.retry ? { retry:fields.retry } : {}),
    unresolved_effect:operation ? publicOperation(operation) : null,
    authoritative_observations:fields.authoritative_observations || [],
    evidence:fields.evidence || [],
    historical_correlation_missing:false,
    current_run_state:publicRunState(run),
  };
}

export function createOrchestrationResumeService({ store, authoritative, now = () => new Date().toISOString() } = {}) {
  if (!store || !authoritative) throw new TypeError('store and authoritative are required');

  async function resume(input) {
    const runId = normalizeRunId(input);
    const { run, execution, operation, legacyLease } = await currentRecoveryState(store, runId);
    const observedAt = now();

    if (execution) {
      const unexpired = Date.parse(execution.expires_at) > Date.parse(observedAt);
      const evidence = [{
        kind:'compact_execution_state',
        subject_key:execution.subject_key,
        lease_ref:execution.lease_ref,
        authority_epoch:Number(execution.authority_epoch || 0),
        authority_revision:execution.authority_revision || null,
        unexpired,
      }];
      if (!unexpired) return baseResume(runId, run, operation, { continuation:'recompute_frontier', evidence });
      return baseResume(runId, run, operation, {
        continuation:'recover_active_lease',
        active_execution:publicCompactExecution(execution, true),
        evidence,
      });
    }

    if (legacyLease) {
      if (legacyLease.status === 'invalidated') {
        return baseResume(runId, run, operation, {
          continuation:'owner_action_required',
          active_execution:publicLegacyLease(legacyLease, false),
          evidence:[{ kind:'invalidated_lease', reconciliation:asObject(legacyLease.reconciliation) || {} }],
        });
      }
      const slot = await store.slot(legacyLease.work_ref, legacyLease.gate);
      const unexpired = Date.parse(legacyLease.expires_at) > Date.parse(observedAt);
      const ownsSlot = Boolean(slot && slot.lease_id === legacyLease.lease_id && Date.parse(slot.expires_at) > Date.parse(observedAt));
      const evidence = [{ kind:'current_legacy_lease', lease_id:legacyLease.lease_id, status:legacyLease.status, owns_slot:ownsSlot, unexpired }];
      if (!unexpired || !ownsSlot) return baseResume(runId, run, operation, { continuation:'recompute_frontier', evidence });

      let issue;
      try { issue = await authoritative.getIssue(legacyLease.work_ref); }
      catch (error) {
        return baseResume(runId, run, operation, {
          continuation:'reconcile_authority',
          active_execution:publicLegacyLease(legacyLease, false),
          authoritative_observations:[{ source:'linear', work_ref:legacyLease.work_ref, observed:false, error:String(error?.code || error?.message || 'read_failed') }],
          evidence,
        });
      }
      const state = issue?.state?.name || null;
      const lane = laneOf(issue);
      const expectedState = expectedOwnedState(legacyLease);
      const observations = [{ source:'linear', work_ref:legacyLease.work_ref, state, lane, authoritative_revision:issue?.updatedAt || null }];
      if (state !== expectedState || lane !== legacyLease.gate) {
        return baseResume(runId, run, operation, {
          continuation:'owner_action_required',
          active_execution:publicLegacyLease(legacyLease, false),
          authoritative_observations:observations,
          evidence:[...evidence, { kind:'lease_authority_mismatch', expected_state:expectedState, expected_lane:legacyLease.gate, actual_state:state, actual_lane:lane }],
        });
      }
      if (legacyLease.status === 'active') {
        return baseResume(runId, run, operation, {
          continuation:'recover_active_lease',
          active_execution:publicLegacyLease(legacyLease, true),
          authoritative_observations:observations,
          evidence,
        });
      }
      if (legacyLease.status === 'claiming') {
        const request = asObject(legacyLease.claim_request);
        return baseResume(runId, run, operation, {
          continuation:request ? 'retry_same_request' : 'reconcile_authority',
          active_execution:publicLegacyLease(legacyLease, false),
          ...(request ? { retry:{ command:'work.claim', request } } : {}),
          authoritative_observations:observations,
          evidence,
        });
      }
      const plan = asObject(legacyLease.settle_plan);
      const replay = asObject(plan?.replay_request);
      const request = replay ? { lease_token:legacyLease.lease_token, ...replay, idempotency_key:legacyLease.settle_idempotency_key } : null;
      return baseResume(runId, run, operation, {
        continuation:request ? 'retry_same_request' : 'reconcile_authority',
        active_execution:publicLegacyLease(legacyLease, true),
        ...(request ? { retry:{ command:'work.settle', request, request_sha256:legacyLease.settle_request_hash } } : {}),
        authoritative_observations:observations,
        evidence,
      });
    }

    if (operation) {
      const recovery = asObject(operation.recovery_payload) || {};
      const request = asObject(recovery.request_json);
      if (operation.state === 'prepared' && operation.may_have_mutated !== true && request) {
        return baseResume(runId, run, operation, {
          continuation:'retry_same_request',
          retry:{ command:operation.command, request, request_sha256:operation.request_sha256 },
          evidence:[{ kind:'compact_operation_state', operation_id:operation.operation_id, state:operation.state, may_have_mutated:false }],
        });
      }
      if (operation.state === 'prepared' && operation.may_have_mutated !== true) {
        return baseResume(runId, run, operation, {
          continuation:'recompute_frontier',
          evidence:[{ kind:'compact_operation_state', operation_id:operation.operation_id, state:operation.state, may_have_mutated:false }],
        });
      }
      return baseResume(runId, run, operation, {
        continuation:'reconcile_authority',
        evidence:[{ kind:'compact_operation_state', operation_id:operation.operation_id, state:operation.state, may_have_mutated:Boolean(operation.may_have_mutated), effect_kind:operation.effect_kind || null, effect_ref:operation.effect_ref || null }],
      });
    }

    return baseResume(runId, run, null, {
      continuation:run.status === 'finished' ? 'terminal_or_quiescent' : 'recompute_frontier',
    });
  }

  return { resume };
}

export function createPostgresOrchestrationResumeService(options = {}) {
  return createOrchestrationResumeService({
    store:options.store || createPostgresOrchestrationRecoveryStore(options.db || db),
    authoritative:options.authoritative || createLinearAuthority(options.api || api),
    now:options.now,
  });
}

export async function orchestrationResumePacket(input, options = {}) {
  const resumeService = options.resumeService || createPostgresOrchestrationResumeService(options);
  const skillService = options.skillService || createPostgresSkillExecutionService({ db:options.db || db });
  const packet = await resumeService.resume(input);
  const runId = packet.run_id || input?.run_id;
  let skills;
  try {
    skills = await skillService.state({ run_id:runId });
  } catch (error) {
    if (error?.code !== 'RUN_NOT_FOUND') throw error;
    skills = { ok:true, ...projectSkillState({ run_id:runId, worker:null }, []) };
  }
  return { ...packet, skills };
}

export const orchestrationResumeConfig = Object.freeze({ continuations:CONTINUATIONS });