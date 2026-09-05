import {
  assertExactObligationAuthorityCoordinate,
  assertPredecessorClosedObligationSet,
  projectObligationFingerprint,
} from './project-obligation-contract.js';

const SHA256 = /^[0-9a-f]{64}$/;

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PROJECT_OBLIGATION_PROJECTION_INVALID', `${field} must be an object`, { field });
  }
  return value;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('PROJECT_OBLIGATION_PROJECTION_INVALID', `${field} must be a non-empty string`, { field });
  return normalized;
}

function fingerprint(value, field) {
  const normalized = text(value, field).toLowerCase();
  if (!SHA256.test(normalized)) {
    fail('PROJECT_OBLIGATION_PROJECTION_INVALID', `${field} must be a SHA-256 digest`, { field });
  }
  return normalized;
}

function sameAuthoritySource(left, right) {
  return left.kind === right.kind
    && left.repository === right.repository
    && left.derivation === right.derivation;
}

function sameExactAuthority(left, right) {
  return sameAuthoritySource(left, right) && left.revision === right.revision;
}

function compareFrontier(left, right) {
  if (left.priority !== right.priority) return right.priority - left.priority;
  return left.id.localeCompare(right.id);
}

function normalizeNodes(rawNodes) {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'nodes must be a non-empty array');
  }
  const byId = new Map();
  for (const [index, rawNode] of rawNodes.entries()) {
    const node = record(rawNode, `nodes[${index}]`);
    const id = text(node.id, `nodes[${index}].id`);
    if (byId.has(id)) fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'node ids must be unique', { transition_id:id });
    if (!Array.isArray(node.requires)) fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'requires must be an array', { transition_id:id });
    const requires = node.requires.map((value, requirementIndex) => text(value, `nodes[${index}].requires[${requirementIndex}]`));
    if (new Set(requires).size !== requires.length) {
      fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'requires must not contain duplicates', { transition_id:id });
    }
    if (requires.includes(id)) fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'obligation cannot require itself', { transition_id:id });
    const priority = node.priority == null ? 0 : node.priority;
    if (!Number.isInteger(priority)) fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'priority must be an integer', { transition_id:id });
    byId.set(id, Object.freeze({ ...node, id, priority, requires:Object.freeze([...requires].sort()) }));
  }
  for (const node of byId.values()) {
    for (const requirement of node.requires) {
      if (!byId.has(requirement)) {
        fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'requires references a missing obligation', {
          transition_id:node.id,
          requirement,
        });
      }
    }
  }
  return byId;
}

async function currentFingerprints(byId) {
  const pairs = await Promise.all([...byId.values()].map(async (node) => [node.id, await projectObligationFingerprint(node)]));
  return new Map(pairs);
}

function normalizeHistoricalRealization(raw, index) {
  const value = record(raw, `realizations[${index}]`);
  const transitionId = text(value.transition_id, `realizations[${index}].transition_id`);
  if (String(value.disposition || '').trim().toLowerCase() !== 'completed') {
    fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'realization disposition must be completed', { transition_id:transitionId });
  }
  return Object.freeze({
    transition_id:transitionId,
    obligation_fingerprint:fingerprint(value.obligation_fingerprint, `realizations[${index}].obligation_fingerprint`),
    authority:assertExactObligationAuthorityCoordinate(value.authority),
    disposition:'completed',
  });
}

function normalizeExecution(raw, index) {
  const value = record(raw, `executions[${index}]`);
  return Object.freeze({
    transition_id:text(value.transition_id, `executions[${index}].transition_id`),
    obligation_fingerprint:fingerprint(value.obligation_fingerprint, `executions[${index}].obligation_fingerprint`),
    authority:assertExactObligationAuthorityCoordinate(value.authority),
    lease_ref:text(value.lease_ref, `executions[${index}].lease_ref`),
  });
}

function normalizeBlocker(raw, index) {
  const value = record(raw, `blockers[${index}]`);
  return Object.freeze({
    transition_id:text(value.transition_id, `blockers[${index}].transition_id`),
    obligation_fingerprint:fingerprint(value.obligation_fingerprint, `blockers[${index}].obligation_fingerprint`),
    reason:text(value.reason, `blockers[${index}].reason`),
  });
}

export async function deriveProjectObligationProjection(input = {}) {
  const currentAuthority = assertExactObligationAuthorityCoordinate(input.authority);
  const byId = normalizeNodes(input.nodes);
  const fingerprints = await currentFingerprints(byId);

  const acceptedRealizations = [];
  const staleRealizations = [];
  for (const [index, raw] of (input.realizations ?? []).entries()) {
    const realization = normalizeHistoricalRealization(raw, index);
    const currentFingerprint = fingerprints.get(realization.transition_id) || null;
    let reason = null;
    if (!currentFingerprint) reason = 'obligation_missing';
    else if (!sameAuthoritySource(realization.authority, currentAuthority)) reason = 'authority_source_mismatch';
    else if (realization.obligation_fingerprint !== currentFingerprint) reason = 'obligation_identity_changed';
    if (reason) staleRealizations.push(Object.freeze({ ...realization, reason }));
    else acceptedRealizations.push(realization);
  }

  const satisfied = [...new Set(acceptedRealizations.map((item) => item.transition_id))].sort();
  assertPredecessorClosedObligationSet([...byId.values()], satisfied);
  const satisfiedSet = new Set(satisfied);

  const executionById = new Map();
  for (const [index, raw] of (input.executions ?? []).entries()) {
    const execution = normalizeExecution(raw, index);
    const currentFingerprint = fingerprints.get(execution.transition_id) || null;
    if (!currentFingerprint || execution.obligation_fingerprint !== currentFingerprint || !sameExactAuthority(execution.authority, currentAuthority)) continue;
    if (executionById.has(execution.transition_id)) {
      fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'more than one live execution authority exists for an obligation', {
        transition_id:execution.transition_id,
      });
    }
    executionById.set(execution.transition_id, execution);
  }

  const blockerById = new Map();
  for (const [index, raw] of (input.blockers ?? []).entries()) {
    const blocker = normalizeBlocker(raw, index);
    const currentFingerprint = fingerprints.get(blocker.transition_id) || null;
    if (!currentFingerprint || blocker.obligation_fingerprint !== currentFingerprint) continue;
    if (blockerById.has(blocker.transition_id)) {
      fail('PROJECT_OBLIGATION_PROJECTION_INVALID', 'more than one blocker exists for an obligation', {
        transition_id:blocker.transition_id,
      });
    }
    blockerById.set(blocker.transition_id, blocker);
  }

  const evaluated = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)).map((node) => {
    const unmetRequirements = node.requires.filter((requirement) => !satisfiedSet.has(requirement));
    const execution = executionById.get(node.id) || null;
    const blocker = blockerById.get(node.id) || null;
    let state;
    if (satisfiedSet.has(node.id)) state = 'DONE';
    else if (blocker) state = 'OFF_NOMINAL';
    else if (execution) {
      if (unmetRequirements.length) {
        fail('PROJECT_OBLIGATION_EXECUTION_PRECONDITION_INVALID', 'live execution authority exists before prerequisites are satisfied', {
          transition_id:node.id,
          unmet_requirements:unmetRequirements,
        });
      }
      state = 'EXECUTING';
    } else if (unmetRequirements.length) state = 'WAITING';
    else state = 'READY';
    return Object.freeze({
      id:node.id,
      priority:node.priority,
      requires:node.requires,
      obligation_fingerprint:fingerprints.get(node.id),
      unmet_requirements:Object.freeze([...unmetRequirements]),
      state,
      ...(execution ? { execution } : {}),
      ...(blocker ? { blocker } : {}),
    });
  });

  const frontier = evaluated.filter((node) => node.state === 'READY').sort(compareFrontier);
  const complete = evaluated.every((node) => node.state === 'DONE');
  if (!complete && frontier.length === 0 && !evaluated.some((node) => ['EXECUTING', 'OFF_NOMINAL'].includes(node.state))) {
    fail('PROJECT_OBLIGATION_EMPTY_FRONTIER_INVARIANT', 'incomplete obligation graph has no READY work and no explicit blocker', {
      states:evaluated.map((node) => ({ id:node.id, state:node.state, unmet_requirements:node.unmet_requirements })),
    });
  }

  return Object.freeze({
    complete,
    authority:currentAuthority,
    satisfied:Object.freeze(satisfied),
    accepted_realizations:Object.freeze(acceptedRealizations),
    stale_realizations:Object.freeze(staleRealizations),
    frontier:Object.freeze(frontier),
    nodes:Object.freeze(evaluated),
  });
}