import {
  OVERCENTER_PROJECT_GRAPH_DERIVATION,
  deriveOvercenterProjectGraph,
} from './overcenter-project-graph-deriver.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function object(value, code, message, details = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message, details);
  return value;
}

function text(value, code, message, details = null) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(code, message, details);
  return normalized;
}

function exactRevision(value) {
  const revision = text(value, 'PROJECT_GRAPH_AUTHORITY_INVALID', 'project graph authority revision must be a full Git commit SHA');
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    fail('PROJECT_GRAPH_AUTHORITY_INVALID', 'project graph authority revision must be a full Git commit SHA', { revision });
  }
  return revision.toLowerCase();
}

function deriverFor(registry, name) {
  if (name === OVERCENTER_PROJECT_GRAPH_DERIVATION) return deriveOvercenterProjectGraph;
  if (registry instanceof Map) return registry.get(name) || null;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return null;
  return Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : null;
}

function requireRuntime(runtime, name) {
  const operation = runtime?.[name];
  if (typeof operation !== 'function') {
    fail('PROJECT_GRAPH_READER_UNAVAILABLE', 'authoritative project graph reader dependency is unavailable', { dependency:name });
  }
  return operation;
}

export function createAuthoritativeProjectGraphReader(runtime = {}) {
  const resolveProjectAuthority = requireRuntime(runtime, 'resolveProjectAuthority');
  const readProjectFacts = requireRuntime(runtime, 'readProjectFacts');
  const readProjectObservations = requireRuntime(runtime, 'readProjectObservations');

  return async function readProjectGraph(input = {}) {
    const projectRef = text(input?.project_ref, 'PROJECT_REF_INVALID', 'project_ref must be a non-empty string');
    const resolved = object(
      await resolveProjectAuthority(Object.freeze({ project_ref:projectRef })),
      'PROJECT_GRAPH_AUTHORITY_INVALID',
      'project graph authority resolution returned invalid state',
      { project_ref:projectRef },
    );
    if (String(resolved.kind || '').trim().toLowerCase() !== 'github') {
      fail('PROJECT_GRAPH_AUTHORITY_INVALID', 'project graph definition authority must be GitHub', { kind:resolved.kind ?? null });
    }

    const repository = text(resolved.repository, 'PROJECT_GRAPH_AUTHORITY_INVALID', 'project graph authority repository must be explicit');
    const revision = exactRevision(resolved.revision);
    const derivation = text(resolved.derivation, 'PROJECT_GRAPH_AUTHORITY_INVALID', 'project graph derivation contract must be explicit');
    const definition = Object.freeze({ kind:'github', repository, revision, derivation });

    const factsEnvelope = object(
      await readProjectFacts(Object.freeze({ project_ref:projectRef, repository, revision })),
      'PROJECT_GRAPH_FACTS_INVALID',
      'project graph fact reader returned invalid state',
      { project_ref:projectRef, repository, revision },
    );
    if (factsEnvelope.schema !== 'project-authority-facts-v1' || factsEnvelope.repository !== repository || String(factsEnvelope.revision || '').toLowerCase() !== revision) {
      fail('PROJECT_GRAPH_FACTS_MISMATCH', 'project graph facts are not attributable to the resolved exact repository revision', {
        repository,
        revision,
        facts_schema:factsEnvelope.schema ?? null,
        facts_repository:factsEnvelope.repository ?? null,
        facts_revision:factsEnvelope.revision ?? null,
      });
    }

    const derive = deriverFor(runtime?.projectGraphDerivers, derivation);
    if (typeof derive !== 'function') {
      fail('PROJECT_GRAPH_DERIVER_UNAVAILABLE', 'project graph derivation contract is not registered', { derivation });
    }
    const derived = object(
      await derive(Object.freeze({ project_ref:projectRef, authority:definition, facts:factsEnvelope.facts })),
      'PROJECT_GRAPH_DERIVATION_INVALID',
      'project graph derivation returned invalid state',
      { derivation },
    );
    if (!Array.isArray(derived.nodes)) {
      fail('PROJECT_GRAPH_DERIVATION_INVALID', 'project graph derivation must return nodes', { derivation });
    }
    const horizons = derived.horizons == null ? [] : derived.horizons;
    if (!Array.isArray(horizons)) {
      fail('PROJECT_GRAPH_DERIVATION_INVALID', 'project graph derivation horizons must be an array when provided', { derivation });
    }

    const observations = await readProjectObservations(Object.freeze({
      project_ref:projectRef,
      repository,
      revision,
      derivation,
      facts:factsEnvelope.facts,
      nodes:derived.nodes,
    }));
    if (!Array.isArray(observations)) {
      fail('PROJECT_GRAPH_OBSERVATIONS_INVALID', 'project graph observations must be an array', { project_ref:projectRef });
    }

    return Object.freeze({
      schema:'project-graph-authority-v1',
      project_ref:projectRef,
      authority:Object.freeze({
        definition,
        observations:Object.freeze([...observations]),
      }),
      nodes:Object.freeze([...derived.nodes]),
      horizons:Object.freeze([...horizons]),
    });
  };
}