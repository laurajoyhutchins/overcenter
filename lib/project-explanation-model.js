const SHA40 = /^[0-9a-f]{40}$/;
const STATES = new Set(['READY','WAITING','OFF_NOMINAL','DONE']);

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('PROJECT_EXPLANATION_INVALID', `${field} must be explicit`, { field });
  return normalized;
}

function uniqueSorted(values) { return [...new Set(values)].sort(); }

function evidenceFor(node, runtime) {
  const evidence = [Object.freeze({ kind:'graph', subject:`transition:${node.id}` })];
  if (runtime?.occupancy !== undefined) evidence.push(Object.freeze({ kind:'occupancy', subject:`transition:${node.id}` }));
  if (runtime?.confirmation !== undefined) evidence.push(Object.freeze({ kind:'confirmation', subject:`transition:${node.id}` }));
  if (runtime?.execution !== undefined) evidence.push(Object.freeze({ kind:'execution', subject:`transition:${node.id}` }));
  if (runtime?.recovery !== undefined) evidence.push(Object.freeze({ kind:'recovery', subject:`transition:${node.id}` }));
  if (Array.isArray(runtime?.evidence) && runtime.evidence.length) evidence.push(Object.freeze({ kind:'evidence', subject:`transition:${node.id}` }));
  return Object.freeze(evidence);
}

function currentRuntime(runtime, authorityRevision) {
  if (!runtime || !runtime.occupancy || runtime.occupancy.authority_revision !== authorityRevision) return null;
  return runtime;
}

function effectiveStatus(node, runtime) {
  if (node.state === 'DONE') return 'done';
  if (node.state === 'OFF_NOMINAL') return 'blocked';
  if (node.state === 'WAITING') return 'waiting';
  if (!runtime || runtime.occupancy == null) return 'ready';
  if (runtime.occupancy.occupied === true) return 'working';
  if (runtime.occupancy.suspended === true) return 'waiting';
  return 'ready';
}

function reasonFor(node, runtime) {
  const status = effectiveStatus(node, runtime);
  if (status === 'done') return Object.freeze({ kind:'complete', subjects:Object.freeze([]) });
  if (status === 'working') return Object.freeze({ kind:'occupied', subjects:Object.freeze([node.id]) });
  if (runtime?.occupancy?.suspended === true) return Object.freeze({ kind:String(runtime.occupancy.wait_reason || runtime.occupancy.suspension_reason || 'suspended'), subjects:Object.freeze([node.id]) });
  if (node.state === 'OFF_NOMINAL') return Object.freeze({ kind:'off_nominal', subjects:Object.freeze([node.id]) });
  const unmet = uniqueSorted(node.unmet_requirements || []);
  if (unmet.length) return Object.freeze({ kind:'prerequisites', subjects:Object.freeze(unmet) });
  return Object.freeze({ kind:'ready', subjects:Object.freeze([]) });
}

function transitiveBlockers(id, byId) {
  const found = new Set();
  const visiting = new Set();
  function visit(nodeId) {
    if (visiting.has(nodeId)) return;
    visiting.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) return;
    for (const requirement of node.unmet_requirements || []) { found.add(requirement); visit(requirement); }
    visiting.delete(nodeId);
  }
  visit(id);
  return uniqueSorted(found);
}

function downstreamImpact(id, nodes) {
  const reverse = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) for (const requirement of node.requires || []) if (reverse.has(requirement)) reverse.get(requirement).push(node.id);
  const reached = new Set();
  const queue = [...(reverse.get(id) || [])];
  while (queue.length) {
    const next = queue.shift();
    if (reached.has(next)) continue;
    reached.add(next);
    queue.push(...(reverse.get(next) || []));
  }
  return Object.freeze({ count:reached.size, transition_ids:Object.freeze(uniqueSorted(reached)) });
}

function staleFacts(runtime, authorityRevision) {
  if (!runtime) return Object.freeze([]);
  const facts = [];
  for (const key of ['occupancy','confirmation','execution','recovery']) {
    const value = runtime[key];
    if (value && typeof value === 'object' && value.authority_revision && value.authority_revision !== authorityRevision) facts.push(key);
  }
  if (Array.isArray(runtime.evidence) && runtime.evidence.some((item) => item?.authority_revision && item.authority_revision !== authorityRevision)) facts.push('evidence');
  return Object.freeze(uniqueSorted(facts));
}

export function deriveProjectExplanation(input = {}) {
  const projectRef = text(input.project_ref, 'project_ref');
  const authorityRevision = text(input.authority_revision, 'authority_revision').toLowerCase();
  if (!SHA40.test(authorityRevision)) fail('PROJECT_EXPLANATION_AUTHORITY_INVALID', 'authority_revision must be an exact Git SHA', { authority_revision:authorityRevision });
  if (!Array.isArray(input.nodes)) fail('PROJECT_EXPLANATION_INVALID', 'nodes must be an array');
  const runtimeByTransition = input.runtime_by_transition && typeof input.runtime_by_transition === 'object' ? input.runtime_by_transition : {};
  const nodes = input.nodes.map((raw) => {
    const id = text(raw?.id, 'node.id');
    const state = text(raw?.state, `node.${id}.state`).toUpperCase();
    if (!STATES.has(state)) fail('PROJECT_EXPLANATION_INVALID', 'node state is unsupported', { id, state });
    return Object.freeze({ id, state, requires:Object.freeze(uniqueSorted(Array.isArray(raw.requires) ? raw.requires : [])), unmet_requirements:Object.freeze(uniqueSorted(Array.isArray(raw.unmet_requirements) ? raw.unmet_requirements : [])) });
  });
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) fail('PROJECT_EXPLANATION_INVALID', 'node ids must be unique');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) for (const dep of node.requires) if (!byId.has(dep)) fail('PROJECT_EXPLANATION_INVALID', 'requires references missing node', { node_id:node.id, dependency:dep });

  const transitions = nodes.map((node) => {
    const observedRuntime = runtimeByTransition[node.id] || null;
    const stale = staleFacts(observedRuntime, authorityRevision);
    const runtime = currentRuntime(observedRuntime, authorityRevision);
    return Object.freeze({
      id:node.id,
      status:effectiveStatus(node, runtime),
      reason:reasonFor(node, runtime),
      blockers:Object.freeze(transitiveBlockers(node.id, byId)),
      impact:downstreamImpact(node.id, nodes),
      runtime_state:runtime ? 'known' : 'unknown',
      stale:Object.freeze({ value:stale.length > 0, facts:stale }),
      evidence:evidenceFor(node, observedRuntime),
    });
  }).sort((a,b) => a.id.localeCompare(b.id));

  const highestImpactBlockers = transitions.filter((item) => item.status !== 'done' && item.impact.count > 0).sort((a,b) => b.impact.count - a.impact.count || a.id.localeCompare(b.id)).map((item) => item.id);
  return Object.freeze({
    schema:'project-explanation-v1', project_ref:projectRef, authority_revision:authorityRevision, transitions:Object.freeze(transitions),
    summary:Object.freeze({
      ready:Object.freeze(transitions.filter((item) => item.status === 'ready').map((item) => item.id)),
      working:Object.freeze(transitions.filter((item) => item.status === 'working').map((item) => item.id)),
      waiting:Object.freeze(transitions.filter((item) => item.status === 'waiting').map((item) => item.id)),
      blocked:Object.freeze(transitions.filter((item) => item.status === 'blocked').map((item) => item.id)),
      done:Object.freeze(transitions.filter((item) => item.status === 'done').map((item) => item.id)),
      highest_impact_blockers:Object.freeze(highestImpactBlockers),
    }),
  });
}
