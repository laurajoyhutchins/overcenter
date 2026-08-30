import { evaluateProjectHorizon as evaluateAuthoritativeProjectHorizon } from './project-horizon.js';

const PROJECT_REF = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;

function invalid(message, details = null) {
  const error = new Error(message);
  error.code = 'PROJECT_INSPECT_RUNTIME_INVALID';
  error.details = details;
  throw error;
}

function projectRefFrom(input) {
  const projectRef = String(input?.project_ref || '').trim();
  if (!PROJECT_REF.test(projectRef)) invalid('project.inspect requires github:owner/repo project_ref', { project_ref:projectRef || null });
  return projectRef;
}

function transitionId(node) {
  const id = typeof node === 'string' ? node : String(node?.id || '');
  if (!id) invalid('project.inspect observed a frontier node without an id');
  return id;
}

// Concrete graph runtime composition belongs to production adapters.

export function projectInspectFor(options = {}) {
  const readProjectGraph = options.readProjectGraph;
  const evaluateProjectHorizon = options.evaluateProjectHorizon || evaluateAuthoritativeProjectHorizon;
  if (typeof readProjectGraph !== 'function') {
    invalid('project.inspect readProjectGraph dependency is required');
  }
  if (typeof evaluateProjectHorizon !== 'function') {
    invalid('project.inspect horizon evaluator dependency is unavailable');
  }

  return Object.freeze({
    async inspect(input = {}) {
      const projectRef = projectRefFrom(input);
      const graph = await readProjectGraph({ project_ref:projectRef });
      const revision = String(graph?.authority?.definition?.revision || '').trim().toLowerCase();
      if (!SHA40.test(revision)) invalid('project.inspect requires an exact GitHub authority revision', { revision:revision || null });
      const horizon = evaluateProjectHorizon(graph, { kind:'project', ref:projectRef });
      if (!horizon || typeof horizon.complete !== 'boolean' || !Array.isArray(horizon.frontier)) {
        invalid('project.inspect received an invalid authoritative horizon');
      }
      return Object.freeze({
        ok:true,
        project_ref:projectRef,
        authority_revision:revision,
        complete:horizon.complete,
        frontier:Object.freeze(horizon.frontier.map(transitionId)),
      });
    },
  });
}