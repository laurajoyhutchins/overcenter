import { canonicalJson, sha256Text } from './canonical-json.js';
import { PROJECT_HORIZON_KINDS, evaluateProjectHorizon } from './project-horizon.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('REQUEST_INVALID', `${field} must be an object`, { field });
  }
  return value;
}

function text(value, field, max = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) {
    fail('REQUEST_INVALID', `${field} is invalid`, { field });
  }
  return normalized;
}

export function normalizeOrchestrationRunTarget(value) {
  if (value == null) return null;
  const input = object(value, 'target');
  const unknown = Object.keys(input).filter((key) => !['project_ref', 'horizon'].includes(key)).sort();
  if (unknown.length) fail('REQUEST_INVALID', 'target contains unsupported fields', { fields:unknown });

  const projectRef = text(input.project_ref, 'target.project_ref');
  const horizonInput = object(input.horizon, 'target.horizon');
  const horizonUnknown = Object.keys(horizonInput).filter((key) => !['kind', 'ref'].includes(key)).sort();
  if (horizonUnknown.length) fail('REQUEST_INVALID', 'target.horizon contains unsupported fields', { fields:horizonUnknown });
  const kind = text(horizonInput.kind, 'target.horizon.kind', 64).toLowerCase();
  if (!PROJECT_HORIZON_KINDS.includes(kind)) {
    fail('REQUEST_INVALID', 'target.horizon.kind is unsupported', { field:'target.horizon.kind', kind });
  }
  const ref = text(horizonInput.ref, 'target.horizon.ref');
  if (kind === 'project' && ref !== projectRef) {
    fail('REQUEST_INVALID', 'project horizon ref must match target.project_ref', { project_ref:projectRef, horizon_ref:ref });
  }
  return Object.freeze({ project_ref:projectRef, horizon:Object.freeze({ kind, ref }) });
}

export async function orchestrationRunTargetSha256(target) {
  const normalized = normalizeOrchestrationRunTarget(target);
  return normalized ? sha256Text(canonicalJson(normalized)) : null;
}

function targetStoreFacade(store, target, targetSha256, journalRequestSha256 = null) {
  return new Proxy(store, {
    get(source, property, receiver) {
      if (property === 'getRun') {
        return async (runId) => {
          const row = await source.getRun(runId);
          if (!row?.base_start_request_sha256) return row;
          return { ...row, start_request_sha256:row.base_start_request_sha256 };
        };
      }
      if (property === 'findPredecessor') {
        return (continuationKey, scopeSha256, excludeRunId) =>
          source.findPredecessorByTarget(continuationKey, scopeSha256, targetSha256, excludeRunId);
      }
      if (property === 'insertRun') {
        return (row) => source.insertRunWithTarget(row, target, targetSha256, journalRequestSha256);
      }
      const value = Reflect.get(source, property, receiver);
      return typeof value === 'function' ? value.bind(source) : value;
    },
  });
}

function sameTargetSha(left, right) {
  return (left || null) === (right || null);
}

export function createTargetAwareOrchestrationRunService({
  store,
  createBaseService,
  projectGraphReader = null,
} = {}) {
  if (!store) throw new TypeError('store is required');
  if (typeof createBaseService !== 'function') throw new TypeError('createBaseService is required');
  if (typeof store.findPredecessorByTarget !== 'function' || typeof store.insertRunWithTarget !== 'function') {
    throw new TypeError('target-aware store methods are required');
  }

  async function start(input = {}) {
    const target = normalizeOrchestrationRunTarget(input?.target);
    const targetSha256 = await orchestrationRunTargetSha256(target);
    const journalRequestSha256 = await sha256Text(canonicalJson(input || {}));
    const runId = typeof input?.run_id === 'string' ? input.run_id.trim() : '';
    const existing = runId ? await store.getRun(runId) : null;
    if (existing && !sameTargetSha(existing.target_sha256, targetSha256)) {
      fail('IDEMPOTENCY_CONFLICT', 'run_id already exists with different target semantics', {
        run_id:runId,
        existing_target_sha256:existing.target_sha256 || null,
        requested_target_sha256:targetSha256,
      });
    }

    const facade = targetStoreFacade(store, target, targetSha256, journalRequestSha256);
    const base = createBaseService(facade);
    const { target: _target, ...baseInput } = input || {};
    const result = await base.start(baseInput);
    const stored = runId ? await store.getRun(runId) : null;
    return {
      ...result,
      target:stored?.target ?? target,
      target_sha256:stored?.target_sha256 ?? targetSha256,
    };
  }

  async function resolveHorizon(input = {}) {
    const runId = typeof input?.run_id === 'string' ? input.run_id.trim() : '';
    const run = runId ? await store.getRun(runId) : null;
    if (!run) return createBaseService(targetStoreFacade(store, null, null)).resolveHorizon(input);
    const target = normalizeOrchestrationRunTarget(run.target);
    if (!target) return createBaseService(targetStoreFacade(store, null, null)).resolveHorizon(input);
    if (typeof projectGraphReader !== 'function') {
      fail('PROJECT_GRAPH_READER_UNAVAILABLE', 'targeted horizon resolution requires an authoritative project graph reader', {
        project_ref:target.project_ref,
      });
    }
    const graph = await projectGraphReader(Object.freeze({ project_ref:target.project_ref }));
    const evaluation = evaluateProjectHorizon(graph, target.horizon);
    return Object.freeze({
      ok:true,
      ...evaluation,
      run_id:runId,
      target,
      ownership_granted:false,
      authority_revalidated:true,
      work_authority_changed:false,
    });
  }

  return Object.freeze({ start, resolveHorizon });
}
