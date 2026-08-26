import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { runProjectControllerTick } from './project-controller.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function projectRef(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('PROJECT_REF_INVALID', 'project_ref must be a non-empty string');
  return normalized;
}

function registeredPrimitive(runtime, primitive) {
  const registry = runtime?.primitives;
  if (registry instanceof Map) return registry.get(primitive) || null;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return null;
  return Object.prototype.hasOwnProperty.call(registry, primitive) ? registry[primitive] : null;
}

function resolveReference(path, transition, context) {
  const root = Object.freeze({ transition, context });
  let value = root;
  for (const segment of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segment)) {
      fail('PROJECT_PHASE_INPUT_UNAVAILABLE', 'declared lifecycle phase input evidence is unavailable', { path });
    }
    value = value[segment];
  }
  return value;
}

function resolvePhaseInput(binding, transition, context) {
  const resolved = {};
  for (const [field, source] of Object.entries(binding?.input || {})) {
    resolved[field] = Object.prototype.hasOwnProperty.call(source, 'literal')
      ? source.literal
      : resolveReference(source.from, transition, context);
  }
  return Object.freeze(resolved);
}

function boundPhaseHandler(runtime, phase) {
  return async (transition, context) => {
    const binding = transition?.phase_bindings?.[phase] || null;
    if (!binding) {
      fail('PROJECT_PHASE_BINDING_REQUIRED', 'selected transition is missing a required lifecycle phase binding', {
        node_id:transition?.node_id ?? null,
        phase,
      });
    }
    const primitive = registeredPrimitive(runtime, binding.primitive);
    if (typeof primitive !== 'function') {
      fail('PROJECT_PRIMITIVE_UNAVAILABLE', 'declared Busbar primitive is not registered', {
        node_id:transition?.node_id ?? null,
        phase,
        primitive:binding.primitive,
      });
    }
    const outcome = await primitive(resolvePhaseInput(binding, transition, context));
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) || outcome.ok !== true) return outcome;
    const missingEvidence = binding.evidence.filter((key) => !Object.prototype.hasOwnProperty.call(outcome, key));
    if (missingEvidence.length) {
      fail('PROJECT_PHASE_EVIDENCE_MISSING', 'declared lifecycle phase evidence is missing from primitive result', {
        node_id:transition?.node_id ?? null,
        phase,
        primitive:binding.primitive,
        missing_evidence:missingEvidence,
      });
    }
    return outcome;
  };
}

function createLifecycleRuntime(runtime = {}) {
  return Object.freeze({
    ...runtime,
    enable:typeof runtime?.enable === 'function' ? runtime.enable : async () => Object.freeze({ ok:true }),
    acquire:typeof runtime?.acquire === 'function' ? runtime.acquire : boundPhaseHandler(runtime, 'ACQUIRE'),
    commit:typeof runtime?.commit === 'function' ? runtime.commit : boundPhaseHandler(runtime, 'COMMIT'),
    confirm:typeof runtime?.confirm === 'function' ? runtime.confirm : boundPhaseHandler(runtime, 'CONFIRM'),
  });
}

export async function runAuthoritativeProjectControllerTick(input = {}, runtime = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('PROJECT_CONTROLLER_INPUT_INVALID', 'project controller input must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'graph') || Object.prototype.hasOwnProperty.call(input, 'nodes')) {
    fail('PROJECT_GRAPH_CALLER_AUTHORITY_REJECTED', 'caller-supplied project graph state is not authoritative');
  }

  const ref = projectRef(input.project_ref);
  const readProjectGraph = typeof runtime?.readProjectGraph === 'function'
    ? runtime.readProjectGraph
    : createAuthoritativeProjectGraphReader(runtime);
  const graph = await readProjectGraph(Object.freeze({ project_ref:ref }));
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    fail('PROJECT_GRAPH_READ_INVALID', 'authoritative project graph reader returned invalid graph state', { project_ref:ref });
  }

  const lifecycleRuntime = createLifecycleRuntime(runtime);
  const confirm = lifecycleRuntime.confirm;
  const controllerRuntime = Object.freeze({
    ...lifecycleRuntime,
    confirm:async (transition, context) => {
      const outcome = await confirm(transition, context);
      if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) || outcome.ok !== true) return outcome;
      const refreshedGraph = await readProjectGraph(Object.freeze({ project_ref:ref }));
      if (!refreshedGraph || typeof refreshedGraph !== 'object' || Array.isArray(refreshedGraph)) {
        fail('PROJECT_GRAPH_READ_INVALID', 'authoritative project graph reader returned invalid confirmation state', { project_ref:ref });
      }
      return Object.freeze({ ...outcome, graph:refreshedGraph });
    },
  });

  return runProjectControllerTick(graph, controllerRuntime);
}
