import { db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { executeCommand } from 'lib/command-response.js';

export const ORCHESTRATION_JOURNAL_SCHEMA_VERSION = 'orchestration-journal-v1';
const MAX_RUN_ID = 512;
const MAX_PATHS = 20;
const MAX_ITEMS = 25;

function err(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function optionalRunId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_RUN_ID) {
    throw err('REQUEST_INVALID', `run_id must be a non-empty string of at most ${MAX_RUN_ID} characters`, { field: 'run_id' });
  }
  return value.trim();
}

function boundedStrings(values, max = MAX_PATHS) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, max).map((value) => String(value).slice(0, 1024));
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function sourceSyncTarget(request) {
  const project = typeof request?.hatchable_project === 'string' ? request.hatchable_project.trim() : '';
  const repository = typeof request?.github_repository === 'string' ? request.github_repository.trim() : '';
  if (project && repository) return `${project}<->${repository}`;
  return repository || project || null;
}

function safeTarget(command, request) {
  if (command.startsWith('work.')) return { target_kind: 'linear_issue', target_ref: request.work_ref || null };
  if (command.startsWith('github.')) return { target_kind: 'github_repository', target_ref: request.repo || request.repository || null };
  if (command.startsWith('source.')) return { target_kind: 'source_sync', target_ref: sourceSyncTarget(request) };
  if (command.startsWith('skill.')) return { target_kind: 'orchestration_skill', target_ref: request.skill || request.activation_id || null };
  if (command === 'linear.archive') return { target_kind: 'linear_issue', target_ref: request.issue || null };
  if (command === 'portfolio.reconcile_work_surface') return { target_kind: 'linear_project', target_ref: request.project || null };
  if (command.startsWith('orchestration.')) return { target_kind: 'orchestration_run', target_ref: request.run_id || null };
  return { target_kind: null, target_ref: null };
}

export function splitOrchestrationRequest(command, input) {
  const original = object(input);
  const run_id = optionalRunId(original.run_id);
  if (command === 'work.claim' || command === 'work.heartbeat' || command === 'skill.activate' || command.startsWith('orchestration.')) return { run_id, domain_request: { ...original } };
  const domain_request = { ...original };
  delete domain_request.run_id;
  return { run_id, domain_request };
}

export async function semanticRequestHash(command, input) {
  const { domain_request } = splitOrchestrationRequest(command, input);
  return sha256Text(canonicalJson(domain_request));
}

export function safeRequestProjection(command, request) {
  const body = object(request);
  if (command === 'skill.activate') return pick(body, ['run_id','skill','reason']);
  if (command === 'skill.complete') return { ...pick(body, ['activation_id','outcome']), evidence_count:Array.isArray(body.evidence) ? body.evidence.length : 0 };
  if (command === 'work.claim') {
    return pick(body, ['work_ref', 'expected_revision', 'expected_state', 'expected_lane', 'lease_seconds', 'idempotency_key']);
  }
  if (command === 'work.checkpoint') {
    return {
      idempotency_key: body.idempotency_key || null,
      checkpoint_phase: body.checkpoint?.phase || null,
      next_action_kind: body.checkpoint?.next_action_kind || null,
      completed_count: Array.isArray(body.checkpoint?.completed) ? body.checkpoint.completed.length : 0,
      evidence_count: Array.isArray(body.checkpoint?.evidence) ? body.checkpoint.evidence.length : 0,
    };
  }
  if (command === 'work.heartbeat') {
    return {
      idempotency_key: body.idempotency_key || null,
      extend_seconds: body.extend_seconds || null,
      checkpoint_phase: body.checkpoint?.phase || null,
      next_action_kind: body.checkpoint?.next_action_kind || null,
      completed_count: Array.isArray(body.checkpoint?.completed) ? body.checkpoint.completed.length : 0,
      evidence_count: Array.isArray(body.checkpoint?.evidence) ? body.checkpoint.evidence.length : 0,
    };
  }
  if (command === 'work.settle') {
    return {
      ...pick(body, ['disposition', 'reason', 'promotion_condition', 'next_state', 'next_lane', 'idempotency_key']),
      evidence_count: Array.isArray(body.evidence) ? body.evidence.length : 0,
    };
  }
  if (command === 'github.apply_changeset') {
    return {
      ...pick(body, ['repo', 'branch', 'expected_head', 'base_branch', 'idempotency_key', 'commit_message']),
      changed_path_count: Array.isArray(body.changes) ? body.changes.length : null,
      changed_paths: Array.isArray(body.changes) ? boundedStrings(body.changes.map((change) => change?.path).filter(Boolean)) : [],
    };
  }
  if (command === 'github.delete_branch') return pick(body, ['repo', 'branch', 'expected_head']);
  if (command === 'github.required_checks.ensure') {
    return { ...pick(body, ['repo', 'branch', 'expected_head']), required_checks: boundedStrings(body.required_checks, 50) };
  }
  if (command === 'github.pages.ensure') return pick(body, ['repo', 'dispatch', 'ref']);
  if (command === 'github.review_packet') return pick(body, ['repo', 'pull_number', 'pr_number', 'expected_head']);
  if (command === 'github.capabilities') return pick(body, ['repo']);
  if (command === 'github.integration.reconcile') return pick(body, ['repo', 'pull_request', 'expected_head', 'apply', 'merge_request_uuid']);
  if (command === 'linear.archive') return pick(body, ['issue', 'dry_run']);
  if (command === 'portfolio.reconcile_work_surface') {
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
    return {
      project: body.project || null,
      idempotency_key: body.idempotency_key || null,
      dry_run: Boolean(body.dry_run),
      item_count: items.length,
      items: items.map((item) => ({
        repo: item?.source?.repo || null,
        issue_number: item?.source?.issue_number || null,
        expected_revision: item?.source?.expected_revision || null,
      })),
    };
  }
  if (command === 'orchestration.start') return {
    ...pick(body, ['run_id','worker','mode','continuation_key','budget_seconds','settlement_reserve_seconds','minimum_new_gate_seconds']),
    scope: body.scope ? { project: body.scope.project || null, team: body.scope.team || null, projects: boundedStrings(body.scope.projects, 25), lanes: boundedStrings(body.scope.lanes, 8), repositories: boundedStrings(body.scope.repositories, 25) } : null,
    contract_provenance: body.contract_provenance ? {
      project_instructions: pick(body.contract_provenance.project_instructions, ['file_id','revision_id','sha256']),
      fast_forward_skill: pick(body.contract_provenance.fast_forward_skill, ['file_id','revision_id','sha256']),
      execution_ownership_skill: pick(body.contract_provenance.execution_ownership_skill, ['file_id','revision_id','sha256']),
    } : null,
  };
  if (command === 'orchestration.horizon_checkpoint') return { run_id: body.run_id || null, candidate_count: Array.isArray(body.candidates) ? body.candidates.length : 0, work_refs: boundedStrings((body.candidates || []).map(x=>x?.work_ref).filter(Boolean), 10) };
  if (command === 'orchestration.horizon_resolve') return pick(body, ['run_id']);
  if (command === 'orchestration.finish') {
    const projection = pick(body, ['run_id','disposition','last_work_ref','last_gate','stop_reason']);
    if (body.active_lease_settlement && typeof body.active_lease_settlement === 'object') {
      projection.active_lease_settlement = pick(body.active_lease_settlement, ['disposition','requeue_class','next_state','next_lane']);
    }
    return projection;
  }
  if (command === 'orchestration.maintain') return pick(body, ['run_id']);
  if (command === 'orchestration.resume_packet') return pick(body, ['run_id']);
  if (command === 'orchestration.diagnose') return pick(body, ['run_id','work_ref']);
  if (command === 'orchestration.status') return {};
  return {};
}

export function safeResultProjection(command, responseBody) {
  const body = object(responseBody);
  if (command === 'skill.activate' || command === 'skill.complete') {
    return pick(body, ['activation_id','run_id','skill','revision','reference','status','created_at','completed_at','idempotent_replay']);
  }
  if (command === 'work.claim') {
    return pick(body, ['work_ref', 'lease_id', 'expires_at', 'previous_state', 'current_state', 'lane', 'authoritative_revision', 'idempotent_replay']);
  }
  if (command === 'work.checkpoint') {
    return pick(body, ['work_ref', 'lease_id', 'gate', 'checkpoint_sha256', 'created_at', 'idempotent_replay']);
  }
  if (command === 'work.heartbeat') {
    return pick(body, ['work_ref','lease_id','gate','previous_expires_at','expires_at','hard_expires_at','checkpoint_sha256','progress_sha256','heartbeat_count','created_at','idempotent_replay']);
  }
  if (command === 'work.settle') {
    return pick(body, ['work_ref', 'lease_id', 'disposition', 'previous_state', 'current_state', 'previous_lane', 'current_lane', 'settled_at', 'settlement_authoritative_revision', 'idempotent_replay']);
  }
  if (command === 'github.apply_changeset') {
    const projection = pick(body, ['repo', 'repository', 'branch', 'commit_sha', 'tree_sha', 'base_sha', 'previous_head', 'new_head', 'idempotent_replay']);
    const paths = body.changed_paths || body.paths;
    if (Array.isArray(paths)) {
      projection.changed_path_count = paths.length;
      projection.changed_paths = boundedStrings(paths);
    }
    return projection;
  }
  if (command === 'github.delete_branch') return pick(body, ['repo', 'branch', 'expected_head', 'actual_head', 'outcome', 'may_have_mutated']);
  if (command === 'github.required_checks.ensure') {
    return {
      ...pick(body, ['repo', 'branch', 'expected_head', 'observed_head', 'mechanism', 'changed', 'outcome', 'verified', 'ruleset_id', 'may_have_mutated']),
      effective_required_checks: boundedStrings(body.effective_required_checks, 50),
    };
  }
  if (command === 'github.pages.ensure') return pick(body, ['repo', 'created', 'build_type', 'html_url', 'status', 'dispatched', 'ref', 'workflow_run_id', 'workflow_run_status', 'workflow_run_conclusion', 'workflow_run_html_url', 'workflow_run_head_sha']);
  if (command === 'github.review_packet') return {
    repo: body.repo || null,
    pull_request: body.pull_request ?? body.pull_number ?? body.pr_number ?? null,
    head_sha: body.head?.sha || body.head_sha || null,
    base_sha: body.base?.sha || body.base_sha || null,
    head_moved: body.head_moved ?? null,
    review_decision: body.review?.decision ?? body.review_decision ?? null,
    mergeable: body.merge?.mergeable ?? null,
    merge_state: body.merge?.merge_state ?? null,
    checks_rollup_state: body.checks?.rollup_state ?? null,
    snapshot_sha256: body.snapshot?.sha256 || null,
  };
  if (command === 'github.capabilities') return pick(body, ['repo']);
  if (command === 'github.integration.reconcile') return pick(body, ['repo', 'pull_request', 'expected_head', 'outcome', 'merge_request_uuid', 'merge_commit_sha', 'stack_atomic', 'integration_method', 'merge_method', 'merge_action', 'existing_request', 'may_have_mutated']);
  if (command === 'linear.archive') {
    return {
      ...pick(body, ['changed', 'alreadyArchived', 'archived', 'dryRun', 'may_have_mutated']),
      issue: body.candidate?.identifier || body.issue || null,
      state: body.candidate?.state?.name || null,
    };
  }
  if (command === 'portfolio.reconcile_work_surface') {
    return {
      project: body.project || null,
      summary: body.summary || null,
      idempotent_replay: Boolean(body.idempotent_replay),
      may_have_mutated: body.may_have_mutated === true,
      items: Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS).map((item) => pick(item, [
        'source_key', 'source_revision', 'result', 'reason', 'linear_issue', 'linear_issue_id', 'changed_fields', 'recovery_outcome',
      ])) : [],
    };
  }
  if (command === 'orchestration.start') return { ...pick(body, ['run_id','worker','mode','continuation_key','predecessor_run_id','status','deadline_at','idempotent_replay','work_authority_changed']), recovered_candidate_count: Array.isArray(body.recovered_horizon?.candidates) ? body.recovered_horizon.candidates.length : 0 };
  if (command === 'orchestration.horizon_checkpoint' || command === 'orchestration.horizon_resolve') return { ...pick(body, ['run_id','horizon_id','generation','horizon_sha256','ownership_granted','authority_revalidated','work_authority_changed']), candidate_count: Array.isArray(body.candidates) ? body.candidates.length : 0 };
  if (command === 'orchestration.finish') return pick(body, ['run_id','status','disposition','last_work_ref','last_gate','stop_reason','finished_at','idempotent_replay','work_authority_changed']);
  if (command === 'orchestration.maintain') return pick(body, ['action_count','semantic_work_mutations','work_selection_performed']);
  if (command === 'orchestration.resume_packet') return pick(body, ['run_id', 'continuation', 'historical_correlation_missing']);
  if (command === 'orchestration.diagnose') return pick(body, ['run_id','failure_state','worker_state','automatic_recovery_allowed','escalation_required','historical_classification','investigation_required']);
  if (command === 'orchestration.status') return pick(body, ['healthy', 'observed_window_hours']);
  return {};
}

export function journalOutcomeFor(body) {
  if (body?.ok === true) return 'succeeded';
  const code = String(body?.error || '');
  const mayHaveMutated = body?.may_have_mutated === true || body?.details?.may_have_mutated === true;
  if (code.includes('INDETERMINATE') || (mayHaveMutated && body?.rejection !== true)) return 'indeterminate';
  if (body?.rejection === true) return 'rejected';
  return 'failed';
}

export function createPostgresOrchestrationJournal(dbBinding = db) {
  return {
    async start({ run_id, command, request_sha256, idempotency_key, request_projection, target_kind, target_ref }) {
      const result = await dbBinding.query(`INSERT INTO orchestration_command_invocations (
        run_id, command, target_kind, target_ref, request_sha256, idempotency_key, request_projection, outcome, schema_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'running',$8) RETURNING invocation_id, sequence, started_at`, [
        run_id, command, target_kind, target_ref, request_sha256, idempotency_key || null,
        JSON.stringify(request_projection || {}), ORCHESTRATION_JOURNAL_SCHEMA_VERSION,
      ]);
      return result.rows?.[0] || null;
    },
    async finish(invocationId, responseBody, activity = null) {
      const projection = safeResultProjection(responseBody?.command, responseBody);
      const resultSha = await sha256Text(canonicalJson(projection));
      const outcome = journalOutcomeFor(responseBody);
      const mayHaveMutated = responseBody?.may_have_mutated === true || responseBody?.details?.may_have_mutated === true;
      await dbBinding.query(`UPDATE orchestration_command_invocations SET
        completed_at = now(), outcome = $2, error_code = $3, error_class = $4,
        retryable = $5, rejection = $6, may_have_mutated = $7,
        result_sha256 = $8, result_projection = $9::jsonb
        WHERE invocation_id = $1`, [
        invocationId,
        outcome,
        responseBody?.ok === false ? String(responseBody?.error || 'INTERNAL_ERROR') : null,
        responseBody?.ok === false ? String(responseBody?.error_class || 'internal') : null,
        responseBody?.ok === false ? Boolean(responseBody?.retryable) : null,
        responseBody?.ok === false ? Boolean(responseBody?.rejection) : null,
        mayHaveMutated,
        resultSha,
        JSON.stringify(projection),
      ]);
      if (activity?.run_id && Number.isFinite(Number(activity.sequence))) {
        try {
          await dbBinding.query(`UPDATE orchestration_runs SET
            last_durable_activity_at = now(), last_durable_activity_type = $2, last_durable_activity_sequence = $3, updated_at = GREATEST(updated_at, now())
            WHERE run_id = $1 AND (last_durable_activity_sequence IS NULL OR last_durable_activity_sequence <= $3)`, [
            activity.run_id,
            `${activity.command}:${outcome}`,
            Number(activity.sequence),
          ]);
        } catch { /* run activity is non-authoritative observability */ }
      }
      return { outcome, result_sha256: resultSha, result_projection: projection };
    },
  };
}

export async function executeCorrelatedCommand(command, input, operation, options = {}) {
  let split;
  try {
    split = splitOrchestrationRequest(command, input);
  } catch (error) {
    return executeCommand(command, async () => { throw error; }, options);
  }

  const { run_id, domain_request } = split;
  const responseOptions = { ...options, ...(run_id ? { run_id } : {}) };
  let invocation = null;
  let journal = null;

  if (run_id && !['orchestration.resume_packet','orchestration.diagnose'].includes(command)) {
    try {
      journal = options.journal || createPostgresOrchestrationJournal(options.db || db);
      const request_sha256 = await sha256Text(canonicalJson(domain_request));
      const target = safeTarget(command, { ...domain_request, run_id });
      invocation = await journal.start({
        run_id,
        command,
        request_sha256,
        idempotency_key: domain_request.idempotency_key || null,
        request_projection: safeRequestProjection(command, domain_request),
        ...target,
      });
    } catch {
      invocation = null;
      journal = null;
    }
  }

  const response = await executeCommand(command, () => operation(domain_request), responseOptions);
  if (run_id && journal && invocation?.invocation_id) {
    try { await journal.finish(invocation.invocation_id, response.body, { run_id, command, sequence: invocation.sequence }); } catch { /* journal is non-authoritative observability */ }
  }
  return response;
}
