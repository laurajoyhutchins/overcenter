const SHA40 = /^[0-9a-f]{40}$/;
const STATES = new Set(['READY','WAITING','OFF_NOMINAL','DONE']);
const RUNTIME_FACTS = Object.freeze(['occupancy','confirmation','execution','recovery']);
const CHANGE_FACTS = Object.freeze(['status','reason','blockers','impact','runtime_state','stale']);

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
function stable(value) { return JSON.stringify(value); }

function runtimeIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['lease_ref','lease_id','run_id','operation_id','attempt_id','id']) {
    const candidate = typeof value[key] === 'string' ? value[key].trim() : '';
    if (candidate) return candidate;
  }
  return null;
}

function provenanceEntry(kind, nodeId, value, fallbackRevision = null, extra = {}) {
  const revision = value && typeof value === 'object' && typeof value.authority_revision === 'string'
    ? value.authority_revision.trim().toLowerCase()
    : fallbackRevision;
  const entry = { kind, subject:`transition:${nodeId}`, authority_revision:revision || null, ...extra };
  const identity = runtimeIdentity(value);
  if (identity) entry.identity = identity;
  return Object.freeze(entry);
}

function evidenceFor(node, runtime, projectRef, authorityRevision) {
  const evidence = [Object.freeze({
    kind:'graph',
    subject:`transition:${node.id}`,
    authority_revision:authorityRevision,
    ref:`${projectRef}@${authorityRevision}#transition:${node.id}`,
  })];
  for (const key of RUNTIME_FACTS) {
    if (runtime?.[key] !== undefined) evidence.push(provenanceEntry(key, node.id, runtime[key]));
  }
  if (Array.isArray(runtime?.evidence)) {
    for (const item of runtime.evidence) {
      if (!item || typeof item !== 'object') continue;
      const ref = typeof item.ref === 'string' && item.ref.trim() ? item.ref.trim() : null;
      evidence.push(provenanceEntry('evidence', node.id, item, null, ...(ref ? [{ ref }] : [{}])));
    }
  }
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
  for (const key of RUNTIME_FACTS) {
    const value = runtime[key];
    if (value && typeof value === 'object' && value.authority_revision && value.authority_revision !== authorityRevision) facts.push(key);
  }
  if (Array.isArray(runtime.evidence) && runtime.evidence.some((item) => item?.authority_revision && item.authority_revision !== authorityRevision)) facts.push('evidence');
  return Object.freeze(uniqueSorted(facts));
}

function normalizeNodes(rawNodes) {
  if (!Array.isArray(rawNodes)) fail('PROJECT_EXPLANATION_INVALID', 'nodes must be an array');
  const nodes = rawNodes.map((raw) => {
    const id = text(raw?.id, 'node.id');
    const state = text(raw?.state, `node.${id}.state`).toUpperCase();
    if (!STATES.has(state)) fail('PROJECT_EXPLANATION_INVALID', 'node state is unsupported', { id, state });
    return Object.freeze({ id, state, requires:Object.freeze(uniqueSorted(Array.isArray(raw.requires) ? raw.requires : [])), unmet_requirements:Object.freeze(uniqueSorted(Array.isArray(raw.unmet_requirements) ? raw.unmet_requirements : [])) });
  });
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) fail('PROJECT_EXPLANATION_INVALID', 'node ids must be unique');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) for (const dep of node.requires) if (!byId.has(dep)) fail('PROJECT_EXPLANATION_INVALID', 'requires references missing node', { node_id:node.id, dependency:dep });
  return { nodes, byId };
}

function deriveSnapshot({ projectRef, authorityRevision, rawNodes, runtimeByTransition }) {
  const { nodes, byId } = normalizeNodes(rawNodes);
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
      evidence:evidenceFor(node, observedRuntime, projectRef, authorityRevision),
    });
  }).sort((a,b) => a.id.localeCompare(b.id));
  return Object.freeze(transitions);
}

function changeFor(current, previous, previousRevision) {
  if (!previous) return Object.freeze({ value:true, from_authority_revision:previousRevision, facts:Object.freeze(['added']) });
  const facts = CHANGE_FACTS.filter((key) => stable(current[key]) !== stable(previous[key]));
  return Object.freeze({ value:facts.length > 0, from_authority_revision:previousRevision, facts:Object.freeze(facts) });
}

export function deriveProjectExplanation(input = {}) {
  const projectRef = text(input.project_ref, 'project_ref');
  const authorityRevision = text(input.authority_revision, 'authority_revision').toLowerCase();
  if (!SHA40.test(authorityRevision)) fail('PROJECT_EXPLANATION_AUTHORITY_INVALID', 'authority_revision must be an exact Git SHA', { authority_revision:authorityRevision });
  const runtimeByTransition = input.runtime_by_transition && typeof input.runtime_by_transition === 'object' ? input.runtime_by_transition : {};
  const current = deriveSnapshot({ projectRef, authorityRevision, rawNodes:input.nodes, runtimeByTransition });

  let previousRevision = null;
  let previousById = new Map();
  let removed = [];
  if (input.previous !== undefined && input.previous !== null) {
    if (!input.previous || typeof input.previous !== 'object' || Array.isArray(input.previous)) fail('PROJECT_EXPLANATION_INVALID', 'previous must be an object when supplied');
    previousRevision = text(input.previous.authority_revision, 'previous.authority_revision').toLowerCase();
    if (!SHA40.test(previousRevision)) fail('PROJECT_EXPLANATION_AUTHORITY_INVALID', 'previous.authority_revision must be an exact Git SHA', { authority_revision:previousRevision });
    if (previousRevision === authorityRevision) fail('PROJECT_EXPLANATION_INVALID', 'previous authority revision must differ from current authority revision');
    const previousRuntime = input.previous.runtime_by_transition && typeof input.previous.runtime_by_transition === 'object' ? input.previous.runtime_by_transition : {};
    const previousTransitions = deriveSnapshot({ projectRef, authorityRevision:previousRevision, rawNodes:input.previous.nodes, runtimeByTransition:previousRuntime });
    previousById = new Map(previousTransitions.map((item) => [item.id, item]));
    const currentIds = new Set(current.map((item) => item.id));
    removed = previousTransitions.filter((item) => !currentIds.has(item.id)).map((item) => item.id);
  }

  const transitions = current.map((item) => Object.freeze({
    ...item,
    changed: input.previous === undefined || input.previous === null
      ? Object.freeze({ value:false, from_authority_revision:null, facts:Object.freeze([]) })
      : changeFor(item, previousById.get(item.id), previousRevision),
  }));
  const changed = transitions.filter((item) => item.changed.value).map((item) => item.id);
  const added = transitions.filter((item) => item.changed.facts.includes('added')).map((item) => item.id);
  const highestImpactBlockers = transitions.filter((item) => item.status !== 'done' && item.impact.count > 0).sort((a,b) => b.impact.count - a.impact.count || a.id.localeCompare(b.id)).map((item) => item.id);
  return Object.freeze({
    schema:'project-explanation-v1', project_ref:projectRef, authority_revision:authorityRevision, transitions:Object.freeze(transitions),
    summary:Object.freeze({
      ready:Object.freeze(transitions.filter((item) => item.status === 'ready').map((item) => item.id)),
      working:Object.freeze(transitions.filter((item) => item.status === 'working').map((item) => item.id)),
      waiting:Object.freeze(transitions.filter((item) => item.status === 'waiting').map((item) => item.id)),
      blocked:Object.freeze(transitions.filter((item) => item.status === 'blocked').map((item) => item.id)),
      done:Object.freeze(transitions.filter((item) => item.status === 'done').map((item) => item.id)),
      changed:Object.freeze(changed),
      added:Object.freeze(added),
      removed:Object.freeze(uniqueSorted(removed)),
      highest_impact_blockers:Object.freeze(highestImpactBlockers),
    }),
  });
}

export function queryProjectExplanation(input = {}, query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) fail('PROJECT_EXPLANATION_QUERY_INVALID', 'query must be an object');
  const kind = text(query.kind, 'query.kind').toLowerCase();
  const allowed = kind === 'transition' ? new Set(['kind','transition_id']) : new Set(['kind']);
  const unknown = Object.keys(query).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('PROJECT_EXPLANATION_QUERY_INVALID', 'query contains unknown fields', { unknown });
  const explanation = deriveProjectExplanation(input);
  if (kind === 'project') {
    return Object.freeze({
      schema:'project-explanation-query-v1',
      query:Object.freeze({ kind:'project' }),
      project_ref:explanation.project_ref,
      authority_revision:explanation.authority_revision,
      result:explanation.summary,
    });
  }
  if (kind === 'transition') {
    const transitionId = text(query.transition_id, 'query.transition_id');
    const result = explanation.transitions.find((item) => item.id === transitionId);
    if (!result) fail('PROJECT_EXPLANATION_SUBJECT_NOT_FOUND', 'transition is not present at the exact project authority revision', { transition_id:transitionId, authority_revision:explanation.authority_revision });
    return Object.freeze({
      schema:'project-explanation-query-v1',
      query:Object.freeze({ kind:'transition', transition_id:transitionId }),
      project_ref:explanation.project_ref,
      authority_revision:explanation.authority_revision,
      result,
    });
  }
  fail('PROJECT_EXPLANATION_QUERY_INVALID', 'query.kind is unsupported', { kind });
}
