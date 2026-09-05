export const OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION = 'outcome-integrity-v0';

function requireRevision(revision) {
  if (!/^[0-9a-f]{40}$/i.test(String(revision || ''))) {
    throw new TypeError('fixture revision must be an exact 40-character Git revision');
  }
  return revision.toLowerCase();
}

function score(matches, total) {
  return total === 0 ? 1 : matches / total;
}

function clone(value) {
  return structuredClone(value);
}

export function createKnownGoodFixture({ revision }) {
  const exactRevision = requireRevision(revision);
  return Object.freeze({
    schema: 'outcome-integrity-benchmark-fixture-v1',
    revision: exactRevision,
    review_contract_version: OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION,
    root_claim: 'the requested project outcome is established on authoritative development source',
    structurally_valid: true,
    graph: {
      obligations: [
        { id: 'implement', produces: 'candidate-implementation' },
        { id: 'verify', requires: ['implement'], produces: 'exact-candidate-verification' },
        { id: 'integrate', requires: ['verify'], produces: 'authoritative-development-effect' },
      ],
      assumptions: [{ id: 'github-source-authority', authority: `github@${exactRevision}` }],
      argument: [
        ['candidate-implementation', 'exact-candidate-verification', 'authoritative-development-effect'],
        ['authoritative-development-effect', 'root-outcome'],
      ],
      evidence: [
        { claim: 'exact-candidate-verification', subject_revision: exactRevision, kind: 'test' },
        { claim: 'authoritative-development-effect', subject_revision: exactRevision, kind: 'authority' },
      ],
    },
  });
}

const MUTATIONS = Object.freeze([
  {
    kind: 'missing-work',
    operation: 'delete-required-obligation',
    required_finding: 'missing-required-obligation',
    claim_path: ['root-outcome', 'authoritative-development-effect'],
    minimal_missing_obligation: 'integrate-authoritative-development-source',
    minimal_repair: 'restore-one-authoritative-integration-obligation',
  },
  {
    kind: 'weak-evidence',
    operation: 'weaken-acceptance-evidence',
    required_finding: 'evidence-does-not-establish-claim',
    claim_path: ['root-outcome', 'exact-candidate-verification'],
    minimal_missing_obligation: 'authority-bound-outcome-evidence',
    minimal_repair: 'bind-evidence-to-the-claimed-authoritative-effect',
  },
  {
    kind: 'hidden-assumption',
    operation: 'remove-authoritative-assumption',
    required_finding: 'required-assumption-is-hidden',
    claim_path: ['root-outcome', 'github-source-authority'],
    minimal_missing_obligation: 'explicit-source-authority-assumption',
    minimal_repair: 'restore-the-minimal-authority-assumption',
  },
  {
    kind: 'incompatible-sibling-strategies',
    operation: 'introduce-typed-contradiction',
    required_finding: 'sibling-strategies-cannot-jointly-hold',
    claim_path: ['root-outcome', 'strategy-a', 'strategy-b'],
    minimal_missing_obligation: 'strategy-consistency-resolution',
    minimal_repair: 'choose-one-compatible-strategy-or-add-explicit-reconciliation',
  },
  {
    kind: 'semantic-justification-cycle',
    operation: 'introduce-semantic-cycle',
    required_finding: 'claim-justification-is-circular',
    claim_path: ['root-outcome', 'supporting-claim', 'root-outcome'],
    minimal_missing_obligation: 'acyclic-independent-support',
    minimal_repair: 'replace-the-back-edge-with-independent-support',
  },
  {
    kind: 'stale-exact-revision-assurance',
    operation: 'change-reviewed-revision',
    required_finding: 'review-revision-is-stale',
    claim_path: ['root-outcome', 'authority-binding'],
    minimal_missing_obligation: 'fresh-review-for-current-revision',
    minimal_repair: 're-evaluate-at-the-current-authoritative-revision',
  },
  {
    kind: 'orphan-work',
    operation: 'insert-irrelevant-work',
    required_finding: 'work-does-not-contribute-to-outcome',
    claim_path: ['orphan-transition'],
    minimal_missing_obligation: 'outcome-contribution-link',
    minimal_repair: 'remove-or-link-the-orphan-transition',
  },
  {
    kind: 'vacuous-leaf-success',
    operation: 'make-all-leaves-pass-with-root-false',
    required_finding: 'acceptance-closure-is-vacuous',
    claim_path: ['root-outcome', 'all-leaf-successes'],
    minimal_missing_obligation: 'root-outcome-witness',
    minimal_repair: 'add-one-non-vacuous-root-outcome-obligation',
  },
  {
    kind: 'authoritative-effect-gap',
    operation: 'remove-authoritative-effect-after-verified-candidate',
    required_finding: 'missing-authoritative-integration-effect',
    claim_path: ['root-outcome', 'authoritative-development-effect'],
    minimal_missing_obligation: 'authoritative-development-branch-integration',
    minimal_repair: 'integrate-the-exact-verified-candidate-through-authoritative-source-control',
  },
]);

function changedRevision(revision) {
  return `${revision.slice(0, 39)}${revision.endsWith('0') ? '1' : '0'}`;
}

function mutateGraph(graph, kind) {
  const mutated = clone(graph);
  if (kind === 'missing-work') {
    mutated.obligations = mutated.obligations.filter((item) => item.id !== 'integrate');
  } else if (kind === 'weak-evidence') {
    mutated.evidence = mutated.evidence.map((item) => item.claim === 'authoritative-development-effect'
      ? { ...item, kind: 'adjacent-test', claim: 'authoritative-development-effect' }
      : item);
  } else if (kind === 'hidden-assumption') {
    mutated.assumptions = [];
  } else if (kind === 'incompatible-sibling-strategies') {
    mutated.strategies = ['direct-merge', 'never-change-dev'];
  } else if (kind === 'semantic-justification-cycle') {
    mutated.argument.push(['root-outcome', 'supporting-claim']);
    mutated.argument.push(['supporting-claim', 'root-outcome']);
  } else if (kind === 'orphan-work') {
    mutated.obligations.push({ id: 'irrelevant-cleanup' });
  } else if (kind === 'authoritative-effect-gap') {
    mutated.evidence = mutated.evidence.filter((item) => item.claim !== 'authoritative-development-effect');
  }
  return mutated;
}

function observationsFor(kind, revision) {
  if (kind === 'authoritative-effect-gap') return {
    candidate_created: true,
    candidate_exact_revision_verified: true,
    authoritative_development_branch_changed: false,
    candidate_revision: revision,
    authoritative_revision: revision,
  };
  if (kind === 'vacuous-leaf-success') return {
    every_leaf_success: true,
    root_outcome_established: false,
  };
  return {};
}

export function deriveSemanticMutants(fixture) {
  if (!fixture || fixture.schema !== 'outcome-integrity-benchmark-fixture-v1' || fixture.structurally_valid !== true) {
    throw new TypeError('known-good outcome-integrity fixture is required');
  }
  return MUTATIONS.map((mutation) => {
    const currentAuthoritativeRevision = mutation.kind === 'stale-exact-revision-assurance'
      ? changedRevision(fixture.revision)
      : fixture.revision;
    return {
      schema: 'outcome-integrity-semantic-mutant-v1',
      id: `semantic-mutant:${mutation.kind}`,
      fixture_revision: fixture.revision,
      review_contract_version: fixture.review_contract_version,
      reviewed_revision: fixture.revision,
      current_authoritative_revision: currentAuthoritativeRevision,
      structurally_valid: true,
      graph: mutateGraph(fixture.graph, mutation.kind),
      mutation: { operation: mutation.operation },
      observations: observationsFor(mutation.kind, fixture.revision),
      expected_defect: {
        kind: mutation.kind,
        required_finding: mutation.required_finding,
        claim_path: clone(mutation.claim_path),
        minimal_missing_obligation: mutation.minimal_missing_obligation,
        minimal_repair: mutation.minimal_repair,
      },
    };
  });
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function evaluateOutcomeIntegrityBenchmark(cases, review) {
  if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('benchmark cases are required');
  if (typeof review !== 'function') throw new TypeError('review function is required');

  const fixtureRevision = cases[0].fixture_revision;
  const contractVersion = cases[0].review_contract_version;
  if (cases.some((item) => item.fixture_revision !== fixtureRevision || item.review_contract_version !== contractVersion)) {
    throw new Error('benchmark cases must share exact fixture revision and review contract version');
  }

  const expectedDefects = cases.filter((item) => item.expected_defect);
  let detected = 0;
  let precise = 0;
  let falseBlockers = 0;
  let counterexamples = 0;
  let claimPaths = 0;
  let missingObligations = 0;
  let minimalRepairs = 0;
  let paraphraseStable = 0;
  let revisionBound = 0;

  for (const benchmarkCase of cases) {
    const result = review(clone(benchmarkCase)) || {};
    const expected = benchmarkCase.expected_defect;
    if (expected) {
      if (result.finding) detected += 1;
      if (result.finding === expected.required_finding && result.defect_kind === expected.kind) precise += 1;
      if (result.counterexample_valid === true) counterexamples += 1;
      if (sameJson(result.claim_path, expected.claim_path)) claimPaths += 1;
      if (result.minimal_missing_obligation === expected.minimal_missing_obligation) missingObligations += 1;
      if (result.repair === expected.minimal_repair) minimalRepairs += 1;
    } else if (result.finding) {
      falseBlockers += 1;
    }
    if (result.revision === benchmarkCase.fixture_revision) revisionBound += 1;

    const paraphrased = clone(benchmarkCase);
    paraphrased.paraphrase_variant = true;
    const paraphrasedResult = review(paraphrased) || {};
    if (paraphrasedResult.finding === result.finding && paraphrasedResult.defect_kind === result.defect_kind) paraphraseStable += 1;
  }

  const cleanCases = cases.length - expectedDefects.length;
  return {
    schema: 'outcome-integrity-benchmark-report-v1',
    fixture_revision: fixtureRevision,
    review_contract_version: contractVersion,
    case_count: cases.length,
    metrics: {
      defect_recall: score(detected, expectedDefects.length),
      finding_precision: score(precise, detected),
      false_blocker_rate: cleanCases === 0 ? 0 : falseBlockers / cleanCases,
      counterexample_validity: score(counterexamples, expectedDefects.length),
      correct_claim_argument_path: score(claimPaths, expectedDefects.length),
      minimal_missing_obligation_accuracy: score(missingObligations, expectedDefects.length),
      repair_minimality: score(minimalRepairs, expectedDefects.length),
      paraphrase_stability: score(paraphraseStable, cases.length),
      revision_binding_correctness: score(revisionBound, cases.length),
    },
  };
}