import { canonicalJson, sha256Text } from './canonical-json.js';
import { evaluateProjectHorizon } from './project-horizon.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field, max = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) {
    fail('ORCHESTRATION_ADVANCE_REQUEST_INVALID', `${field} is invalid`, { field });
  }
  return normalized;
}

function activeRun(run, runId) {
  if (!run || run.run_id !== runId) {
    fail('ORCHESTRATION_ADVANCE_RUN_NOT_FOUND', 'targeted orchestration run was not found', { run_id:runId });
  }
  if (run.status !== 'active') {
    fail('ORCHESTRATION_ADVANCE_RUN_NOT_ACTIVE', 'orchestration.advance requires an active run', {
      run_id:runId,
      status:run.status || null,
    });
  }
  if (!run.target?.project_ref || !run.target?.horizon) {
    fail('ORCHESTRATION_ADVANCE_TARGET_REQUIRED', 'orchestration.advance requires a targeted project run', { run_id:runId });
  }
  return run;
}

function authority(graph) {
  const definition = graph?.authority?.definition;
  if (!definition || definition.kind !== 'github' || !definition.repository || !definition.revision || !definition.derivation) {
    fail('ORCHESTRATION_ADVANCE_AUTHORITY_INVALID', 'authoritative project graph definition coordinate is invalid');
  }
  return Object.freeze({
    kind:definition.kind,
    repository:definition.repository,
    revision:definition.revision,
    derivation:definition.derivation,
  });
}

async function operationKey(kind, runId, projectRef, transition, definition) {
  const digest = await sha256Text(canonicalJson({
    kind,
    run_id:runId,
    project_ref:projectRef,
    transition_id:transition.id,
    authority:definition,
  }));
  return `orchestration.advance:${kind}:${digest}`;
}

function publicTransition(transition) {
  return Object.freeze({
    id:transition.id,
    priority:transition.priority,
    requires:Object.freeze([...(transition.requires || [])]),
    executor:Object.freeze({ ...(transition.executor || {}) }),
    lifecycle:Object.freeze({ ...(transition.lifecycle || {}) }),
  });
}

function baseResult(outcome, runId, projectRef, evaluation) {
  return {
    ok:true,
    schema:'orchestration-advance-v1',
    outcome,
    run_id:runId,
    project_ref:projectRef,
    horizon:evaluation.horizon,
    frontier:Object.freeze(evaluation.frontier.map((node) => node.id)),
  };
}

function isOccupied(error) {
  return error?.code === 'PROJECT_TRANSITION_ALREADY_LEASED';
}

export function createOrchestrationAdvanceService({ store, readProjectGraph, projectTransitions, executeOperator } = {}) {
  if (!store || typeof store.getRun !== 'function') throw new TypeError('orchestration advance store is required');
  if (typeof readProjectGraph !== 'function') throw new TypeError('readProjectGraph is required');
  if (!projectTransitions || typeof projectTransitions.acquire !== 'function' || typeof projectTransitions.settle !== 'function') {
    throw new TypeError('projectTransitions is required');
  }

  async function advance(input = {}) {
    const runId = text(input.run_id, 'run_id');
    const run = activeRun(await store.getRun(runId), runId);
    const projectRef = text(run.target.project_ref, 'target.project_ref');
    const graph = await readProjectGraph(Object.freeze({ project_ref:projectRef }));
    const evaluation = evaluateProjectHorizon(graph, run.target.horizon);

    if (evaluation.complete) {
      return Object.freeze(baseResult('PROJECT_COMPLETE', runId, projectRef, evaluation));
    }
    if (evaluation.frontier.length === 0) {
      const outcome = evaluation.off_nominal.length > 0 ? 'OFF_NOMINAL' : 'WAITING';
      return Object.freeze({
        ...baseResult(outcome, runId, projectRef, evaluation),
        off_nominal:Object.freeze(evaluation.off_nominal.map((node) => node.id)),
      });
    }

    const definition = authority(graph);
    for (const transition of evaluation.frontier) {
      let lease;
      try {
        lease = await projectTransitions.acquire({
          run_id:runId,
          project_ref:projectRef,
          transition_id:transition.id,
          lease_seconds:1800,
          idempotency_key:await operationKey('acquire', runId, projectRef, transition, definition),
        });
      } catch (error) {
        if (isOccupied(error)) return Object.freeze(baseResult('WAITING', runId, projectRef, evaluation));
        throw error;
      }

      const selected = publicTransition(transition);
      if (transition.executor?.kind === 'agent') {
        return Object.freeze({
          ...baseResult('AGENT_EXECUTION_REQUIRED', runId, projectRef, evaluation),
          transition:selected,
          lease_ref:lease.lease_ref,
          transition_definition_fingerprint:lease.transition_definition_fingerprint || null,
          authority:Object.freeze({ ...(lease.authority || definition) }),
          expires_at:lease.expires_at || null,
        });
      }

      if (transition.executor?.kind !== 'operator') {
        fail('ORCHESTRATION_ADVANCE_EXECUTOR_INVALID', 'selected project transition executor is unsupported', {
          transition_id:transition.id,
          kind:transition.executor?.kind || null,
        });
      }
      if (typeof executeOperator !== 'function') {
        fail('ORCHESTRATION_ADVANCE_OPERATOR_UNAVAILABLE', 'deterministic operator execution is unavailable', {
          transition_id:transition.id,
          command:transition.executor.command,
        });
      }

      const operation = await executeOperator(Object.freeze({
        command:transition.executor.command,
        run_id:runId,
        project_ref:projectRef,
        transition:selected,
        lease_ref:lease.lease_ref,
        authority:Object.freeze({ ...(lease.authority || definition) }),
      }));

      if (operation?.ok !== true) {
        await projectTransitions.settle({
          lease_ref:lease.lease_ref,
          run_id:runId,
          disposition:'blocked',
          idempotency_key:await operationKey('blocked', runId, projectRef, transition, definition),
        });
        return Object.freeze({
          ...baseResult('BLOCKED', runId, projectRef, evaluation),
          transition:selected,
          lease_ref:lease.lease_ref,
          operator:Object.freeze({ command:transition.executor.command, ok:false }),
        });
      }

      const settlement = await projectTransitions.settle({
        lease_ref:lease.lease_ref,
        run_id:runId,
        disposition:'completed',
        idempotency_key:await operationKey('complete', runId, projectRef, transition, definition),
      });
      const refreshedGraph = await readProjectGraph(Object.freeze({ project_ref:projectRef }));
      const refreshed = evaluateProjectHorizon(refreshedGraph, run.target.horizon);
      const confirmed = refreshed.nodes.find((node) => node.id === transition.id) || null;
      if (!confirmed || confirmed.state !== 'DONE') {
        fail('ORCHESTRATION_ADVANCE_CONFIRMATION_UNPROVEN', 'completed transition settlement is not proven DONE by fresh authoritative graph state', {
          transition_id:transition.id,
          state:confirmed?.state || null,
        });
      }
      return Object.freeze({
        ...baseResult('TRANSITION_CONFIRMED', runId, projectRef, refreshed),
        transition:publicTransition(confirmed),
        lease_ref:lease.lease_ref,
        settled_at:settlement?.settled_at || null,
        authority:refreshed.horizon.authority,
      });
    }

    return Object.freeze(baseResult('WAITING', runId, projectRef, evaluation));
  }

  return Object.freeze({ advance });
}

export function statusForOrchestrationAdvanceError(error) {
  const code = String(error?.code || '');
  if (code === 'ORCHESTRATION_ADVANCE_REQUEST_INVALID') return 400;
  if (code === 'ORCHESTRATION_ADVANCE_RUN_NOT_FOUND') return 404;
  if (code === 'ORCHESTRATION_ADVANCE_OPERATOR_UNAVAILABLE') return 503;
  if (code.startsWith('ORCHESTRATION_ADVANCE_') || code.startsWith('PROJECT_TRANSITION_') || code.startsWith('PROJECT_HORIZON_')) return 409;
  return null;
}
