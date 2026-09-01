import { evaluateProjectHorizon as evaluateAuthoritativeProjectHorizon } from './project-horizon.js';

const PROJECT_REF = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const MAX_FRONTIER_OCCUPANCY = 32;

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

function earliestExpiry(leases) {
  return leases
    .map((lease) => String(lease?.expires_at || '').trim())
    .filter(Boolean)
    .sort()[0] || null;
}

export function projectInspectFor(options = {}) {
  const readProjectGraph = options.readProjectGraph;
  const evaluateProjectHorizon = options.evaluateProjectHorizon || evaluateAuthoritativeProjectHorizon;
  const activeLeasesForTransition = options.activeLeasesForTransition || null;
  const now = options.now || (() => new Date().toISOString());
  if (typeof readProjectGraph !== 'function' || typeof evaluateProjectHorizon !== 'function') {
    invalid('project.inspect runtime dependencies are unavailable');
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
      const frontier = Object.freeze(horizon.frontier.map(transitionId));
      const observedAt = String(now());
      const occupancyIds = frontier.slice(0, MAX_FRONTIER_OCCUPANCY);
      const frontierStatus = [];
      for (const id of occupancyIds) {
        if (typeof activeLeasesForTransition !== 'function') {
          frontierStatus.push(Object.freeze({ transition_id:id, availability:'UNKNOWN', occupied:null, expires_at:null }));
          continue;
        }
        const leases = await activeLeasesForTransition(projectRef, id, observedAt);
        if (!Array.isArray(leases)) invalid('project.inspect occupancy reader returned an invalid lease set', { transition_id:id });
        frontierStatus.push(Object.freeze({
          transition_id:id,
          availability:leases.length ? 'OCCUPIED' : 'AVAILABLE',
          occupied:leases.length > 0,
          expires_at:earliestExpiry(leases),
        }));
      }
      return Object.freeze({
        ok:true,
        project_ref:projectRef,
        authority_revision:revision,
        complete:horizon.complete,
        frontier,
        frontier_status:Object.freeze(frontierStatus),
        frontier_status_truncated:frontier.length > occupancyIds.length,
      });
    },
  });
}