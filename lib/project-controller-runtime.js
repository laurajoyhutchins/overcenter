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
  if (typeof runtime?.readProjectGraph !== 'function') {
    fail('PROJECT_GRAPH_READER_UNAVAILABLE', 'authoritative project graph reader is unavailable');
  }

  const ref = projectRef(input.project_ref);
  const graph = await runtime.readProjectGraph(Object.freeze({ project_ref:ref }));
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    fail('PROJECT_GRAPH_READ_INVALID', 'authoritative project graph reader returned invalid graph state', { project_ref:ref });
  }

  return runProjectControllerTick(graph, runtime);
}
