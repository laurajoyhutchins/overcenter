import { evaluateProjectHorizon as evaluateAuthoritativeProjectHorizon } from './project-horizon.js';
import { deriveProjectExplanation } from './project-explanation-model.js';

const PROJECT_REF = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const FRONTIER_OCCUPANCY_LIMIT = 8;

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

function occupancyDetail(id, occupancy) {
  if (!occupancy) return Object.freeze({ id, availability:'unknown', occupied:null, expires_at:null });
  const occupied = Boolean(occupancy.occupied);
  const suspensionObserved = Object.hasOwn(occupancy, 'suspended') || Object.hasOwn(occupancy, 'suspension_reason');
  const suspended = occupancy.suspended === true;
  const detail = {
    id,
    availability:occupied ? 'occupied' : (suspended ? 'waiting' : 'available'),
    occupied,
    expires_at:occupied && occupancy.expires_at ? String(occupancy.expires_at) : null,
  };
  if (suspensionObserved) {
    detail.suspended = suspended;
    detail.wait_reason = suspended ? String(occupancy.suspension_reason || 'blocked_settlement_promotion') : null;
  }
  return Object.freeze(detail);
}

export function projectInspectFor(options = {}) {
  const readProjectGraph = options.readProjectGraph;
  const evaluateProjectHorizon = options.evaluateProjectHorizon || evaluateAuthoritativeProjectHorizon;
  const readTransitionOccupancy = typeof options.readTransitionOccupancy === 'function' ? options.readTransitionOccupancy : null;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
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
      const frontierOccupancy = Object.freeze(await Promise.all(frontier.map(async (id, index) => {
        if (!readTransitionOccupancy || index >= FRONTIER_OCCUPANCY_LIMIT) return null;
        return readTransitionOccupancy({
          project_ref:projectRef,
          transition_id:id,
          authority_revision:revision,
          observed_at:observedAt,
          transition:horizon.frontier[index],
        });
      })));
      const frontierDetails = Object.freeze(frontier.map((id, index) => occupancyDetail(id, frontierOccupancy[index])));
      const runtimeByTransition = Object.fromEntries(frontier.flatMap((id, index) => {
        const occupancy = frontierOccupancy[index];
        return occupancy ? [[id, { occupancy }]] : [];
      }));
      const explanation = deriveProjectExplanation({
        project_ref:projectRef,
        authority_revision:revision,
        nodes:horizon.nodes,
        runtime_by_transition:runtimeByTransition,
      });
      return Object.freeze({
        ok:true,
        project_ref:projectRef,
        authority_revision:revision,
        complete:horizon.complete,
        frontier,
        frontier_details:frontierDetails,
        explanation,
      });
    },
  });
}