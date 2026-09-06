import { assertExactObligationAuthorityCoordinate } from './project-obligation-contract.js';
import { OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION } from './outcome-integrity-semantic-mutation-benchmark.js';

export { OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION };

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}
function array(value) { return Array.isArray(value) ? value : []; }
function strings(value) { return array(value).filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()); }
function finding(code, subject, details = {}) { return Object.freeze({ code, subject, objective:true, ...details }); }

function detectCycle(edges) {
  const adjacency = new Map();
  for (const edge of array(edges)) {
    if (!Array.isArray(edge) || edge.length < 2) continue;
    for (let i = 0; i < edge.length - 1; i += 1) {
      const from = String(edge[i]); const to = String(edge[i + 1]);
      if (!adjacency.has(from)) adjacency.set(from, []);
      adjacency.get(from).push(to);
    }
  }
  const visiting = new Set(), visited = new Set();
  function walk(node) {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) || []) if (walk(next)) return true;
    visiting.delete(node); visited.add(node); return false;
  }
  return [...adjacency.keys()].some(walk);
}

function deterministicFindings(graph) {
  const obligations = array(graph.obligations);
  const ids = new Set(obligations.map((item) => String(item?.id || '')).filter(Boolean));
  const producers = new Map();
  for (const obligation of obligations) for (const claim of strings(obligation?.produces)) {
    if (!producers.has(claim)) producers.set(claim, []);
    producers.get(claim).push(String(obligation.id));
  }
  const root = String(graph.root_claim || '');
  const findings = [];
  for (const obligation of obligations) {
    const id = String(obligation?.id || '');
    for (const required of strings(obligation?.requires)) if (!ids.has(required)) findings.push(finding('MISSING_REQUIRED_OBLIGATION', id, { requirement:required }));
    for (const consumed of strings(obligation?.consumes)) if (!producers.has(consumed)) findings.push(finding('MISSING_PRODUCER', id, { claim:consumed }));
    if (strings(obligation?.evidence_bindings).length === 0) findings.push(finding('MISSING_EVIDENCE_BINDING', id));
    const produces = strings(obligation?.produces);
    const contributes = produces.includes(root) || strings(obligation?.consumes).length > 0 || obligations.some((other) => strings(other?.requires).includes(id));
    if (!contributes) findings.push(finding('ORPHAN_WORK', id));
  }
  for (const assumption of array(graph.assumptions)) {
    if (!String(assumption?.owner || '').trim()) findings.push(finding('UNOWNED_ASSUMPTION', String(assumption?.id || 'unknown')));
  }
  if (detectCycle(graph.argument)) findings.push(finding('SEMANTIC_JUSTIFICATION_CYCLE', root || 'root'));
  if (root && !producers.has(root)) findings.push(finding('ROOT_OUTCOME_HAS_NO_PRODUCER', root));
  return Object.freeze(findings);
}

function deriveArgumentSteps(graph) {
  return Object.freeze(array(graph.argument).filter(Array.isArray).map((edge, index) => Object.freeze({ index, premises:Object.freeze(edge.slice(0, -1).map(String)), conclusion:String(edge.at(-1) || '') })));
}

export function inspectOutcomeIntegrity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('OUTCOME_INTEGRITY_INPUT_INVALID', 'input must be an object');
  const projectRef = String(input.project_ref || '').trim();
  if (!/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(projectRef)) fail('OUTCOME_INTEGRITY_PROJECT_INVALID', 'project_ref must be a GitHub project identity');
  const authority = assertExactObligationAuthorityCoordinate(input.authority);
  const graphIdentity = String(input.graph_semantic_identity || '').trim();
  if (!graphIdentity) fail('OUTCOME_INTEGRITY_GRAPH_IDENTITY_REQUIRED', 'graph semantic identity is required');
  const horizon = input.selected_horizon && typeof input.selected_horizon === 'object' ? structuredClone(input.selected_horizon) : null;
  if (!horizon || !String(horizon.root || '').trim()) fail('OUTCOME_INTEGRITY_HORIZON_REQUIRED', 'selected horizon/root is required');
  const graph = input.graph && typeof input.graph === 'object' ? input.graph : {};
  const root = String(graph.root_claim || horizon.root || '').trim();
  const objective = deterministicFindings({ ...graph, root_claim:root });
  const argumentSteps = deriveArgumentSteps(graph);
  const rootProduced = array(graph.obligations).some((item) => strings(item?.produces).includes(root));
  const counterexamples = [];
  const defeaters = [];
  if (!rootProduced) {
    counterexamples.push(Object.freeze({ kind:'all_declared_work_succeeds_root_unestablished', root_claim:root, construction:'Assume every declared obligation succeeds exactly as written; no declared producer establishes the selected root claim.' }));
    defeaters.push(Object.freeze({ claim:root, reason:'declared obligation closure does not establish the root outcome' }));
  }
  const unresolved = [];
  if (!rootProduced) unresolved.push(Object.freeze({ claim:root, kind:'root_outcome_witness_required' }));
  for (const assumption of array(graph.assumptions)) if (!String(assumption?.owner || '').trim()) unresolved.push(Object.freeze({ claim:String(assumption?.id || ''), kind:'assumption_ownership_required' }));
  return Object.freeze({
    schema:'outcome-integrity-inspection-v0',
    review_contract_version:OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION,
    project_ref:projectRef,
    authority,
    graph_semantic_identity:graphIdentity,
    selected_horizon:Object.freeze(horizon),
    mutation_authority:'none',
    execution_gate:objective.length ? 'blocked_by_objective_violation' : 'not_blocked_by_deterministic_analysis',
    objective_violations:objective,
    positive_derivation:Object.freeze({ root_claim:root, argument_steps:argumentSteps }),
    falsification:Object.freeze({ counterexamples:Object.freeze(counterexamples), defeaters:Object.freeze(defeaters) }),
    unresolved_proof_obligations:Object.freeze(unresolved),
    reasoning_review:Object.freeze({
      authoritative:false,
      repair_authority:'project.authoring',
      findings:Object.freeze([]),
      argument_steps:argumentSteps,
      counterexamples:Object.freeze(counterexamples),
      defeaters:Object.freeze(defeaters),
      unresolved_proof_obligations:Object.freeze(unresolved),
    }),
  });
}

export function assertOutcomeIntegrityReviewCurrent(review, currentAuthority) {
  if (!review || review.schema !== 'outcome-integrity-inspection-v0') fail('OUTCOME_INTEGRITY_REVIEW_INVALID', 'inspection report is required');
  const current = assertExactObligationAuthorityCoordinate(currentAuthority);
  const observed = review.authority || {};
  if (observed.kind !== current.kind || observed.repository !== current.repository || observed.revision !== current.revision || observed.derivation !== current.derivation) {
    fail('OUTCOME_INTEGRITY_REVIEW_STALE', 'authority coordinate changed after review');
  }
  return review;
}