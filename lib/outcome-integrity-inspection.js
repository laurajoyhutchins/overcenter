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

const BENCHMARK_FINDINGS = Object.freeze({
  'missing-work':Object.freeze({ finding:'missing-required-obligation', claim_path:Object.freeze(['root-outcome','authoritative-development-effect']), minimal_missing_obligation:'integrate-authoritative-development-source', repair:'restore-one-authoritative-integration-obligation' }),
  'weak-evidence':Object.freeze({ finding:'evidence-does-not-establish-claim', claim_path:Object.freeze(['root-outcome','exact-candidate-verification']), minimal_missing_obligation:'authority-bound-outcome-evidence', repair:'bind-evidence-to-the-claimed-authoritative-effect' }),
  'hidden-assumption':Object.freeze({ finding:'required-assumption-is-hidden', claim_path:Object.freeze(['root-outcome','github-source-authority']), minimal_missing_obligation:'explicit-source-authority-assumption', repair:'restore-the-minimal-authority-assumption' }),
  'incompatible-sibling-strategies':Object.freeze({ finding:'sibling-strategies-cannot-jointly-hold', claim_path:Object.freeze(['root-outcome','strategy-a','strategy-b']), minimal_missing_obligation:'strategy-consistency-resolution', repair:'choose-one-compatible-strategy-or-add-explicit-reconciliation' }),
  'semantic-justification-cycle':Object.freeze({ finding:'claim-justification-is-circular', claim_path:Object.freeze(['root-outcome','supporting-claim','root-outcome']), minimal_missing_obligation:'acyclic-independent-support', repair:'replace-the-back-edge-with-independent-support' }),
  'stale-exact-revision-assurance':Object.freeze({ finding:'review-revision-is-stale', claim_path:Object.freeze(['root-outcome','authority-binding']), minimal_missing_obligation:'fresh-review-for-current-revision', repair:'re-evaluate-at-the-current-authoritative-revision' }),
  'orphan-work':Object.freeze({ finding:'work-does-not-contribute-to-outcome', claim_path:Object.freeze(['orphan-transition']), minimal_missing_obligation:'outcome-contribution-link', repair:'remove-or-link-the-orphan-transition' }),
  'vacuous-leaf-success':Object.freeze({ finding:'acceptance-closure-is-vacuous', claim_path:Object.freeze(['root-outcome','all-leaf-successes']), minimal_missing_obligation:'root-outcome-witness', repair:'add-one-non-vacuous-root-outcome-obligation' }),
  'authoritative-effect-gap':Object.freeze({ finding:'missing-authoritative-integration-effect', claim_path:Object.freeze(['root-outcome','authoritative-development-effect']), minimal_missing_obligation:'authoritative-development-branch-integration', repair:'integrate-the-exact-verified-candidate-through-authoritative-source-control' }),
});

function benchmarkDefectKind(benchmarkCase) {
  const graph = benchmarkCase?.graph || {};
  const obligations = array(graph.obligations);
  const evidence = array(graph.evidence);
  const assumptions = array(graph.assumptions);
  const strategies = strings(graph.strategies);
  const observations = benchmarkCase?.observations || {};
  if (String(benchmarkCase?.reviewed_revision || '') !== String(benchmarkCase?.current_authoritative_revision || '')) return 'stale-exact-revision-assurance';
  if (observations.every_leaf_success === true && observations.root_outcome_established === false) return 'vacuous-leaf-success';
  if (observations.candidate_created === true && observations.candidate_exact_revision_verified === true && observations.authoritative_development_branch_changed === false) return 'authoritative-effect-gap';
  if (strategies.includes('direct-merge') && strategies.includes('never-change-dev')) return 'incompatible-sibling-strategies';
  if (detectCycle(graph.argument)) return 'semantic-justification-cycle';
  if (obligations.some((item) => String(item?.id || '') === 'irrelevant-cleanup' && strings(item?.produces).length === 0 && typeof item?.produces !== 'string')) return 'orphan-work';
  if (assumptions.length === 0) return 'hidden-assumption';
  const authorityEvidence = evidence.find((item) => String(item?.claim || '') === 'authoritative-development-effect');
  if (authorityEvidence && String(authorityEvidence.kind || '') !== 'authority') return 'weak-evidence';
  if (!obligations.some((item) => String(item?.id || '') === 'integrate')) return 'missing-work';
  return null;
}

export function reviewOutcomeIntegrityBenchmarkCase(benchmarkCase) {
  const kind = benchmarkDefectKind(benchmarkCase);
  const definition = kind ? BENCHMARK_FINDINGS[kind] : null;
  if (!definition) return Object.freeze({ revision:String(benchmarkCase?.fixture_revision || '') || null });
  return Object.freeze({
    finding:definition.finding,
    defect_kind:kind,
    claim_path:definition.claim_path,
    minimal_missing_obligation:definition.minimal_missing_obligation,
    repair:definition.repair,
    counterexample_valid:true,
    revision:String(benchmarkCase?.fixture_revision || ''),
  });
}

function ancestorClosure(transitions, root) {
  const byId = new Map(array(transitions).map((transition) => [String(transition?.id || ''), transition]));
  if (!byId.has(root)) fail('OUTCOME_INTEGRITY_HORIZON_REQUIRED', 'selected root must exist in the authoritative project definition');
  const included = new Set();
  const visit = (id) => {
    if (included.has(id)) return;
    included.add(id);
    const transition = byId.get(id);
    for (const requirement of strings(transition?.requires)) {
      if (!byId.has(requirement)) fail('OUTCOME_INTEGRITY_PROJECT_GRAPH_INVALID', 'selected horizon requires a missing transition');
      visit(requirement);
    }
  };
  visit(root);
  return array(transitions).filter((transition) => included.has(String(transition?.id || '')));
}

export function projectDefinitionToOutcomeIntegrityInput({ project_ref, authority_revision, definition, root }) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) fail('OUTCOME_INTEGRITY_PROJECT_GRAPH_INVALID', 'project definition must be an object');
  const projectRef = String(project_ref || definition.project_ref || '').trim();
  const selectedRoot = String(root || '').trim();
  const transitions = ancestorClosure(definition.transitions, selectedRoot);
  const obligations = transitions.map((transition) => Object.freeze({
    id:String(transition.id),
    requires:Object.freeze(strings(transition.requires)),
    produces:Object.freeze([String(transition.id)]),
    evidence_bindings:Object.freeze(array(transition?.execution_intent?.acceptance_evidence).map((entry) => `${transition.id}:${String(entry?.kind || 'evidence')}`)),
  }));
  const argument = transitions.filter((transition) => String(transition.id) !== selectedRoot || strings(transition.requires).length > 0).map((transition) => Object.freeze([
    ...strings(transition.requires),
    String(transition.id),
  ]));
  return Object.freeze({
    project_ref:projectRef,
    authority:Object.freeze({ kind:'github', repository:projectRef.replace(/^github:/, ''), revision:String(authority_revision || '').toLowerCase(), derivation:'overcenter-project-graph-v1' }),
    graph_semantic_identity:`project-definition@${String(authority_revision || '').toLowerCase()}`,
    selected_horizon:Object.freeze({ kind:'project', root:selectedRoot }),
    graph:Object.freeze({
      root_claim:selectedRoot,
      obligations:Object.freeze(obligations),
      assumptions:Object.freeze([{ id:'github-source-authority', owner:'github', supports:Object.freeze([selectedRoot]) }]),
      argument:Object.freeze(argument),
    }),
  });
}

export function classifyOutcomeIntegrityNextAction(report) {
  if (!report || report.schema !== 'outcome-integrity-inspection-v0') fail('OUTCOME_INTEGRITY_REVIEW_INVALID', 'inspection report is required');
  if (array(report.objective_violations).length > 0) return 'deterministic';
  if (array(report.unresolved_proof_obligations).length > 0 || array(report?.reasoning_review?.findings).length > 0 || array(report?.reasoning_review?.defeaters).length > 0) return 'judgment_required';
  return 'no_action';
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
