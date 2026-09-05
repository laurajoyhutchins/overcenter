import { canonicalJson, sha256Text } from './canonical-json.js';

export const PROJECT_OBLIGATION_GRAPH_PROFILE = 'overcenter-obligation-dag-v1';

export const PROJECT_OBLIGATION_GRAPH_CONTRACT = Object.freeze({
  schema:'project-obligation-graph-contract-v1',
  profile:PROJECT_OBLIGATION_GRAPH_PROFILE,
  workflow:Object.freeze({
    dependency_semantics:'all',
    acyclic:true,
    transition_fires_at_most_once:true,
    token_accounting:false,
  }),
  layers:Object.freeze({
    definition:'immutable_obligation_graph',
    proof:'realizations_and_evidence',
    coordination:'live_execution_authority',
    projection:'derived_current_state',
  }),
  identity:Object.freeze({
    logical_key_field:'id',
    obligation_semantic_fields:Object.freeze(['requires', 'executor', 'version_impact', 'phase_bindings']),
    selection_policy_fields:Object.freeze(['priority']),
    excluded_runtime_fields:Object.freeze([
      'lifecycle',
      'state',
      'unmet_requirements',
      'lease_ref',
      'run_id',
      'evidence',
      'receipt',
      'observed_at',
      'expires_at',
    ]),
  }),
  invariants:Object.freeze({
    satisfaction:'predecessor_closed',
    historical_truth:'authority_coordinate_scoped_and_monotonic',
    current_state:'derived_projection',
    authority_provenance:'exact_repository_revision_and_derivation',
  }),
});

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function record(value, field, code = 'PROJECT_OBLIGATION_CONTRACT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${field} must be an object`, { field });
  }
  return value;
}

function text(value, field, code = 'PROJECT_OBLIGATION_CONTRACT_INVALID') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(code, `${field} must be a non-empty string`, { field });
  return normalized;
}

function semanticValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(semanticValue));
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) normalized[key] = semanticValue(value[key]);
  }
  return Object.freeze(normalized);
}

function normalizedRequires(input, logicalKey = null) {
  if (!Array.isArray(input.requires)) {
    fail('PROJECT_OBLIGATION_CONTRACT_INVALID', 'requires must be an array');
  }
  const requires = input.requires.map((value, index) => text(value, `requires[${index}]`));
  const unique = [...new Set(requires)].sort();
  if (unique.length !== requires.length) {
    fail('PROJECT_OBLIGATION_CONTRACT_INVALID', 'requires must not contain duplicates', { transition_id:logicalKey });
  }
  if (logicalKey && unique.includes(logicalKey)) {
    fail('PROJECT_OBLIGATION_CONTRACT_INVALID', 'obligation cannot require itself', { transition_id:logicalKey });
  }
  return Object.freeze(unique);
}

export function projectObligationSemanticInput(raw) {
  const input = record(raw, 'obligation');
  const logicalKey = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null;
  return Object.freeze({
    schema:'project-obligation-semantics-v1',
    requires:normalizedRequires(input, logicalKey),
    executor:semanticValue(input.executor ?? null),
    version_impact:semanticValue(input.version_impact ?? null),
    phase_bindings:semanticValue(input.phase_bindings ?? {}),
  });
}

export function projectObligationGraphSemanticInput(raw) {
  const input = record(raw, 'graph');
  const transitions = input.transitions ?? input.nodes;
  if (!Array.isArray(transitions) || transitions.length === 0) {
    fail('PROJECT_OBLIGATION_CONTRACT_INVALID', 'graph transitions must be a non-empty array');
  }
  const seen = new Set();
  const normalized = transitions.map((rawTransition, index) => {
    const transition = record(rawTransition, `transitions[${index}]`);
    const key = text(transition.id, `transitions[${index}].id`);
    if (seen.has(key)) {
      fail('PROJECT_OBLIGATION_CONTRACT_INVALID', 'obligation logical keys must be unique', { transition_id:key });
    }
    seen.add(key);
    return Object.freeze({ key, obligation:projectObligationSemanticInput(transition) });
  }).sort((left, right) => left.key.localeCompare(right.key));
  return Object.freeze({
    schema:PROJECT_OBLIGATION_GRAPH_PROFILE,
    transitions:Object.freeze(normalized),
  });
}

export async function projectObligationFingerprint(raw) {
  return sha256Text(canonicalJson(projectObligationSemanticInput(raw)));
}

export async function projectObligationGraphFingerprint(raw) {
  return sha256Text(canonicalJson(projectObligationGraphSemanticInput(raw)));
}

export function assertPredecessorClosedObligationSet(rawTransitions, rawSatisfiedIds) {
  if (!Array.isArray(rawTransitions)) {
    fail('PROJECT_OBLIGATION_GRAPH_INVALID', 'transitions must be an array');
  }
  if (!Array.isArray(rawSatisfiedIds)) {
    fail('PROJECT_OBLIGATION_PREDECESSOR_CLOSURE_INVALID', 'satisfied obligation ids must be an array');
  }
  const byId = new Map();
  for (const [index, rawTransition] of rawTransitions.entries()) {
    const transition = record(rawTransition, `transitions[${index}]`, 'PROJECT_OBLIGATION_GRAPH_INVALID');
    const id = text(transition.id, `transitions[${index}].id`, 'PROJECT_OBLIGATION_GRAPH_INVALID');
    if (byId.has(id)) fail('PROJECT_OBLIGATION_GRAPH_INVALID', 'transition ids must be unique', { transition_id:id });
    byId.set(id, Object.freeze({ id, requires:normalizedRequires(transition, id) }));
  }
  const satisfied = [...new Set(rawSatisfiedIds.map((value, index) => text(
    value,
    `satisfied[${index}]`,
    'PROJECT_OBLIGATION_PREDECESSOR_CLOSURE_INVALID',
  )))].sort();
  const satisfiedSet = new Set(satisfied);
  for (const transitionId of satisfied) {
    const transition = byId.get(transitionId);
    if (!transition) {
      fail('PROJECT_OBLIGATION_PREDECESSOR_CLOSURE_INVALID', 'satisfied obligation is absent from the graph', {
        transition_id:transitionId,
      });
    }
    for (const requirement of transition.requires) {
      if (!byId.has(requirement)) {
        fail('PROJECT_OBLIGATION_GRAPH_INVALID', 'obligation requires a missing transition', {
          transition_id:transitionId,
          requirement,
        });
      }
      if (!satisfiedSet.has(requirement)) {
        fail('PROJECT_OBLIGATION_PREDECESSOR_CLOSURE_INVALID', 'satisfied obligations must be predecessor closed', {
          transition_id:transitionId,
          missing_requirement:requirement,
        });
      }
    }
  }
  return Object.freeze(satisfied);
}

export function assertExactObligationAuthorityCoordinate(raw) {
  const input = record(raw, 'authority', 'PROJECT_OBLIGATION_AUTHORITY_INVALID');
  const kind = text(input.kind, 'authority.kind', 'PROJECT_OBLIGATION_AUTHORITY_INVALID').toLowerCase();
  if (kind !== 'github') {
    fail('PROJECT_OBLIGATION_AUTHORITY_INVALID', 'obligation graph definition authority must be GitHub', { kind });
  }
  const repository = text(input.repository, 'authority.repository', 'PROJECT_OBLIGATION_AUTHORITY_INVALID');
  const revision = text(input.revision, 'authority.revision', 'PROJECT_OBLIGATION_AUTHORITY_INVALID').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail('PROJECT_OBLIGATION_AUTHORITY_INVALID', 'authority revision must be an exact 40-character Git revision', { revision });
  }
  const derivation = text(input.derivation, 'authority.derivation', 'PROJECT_OBLIGATION_AUTHORITY_INVALID');
  return Object.freeze({ kind:'github', repository, revision, derivation });
}