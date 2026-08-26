import { evaluateProjectGraph } from './project-graph.js';

export const PROJECT_HORIZON_KINDS = Object.freeze([
  'transition',
  'milestone',
  'project',
  'release',
  'portfolio',
]);

const EXPLICIT_HORIZON_KINDS = new Set(['milestone', 'release', 'portfolio']);

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

function authorityDefinition(value, code = 'PROJECT_HORIZON_AUTHORITY_INVALID') {
  const definition = object(value, code, 'project horizon authority definition must be an object');
  const kind = text(definition.kind, code, 'project horizon authority kind must be explicit').toLowerCase();
  if (kind !== 'github') fail(code, 'project horizon definition authority must be GitHub', { kind });
  const repository = text(definition.repository, code, 'project horizon authority repository must be explicit');
  const revision = text(definition.revision, code, 'project horizon authority revision must be explicit').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail(code, 'project horizon authority revision must be a full Git commit SHA', { revision });
  }
  const derivation = text(definition.derivation, code, 'project horizon derivation contract must be explicit');
  return Object.freeze({ kind, repository, revision, derivation });
}

function authorityKey(definition) {
  return `${definition.kind}:${definition.repository}@${definition.revision}#${definition.derivation}`;
}

function sameAuthority(left, right) {
  return authorityKey(left) === authorityKey(right);
}

function normalizeTarget(raw, projectRef) {
  const target = object(raw, 'PROJECT_HORIZON_TARGET_INVALID', 'project horizon target must be an object');
  const unknown = Object.keys(target).filter((key) => !['kind', 'ref'].includes(key)).sort();
  if (unknown.length) {
    fail('PROJECT_HORIZON_TARGET_INVALID', 'project horizon target contains unsupported fields', { unknown });
  }
  const kind = text(target.kind, 'PROJECT_HORIZON_TARGET_INVALID', 'project horizon target kind must be explicit').toLowerCase();
  if (!PROJECT_HORIZON_KINDS.includes(kind)) {
    fail('PROJECT_HORIZON_TARGET_INVALID', 'project horizon target kind is unsupported', { kind });
  }
  const ref = text(target.ref, 'PROJECT_HORIZON_TARGET_INVALID', 'project horizon target ref must be explicit');
  if (kind === 'project' && ref !== projectRef) {
    fail('PROJECT_HORIZON_TARGET_INVALID', 'project horizon ref must match the authoritative project_ref', {
      expected_project_ref:projectRef,
      actual_ref:ref,
    });
  }
  return Object.freeze({ kind, ref });
}

function normalizeExplicitHorizons(rawHorizons, nodeIds) {
  const raw = rawHorizons == null ? [] : rawHorizons;
  if (!Array.isArray(raw)) {
    fail('PROJECT_HORIZON_DEFINITION_INVALID', 'authoritative project horizon definitions must be an array');
  }

  const byKey = new Map();
  for (const rawHorizon of raw) {
    const horizon = object(rawHorizon, 'PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon definition must be an object');
    const unknown = Object.keys(horizon).filter((key) => !['kind', 'ref', 'target_node_ids'].includes(key)).sort();
    if (unknown.length) {
      fail('PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon definition contains unsupported fields', { unknown });
    }

    const kind = text(horizon.kind, 'PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon definition kind must be explicit').toLowerCase();
    if (!EXPLICIT_HORIZON_KINDS.has(kind)) {
      fail('PROJECT_HORIZON_DEFINITION_INVALID', 'only milestone, release, and portfolio horizons may be explicitly defined', { kind });
    }
    const ref = text(horizon.ref, 'PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon definition ref must be explicit');
    if (!Array.isArray(horizon.target_node_ids) || horizon.target_node_ids.length === 0) {
      fail('PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon definition must declare at least one target node', { kind, ref });
    }
    const targetNodeIds = horizon.target_node_ids.map((value, index) =>
      text(value, 'PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon target node id must be explicit', { kind, ref, index }));
    if (new Set(targetNodeIds).size !== targetNodeIds.length) {
      fail('PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon target node ids must be unique', { kind, ref });
    }
    const missing = targetNodeIds.filter((id) => !nodeIds.has(id)).sort();
    if (missing.length) {
      fail('PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon definition references missing target nodes', { kind, ref, missing });
    }

    const key = `${kind}:${ref}`;
    if (byKey.has(key)) {
      fail('PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon definitions must have unique kind/ref identity', { kind, ref });
    }
    byKey.set(key, Object.freeze({ kind, ref, target_node_ids:Object.freeze([...targetNodeIds]) }));
  }
  return byKey;
}

function dependencyClosure(targetNodeIds, evaluatedById) {
  const included = new Set();

  function include(nodeId) {
    if (included.has(nodeId)) return;
    const node = evaluatedById.get(nodeId);
    if (!node) {
      fail('PROJECT_HORIZON_DEFINITION_INVALID', 'project horizon dependency closure references a missing node', { node_id:nodeId });
    }
    for (const dependency of node.requires) include(dependency);
    included.add(nodeId);
  }

  for (const nodeId of targetNodeIds) include(nodeId);
  return included;
}

export function evaluateProjectHorizon(graph = {}, rawTarget = {}, options = {}) {
  const authoritativeGraph = object(graph, 'PROJECT_HORIZON_GRAPH_INVALID', 'project horizon requires an authoritative project graph');
  if (authoritativeGraph.schema !== 'project-graph-authority-v1') {
    fail('PROJECT_HORIZON_GRAPH_INVALID', 'project horizon requires project-graph-authority-v1 input', {
      schema:authoritativeGraph.schema ?? null,
    });
  }

  const projectRef = text(authoritativeGraph.project_ref, 'PROJECT_HORIZON_GRAPH_INVALID', 'authoritative project graph must include project_ref');
  const definition = authorityDefinition(authoritativeGraph.authority?.definition);
  if (options?.expected_authority !== undefined && options.expected_authority !== null) {
    const expected = authorityDefinition(options.expected_authority, 'PROJECT_HORIZON_EXPECTED_AUTHORITY_INVALID');
    if (!sameAuthority(expected, definition)) {
      fail('PROJECT_HORIZON_AUTHORITY_STALE', 'project horizon authority changed since the prior observation', {
        expected:expected,
        actual:definition,
      });
    }
  }

  const fullEvaluation = evaluateProjectGraph({ nodes:authoritativeGraph.nodes });
  const evaluatedById = new Map(fullEvaluation.nodes.map((node) => [node.id, node]));
  const nodeIds = new Set(evaluatedById.keys());
  const target = normalizeTarget(rawTarget, projectRef);
  const explicitHorizons = normalizeExplicitHorizons(authoritativeGraph.horizons, nodeIds);

  let targetNodeIds;
  if (target.kind === 'project') {
    targetNodeIds = fullEvaluation.nodes.map((node) => node.id);
  } else if (target.kind === 'transition') {
    if (!nodeIds.has(target.ref)) {
      fail('PROJECT_HORIZON_TARGET_NOT_FOUND', 'transition horizon target does not exist in the authoritative project graph', {
        kind:target.kind,
        ref:target.ref,
      });
    }
    targetNodeIds = [target.ref];
  } else {
    const explicit = explicitHorizons.get(`${target.kind}:${target.ref}`) || null;
    if (!explicit) {
      fail('PROJECT_HORIZON_TARGET_NOT_FOUND', 'project horizon target is not defined by the authoritative project graph', {
        kind:target.kind,
        ref:target.ref,
      });
    }
    targetNodeIds = [...explicit.target_node_ids];
  }

  const scopedIds = dependencyClosure(targetNodeIds, evaluatedById);
  const scopedNodes = authoritativeGraph.nodes.filter((node, index) => scopedIds.has(fullEvaluation.nodes[index].id));
  const evaluation = evaluateProjectGraph({ nodes:scopedNodes });

  return Object.freeze({
    schema:'project-horizon-evaluation-v1',
    horizon:Object.freeze({
      schema:'project-horizon-v1',
      kind:target.kind,
      ref:target.ref,
      authority:definition,
      authority_key:authorityKey(definition),
      target_node_ids:Object.freeze([...targetNodeIds].sort()),
      scope_node_ids:Object.freeze([...scopedIds].sort()),
    }),
    complete:evaluation.complete,
    frontier:evaluation.frontier,
    nodes:evaluation.nodes,
    off_nominal:Object.freeze(evaluation.nodes.filter((node) => node.state === 'OFF_NOMINAL')),
  });
}
