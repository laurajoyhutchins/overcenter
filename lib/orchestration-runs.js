import { api, db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { createLinearAuthority, createPostgresWorkLeaseService, workLeaseInternals } from 'lib/work-leases.js';

const RUN_SCHEMA = 'orchestration-run-v1';
const HORIZON_SCHEMA = 'orchestration-horizon-v1';
const DEFAULT_SCHEDULED_BUDGET_SECONDS = 2700;
const DEFAULT_INTERACTIVE_BUDGET_SECONDS = 10800;
const DEFAULT_SETTLEMENT_RESERVE_SECONDS = 300;
const DEFAULT_MINIMUM_NEW_GATE_SECONDS = 600;
const MAX_HORIZON = 10;
const FINISH_DISPOSITIONS = new Set(['completed','clean-stop','blocked','failed','no-work']);
const LIVE_LEASE_STATUSES = Object.freeze(['claiming','active','settling']);
const LIVE_LEASE_STATUS_SQL = LIVE_LEASE_STATUSES.map((status) => `'${status}'`).join(',');
const ABANDONED_DISPOSITION = 'abandoned';
const ABANDONED_STOP_REASON = 'RUN_DEADLINE_ELAPSED_NO_CLEAN_FINISH: deadline elapsed without orchestration.finish; no live lease remained; terminalized by orchestration maintenance.';
const WORKER_TRANSPORT_REVISION = 'worker-transport-v2';

function err(code, message, details = null) { const e = new Error(message); e.code = code; e.details = details; return e; }
function requiredString(value, name, max = 512) { const text = typeof value === 'string' ? value.trim() : ''; if (!text || text.length > max) throw err('REQUEST_INVALID', `${name} is invalid`, { field: name }); return text; }
function optionalString(value, name, max = 2000) { if (value == null || value === '') return null; return requiredString(String(value), name, max); }
function integer(value, fallback, min, max, name) { const n = value == null ? fallback : Number(value); if (!Number.isInteger(n) || n < min || n > max) throw err('REQUEST_INVALID', `${name} must be an integer from ${min} to ${max}`, { field: name }); return n; }
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw err('REQUEST_INVALID', `${name} must be an object`, { field: name }); return value; }
function normalizeContractRef(value, name) { const input = object(value, name); return { file_id: requiredString(input.file_id, `${name}.file_id`, 256), revision_id: requiredString(input.revision_id, `${name}.revision_id`, 512), sha256: optionalString(input.sha256, `${name}.sha256`, 128) }; }
function normalizeContractProvenance(value) {
  if (value == null) return { status: 'not_supplied', worker_transport_revision: WORKER_TRANSPORT_REVISION };
  const input = object(value, 'contract_provenance');
  return {
    status: 'declared',
    project_instructions: normalizeContractRef(input.project_instructions, 'contract_provenance.project_instructions'),
    fast_forward_skill: normalizeContractRef(input.fast_forward_skill, 'contract_provenance.fast_forward_skill'),
    execution_ownership_skill: normalizeContractRef(input.execution_ownership_skill, 'contract_provenance.execution_ownership_skill'),
    worker_transport_revision: WORKER_TRANSPORT_REVISION,
  };
}
function publicContractProvenance(run) { const value = run?.contract_provenance; return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length ? value : { status: 'historical_unknown' }; }
function publicBudget(run) { return { started_at: run.started_at, deadline_at: run.deadline_at, settlement_reserve_seconds: Number(run.settlement_reserve_seconds), minimum_new_gate_seconds: Number(run.minimum_new_gate_seconds) }; }
function publicRun(run) { if (!run) return null; return { schema: RUN_SCHEMA, run_id: run.run_id, worker: run.worker, mode: run.mode, continuation_key: run.continuation_key, scope: run.scope, scope_sha256: run.scope_sha256, predecessor_run_id: run.predecessor_run_id || null, status: run.status, disposition: run.disposition || null, last_work_ref: run.last_work_ref || null, last_gate: run.last_gate || null, stop_reason: run.stop_reason || null, started_at: run.started_at, deadline_at: run.deadline_at, finished_at: run.finished_at || null, contract_provenance: publicContractProvenance(run), last_durable_activity_at: run.last_durable_activity_at || null, last_durable_activity_type: run.last_durable_activity_type || null, last_durable_activity_sequence: run.last_durable_activity_sequence == null ? null : Number(run.last_durable_activity_sequence), budget: publicBudget(run) }; }
function runScopeAllows(scope, issue) {
  const lane = workLeaseInternals.laneOf(issue)?.name || null;
  const projection = workLeaseInternals.executionProjection(issue);
  if (scope?.project && projection.project !== scope.project) return false;
  if (Array.isArray(scope?.lanes) && scope.lanes.length && !scope.lanes.includes(lane)) return false;
  if (Array.isArray(scope?.repositories) && scope.repositories.length && !scope.repositories.includes(projection.repository)) return false;
  return true;
}
function normalizeFinish(input) {
  const disposition = requiredString(input?.disposition, 'disposition', 32);
  if (!FINISH_DISPOSITIONS.has(disposition)) throw err('REQUEST_INVALID', 'disposition is unsupported');
  return {
    run_id: requiredString(input?.run_id, 'run_id'),
    disposition,
    last_work_ref: optionalString(input?.last_work_ref, 'last_work_ref', 128),
    last_gate: optionalString(input?.last_gate, 'last_gate', 128),
    stop_reason: optionalString(input?.stop_reason, 'stop_reason', 2000),
  };
}

function normalizeScope(value) {
  const input = object(value, 'scope');
  const project = requiredString(input.project, 'scope.project', 256);
  const lanes = Array.isArray(input.lanes) ? input.lanes.map((x,i)=>requiredString(x, `scope.lanes[${i}]`, 128)) : [];
  if (lanes.length > 8) throw err('REQUEST_INVALID', 'scope.lanes may contain at most 8 entries');
  const repositories = Array.isArray(input.repositories) ? input.repositories.map((x,i)=>requiredString(x, `scope.repositories[${i}]`, 256)) : [];
  if (repositories.length > 25) throw err('REQUEST_INVALID', 'scope.repositories may contain at most 25 entries');
  return { project, lanes: [...new Set(lanes)].sort(), repositories: [...new Set(repositories)].sort(), direction: optionalString(input.direction, 'scope.direction', 1000) };
}

function normalizeStart(input) {
  const mode = requiredString(input?.mode, 'mode', 32).toLowerCase();
  if (!['scheduled','interactive'].includes(mode)) throw err('REQUEST_INVALID', 'mode must be scheduled or interactive');
  const defaultBudget = mode === 'scheduled' ? DEFAULT_SCHEDULED_BUDGET_SECONDS : DEFAULT_INTERACTIVE_BUDGET_SECONDS;
  return {
    run_id: requiredString(input?.run_id, 'run_id'),
    worker: requiredString(input?.worker, 'worker', 256),
    mode,
    continuation_key: requiredString(input?.continuation_key, 'continuation_key', 512),
    scope: normalizeScope(input?.scope),
    budget_seconds: integer(input?.budget_seconds, defaultBudget, 900, 10800, 'budget_seconds'),
    settlement_reserve_seconds: integer(input?.settlement_reserve_seconds, DEFAULT_SETTLEMENT_RESERVE_SECONDS, 60, 1800, 'settlement_reserve_seconds'),
    minimum_new_gate_seconds: integer(input?.minimum_new_gate_seconds, DEFAULT_MINIMUM_NEW_GATE_SECONDS, 60, 3600, 'minimum_new_gate_seconds'),
    contract_provenance: normalizeContractProvenance(input?.contract_provenance),
  };
}

function normalizeHorizonCandidates(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_HORIZON) throw err('REQUEST_INVALID', `candidates must contain 1 to ${MAX_HORIZON} entries`);
  return value.map((item,index)=>({
    position: index + 1,
    work_ref: requiredString(item?.work_ref, `candidates[${index}].work_ref`, 128),
    expected_state: requiredString(item?.expected_state, `candidates[${index}].expected_state`, 128),
    expected_lane: requiredString(item?.expected_lane, `candidates[${index}].expected_lane`, 128),
    selection_reason: requiredString(item?.selection_reason, `candidates[${index}].selection_reason`, 128),
    repository: optionalString(item?.repository, `candidates[${index}].repository`, 256),
  }));
}

async function fingerprintIssue(issue) {
  const projection = workLeaseInternals.executionProjection(issue);
  return { execution_projection: projection, execution_fingerprint: await sha256Text(canonicalJson(projection)) };
}

export function createOrchestrationRunService({ store, authoritative = null, now = () => new Date().toISOString() } = {}) {
  if (!store) throw new TypeError('store is required');

  async function resolveStoredHorizon(run, horizon) {
    if (!horizon) return null;
    if (!authoritative) return { schema: HORIZON_SCHEMA, horizon_id: horizon.horizon_id || null, run_id: run.run_id, generation: Number(horizon.generation), candidates: horizon.candidates || [], ownership_granted: false, authority_revalidated: false };
    const resolved = [];
    for (const candidate of horizon.candidates || []) {
      try {
        const issue = await authoritative.getIssue(candidate.work_ref);
        const currentLane = workLeaseInternals.laneOf(issue)?.name || null;
        const evidence = await fingerprintIssue(issue);
        let status = 'valid';
        if (issue.state?.name !== candidate.expected_state || currentLane !== candidate.expected_lane) status = 'no_longer_executable';
        else if (evidence.execution_fingerprint !== candidate.execution_fingerprint) status = 'materially_changed';
        resolved.push({ ...candidate, status, current_execution_fingerprint: evidence.execution_fingerprint, authoritative_revision: issue.updatedAt || null });
      } catch (error) {
        resolved.push({ ...candidate, status: error?.code === 'WORK_NOT_FOUND' ? 'no_longer_executable' : 'authority_unavailable', error: String(error?.code || error?.message || 'read_failed') });
      }
    }
    return { schema: HORIZON_SCHEMA, horizon_id: horizon.horizon_id || null, run_id: run.run_id, generation: Number(horizon.generation), candidates: resolved, ownership_granted: false, authority_revalidated: true };
  }

  async function start(input) {
    const request = normalizeStart(input);
    const scopeSha = await sha256Text(canonicalJson(request.scope));
    const { contract_provenance: _observabilityOnly, ...semanticRequest } = request;
    const requestSha = await sha256Text(canonicalJson(semanticRequest));
    const existing = await store.getRun(request.run_id);
    if (existing) {
      const legacyBudget = Math.round((Date.parse(existing.deadline_at) - Date.parse(existing.started_at)) / 1000);
      const sameLegacySemantics = existing.worker === request.worker && existing.mode === request.mode && existing.continuation_key === request.continuation_key && existing.scope_sha256 === scopeSha
        && legacyBudget === request.budget_seconds && Number(existing.settlement_reserve_seconds) === request.settlement_reserve_seconds && Number(existing.minimum_new_gate_seconds) === request.minimum_new_gate_seconds;
      if ((existing.start_request_sha256 && existing.start_request_sha256 !== requestSha) || (!existing.start_request_sha256 && !sameLegacySemantics)) throw err('IDEMPOTENCY_CONFLICT', 'run_id already exists with different run semantics');
      const priorHorizon = typeof store.latestHorizon === 'function' && existing.predecessor_run_id ? await store.latestHorizon(existing.predecessor_run_id) : null;
      return { ok: true, ...publicRun(existing), idempotent_replay: true, recovered_horizon: priorHorizon ? await resolveStoredHorizon(existing, priorHorizon) : null, work_authority_changed: false };
    }
    const startedAt = now();
    let predecessor = typeof store.findPredecessor === 'function' ? await store.findPredecessor(request.continuation_key, scopeSha, request.run_id) : null;
    if (predecessor && predecessor.status !== 'finished' && Date.parse(predecessor.deadline_at) > Date.parse(startedAt)) predecessor = null;
    const deadlineAt = new Date(Date.parse(startedAt) + request.budget_seconds * 1000).toISOString();
    const row = await store.insertRun({
      run_id: request.run_id, worker: request.worker, mode: request.mode, continuation_key: request.continuation_key,
      scope: request.scope, scope_sha256: scopeSha, start_request_sha256: requestSha, started_at: startedAt, deadline_at: deadlineAt,
      settlement_reserve_seconds: request.settlement_reserve_seconds, minimum_new_gate_seconds: request.minimum_new_gate_seconds,
      predecessor_run_id: predecessor?.run_id || null, status: 'active', disposition: null, last_work_ref: null, last_gate: null,
      latest_horizon_id: null, stop_reason: null, finished_at: null, contract_provenance: request.contract_provenance,
    });
    const priorHorizon = predecessor && typeof store.latestHorizon === 'function' ? await store.latestHorizon(predecessor.run_id) : null;
    return { ok: true, ...publicRun(row), idempotent_replay: false, recovered_horizon: priorHorizon ? await resolveStoredHorizon(row, priorHorizon) : null, work_authority_changed: false };
  }

  async function checkpointHorizon(input) {
    if (!authoritative) throw new TypeError('authoritative is required for horizon checkpoint');
    const runId = requiredString(input?.run_id, 'run_id');
    const run = await store.getRun(runId);
    if (!run) throw err('RUN_NOT_FOUND', `orchestration run ${runId} was not found`);
    if (run.status !== 'active') throw err('RUN_NOT_ACTIVE', `orchestration run is ${run.status}`);
    const candidates = [];
    for (const candidate of normalizeHorizonCandidates(input?.candidates)) {
      const issue = await authoritative.getIssue(candidate.work_ref);
      const lane = workLeaseInternals.laneOf(issue)?.name || null;
      if (!runScopeAllows(run.scope, issue)) throw err('RUN_SCOPE_VIOLATION', 'candidate is outside the registered orchestration run scope', { work_ref: candidate.work_ref, lane, repository: workLeaseInternals.executionProjection(issue).repository || null });
      if (issue.state?.name !== candidate.expected_state || lane !== candidate.expected_lane) throw err('HORIZON_PRECONDITION_CHANGED', 'candidate no longer matches the observed execution state', { work_ref: candidate.work_ref, expected_state: candidate.expected_state, actual_state: issue.state?.name || null, expected_lane: candidate.expected_lane, actual_lane: lane });
      const evidence = await fingerprintIssue(issue);
      candidates.push({ ...candidate, execution_projection: evidence.execution_projection, execution_fingerprint: evidence.execution_fingerprint, authoritative_revision: issue.updatedAt || null });
    }
    const generation = await store.nextHorizonGeneration(runId);
    const horizonSha = await sha256Text(canonicalJson(candidates));
    const saved = await store.insertHorizon({ run_id: runId, generation, candidates, horizon_sha256: horizonSha, created_at: now() });
    if (typeof store.updateRunHorizon === 'function') await store.updateRunHorizon(runId, saved.horizon_id || null);
    return { ok: true, schema: HORIZON_SCHEMA, horizon_id: saved.horizon_id || null, run_id: runId, generation: Number(saved.generation), horizon_sha256: saved.horizon_sha256, candidates: saved.candidates, ownership_granted: false, work_authority_changed: false };
  }

  async function resolveHorizon(input) {
    const runId = requiredString(input?.run_id, 'run_id');
    const run = await store.getRun(runId);
    if (!run) throw err('RUN_NOT_FOUND', `orchestration run ${runId} was not found`);
    const horizon = await store.latestHorizon(runId) || (run.predecessor_run_id ? await store.latestHorizon(run.predecessor_run_id) : null);
    if (!horizon) return { ok: true, schema: HORIZON_SCHEMA, run_id: runId, horizon_id: null, generation: 0, candidates: [], ownership_granted: false, authority_revalidated: true, work_authority_changed: false };
    return { ok: true, ...(await resolveStoredHorizon(run, horizon)), work_authority_changed: false };
  }

  async function finish(input) {
    const request = normalizeFinish(input);
    const runId = request.run_id;
    const requestSha = await sha256Text(canonicalJson(request));
    const run = await store.getRun(runId);
    if (!run) throw err('RUN_NOT_FOUND', `orchestration run ${runId} was not found`);
    if (run.status === 'finished') {
      const legacy = { run_id: runId, disposition: run.disposition, last_work_ref: run.last_work_ref || null, last_gate: run.last_gate || null, stop_reason: run.stop_reason || null };
      const legacySha = await sha256Text(canonicalJson(legacy));
      if ((run.finish_request_sha256 && run.finish_request_sha256 !== requestSha) || (!run.finish_request_sha256 && legacySha !== requestSha)) throw err('IDEMPOTENCY_CONFLICT', 'run was already finished with different terminal handoff semantics');
      return { ok: true, ...publicRun(run), idempotent_replay: true, work_authority_changed: false };
    }
    if (typeof store.activeLeaseForRun === 'function') {
      const activeLease = await store.activeLeaseForRun(runId, now());
      if (activeLease) throw err('RUN_HAS_ACTIVE_LEASE', 'orchestration run cannot finish while it still owns an active lease', {
        lease_id: activeLease.lease_id,
        lease_ref: activeLease.lease_id,
        work_ref: activeLease.work_ref,
        gate: activeLease.gate,
        lease_status: activeLease.status,
        expires_at: activeLease.expires_at,
        required_transition: 'settle_active_lease_then_retry_finish',
        required_command: 'work.settle',
        retry_command: 'orchestration.finish',
      });
    }
    const finishedAt = now();
    const updated = await store.finishRun(runId, {
      status: 'finished', disposition: request.disposition, last_work_ref: request.last_work_ref,
      last_gate: request.last_gate, stop_reason: request.stop_reason, finish_request_sha256: requestSha,
      finished_at: finishedAt, updated_at: finishedAt,
    });
    return { ok: true, ...publicRun(updated), idempotent_replay: false, work_authority_changed: false };
  }

  return { start, checkpointHorizon, resolveHorizon, finish };
}

export function createPostgresOrchestrationRunStore(dbBinding = db) {
  async function row(sql, params = []) { const result = await dbBinding.query(sql, params); return result.rows?.[0] || null; }
  return {
    async getRun(id) { return row('SELECT * FROM orchestration_runs WHERE run_id = $1', [id]); },
    async activeLeaseForRun(runId, observedAt) { return row(`SELECT lease_id,work_ref,gate,status,expires_at FROM work_leases WHERE run_id=$1 AND status IN (${LIVE_LEASE_STATUS_SQL}) AND expires_at > $2 ORDER BY created_at DESC LIMIT 1`, [runId, observedAt]); },
    async findPredecessor(key, scopeSha, exclude) { return row("SELECT * FROM orchestration_runs WHERE continuation_key = $1 AND scope_sha256 = $2 AND run_id <> $3 AND (status = 'finished' OR deadline_at <= now()) ORDER BY started_at DESC LIMIT 1", [key, scopeSha, exclude]); },
    async insertRun(run) { return row(`INSERT INTO orchestration_runs (run_id,worker,mode,continuation_key,scope,scope_sha256,start_request_sha256,started_at,deadline_at,settlement_reserve_seconds,minimum_new_gate_seconds,predecessor_run_id,status,contract_provenance) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING *`, [run.run_id,run.worker,run.mode,run.continuation_key,JSON.stringify(run.scope),run.scope_sha256,run.start_request_sha256,run.started_at,run.deadline_at,run.settlement_reserve_seconds,run.minimum_new_gate_seconds,run.predecessor_run_id,run.status,JSON.stringify(run.contract_provenance || {})]); },
    async nextHorizonGeneration(runId) { const result = await row('SELECT COALESCE(max(generation),0)::int + 1 AS generation FROM orchestration_horizons WHERE run_id = $1', [runId]); return Number(result?.generation || 1); },
    async insertHorizon(horizon) { return row('INSERT INTO orchestration_horizons (run_id,generation,candidates,horizon_sha256,created_at) VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING *', [horizon.run_id,horizon.generation,JSON.stringify(horizon.candidates),horizon.horizon_sha256,horizon.created_at]); },
    async latestHorizon(runId) { return row('SELECT * FROM orchestration_horizons WHERE run_id = $1 ORDER BY generation DESC LIMIT 1', [runId]); },
    async updateRunHorizon(runId, horizonId) { return row('UPDATE orchestration_runs SET latest_horizon_id = $2, updated_at = now() WHERE run_id = $1 RETURNING *', [runId,horizonId]); },
    async finishRun(runId, patch) { return row('UPDATE orchestration_runs SET status=$2, disposition=$3, last_work_ref=$4, last_gate=$5, stop_reason=$6, finish_request_sha256=$7, finished_at=$8, updated_at=$9 WHERE run_id=$1 RETURNING *', [runId,patch.status,patch.disposition,patch.last_work_ref,patch.last_gate,patch.stop_reason,patch.finish_request_sha256,patch.finished_at,patch.updated_at]); },
  };
}

export function createPostgresOrchestrationRunService(options = {}) {
  return createOrchestrationRunService({ store: options.store || createPostgresOrchestrationRunStore(options.db || db), authoritative: options.authoritative || createLinearAuthority(options.api || api), now: options.now });
}

export function createOrchestrationMaintenanceService({ store, leases, limit = 20, now = () => new Date().toISOString() } = {}) {
  if (!store || !leases) throw new TypeError('store and leases are required');
  return {
    async maintain() {
      const actions = [];
      const observedAt = now();
      const expired = (await store.expiredSlots(limit)) || [];
      for (const item of expired.slice(0, Math.max(0, limit - actions.length))) {
        try { actions.push({ kind: 'expired_lease_reconciliation', work_ref: item.work_ref, gate: item.gate, result: await leases.reconcileExpired(item.work_ref, item.gate) }); }
        catch (error) { actions.push({ kind: 'expired_lease_reconciliation', work_ref: item.work_ref, gate: item.gate, error: String(error?.code || error?.message || 'failed') }); }
      }
      const stuck = (await store.stuckLeases(Math.max(0, limit - actions.length))) || [];
      for (const item of stuck.slice(0, Math.max(0, limit - actions.length))) {
        try {
          if (item.kind === 'claiming' && item.claim_request) actions.push({ kind: 'claim_replay', lease_id: item.lease_id || null, result: await leases.claim(item.claim_request) });
          else if (item.kind === 'settling' && item.settle_plan?.replay_request && item.lease_token && item.settle_idempotency_key) actions.push({ kind: 'settlement_replay', lease_id: item.lease_id || null, result: await leases.settle({ lease_token: item.lease_token, ...item.settle_plan.replay_request, idempotency_key: item.settle_idempotency_key }) });
        } catch (error) { actions.push({ kind: item.kind === 'claiming' ? 'claim_replay' : 'settlement_replay', lease_id: item.lease_id || null, error: String(error?.code || error?.message || 'failed') }); }
      }
      const unresolved = typeof store.unresolvedInvocations === 'function' ? (await store.unresolvedInvocations(Math.max(0, limit - actions.length))) || [] : [];
      for (const invocation of unresolved.slice(0, Math.max(0, limit - actions.length))) {
        if (typeof store.reconcileInvocation !== 'function') break;
        try { const result = await store.reconcileInvocation(invocation); if (result) actions.push({ kind: 'journal_reconciliation', invocation_id: invocation.invocation_id, result }); }
        catch (error) { actions.push({ kind: 'journal_reconciliation', invocation_id: invocation.invocation_id, error: String(error?.code || error?.message || 'failed') }); }
      }
      const remaining = Math.max(0, limit - actions.length);
      const overdue = remaining > 0 && typeof store.overdueRuns === 'function' ? (await store.overdueRuns(observedAt, remaining)) || [] : [];
      for (const run of overdue.slice(0, Math.max(0, limit - actions.length))) {
        if (typeof store.reconcileAbandonedRun !== 'function') break;
        try {
          const result = await store.reconcileAbandonedRun(run.run_id, observedAt);
          if (result) actions.push({ kind: 'abandoned_run_reconciliation', run_id: run.run_id, result: { status: result.status, disposition: result.disposition } });
        } catch (error) {
          actions.push({ kind: 'abandoned_run_reconciliation', run_id: run.run_id, error: String(error?.code || error?.message || 'failed') });
        }
      }
      return { ok: true, schema: 'orchestration-maintenance-v1', actions, action_count: actions.length, semantic_work_mutations: 0, work_selection_performed: false };
    },
  };
}

export function createPostgresOrchestrationMaintenanceStore(dbBinding = db) {
  return {
    async expiredSlots(limit = 20) { const r=await dbBinding.query(`SELECT work_ref,gate,lease_id,expires_at FROM work_lease_slots WHERE expires_at <= now() ORDER BY expires_at ASC LIMIT ${Math.min(100,Math.max(1,Number(limit)||20))}`); return r.rows || []; },
    async stuckLeases(limit = 20) { const r=await dbBinding.query(`SELECT *, CASE WHEN status='claiming' THEN 'claiming' ELSE 'settling' END AS kind FROM work_leases WHERE status IN ('claiming','settling') AND updated_at < now() - interval '5 minutes' ORDER BY updated_at ASC LIMIT ${Math.min(100,Math.max(1,Number(limit)||20))}`); return r.rows || []; },
    async unresolvedInvocations(limit = 20) { const r=await dbBinding.query(`SELECT i.* FROM orchestration_command_invocations i WHERE i.outcome IN ('running','indeterminate') AND i.started_at < now() - interval '5 minutes' AND NOT EXISTS (SELECT 1 FROM orchestration_invocation_resolutions r WHERE r.invocation_id=i.invocation_id) ORDER BY i.started_at ASC LIMIT ${Math.min(100,Math.max(1,Number(limit)||20))}`); return r.rows || []; },
    async overdueRuns(observedAt, limit = 20) { const r=await dbBinding.query(`SELECT run_id,worker,mode,deadline_at,updated_at,last_work_ref,last_gate FROM orchestration_runs WHERE status='active' AND deadline_at <= $1 ORDER BY deadline_at ASC LIMIT ${Math.min(100,Math.max(1,Number(limit)||20))}`, [observedAt]); return r.rows || []; },
    async reconcileAbandonedRun(runId, observedAt) {
      if (typeof dbBinding.transaction !== 'function') throw err('RUN_RECONCILIATION_STORAGE_UNAVAILABLE', 'abandoned-run reconciliation requires transactional database support');
      const tx = await dbBinding.transaction([
        { sql: 'SELECT run_id FROM orchestration_runs WHERE run_id=$1 FOR UPDATE', params: [runId] },
        { sql: `UPDATE orchestration_runs r SET status='finished', disposition=$3, stop_reason=$4, finished_at=$2, updated_at=$2
            WHERE r.run_id=$1 AND r.status='active' AND r.deadline_at <= $2
              AND NOT EXISTS (
                SELECT 1 FROM work_leases l
                WHERE l.run_id=r.run_id AND l.status IN (${LIVE_LEASE_STATUS_SQL}) AND l.expires_at > $2
              )
            RETURNING r.run_id,r.status,r.disposition,r.finished_at`, params: [runId, observedAt, ABANDONED_DISPOSITION, ABANDONED_STOP_REASON] },
      ]);
      return tx.results?.[1]?.rows?.[0] || null;
    },
    async recordResolution(invocationId, kind, evidence) { const inserted=(await dbBinding.query('INSERT INTO orchestration_invocation_resolutions (invocation_id,resolution_kind,evidence) VALUES ($1,$2,$3::jsonb) ON CONFLICT (invocation_id) DO NOTHING RETURNING *', [invocationId,kind,JSON.stringify(evidence || {})])).rows?.[0] || null; if (inserted) return inserted; return (await dbBinding.query('SELECT * FROM orchestration_invocation_resolutions WHERE invocation_id=$1 ORDER BY created_at DESC LIMIT 1',[invocationId])).rows?.[0] || null; },
    async reconcileInvocation(invocation) {
      let receipt = null;
      let storedHash = null;
      if (invocation.command === 'work.claim' && invocation.idempotency_key) { const x=(await dbBinding.query('SELECT claim_receipt AS receipt, claim_request_hash AS request_sha256 FROM work_leases WHERE claim_idempotency_key=$1 AND claim_receipt IS NOT NULL', [invocation.idempotency_key])).rows?.[0] || null; receipt=x?.receipt||null; storedHash=x?.request_sha256||null; }
      if (invocation.command === 'work.settle' && invocation.idempotency_key) { const x=(await dbBinding.query('SELECT settle_receipt AS receipt, settle_request_hash AS request_sha256 FROM work_leases WHERE settle_idempotency_key=$1 AND settle_receipt IS NOT NULL', [invocation.idempotency_key])).rows?.[0] || null; receipt=x?.receipt||null; storedHash=x?.request_sha256||null; }
      if (invocation.command === 'work.checkpoint' && invocation.idempotency_key) { const x=(await dbBinding.query('SELECT jsonb_build_object(\'checkpoint_sha256\',checkpoint_sha256,\'created_at\',created_at) AS receipt, request_sha256 FROM work_lease_checkpoints WHERE idempotency_key=$1 ORDER BY created_at DESC LIMIT 1', [invocation.idempotency_key])).rows?.[0] || null; receipt=x?.receipt||null; storedHash=x?.request_sha256||null; }
      if (invocation.command === 'work.heartbeat' && invocation.idempotency_key) { const x=(await dbBinding.query('SELECT jsonb_build_object(\'progress_sha256\',progress_sha256,\'new_expires_at\',new_expires_at,\'created_at\',created_at) AS receipt, request_sha256 FROM work_lease_heartbeats WHERE idempotency_key=$1 ORDER BY created_at DESC LIMIT 1', [invocation.idempotency_key])).rows?.[0] || null; receipt=x?.receipt||null; storedHash=x?.request_sha256||null; }
      if (invocation.command === 'orchestration.start' && invocation.run_id) {
        const run = (await dbBinding.query('SELECT run_id,status,deadline_at,predecessor_run_id,start_request_sha256 FROM orchestration_runs WHERE run_id=$1', [invocation.run_id])).rows?.[0] || null;
        if (run) { receipt = { run_id: run.run_id, status: run.status, deadline_at: run.deadline_at, predecessor_run_id: run.predecessor_run_id || null }; storedHash = run.start_request_sha256 || null; }
        else {
          const evidence = { run_id: invocation.run_id, run_record_present: false, original_outcome: invocation.outcome };
          await this.recordResolution(invocation.invocation_id, 'definitively_not_applied', evidence);
          return { reconciled: true, command: invocation.command, resolution_kind: 'definitively_not_applied', reason: 'RUN_RECORD_ABSENT' };
        }
      }
      if (!receipt || !storedHash || storedHash !== invocation.request_sha256) return null;
      await this.recordResolution(invocation.invocation_id, 'externally_confirmed', { original_outcome: invocation.outcome, request_sha256: invocation.request_sha256, receipt });
      return { reconciled: true, command: invocation.command, resolution_kind: 'externally_confirmed' };
    },
  };
}

export function createPostgresOrchestrationMaintenanceService(options = {}) {
  return createOrchestrationMaintenanceService({ store: options.store || createPostgresOrchestrationMaintenanceStore(options.db || db), leases: options.leases || createPostgresWorkLeaseService({ db: options.db || db, api: options.api || api }), limit: options.limit || 20, now: options.now });
}

export function statusForOrchestrationRunError(error) {
  const code = String(error?.code || 'ORCHESTRATION_ERROR');
  if (code === 'REQUEST_INVALID') return 400;
  if (code === 'RUN_NOT_FOUND') return 404;
  if (['RUN_NOT_ACTIVE','IDEMPOTENCY_CONFLICT','HORIZON_PRECONDITION_CHANGED','RUN_HAS_ACTIVE_LEASE','RUN_SCOPE_VIOLATION'].includes(code)) return 409;
  if (code.startsWith('LINEAR_')) return 502;
  return 500;
}

export const orchestrationRunInternals = Object.freeze({ liveLeaseStatuses: LIVE_LEASE_STATUSES, liveLeaseStatusSql: LIVE_LEASE_STATUS_SQL, abandonedDisposition: ABANDONED_DISPOSITION, abandonedStopReason: ABANDONED_STOP_REASON });
export const orchestrationRunConfig = Object.freeze({ schema: RUN_SCHEMA, horizon_schema: HORIZON_SCHEMA, scheduled_budget_seconds: DEFAULT_SCHEDULED_BUDGET_SECONDS, interactive_budget_seconds: DEFAULT_INTERACTIVE_BUDGET_SECONDS, settlement_reserve_seconds: DEFAULT_SETTLEMENT_RESERVE_SECONDS, minimum_new_gate_seconds: DEFAULT_MINIMUM_NEW_GATE_SECONDS, max_horizon: MAX_HORIZON });