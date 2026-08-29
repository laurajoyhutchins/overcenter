import { canonicalJson, sha256Text } from './canonical-json.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field, max = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', `${field} is invalid`, { field });
  return normalized;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', `${field} must be an object`, { field });
  }
  return value;
}

function exactRevision(value, field) {
  const revision = text(value, field, 40).toLowerCase();
  if (!SHA40.test(revision)) fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', `${field} must be a full Git commit SHA`, { field });
  return revision;
}

function fingerprint(value, field) {
  const digest = text(value, field, 64).toLowerCase();
  if (!SHA64.test(digest)) fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', `${field} must be a SHA-256 digest`, { field });
  return digest;
}

function transitionDefinition(node = {}) {
  const id = text(node.id, 'transition.id', 256);
  if (!Number.isInteger(node.priority)) {
    fail('PROJECT_TRANSITION_DEFINITION_INVALID', 'transition.priority must be an integer', { transition_id:id });
  }
  if (!Array.isArray(node.requires)) {
    fail('PROJECT_TRANSITION_DEFINITION_INVALID', 'transition.requires must be an array', { transition_id:id });
  }
  const requires = node.requires.map((value, index) => text(value, `transition.requires[${index}]`, 256));
  const executor = object(node.executor, 'transition.executor');
  const phaseBindings = node.phase_bindings == null ? {} : object(node.phase_bindings, 'transition.phase_bindings');
  return Object.freeze({
    id,
    priority:node.priority,
    requires:Object.freeze([...requires]),
    executor,
    phase_bindings:phaseBindings,
  });
}

function completedLifecycle() {
  return Object.freeze({
    current_stage:'CONFIRM',
    condition:'NOMINAL',
    responsibilities:Object.freeze(Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [
      stage,
      Object.freeze({ applicable:true, satisfied:true }),
    ]))),
  });
}

function normalizeObservation(raw, expected = {}) {
  const observation = object(raw, 'observation');
  if (observation.schema !== 'project-transition-observation-v1' || observation.kind !== 'project_transition_confirmation') {
    fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', 'project transition observation schema or kind is unsupported');
  }
  const projectRef = text(observation.project_ref, 'observation.project_ref');
  if (projectRef !== expected.project_ref) {
    fail('PROJECT_GRAPH_OBSERVATION_SCOPE_MISMATCH', 'project transition observation belongs to a different project', {
      expected_project_ref:expected.project_ref,
      observed_project_ref:projectRef,
    });
  }
  const transitionId = text(observation.transition_id, 'observation.transition_id', 256);
  const transitionDefinitionFingerprint = fingerprint(observation.transition_definition_fingerprint, 'observation.transition_definition_fingerprint');
  if (String(observation.disposition || '').trim().toLowerCase() !== 'completed') {
    fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', 'project transition confirmation must have completed disposition', { transition_id:transitionId });
  }

  const authority = object(observation.authority, 'observation.authority');
  const repository = text(authority.repository, 'observation.authority.repository', 256);
  const derivation = text(authority.derivation, 'observation.authority.derivation', 256);
  const revision = exactRevision(authority.revision, 'observation.authority.revision');
  if (String(authority.kind || '').trim().toLowerCase() !== 'github'
      || repository !== expected.authority.repository
      || derivation !== expected.authority.derivation) {
    fail('PROJECT_GRAPH_OBSERVATION_SCOPE_MISMATCH', 'project transition observation authority is incompatible with the current project authority', {
      transition_id:transitionId,
      repository,
      derivation,
    });
  }

  const provenance = object(observation.provenance, 'observation.provenance');
  if (provenance.kind !== 'project_transition_settlement') {
    fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', 'project transition observation provenance is unsupported', { transition_id:transitionId });
  }
  const leaseRef = text(provenance.lease_ref, 'observation.provenance.lease_ref', 128);
  const runId = text(provenance.run_id, 'observation.provenance.run_id', 512);
  const settledAt = text(provenance.settled_at, 'observation.provenance.settled_at', 64);
  if (!Number.isFinite(Date.parse(settledAt))) {
    fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', 'project transition observation settled_at is invalid', { transition_id:transitionId });
  }

  return Object.freeze({
    schema:'project-transition-observation-v1',
    kind:'project_transition_confirmation',
    project_ref:projectRef,
    transition_id:transitionId,
    transition_definition_fingerprint:transitionDefinitionFingerprint,
    disposition:'completed',
    authority:Object.freeze({ kind:'github', repository, revision, derivation }),
    provenance:Object.freeze({ kind:'project_transition_settlement', lease_ref:leaseRef, run_id:runId, settled_at:settledAt }),
  });
}

export async function projectTransitionDefinitionFingerprint(node = {}) {
  return sha256Text(canonicalJson(transitionDefinition(node)));
}

export async function applyProjectTransitionObservations(input = {}) {
  const projectRef = text(input.project_ref, 'project_ref');
  const authority = object(input.authority, 'authority');
  const repository = text(authority.repository, 'authority.repository', 256);
  const derivation = text(authority.derivation, 'authority.derivation', 256);
  exactRevision(authority.revision, 'authority.revision');
  if (String(authority.kind || '').trim().toLowerCase() !== 'github') {
    fail('PROJECT_GRAPH_OBSERVATION_SCOPE_MISMATCH', 'current project observation authority must be GitHub');
  }
  if (!Array.isArray(input.nodes) || !Array.isArray(input.observations)) {
    fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', 'nodes and observations must be arrays');
  }
  if (input.observations.length === 0) return Object.freeze([...input.nodes]);

  const currentFingerprints = new Map();
  for (const node of input.nodes) {
    const definition = transitionDefinition(node);
    currentFingerprints.set(definition.id, await projectTransitionDefinitionFingerprint(definition));
  }

  const confirmed = new Set();
  for (const raw of input.observations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.kind !== 'project_transition_confirmation') continue;
    const observation = normalizeObservation(raw, {
      project_ref:projectRef,
      authority:{ kind:'github', repository, derivation },
    });
    const current = currentFingerprints.get(observation.transition_id) || null;
    if (current && current === observation.transition_definition_fingerprint) confirmed.add(observation.transition_id);
  }

  if (confirmed.size === 0) return Object.freeze([...input.nodes]);
  return Object.freeze(input.nodes.map((node) => confirmed.has(node.id)
    ? Object.freeze({ ...node, lifecycle:completedLifecycle() })
    : node));
}