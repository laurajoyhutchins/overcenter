import { evaluateProjectHorizon as evaluateAuthoritativeProjectHorizon } from './project-horizon.js';

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

function authoringDetail(operation, projectRef, authorityRevision) {
  const payload = operation?.recovery_payload || {};
  if (payload.project_ref !== projectRef) invalid('project.inspect observed authoring state for a different project');
  const stagedRevision = String(payload.staged_revision || '').trim().toLowerCase();
  const expectedRevision = String(payload.expected_revision || '').trim().toLowerCase();
  if (!SHA40.test(stagedRevision) || !SHA40.test(expectedRevision)) invalid('project.inspect observed authoring state without exact revision identity');
  const state = String(operation?.state || '');
  const phase = String(payload.phase || '');
  let disposition;
  let automaticRecovery;
  if (state === 'succeeded') {
    disposition = 'terminal_success';
    automaticRecovery = 'none';
  } else if (state === 'indeterminate' || phase.startsWith('INDETERMINATE_')) {
    disposition = 'external_effect_indeterminate';
    automaticRecovery = 'reconcile_external_effect';
  } else if (phase === 'RECOMPUTE_REQUIRED' || expectedRevision !== authorityRevision) {
    disposition = 'authority_moved';
    automaticRecovery = 'recompute_candidate';
  } else {
    disposition = 'waiting_external_verification';
    automaticRecovery = 'reconcile_on_observable_change';
  }
  return Object.freeze({
    operation_id:String(operation?.operation_id || ''),
    command:String(payload.command || ''),
    recovery_ref:`project-authoring:${projectRef}:${String(operation?.idempotency_key || payload.idempotency_key || '')}`,
    idempotency_key:String(operation?.idempotency_key || payload.idempotency_key || ''),
    staged_revision:stagedRevision,
    pull_request:Number.isInteger(payload.pull_request) ? payload.pull_request : null,
    waiting_on:Object.freeze([...(Array.isArray(payload.waiting_on) ? payload.waiting_on : [])].map(String)),
    expected_authority_revision:expectedRevision,
    disposition,
    automatic_recovery:automaticRecovery,
  });
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
  const readAuthoringOperations = typeof options.readAuthoringOperations === 'function' ? options.readAuthoringOperations : null;
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
      const frontierDetails = Object.freeze(await Promise.all(frontier.map(async (id, index) => {
        if (!readTransitionOccupancy || index >= FRONTIER_OCCUPANCY_LIMIT) return occupancyDetail(id, null);
        const occupancy = await readTransitionOccupancy({
          project_ref:projectRef,
          transition_id:id,
          authority_revision:revision,
          observed_at:observedAt,
          transition:horizon.frontier[index],
        });
        return occupancyDetail(id, occupancy);
      })));
      const authoringOperations = readAuthoringOperations
        ? Object.freeze((await readAuthoringOperations({ project_ref:projectRef, authority_revision:revision, observed_at:observedAt })).map((operation) => authoringDetail(operation, projectRef, revision)))
        : Object.freeze([]);
      return Object.freeze({
        ok:true,
        project_ref:projectRef,
        authority_revision:revision,
        complete:horizon.complete,
        frontier,
        frontier_details:frontierDetails,
        authoring_operations:authoringOperations,
      });
    },
  });
}