import { canonicalJson, sha256Text } from './canonical-json.js';
import { evaluateProjectGraph } from './project-graph.js';
import { projectTransitionDefinitionFingerprint } from './project-transition-observations.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field, max = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) fail('COMPATIBILITY_TRANSITION_CONFIRMATION_INVALID', `${field} is invalid`, { field });
  return normalized;
}

function exactInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('COMPATIBILITY_TRANSITION_CONFIRMATION_INVALID', 'request must be an object');
  const unknown = Object.keys(input).filter((key) => !['run_id', 'work_ref', 'lease_ref'].includes(key)).sort();
  if (unknown.length) fail('COMPATIBILITY_TRANSITION_CONFIRMATION_INVALID', 'request contains unsupported fields', { unsupported_fields: unknown });
  return Object.freeze({
    run_id: text(input.run_id, 'run_id'),
    work_ref: text(input.work_ref, 'work_ref', 128),
    lease_ref: text(input.lease_ref, 'lease_ref', 128),
  });
}

function bindingFacts(value, workRef) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('COMPATIBILITY_TRANSITION_BINDING_NOT_FOUND', 'compatibility work has no explicit project-transition binding', { work_ref: workRef });
  }
  return Object.freeze({
    project_ref: text(value.project_ref, 'binding.project_ref'),
    transition_id: text(value.transition_id, 'binding.transition_id', 256),
    authority_issue: text(value.authority_issue, 'binding.authority_issue', 512),
  });
}

function completedFacts(value, workRef) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true || value.confirm_complete !== true) {
    fail('COMPATIBILITY_WORK_NOT_CONFIRMED', 'compatibility work is not durably complete through CONFIRM', { work_ref: workRef });
  }
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  if (evidence.length === 0) fail('COMPATIBILITY_WORK_EVIDENCE_REQUIRED', 'compatibility completion requires durable evidence', { work_ref: workRef });
  return Object.freeze({
    settlement_ref: text(value.settlement_ref, 'compatibility_work.settlement_ref', 128),
    evidence: Object.freeze(evidence.map((entry) => Object.freeze({ ...entry }))),
  });
}

function graphNode(graph, binding) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || graph.schema !== 'project-graph-authority-v1' || graph.project_ref !== binding.project_ref) {
    fail('COMPATIBILITY_PROJECT_GRAPH_INVALID', 'authoritative project graph does not match the explicit compatibility binding', { project_ref: binding.project_ref });
  }
  const evaluated = evaluateProjectGraph(graph);
  const selected = evaluated.nodes.find((node) => node.id === binding.transition_id) || null;
  if (!selected) fail('COMPATIBILITY_TRANSITION_NOT_FOUND', 'bound project transition is missing from the authoritative graph', { transition_id: binding.transition_id });
  return Object.freeze({ evaluated, selected, definition: graph.nodes.find((node) => node.id === binding.transition_id) || null });
}

export function createCompatibilityTransitionConfirmationService({ bindings, compatibilityWork, readProjectGraph, projectTransitions } = {}) {
  if (!bindings || typeof bindings.resolve !== 'function') throw new TypeError('bindings.resolve is required');
  if (!compatibilityWork || typeof compatibilityWork.requireCompleted !== 'function') throw new TypeError('compatibilityWork.requireCompleted is required');
  if (typeof readProjectGraph !== 'function') throw new TypeError('readProjectGraph is required');
  if (!projectTransitions || typeof projectTransitions.require !== 'function' || typeof projectTransitions.settle !== 'function') {
    throw new TypeError('projectTransitions require/settle are required');
  }

  async function confirm(rawInput = {}) {
    const input = exactInput(rawInput);
    const binding = bindingFacts(await bindings.resolve({ work_ref: input.work_ref }), input.work_ref);
    const completed = completedFacts(await compatibilityWork.requireCompleted({ work_ref: input.work_ref, binding }), input.work_ref);
    const graph = await readProjectGraph(Object.freeze({ project_ref: binding.project_ref }));
    const observed = graphNode(graph, binding);
    if (!observed.definition) fail('COMPATIBILITY_TRANSITION_NOT_FOUND', 'bound transition definition is unavailable', { transition_id: binding.transition_id });
    const fingerprint = await projectTransitionDefinitionFingerprint(observed.definition);

    if (observed.selected.state === 'DONE') {
      return Object.freeze({ ok:true, outcome:'already_confirmed', work_ref:input.work_ref, binding, transition_definition_fingerprint:fingerprint, compatibility_settlement_ref:completed.settlement_ref, frontier:observed.evaluated.frontier });
    }
    if (observed.selected.state !== 'READY') {
      fail('COMPATIBILITY_TRANSITION_NOT_READY', 'bound transition is not READY in the authoritative graph', { transition_id:binding.transition_id, state:observed.selected.state });
    }

    const authority = graph.authority?.definition || null;
    const lease = await projectTransitions.require({
      lease_ref:input.lease_ref,
      run_id:input.run_id,
      project_ref:binding.project_ref,
      transition_id:binding.transition_id,
      repository:authority?.repository || undefined,
    });
    if (lease.transition_definition_fingerprint !== fingerprint) {
      fail('COMPATIBILITY_TRANSITION_AUTHORITY_CHANGED', 'transition definition changed during compatibility confirmation authority validation', { transition_id:binding.transition_id });
    }

    const identity = await sha256Text(canonicalJson({
      schema:'compatibility-transition-confirmation-v1',
      run_id:input.run_id,
      work_ref:input.work_ref,
      lease_ref:input.lease_ref,
      compatibility_settlement_ref:completed.settlement_ref,
      binding,
      authority,
      transition_definition_fingerprint:fingerprint,
    }));
    const settlement = await projectTransitions.settle({
      lease_ref:lease.lease_ref,
      run_id:input.run_id,
      disposition:'completed',
      idempotency_key:`compatibility-transition-settle:${identity}`,
    });

    const refreshed = await readProjectGraph(Object.freeze({ project_ref:binding.project_ref }));
    const confirmed = graphNode(refreshed, binding);
    const refreshedDefinition = confirmed.definition;
    if (!refreshedDefinition || await projectTransitionDefinitionFingerprint(refreshedDefinition) !== fingerprint) {
      fail('COMPATIBILITY_TRANSITION_AUTHORITY_CHANGED', 'transition definition changed before compatibility confirmation readback', { transition_id:binding.transition_id });
    }
    if (confirmed.selected.state !== 'DONE') {
      fail('COMPATIBILITY_TRANSITION_NOT_CONFIRMED', 'normal project-transition settlement did not project DONE onto the authoritative graph', { transition_id:binding.transition_id, state:confirmed.selected.state });
    }
    return Object.freeze({
      ok:true,
      outcome:'confirmed',
      work_ref:input.work_ref,
      binding,
      transition_definition_fingerprint:fingerprint,
      compatibility_settlement_ref:completed.settlement_ref,
      lease_ref:lease.lease_ref,
      settled_at:settlement.settled_at || null,
      frontier:confirmed.evaluated.frontier,
    });
  }

  return Object.freeze({ confirm });
}

export function statusForCompatibilityTransitionConfirmationError(error) {
  const code = String(error?.code || '');
  if (code === 'COMPATIBILITY_TRANSITION_CONFIRMATION_INVALID') return 400;
  if (code.endsWith('_UNAVAILABLE')) return 503;
  if (code.startsWith('COMPATIBILITY_') || code.startsWith('PROJECT_TRANSITION_') || code.startsWith('PROJECT_GRAPH_')) return 409;
  return null;
}