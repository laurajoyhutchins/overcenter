const TRANSITION_STATES = new Set(['pending', 'satisfied', 'blocked']);

function normalizedId(value, field) {
  const id = String(value || '').trim();
  if (!id) throw new Error(`PROJECT_GRAPH_INVALID_${field.toUpperCase()}`);
  return id;
}

function normalizeTransition(input) {
  if (!input || typeof input !== 'object') throw new Error('PROJECT_GRAPH_INVALID_TRANSITION');
  const id = normalizedId(input.id, 'transition_id');
  const state = String(input.state || 'pending').trim().toLowerCase();
  if (!TRANSITION_STATES.has(state)) throw new Error(`PROJECT_GRAPH_INVALID_STATE:${id}:${state}`);
  const depends_on = [...new Set((Array.isArray(input.depends_on) ? input.depends_on : []).map(value => normalizedId(value, 'dependency_id')))].sort();
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0;
  return Object.freeze({ id, state, depends_on:Object.freeze(depends_on), priority });
}

function assertAcyclic(byId) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`PROJECT_GRAPH_CYCLE:${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
}

export function evaluateProjectFrontier(graph) {
  const transitions = Array.isArray(graph?.transitions) ? graph.transitions.map(normalizeTransition) : [];
  const byId = new Map();
  for (const transition of transitions) {
    if (byId.has(transition.id)) throw new Error(`PROJECT_GRAPH_DUPLICATE_TRANSITION:${transition.id}`);
    byId.set(transition.id, transition);
  }
  for (const transition of transitions) {
    for (const dependency of transition.depends_on) {
      if (!byId.has(dependency)) throw new Error(`PROJECT_GRAPH_MISSING_DEPENDENCY:${transition.id}:${dependency}`);
    }
  }
  assertAcyclic(byId);

  const enabled = transitions
    .filter(transition => transition.state === 'pending')
    .filter(transition => transition.depends_on.every(id => byId.get(id).state === 'satisfied'))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));

  return Object.freeze({
    schema:'project-frontier-v1',
    enabled:Object.freeze(enabled.map(transition => Object.freeze({ id:transition.id, priority:transition.priority }))),
    satisfied_count:transitions.filter(transition => transition.state === 'satisfied').length,
    blocked_count:transitions.filter(transition => transition.state === 'blocked').length,
    pending_count:transitions.filter(transition => transition.state === 'pending').length,
  });
}
