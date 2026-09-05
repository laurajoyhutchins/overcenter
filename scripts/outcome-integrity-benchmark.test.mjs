import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTCOME_INTEGRITY_REVIEW_CONTRACT,
  deriveOutcomeIntegritySemanticMutants,
  scoreOutcomeIntegrityBenchmark,
} from '../lib/outcome-integrity-benchmark.js';

const FIXTURE_REVISION = '0123456789abcdef0123456789abcdef01234567';

function knownGoodFixture() {
  return {
    schema:'outcome-integrity-benchmark-fixture-v0',
    fixture_id:'known-good-project',
    fixture_revision:FIXTURE_REVISION,
    review_contract_version:OUTCOME_INTEGRITY_REVIEW_CONTRACT,
    root_claim:'verified project outcome is integrated into authoritative source',
    refinement:'all-of',
    obligations:[
      { id:'candidate', establishes:'candidate exists', acceptance_evidence:['candidate-sha'] },
      { id:'verify', establishes:'candidate verified', acceptance_evidence:['exact-revision-ci'] },
      { id:'integrate', establishes:'authoritative branch contains candidate', acceptance_evidence:['authoritative-readback'] },
    ],
    assumptions:[{ id:'source-authority', statement:'GitHub authoritative branch is source authority' }],
    sibling_strategies:[{ id:'runtime', strategy:'integrate-then-deploy' }],
    semantic_edges:[['candidate','verify'],['verify','integrate']],
  };
}

test('semantic mutation benchmark derives the required structurally valid outcome defects', () => {
  const cases = deriveOutcomeIntegritySemanticMutants(knownGoodFixture());
  const mutantKinds = new Set(cases.map((item) => item.mutation_kind));
  for (const required of [
    'missing-work',
    'weak-adjacent-evidence',
    'hidden-assumption',
    'incompatible-sibling-strategies',
    'semantic-justification-cycle',
    'stale-exact-revision-assurance',
    'orphan-work',
    'leaf-success-root-false',
    'authoritative-effect-gap',
  ]) assert.ok(mutantKinds.has(required), `missing semantic mutant: ${required}`);

  for (const item of cases) {
    assert.equal(item.fixture_revision, FIXTURE_REVISION);
    assert.equal(item.review_contract_version, OUTCOME_INTEGRITY_REVIEW_CONTRACT);
    assert.equal(item.structurally_valid, true, `${item.mutation_kind} unexpectedly broke workflow structure`);
    assert.ok(item.expected_findings.length > 0, `${item.mutation_kind} lacks planted-defect evidence`);
  }

  const dogfood = cases.find((item) => item.mutation_kind === 'authoritative-effect-gap');
  assert.equal(dogfood.observations.candidate_created, true);
  assert.equal(dogfood.observations.exact_candidate_verified, true);
  assert.equal(dogfood.observations.authoritative_branch_contains_candidate, false);
  assert.equal(dogfood.expected_review_state, 'UNRESOLVED');
  assert.ok(dogfood.expected_findings.some((finding) => finding.kind === 'defeater'));
});

test('benchmark scoring reports verification metrics without becoming project authority', () => {
  const cases = deriveOutcomeIntegritySemanticMutants(knownGoodFixture());
  const findingsByCase = Object.fromEntries(cases.map((item) => [item.case_id, item.expected_findings]));
  const result = scoreOutcomeIntegrityBenchmark({ cases, findings_by_case:findingsByCase });

  assert.equal(result.schema, 'outcome-integrity-benchmark-result-v0');
  assert.equal(result.evidence_role, 'verification');
  assert.equal(result.project_authority, false);
  assert.equal(result.fixture_revision, FIXTURE_REVISION);
  assert.equal(result.review_contract_version, OUTCOME_INTEGRITY_REVIEW_CONTRACT);
  for (const metric of [
    'defect_recall',
    'finding_precision',
    'false_blocker_rate',
    'counterexample_validity',
    'correct_claim_argument_path',
    'minimal_missing_obligation_accuracy',
    'repair_minimality',
    'paraphrase_stability',
    'revision_binding_correctness',
  ]) assert.equal(typeof result.metrics[metric], 'number', `missing metric ${metric}`);
  assert.equal(result.metrics.defect_recall, 1);
  assert.equal(result.metrics.finding_precision, 1);
  assert.equal(result.metrics.false_blocker_rate, 0);
  assert.equal(result.metrics.revision_binding_correctness, 1);
});