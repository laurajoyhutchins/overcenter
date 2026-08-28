import { evaluateProjectGraph } from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

export const OVERCENTER_PROJECT_GRAPH_DERIVATION = 'overcenter-project-graph-v1';
export const OVERCENTER_PROJECT_DEFINITION_PATH = '.overcenter/definitions/target-architecture.json';
const DEFINITION_SCHEMA = 'overcenter-project-definition-v1';

function fail(message, details = null) {
  const error = new Error(message);
  error.code = 'OVERCENTER_PROJECT_GRAPH_DERIVATION_INVALID';
  error.details = details;
  throw error;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(`${field} must be a non-empty string`, { field });
  return normalized;
}

function exactKeys(value, supported, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`, { field });
  const observed = Object.keys(value).sort();
  const expected = [...supported].sort();
  if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
    fail(`${field} contains unsupported fields`, { field, fields:observed });
  }
}

function lifecycle() {
  return Object.freeze({
    current_stage:'ENABLE',
    condition:'NOMINAL',
    responsibilities:Object.freeze(Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [
      stage,
      Object.freeze({ applicable:true, satisfied:false }),
    ]))),
  });
}

function executor(input, index) {
  const kind = text(input?.kind, `transitions[${index}].executor.kind`).toLowerCase();
  if (kind === 'agent') {
    exactKeys(input, ['kind','role','skill'], `transitions[${index}].executor`);
    return Object.freeze({ kind, role:text(input.role, 'executor.role'), skill:text(input.skill, 'executor.skill') });
  }
  if (kind === 'operator') {
    exactKeys(input, ['command','kind'], `transitions[${index}].executor`);
    return Object.freeze({ kind, command:text(input.command, 'executor.command') });
  }
  fail('executor.kind must be agent or operator', { index, kind });
}

function transition(input, index) {
  exactKeys(input, ['executor','id','priority','requires'], `transitions[${index}]`);
  const id = text(input.id, `transitions[${index}].id`);
  if (!Number.isInteger(input.priority)) fail('transition priority must be an integer', { id, priority:input.priority });
  if (!Array.isArray(input.requires)) fail('transition requires must be an array', { id });
  const requires = input.requires.map((value, i) => text(value, `transitions[${index}].requires[${i}]`));
  if (new Set(requires).size !== requires.length) fail('transition requires contains duplicates', { id });
  return Object.freeze({ id, priority:input.priority, requires:Object.freeze(requires), lifecycle:lifecycle(), executor:executor(input.executor, index), phase_bindings:Object.freeze({}) });
}

function definitionFacts(facts, authority) {
  const definitions = facts?.definition_facts ?? facts;
  if (!definitions || definitions.schema !== 'project-definition-facts-v1') fail('exact project definition facts are required');
  if (definitions.repository !== authority.repository || String(definitions.revision || '').toLowerCase() !== authority.revision) {
    fail('project definition facts do not match exact authority');
  }
  const selected = (Array.isArray(definitions.definitions) ? definitions.definitions : []).filter((entry) => entry?.path === OVERCENTER_PROJECT_DEFINITION_PATH);
  if (selected.length !== 1) fail('exactly one Overcenter target architecture definition is required', { observed:selected.length });
  return selected[0];
}

function parseDefinition(entry) {
  let parsed;
  try { parsed = JSON.parse(text(entry?.content, 'definition.content')); }
  catch { fail('Overcenter target architecture definition must be valid JSON'); }
  exactKeys(parsed, ['project_ref','schema','transitions'], 'definition');
  if (parsed.schema !== DEFINITION_SCHEMA) fail('Overcenter target architecture definition schema is unsupported', { schema:parsed.schema ?? null });
  if (!Array.isArray(parsed.transitions) || parsed.transitions.length < 1 || parsed.transitions.length > 100) fail('definition.transitions must contain between 1 and 100 transitions');
  return parsed;
}

export function deriveOvercenterProjectGraph(input = {}) {
  const projectRef = text(input?.project_ref, 'project_ref');
  const authority = input?.authority;
  if (!authority || String(authority.kind || '').toLowerCase() !== 'github') fail('Overcenter project definition authority must be GitHub');
  const repository = text(authority.repository, 'authority.repository');
  const revision = text(authority.revision, 'authority.revision').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) fail('authority.revision must be a full Git commit SHA');
  if (text(authority.derivation, 'authority.derivation') !== OVERCENTER_PROJECT_GRAPH_DERIVATION) fail('authority derivation contract is unsupported');

  const definition = parseDefinition(definitionFacts(input.facts, { repository, revision }));
  if (definition.project_ref !== projectRef) fail('definition project_ref does not match requested project authority');
  const nodes = definition.transitions.map(transition).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) fail('transition ids must be unique');
  const graph = Object.freeze({ nodes:Object.freeze(nodes) });
  evaluateProjectGraph(graph);
  return graph;
}
