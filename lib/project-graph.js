import { resolveWorkLifecycle } from './work-lifecycle.js';

export const PROJECT_NODE_STATES = Object.freeze(['DONE', 'OFF_NOMINAL', 'WAITING', 'READY']);

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('INVALID_PROJECT_GRAPH', `${field} must be a non-empty string`, { field, value:value ?? null });
  return normalized;
}

function normalizeExecutor(raw, nodeId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_PROJECT_GRAPH', 'executor must be an object', { node_id:nodeId });
  }
  const kind = text(raw.kind, 'executor.kind').toLowerCase();
  if (kind === 'operator') {
    return Object.freeze({ kind, command:text(raw.command, 'executor.command') });
  }
  if (kind === 'agent') {
    return Object.freeze({
      kind,
      role:text(raw.role, 'executor.role'),
      skill:text(raw.skill, 'executor.skill'),
    });
  }
  fail('INVALID_PROJECT_GRAPH', 'executor.kind must be operator or agent', { node_id:nodeId, kind });
}

function normalizeRequires(raw, nodeId) {
  const values = raw == null ? [] : raw;
  if (!Array.isArray(values)) fail('INVALID_PROJECT_GRAPH', 'requires must be an array', { node_id:nodeId });
  const requires = values.map((value, index) => text(value, `requires[${index}]`));
  if (new Set(requires).size !== requires.length) fail('INVALID_PROJECT_GRAPH', 'requires contains duplicate node ids', { node_id:nodeId });
  if (requires.includes(nodeId)) fail('INVALID_PROJECT_GRAPH', 'node cannot require itself', { node_id:nodeId });
  return Object.freeze([...requires]);
}

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_PROJECT_GRAPH', 'each node must be an object');
  const id = text(raw.id, 'id');
  const priority = raw.priority == null ? 0 : raw.priority;
  if (!Number.isInteger(priority)) fail('INVALID_PROJECT_GRAPH', 'priority must be an integer', { node_id:id, priority });
  if (!raw.lifecycle || typeof raw.lifecycle !== 'object' || Array.isArray(raw.lifecycle)) {
    fail('INVALID_PROJECT_GRAPH', 'lifecycle must be an object', { node_id:id });
  }
  return Object.freeze({
    id,
    priority,
    requires:normalizeRequires(raw.requires, id),
    lifecycle:raw.lifecycle,
    executor:normalizeExecutor(raw.executor, id),
  });
}

function assertAcyclic(nodesById) {
  const visited = new Set();
  const visiting = new Set();
  const path = [];

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      fail('PROJECT_GRAPH_CYCLE', 'project prerequisite graph must be acyclic', { cycle:[...path.slice(start), id] });
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of nodesById.get(id).requires) visit(dependency);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of [...nodesById.keys()].sort()) visit(id);
}

function compareFrontier(left, right) {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function evaluateProjectGraph(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.nodes)) {
    fail('INVALID_PROJECT_GRAPH', 'nodes must be an array');
  }

  const nodes = input.nodes.map(normalizeNode);
  const nodesById = new Map();
  for (const node of nodes) {
    if (nodesById.has(node.id)) fail('INVALID_PROJECT_GRAPH', 'node ids must be unique', { node_id:node.id });
    nodesById.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dependency of node.requires) {
      if (!nodesById.has(dependency)) {
        fail('INVALID_PROJECT_GRAPH', 'requires references a missing node', { node_id:node.id, dependency });
      }
    }
  }
  assertAcyclic(nodesById);

  const lifecycleById = new Map(nodes.map((node) => [node.id, resolveWorkLifecycle(node.lifecycle)]));
  const done = new Set(nodes.filter((node) => lifecycleById.get(node.id).complete).map((node) => node.id));

  const evaluated = nodes.map((node) => {
    const lifecycle = lifecycleById.get(node.id);
    const unmetRequirements = [...node.requires].filter((dependency) => !done.has(dependency)).sort();
    let state;
    if (lifecycle.complete) state = 'DONE';
    else if (lifecycle.condition !== 'NOMINAL') state = 'OFF_NOMINAL';
    else if (unmetRequirements.length) state = 'WAITING';
    else state = 'READY';
    return Object.freeze({
      id:node.id,
      priority:node.priority,
      requires:node.requires,
      unmet_requirements:Object.freeze(unmetRequirements),
      state,
      lifecycle,
      executor:node.executor,
    });
  });

  const frontier = evaluated.filter((node) => node.state === 'READY').sort(compareFrontier);
  return Object.freeze({
    complete:evaluated.every((node) => node.state === 'DONE'),
    frontier:Object.freeze(frontier),
    nodes:Object.freeze(evaluated),
  });
}

export function applyProjectGraphAmendment(input = {}, amendment = {}) {
  evaluateProjectGraph(input);
  if (!amendment || typeof amendment !== 'object' || Array.isArray(amendment)) {
    fail('INVALID_PROJECT_GRAPH_AMENDMENT', 'amendment must be an object');
  }

  const rawRemove = amendment.remove_node_ids == null ? [] : amendment.remove_node_ids;
  const rawUpsert = amendment.upsert_nodes == null ? [] : amendment.upsert_nodes;
  if (!Array.isArray(rawRemove) || !Array.isArray(rawUpsert)) {
    fail('INVALID_PROJECT_GRAPH_AMENDMENT', 'remove_node_ids and upsert_nodes must be arrays');
  }

  const removeNodeIds = rawRemove.map((value, index) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) fail('INVALID_PROJECT_GRAPH_AMENDMENT', 'remove_node_ids must contain non-empty strings', { index, value:value ?? null });
    return normalized;
  });
  if (new Set(removeNodeIds).size !== removeNodeIds.length) {
    fail('INVALID_PROJECT_GRAPH_AMENDMENT', 'remove_node_ids contains duplicate node ids');
  }

  const upsertNodes = rawUpsert.map(normalizeNode);
  const upsertIds = upsertNodes.map((node) => node.id);
  if (new Set(upsertIds).size !== upsertIds.length) {
    fail('INVALID_PROJECT_GRAPH_AMENDMENT', 'upsert_nodes contains duplicate node ids');
  }
  const contradictory = removeNodeIds.filter((id) => upsertIds.includes(id));
  if (contradictory.length) {
    fail('INVALID_PROJECT_GRAPH_AMENDMENT', 'a node cannot be removed and upserted in the same amendment', { node_ids:contradictory.sort() });
  }

  const nodesById = new Map(input.nodes.map(normalizeNode).map((node) => [node.id, node]));
  for (const id of removeNodeIds) nodesById.delete(id);
  for (const node of upsertNodes) nodesById.set(node.id, node);

  const graph = Object.freeze({
    nodes:Object.freeze([...nodesById.values()].sort((left, right) => left.id.localeCompare(right.id))),
  });
  const evaluation = evaluateProjectGraph(graph);
  return Object.freeze({
    graph,
    evaluation,
    amendment:Object.freeze({
      remove_node_ids:Object.freeze([...removeNodeIds].sort()),
      upsert_node_ids:Object.freeze([...upsertIds].sort()),
    }),
  });
}

export async function dispatchProjectTransition(input = {}, handlers = {}) {
  const evaluated = evaluateProjectGraph(input);
  const selected = evaluated.frontier[0] || null;
  if (!selected) {
    return Object.freeze({
      dispatched:false,
      reason:evaluated.complete ? 'PROJECT_COMPLETE' : 'NO_READY_TRANSITION',
      transition:null,
      result:null,
    });
  }

  const handler = handlers?.[selected.executor.kind];
  if (typeof handler !== 'function') {
    fail('PROJECT_EXECUTOR_UNAVAILABLE', 'selected transition executor is unavailable', {
      node_id:selected.id,
      executor_kind:selected.executor.kind,
    });
  }

  const transition = Object.freeze({
    node_id:selected.id,
    lifecycle:selected.lifecycle,
    executor:selected.executor,
  });
  const result = await handler(transition);
  return Object.freeze({
    dispatched:true,
    reason:null,
    transition,
    result,
  });
}
