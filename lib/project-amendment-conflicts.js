import { projectObligationFingerprint } from './project-obligation-contract.js';
import { projectTransitionDependencyFingerprint } from './project-transition-dependency-fingerprint.js';

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`);
  return normalized;
}

function transitions(definition, field) {
  const value = record(definition, field);
  if (!Array.isArray(value.transitions)) throw new TypeError(`${field}.transitions must be an array`);
  const byId = new Map();
  for (const [index, raw] of value.transitions.entries()) {
    const node = record(raw, `${field}.transitions[${index}]`);
    const id = text(node.id, `${field}.transitions[${index}].id`);
    if (byId.has(id)) throw new TypeError(`${field} contains duplicate transition ${id}`);
    if (!Array.isArray(node.requires)) throw new TypeError(`${field}.transitions[${index}].requires must be an array`);
    const requires = [...new Set(node.requires.map((item, requirementIndex) => text(
      item,
      `${field}.transitions[${index}].requires[${requirementIndex}]`,
    )))].sort();
    byId.set(id, Object.freeze({ ...node, id, requires:Object.freeze(requires) }));
  }
  return byId;
}

async function identityMap(byId) {
  const result = new Map();
  await Promise.all([...byId.values()].map(async (node) => {
    result.set(node.id, Object.freeze({
      obligation_fingerprint:await projectObligationFingerprint(node),
      dependency_fingerprint:await projectTransitionDependencyFingerprint({
        transition_id:node.id,
        requires:node.requires,
      }),
    }));
  }));
  return result;
}

function reverseDependencies(byId) {
  const reverse = new Map([...byId.keys()].map((id) => [id, new Set()]));
  for (const node of byId.values()) {
    for (const requirement of node.requires) {
      if (!reverse.has(requirement)) reverse.set(requirement, new Set());
      reverse.get(requirement).add(node.id);
    }
  }
  return reverse;
}

function addDescendants(seeds, reverse, output) {
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (output.has(id)) continue;
    output.add(id);
    for (const dependent of reverse.get(id) || []) queue.push(dependent);
  }
}

export async function analyzeProjectAmendmentConflicts(input = {}) {
  const current = transitions(input.current_definition, 'current_definition');
  const candidate = transitions(input.candidate_definition, 'candidate_definition');
  const [currentIdentity, candidateIdentity] = await Promise.all([
    identityMap(current),
    identityMap(candidate),
  ]);
  const allIds = [...new Set([...current.keys(), ...candidate.keys()])].sort();
  const changed = [];
  const dependencyChanged = [];
  for (const id of allIds) {
    const before = currentIdentity.get(id) || null;
    const after = candidateIdentity.get(id) || null;
    if (!before || !after || before.obligation_fingerprint !== after.obligation_fingerprint) changed.push(id);
    if (!before || !after || before.dependency_fingerprint !== after.dependency_fingerprint) dependencyChanged.push(id);
  }

  const affected = new Set();
  addDescendants(changed, reverseDependencies(current), affected);
  addDescendants(changed, reverseDependencies(candidate), affected);

  const liveInput = input.live_execution_authorities == null ? [] : input.live_execution_authorities;
  if (!Array.isArray(liveInput)) throw new TypeError('live_execution_authorities must be an array');
  const liveIds = [...new Set(liveInput.map((item, index) => text(
    record(item, `live_execution_authorities[${index}]`).transition_id,
    `live_execution_authorities[${index}].transition_id`,
  )))].sort();
  const conflicts = liveIds.filter((id) => affected.has(id));

  return Object.freeze({
    schema:'project-amendment-semantic-conflicts-v1',
    changed_transition_ids:Object.freeze(changed),
    dependency_changed_transition_ids:Object.freeze(dependencyChanged),
    affected_transition_ids:Object.freeze([...affected].sort()),
    live_transition_ids:Object.freeze(liveIds),
    conflicting_live_transition_ids:Object.freeze(conflicts),
  });
}