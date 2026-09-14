import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { createCompactProviderOperationPostgresStore } from 'lib/compact-provider-operation-store.js';
import { reconcileGithubIntegrationRoleAware } from 'lib/github-branch-role-runtime.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const INTERNAL_COMMAND = 'github.integration.convergence';
const PENDING_PHASE = 'PENDING_CONVERGENCE';
const INDETERMINATE_PHASE = 'INDETERMINATE_CONVERGENCE';
const JUDGMENT_ERRORS = new Set([
  'GITHUB_INTEGRATION_CONFLICT',
  'GITHUB_INTEGRATION_CROSS_REPOSITORY_UNSUPPORTED',
  'GITHUB_INTEGRATION_MERGE_FAILED',
  'GITHUB_INTEGRATION_POLICY_EVIDENCE_INCOMPLETE',
  'GITHUB_INTEGRATION_POLICY_NOT_CONFIGURED',
  'GITHUB_INTEGRATION_PULL_REQUEST_CLOSED',
  'GITHUB_INTEGRATION_RECOMPUTE_REQUIRED',
  'GITHUB_APP_INSTALLATION_NOT_FOUND',
  'GITHUB_APP_PERMISSION_DENIED',
  'GITHUB_APP_SETUP_REQUIRED',
  'GITHUB_REVIEW_PACKET_FAILED',
]);
const JUDGMENT_WAITING = new Set(['changes_requested', 'conversation_resolution']);

function failure(code, message, details = {}) {
  return Object.freeze({ ok:false, error:code, message, may_have_mutated:false, ...details });
}

function text(value, field, max = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) throw Object.assign(new TypeError(`${field} is invalid`), { code:'GITHUB_INTEGRATION_CONVERGENCE_INVALID' });
  return normalized;
}

function exactHead(value, field = 'expected_head') {
  const normalized = text(value, field, 40).toLowerCase();
  if (!SHA40.test(normalized)) throw Object.assign(new TypeError(`${field} must be an exact Git SHA`), { code:'GITHUB_INTEGRATION_CONVERGENCE_INVALID' });
  return normalized;
}

function normalizeIntent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new TypeError('request must be an object'), { code:'GITHUB_INTEGRATION_CONVERGENCE_INVALID' });
  const allowed = new Set(['repo', 'pull_request', 'expected_head', 'run_id']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) throw Object.assign(new TypeError('request contains unknown fields'), { code:'GITHUB_INTEGRATION_CONVERGENCE_INVALID', details:{ unknown } });
  const repo = text(input.repo, 'repo', 256);
  if (!REPO.test(repo)) throw Object.assign(new TypeError('repo must be owner/repo'), { code:'GITHUB_INTEGRATION_CONVERGENCE_INVALID' });
  if (!Number.isInteger(input.pull_request) || input.pull_request <= 0) throw Object.assign(new TypeError('pull_request must be a positive integer'), { code:'GITHUB_INTEGRATION_CONVERGENCE_INVALID' });
  return Object.freeze({
    repo,
    pull_request:input.pull_request,
    expected_head:exactHead(input.expected_head),
    ...(input.run_id === undefined || input.run_id === null ? {} : { run_id:text(input.run_id, 'run_id', 256) }),
  });
}

function nowIso(now) {
  const value = String(now());
  if (!Number.isFinite(Date.parse(value))) throw new TypeError('now must return ISO time');
  return new Date(value).toISOString();
}

function scope(intent) {
  return `github:${intent.repo}`;
}

function idempotencyKey(intent) {
  return `pull-request:${intent.pull_request}:head:${intent.expected_head}`;
}

function subjectKey(intent) {
  return `github:${intent.repo}:pull-request:${intent.pull_request}`;
}

function waitingOn(value) {
  return Object.freeze([...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].sort());
}

function baseRecovery(intent) {
  return Object.freeze({
    schema:'github-integration-convergence-v1',
    phase:PENDING_PHASE,
    repo:intent.repo,
    pull_request:intent.pull_request,
    initial_head:intent.expected_head,
    accepted_head:intent.expected_head,
    merge_request_uuid:null,
    waiting_on:Object.freeze([]),
    last_reconciliation:null,
    external_mutation_attempted:false,
    ...(intent.run_id ? { run_id:intent.run_id } : {}),
  });
}

function operationIntent(operation) {
  const recovery = operation?.recovery_payload || {};
  return normalizeIntent({
    repo:recovery.repo,
    pull_request:Number(recovery.pull_request),
    expected_head:recovery.initial_head,
    ...(recovery.run_id ? { run_id:recovery.run_id } : {}),
  });
}

function publicState(operation, fallback = {}) {
  const recovery = operation?.recovery_payload || fallback || {};
  const resolution = operation?.resolution || {};
  const state = String(operation?.state || '');
  if (state === 'succeeded') {
    return Object.freeze({ ok:true, state, idempotent_replay:true, ...resolution, operation_id:operation?.operation_id || null });
  }
  if (state === 'rejected') {
    return Object.freeze({ ok:true, state, idempotent_replay:true, outcome:'requires_judgment', ...resolution, operation_id:operation?.operation_id || null });
  }
  if (state === 'indeterminate') {
    return Object.freeze({
      ok:false,
      outcome:'indeterminate',
      state,
      operation_id:operation?.operation_id || null,
      accepted_head:recovery.accepted_head || fallback.accepted_head || null,
      merge_request_uuid:recovery.merge_request_uuid || null,
      may_have_mutated:true,
      last_reconciliation:recovery.last_reconciliation || null,
    });
  }
  return Object.freeze({
    ok:true,
    outcome:'waiting',
    state:state || 'prepared',
    operation_id:operation?.operation_id || null,
    accepted_head:recovery.accepted_head || fallback.accepted_head || null,
    merge_request_uuid:recovery.merge_request_uuid || null,
    waiting_on:waitingOn(recovery.waiting_on || fallback.waiting_on),
    last_reconciliation:recovery.last_reconciliation || null,
  });
}

function failingRequired(result) {
  return waitingOn(result?.evidence?.checks?.failing_required || []);
}

function hardWaiting(result) {
  return waitingOn(result?.waiting_on || []).filter((reason) => JUDGMENT_WAITING.has(reason));
}

function resolutionForJudgment(recovery, result, reasons = []) {
  return Object.freeze({
    schema:'github-integration-convergence-resolution-v1',
    outcome:'requires_judgment',
    repo:recovery.repo,
    pull_request:recovery.pull_request,
    initial_head:recovery.initial_head,
    accepted_head:recovery.accepted_head,
    waiting_on:waitingOn(reasons),
    last_reconciliation:result || null,
  });
}

function resolutionForMerged(recovery, result) {
  return Object.freeze({
    schema:'github-integration-convergence-resolution-v1',
    outcome:'merged',
    repo:recovery.repo,
    pull_request:recovery.pull_request,
    initial_head:recovery.initial_head,
    accepted_head:recovery.accepted_head,
    merge_request_uuid:result?.merge_request_uuid || recovery.merge_request_uuid || null,
    merge_commit_sha:result?.merge_commit_sha || null,
    last_reconciliation:result || null,
  });
}

export function createGithubIntegrationConvergenceService(options = {}) {
  const operations = options.operations;
  const reconcileIntegration = options.reconcileIntegration;
  const now = options.now || (() => new Date().toISOString());
  const uuid = options.uuid || (() => crypto.randomUUID());
  const staleSeconds = Number.isFinite(Number(options.staleSeconds)) && Number(options.staleSeconds) > 0
    ? Math.max(1, Math.floor(Number(options.staleSeconds)))
    : 60;
  if (!operations || !['claim', 'claimPending', 'updateRecovery', 'markIndeterminate', 'succeed', 'reject', 'listPending'].every((key) => typeof operations[key] === 'function')) {
    throw new TypeError('operation_state store is required');
  }
  if (typeof reconcileIntegration !== 'function') throw new TypeError('reconcileIntegration is required');

  async function take(intent, recovery = baseRecovery(intent)) {
    const at = nowIso(now);
    const token = text(uuid(), 'attempt_token', 128);
    const semanticRequest = { repo:intent.repo, pull_request:intent.pull_request, expected_head:intent.expected_head };
    const requestSha = await sha256Text(canonicalJson(semanticRequest));
    const claimed = await operations.claim({
      command:INTERNAL_COMMAND,
      scope:scope(intent),
      idempotency_key:idempotencyKey(intent),
      request_sha256:requestSha,
      attempt_token:token,
      created_at:at,
      stale_before:new Date(Date.parse(at) - (staleSeconds * 1000)).toISOString(),
      subject_key:subjectKey(intent),
      run_id:intent.run_id || null,
      authority_revision:intent.expected_head,
      recovery_payload:recovery,
    });
    return { claimed, token };
  }

  async function persistPending(intent, token, recovery, result, extra = {}) {
    const next = Object.freeze({
      ...recovery,
      phase:PENDING_PHASE,
      ...extra,
      waiting_on:waitingOn(extra.waiting_on ?? result?.waiting_on ?? recovery.waiting_on),
      last_reconciliation:result || null,
    });
    const row = await operations.updateRecovery({
      command:INTERNAL_COMMAND,
      scope:scope(intent),
      idempotency_key:idempotencyKey(intent),
      attempt_token:token,
      updated_at:nowIso(now),
      recovery_payload:next,
    });
    return publicState(row, next);
  }

  async function rejectJudgment(intent, token, recovery, result, reasons = []) {
    const resolution = resolutionForJudgment(recovery, result, reasons);
    const row = await operations.reject({
      command:INTERNAL_COMMAND,
      scope:scope(intent),
      idempotency_key:idempotencyKey(intent),
      attempt_token:token,
      updated_at:nowIso(now),
      may_have_mutated:Boolean(recovery.external_mutation_attempted),
      resolution,
    });
    return publicState(row, resolution);
  }

  async function markIndeterminate(intent, token, recovery, result, message = null) {
    const next = Object.freeze({
      ...recovery,
      phase:INDETERMINATE_PHASE,
      external_mutation_attempted:true,
      last_reconciliation:result || null,
      last_error:message || result?.message || null,
    });
    const row = await operations.markIndeterminate({
      command:INTERNAL_COMMAND,
      scope:scope(intent),
      idempotency_key:idempotencyKey(intent),
      attempt_token:token,
      updated_at:nowIso(now),
      recovery_payload:next,
    });
    return publicState(row, next);
  }

  async function advance(intent, operation, token) {
    const recovery = operation?.recovery_payload || baseRecovery(intent);
    const acceptedHead = exactHead(recovery.accepted_head || intent.expected_head, 'accepted_head');
    const request = {
      repo:intent.repo,
      pull_request:intent.pull_request,
      expected_head:acceptedHead,
      apply:true,
      ...(recovery.merge_request_uuid ? { merge_request_uuid:recovery.merge_request_uuid } : {}),
    };
    let result;
    try {
      result = await reconcileIntegration(request);
    } catch (error) {
      if (error?.may_have_mutated === true) return markIndeterminate(intent, token, recovery, null, String(error?.message || error));
      return persistPending(intent, token, recovery, { ok:false, error:error?.code || 'GITHUB_INTEGRATION_RECONCILIATION_ERROR', message:String(error?.message || error), may_have_mutated:false }, { waiting_on:['github_reconciliation_error'] });
    }

    if (result?.may_have_mutated === true || result?.error === 'GITHUB_INTEGRATION_INDETERMINATE') {
      return markIndeterminate(intent, token, recovery, result);
    }

    if (result?.ok === true && result.outcome === 'updated_for_recheck') {
      let refreshedHead;
      try { refreshedHead = exactHead(result?.head?.sha, 'refreshed_head'); }
      catch { return rejectJudgment(intent, token, recovery, result, ['invalid_refreshed_head']); }
      const next = {
        accepted_head:refreshedHead,
        latest_base:result?.base || null,
        merge_request_uuid:null,
        external_mutation_attempted:true,
        waiting_on:['exact_head_verification'],
      };
      return persistPending(intent, token, recovery, result, next);
    }

    if (result?.ok === true && result.outcome === 'waiting') {
      const failing = failingRequired(result);
      if (failing.length) return rejectJudgment(intent, token, recovery, result, failing);
      const judgment = hardWaiting(result);
      if (judgment.length) return rejectJudgment(intent, token, recovery, result, judgment);
      return persistPending(intent, token, recovery, result);
    }

    if (result?.ok === true && result.outcome === 'stack_rebase_required') {
      return rejectJudgment(intent, token, recovery, result, ['stack_rebase_required']);
    }

    if (result?.ok === true && ['merge_submitted', 'merge_pending'].includes(result.outcome)) {
      const mergeRequestUuid = String(result.merge_request_uuid || recovery.merge_request_uuid || '').trim();
      if (!mergeRequestUuid) return markIndeterminate(intent, token, recovery, result, 'merge was submitted without a durable merge request identity');
      const state = await persistPending(intent, token, recovery, result, {
        merge_request_uuid:mergeRequestUuid,
        external_mutation_attempted:true,
        waiting_on:['merge_result'],
      });
      return Object.freeze({ ...state, outcome:'merge_pending', merge_request_uuid:mergeRequestUuid });
    }

    if (result?.ok === true && ['merged', 'already_merged'].includes(result.outcome)) {
      const resolution = resolutionForMerged(recovery, result);
      const row = await operations.succeed({
        command:INTERNAL_COMMAND,
        scope:scope(intent),
        idempotency_key:idempotencyKey(intent),
        attempt_token:token,
        updated_at:nowIso(now),
        may_have_mutated:true,
        effect_kind:'github_pull_request_merge',
        effect_ref:String(result?.merge_commit_sha || recovery.merge_request_uuid || `${intent.repo}#${intent.pull_request}`),
        resolution,
      });
      return publicState(row, resolution);
    }

    if (result?.ok === false && result.error === 'GITHUB_UPSTREAM_ERROR' && result.may_have_mutated !== true) {
      return persistPending(intent, token, recovery, result, { waiting_on:['github_upstream'] });
    }

    if (result?.ok === false && JUDGMENT_ERRORS.has(String(result.error || ''))) {
      return rejectJudgment(intent, token, recovery, result, [String(result.error || 'integration_judgment_required')]);
    }

    return rejectJudgment(intent, token, recovery, result, [String(result?.error || result?.outcome || 'unsupported_integration_state')]);
  }

  async function converge(input = {}) {
    let intent;
    try { intent = normalizeIntent(input); }
    catch (error) { return failure(error?.code || 'GITHUB_INTEGRATION_CONVERGENCE_INVALID', String(error?.message || error), error?.details || {}); }
    const recovery = baseRecovery(intent);
    const { claimed, token } = await take(intent, recovery);
    if (claimed.outcome === 'conflict') return failure('GITHUB_INTEGRATION_CONVERGENCE_IDEMPOTENCY_CONFLICT', 'integration intent identity was reused for a different request');
    if (claimed.outcome === 'terminal' || claimed.outcome === 'indeterminate') return publicState(claimed.operation, recovery);
    if (claimed.outcome === 'in_progress') return publicState(claimed.operation, recovery);
    return advance(intent, claimed.operation, token);
  }

  async function reconcilePending({ limit = 20 } = {}) {
    const pending = await operations.listPending({ command:INTERNAL_COMMAND, phase:PENDING_PHASE, limit });
    const results = [];
    for (const item of Array.isArray(pending) ? pending : []) {
      const intent = operationIntent(item);
      const recovery = item?.recovery_payload || {};
      const priorAttemptToken = text(recovery.attempt_token, 'prior_attempt_token', 128);
      const token = text(uuid(), 'attempt_token', 128);
      const claimed = await operations.claimPending({
        command:INTERNAL_COMMAND,
        scope:scope(intent),
        idempotency_key:idempotencyKey(intent),
        request_sha256:text(item?.request_sha256, 'request_sha256', 64),
        prior_attempt_token:priorAttemptToken,
        attempt_token:token,
        updated_at:nowIso(now),
        phase:PENDING_PHASE,
      });
      if (!claimed) continue;
      results.push(await advance(intent, claimed, token));
    }
    return Object.freeze(results);
  }

  return Object.freeze({ converge, reconcilePending, command:INTERNAL_COMMAND, phase:PENDING_PHASE });
}

export function createGithubIntegrationConvergenceForRuntime(runtime = {}) {
  const db = runtime.db;
  const operations = runtime.operations || createCompactProviderOperationPostgresStore(db);
  const withGitHubAppApiClient = runtime.withGitHubAppApiClient || runtime.githubAppAuth?.withApiClient;
  return createGithubIntegrationConvergenceService({
    operations,
    now:runtime.now,
    uuid:runtime.uuid,
    staleSeconds:runtime.staleSeconds,
    reconcileIntegration:runtime.reconcileIntegration || ((input) => reconcileGithubIntegrationRoleAware(input, {
      db,
      withGitHubAppApiClient,
    })),
  });
}
