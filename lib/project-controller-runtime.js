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

  const confirm = runtime?.confirm;
  const controllerRuntime = Object.freeze({
    ...runtime,
    confirm:async (transition, context) => {
      if (typeof confirm !== 'function') {
        fail('PROJECT_LIFECYCLE_HANDLER_UNAVAILABLE', 'project controller lifecycle handler is unavailable', {
          node_id:transition?.node_id ?? null,
          phase:'CONFIRM',
        });
      }
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
