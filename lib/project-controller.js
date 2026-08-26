import { evaluateProjectGraph, executeProjectTransitionLifecycle } from './project-graph.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function requirePhase(runtime, name, nodeId) {
  const handler = runtime?.[name];
  if (typeof handler !== 'function') {
    fail('PROJECT_LIFECYCLE_HANDLER_UNAVAILABLE', 'project controller lifecycle handler is unavailable', {
      node_id:nodeId,
      phase:name.toUpperCase(),
    });
  }
  return handler;
}

function registeredOperator(runtime, command) {
  const registry = runtime?.operators;
  if (registry instanceof Map) return registry.get(command) || null;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return null;
  return Object.prototype.hasOwnProperty.call(registry, command) ? registry[command] : null;
}

export function createProjectControllerHandlers(input = {}, runtime = {}) {
  const evaluation = evaluateProjectGraph(input);
  const selected = evaluation.frontier[0] || null;
  if (!selected) return Object.freeze({});

  const enable = requirePhase(runtime, 'enable', selected.id);
  const acquire = requirePhase(runtime, 'acquire', selected.id);
  const commit = requirePhase(runtime, 'commit', selected.id);
  const confirm = requirePhase(runtime, 'confirm', selected.id);

  const handlers = {
    enable:(transition, context) => enable(transition, context),
    acquire:(transition, context) => acquire(transition, context),
    commit:(transition, context) => commit(transition, context),
    confirm:(transition, context) => confirm(transition, context),
  };

  if (selected.executor.kind === 'operator') {
    const operator = registeredOperator(runtime, selected.executor.command);
    if (typeof operator !== 'function') {
      fail('PROJECT_OPERATOR_UNAVAILABLE', 'selected project operator is not registered', {
        node_id:selected.id,
        command:selected.executor.command,
      });
    }
    handlers.operator = (transition, context) => operator(Object.freeze({
      command:transition.executor.command,
      transition,
      context,
    }));
  } else if (selected.executor.kind === 'agent') {
    if (typeof runtime?.executeAgent !== 'function') {
      fail('PROJECT_AGENT_EXECUTOR_UNAVAILABLE', 'selected project agent executor is unavailable', {
        node_id:selected.id,
        role:selected.executor.role,
        skill:selected.executor.skill,
      });
    }
    handlers.agent = (transition, context) => runtime.executeAgent(Object.freeze({
      role:transition.executor.role,
      skill:transition.executor.skill,
      transition,
      context,
    }));
  }

  return Object.freeze(handlers);
}

export async function runProjectControllerTick(input = {}, runtime = {}) {
  const handlers = createProjectControllerHandlers(input, runtime);
  return executeProjectTransitionLifecycle(input, handlers);
}
