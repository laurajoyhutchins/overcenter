const SHA40 = /^[0-9a-f]{40}$/;

export const OUTCOME_INTEGRITY_REVIEW_CONTRACT = 'outcome-integrity-v0';
export const OUTCOME_INTEGRITY_BENCHMARK_SCHEMA = 'outcome-integrity-semantic-mutation-benchmark-v0';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requiredText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function exactRevision(value, field = 'fixture_revision') {
  const revision = requiredText(value, field).toLowerCase();
  if (!SHA40.test(revision)) throw new TypeError(`${field} must be an exact Git SHA`);
  return revision;
}

function validateFixture(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('fixture must be an object');
  const fixture = clone(input);
  fixture.fixture_id = requiredText(fixture.fixture_id, 'fixture_id');
  fixture.fixture_revision = exactRevision(fixture.fixture_revision);
  fixture.review_contract_version = requiredText(fixture.review_contract_version, 'review_contract_version');
  if (fixture.review_contract_version !== OUTCOME_INTEGRITY_REVIEW_CONTRACT) {
    throw new TypeError(`review_contract_version must be ${OUTCOME_INTEGRITY_REVIEW_CONTRACT}`);
  }
  fixture.root_claim = requiredText(fixture.root_claim, 'root_claim');
  if (!Array.isArray(fixture.obligations) || fixture.obligations.length < 1) throw new TypeError('fixture obligations are required');
  if (!Array.isArray(fixture.assumptions)) fixture.assumptions = [];
  if (!Array.isArray(fixture.sibling_strategies)) fixture.sibling_strategies = [];
  if (!Array.isArray(fixture.semantic_edges)) fixture.semantic_edges = [];
  return fixture;
}

function finding(id, kind, claim, extras = {}) {
  return Object.freeze({
    finding_id:id,
    kind,
    claim,
    counterexample_valid:extras.counterexample_valid ?? (kind === 'defeater'),
    claim_path_correct:true,
    minimal_missing_obligation:extras.minimal_missing_obligation ?? true,
    repair_minimal:extras.repair_minimal ?? true,
    paraphrase_stable:extras.paraphrase_stable ?? true,
    revision_bound:true,
  });
}

function semanticCase(base, mutationKind, mutate, expectedFindings, extras = {}) {
  const mutated = clone(base);
  mutate(mutated);
  return Object.freeze({
    schema:OUTCOME_INTEGRITY_BENCHMARK_SCHEMA,
    case_id:`${base.fixture_id}:${mutationKind}`,
    mutation_kind:mutationKind,
    fixture_revision:base.fixture_revision,
    review_contract_version:base.review_contract_version,
    structurally_valid:true,
    expected_review_state:extras.expected_review_state || 'UNRESOLVED',
    expected_findings:Object.freeze(expectedFindings),
    observations:Object.freeze(extras.observations || {}),
    fixture:Object.freeze(mutated),
  });
}

export function deriveOutcomeIntegritySemanticMutants(input) {
  const base = validateFixture(input);
  const obligationIds = base.obligations.map((item) => requiredText(item?.id, 'obligation.id'));
  const requiredId = obligationIds.at(-1);
  const firstId = obligationIds[0];
  const secondId = obligationIds[1] || firstId;

  return Object.freeze([
    semanticCase(base, 'missing-work', (fixture) => {
      fixture.obligations = fixture.obligations.filter((item) => item.id !== requiredId);
      fixture.semantic_edges = fixture.semantic_edges.filter((edge) => !edge.includes(requiredId));
    }, [finding('missing-authoritative-integration', 'missing-obligation', base.root_claim)]),

    semanticCase(base, 'weak-adjacent-evidence', (fixture) => {
      const target = fixture.obligations.find((item) => item.id === requiredId) || fixture.obligations[0];
      target.acceptance_evidence = ['candidate-created'];
    }, [finding('adjacent-evidence-does-not-establish-claim', 'evidence-gap', base.root_claim)]),

    semanticCase(base, 'hidden-assumption', (fixture) => {
      fixture.assumptions = [];
    }, [finding('source-authority-assumption-hidden', 'assumption-gap', base.root_claim)]),

    semanticCase(base, 'incompatible-sibling-strategies', (fixture) => {
      fixture.sibling_strategies = [
        { id:'strategy-a', strategy:'integrate-then-deploy' },
        { id:'strategy-b', strategy:'deploy-without-integration' },
      ];
    }, [finding('sibling-strategies-contradict', 'contradiction', base.root_claim)]),

    semanticCase(base, 'semantic-justification-cycle', (fixture) => {
      fixture.semantic_edges.push([requiredId, firstId]);
    }, [finding('semantic-justification-cycle', 'structural-semantic-defect', base.root_claim)]),

    semanticCase(base, 'stale-exact-revision-assurance', (fixture) => {
      fixture.review = {
        authority_revision:'f'.repeat(40),
        review_contract_version:OUTCOME_INTEGRITY_REVIEW_CONTRACT,
        state:'ESTABLISHED',
      };
    }, [finding('review-revision-is-stale', 'authority-gap', base.root_claim)]),

    semanticCase(base, 'orphan-work', (fixture) => {
      fixture.obligations.push({ id:'irrelevant-cleanup', establishes:'unrelated formatting changed', acceptance_evidence:['format-check'] });
    }, [finding('irrelevant-work-has-no-outcome-contribution', 'orphan-work', base.root_claim)]),

    semanticCase(base, 'leaf-success-root-false', (fixture) => {
      fixture.synthetic_outcome = { all_leaf_acceptance:true, root_claim_true:false };
    }, [finding('all-leaves-pass-root-remains-false', 'defeater', base.root_claim, { counterexample_valid:true })]),

    semanticCase(base, 'authoritative-effect-gap', (fixture) => {
      fixture.synthetic_outcome = {
        candidate_created:true,
        exact_candidate_verified:true,
        authoritative_branch_contains_candidate:false,
      };
    }, [
      finding('verified-candidate-not-integrated', 'defeater', base.root_claim, { counterexample_valid:true }),
      finding('missing-authoritative-integration-effect', 'missing-obligation', base.root_claim),
    ], {
      expected_review_state:'UNRESOLVED',
      observations:{
        candidate_created:true,
        exact_candidate_verified:true,
        authoritative_branch_contains_candidate:false,
      },
    }),
  ]);
}

function boundedRatio(numerator, denominator, emptyValue = 1) {
  if (!denominator) return emptyValue;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function findingId(value) {
  return typeof value?.finding_id === 'string' ? value.finding_id : null;
}

export function scoreOutcomeIntegrityBenchmark(input = {}) {
  const cases = Array.isArray(input.cases) ? input.cases : [];
  const findingsByCase = input.findings_by_case && typeof input.findings_by_case === 'object' ? input.findings_by_case : {};
  if (!cases.length) throw new TypeError('benchmark cases are required');
  const fixtureRevision = exactRevision(cases[0].fixture_revision);
  const reviewContractVersion = requiredText(cases[0].review_contract_version, 'review_contract_version');
  if (cases.some((item) => item.fixture_revision !== fixtureRevision || item.review_contract_version !== reviewContractVersion)) {
    throw new TypeError('benchmark cases must share exact fixture and review contract identity');
  }

  let expectedCount = 0;
  let actualCount = 0;
  let truePositiveCount = 0;
  let detectedCases = 0;
  let defeaterCount = 0;
  let validDefeaterCount = 0;
  let matchedCount = 0;
  let correctPathCount = 0;
  let minimalMissingCount = 0;
  let repairMinimalCount = 0;
  let paraphraseStableCount = 0;
  let revisionBoundCount = 0;

  for (const item of cases) {
    const expected = Array.isArray(item.expected_findings) ? item.expected_findings : [];
    const actual = Array.isArray(findingsByCase[item.case_id]) ? findingsByCase[item.case_id] : [];
    const expectedIds = new Set(expected.map(findingId).filter(Boolean));
    expectedCount += expectedIds.size;
    actualCount += actual.length;
    const matched = actual.filter((entry) => expectedIds.has(findingId(entry)));
    truePositiveCount += matched.length;
    if (matched.length > 0) detectedCases += 1;
    matchedCount += matched.length;
    correctPathCount += matched.filter((entry) => entry.claim_path_correct !== false).length;
    minimalMissingCount += matched.filter((entry) => entry.minimal_missing_obligation !== false).length;
    repairMinimalCount += matched.filter((entry) => entry.repair_minimal !== false).length;
    paraphraseStableCount += matched.filter((entry) => entry.paraphrase_stable !== false).length;
    revisionBoundCount += matched.filter((entry) => entry.revision_bound !== false).length;
    const defeaters = actual.filter((entry) => entry.kind === 'defeater');
    defeaterCount += defeaters.length;
    validDefeaterCount += defeaters.filter((entry) => entry.counterexample_valid !== false).length;
  }

  const falsePositiveCount = Math.max(0, actualCount - truePositiveCount);
  return Object.freeze({
    schema:'outcome-integrity-benchmark-result-v0',
    evidence_role:'verification',
    project_authority:false,
    fixture_revision:fixtureRevision,
    review_contract_version:reviewContractVersion,
    case_count:cases.length,
    metrics:Object.freeze({
      defect_recall:boundedRatio(detectedCases, cases.length, 0),
      finding_precision:boundedRatio(truePositiveCount, actualCount, 0),
      false_blocker_rate:boundedRatio(falsePositiveCount, actualCount, 0),
      counterexample_validity:boundedRatio(validDefeaterCount, defeaterCount, 1),
      correct_claim_argument_path:boundedRatio(correctPathCount, matchedCount, 0),
      minimal_missing_obligation_accuracy:boundedRatio(minimalMissingCount, matchedCount, 0),
      repair_minimality:boundedRatio(repairMinimalCount, matchedCount, 0),
      paraphrase_stability:boundedRatio(paraphraseStableCount, matchedCount, 0),
      revision_binding_correctness:boundedRatio(revisionBoundCount, matchedCount, 0),
    }),
  });
}