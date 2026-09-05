import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION,
  createKnownGoodFixture,
  deriveSemanticMutants,
  evaluateOutcomeIntegrityBenchmark,
} from '../lib/outcome-integrity-semantic-mutation-benchmark.js';

test('semantic mutation corpus preserves structural validity while planting outcome defects', () => {
  const fixture = createKnownGoodFixture({ revision: '203d4b1b919ca77108fc4188934fdee6d423ff94' });
  const mutants = deriveSemanticMutants(fixture);
  const defectKinds = new Set(mutants.map((mutant) => mutant.expected_defect.kind));

  assert.deepEqual(defectKinds, new Set([
    'missing-work',
    'weak-evidence',
    'hidden-assumption',
    'incompatible-sibling-strategies',
    'semantic-justification-cycle',
    'stale-exact-revision-assurance',
    'orphan-work',
    'vacuous-leaf-success',
    'authoritative-effect-gap',
  ]));
  assert.ok(mutants.every((mutant) => mutant.structurally_valid === true));
  assert.ok(mutants.every((mutant) => mutant.fixture_revision === fixture.revision));
  assert.ok(mutants.every((mutant) => mutant.review_contract_version === OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION));
});

test('authoritative-effect-gap keeps a defeater when candidate verification succeeds but dev authority is unchanged', () => {
  const fixture = createKnownGoodFixture({ revision: '203d4b1b919ca77108fc4188934fdee6d423ff94' });
  const mutant = deriveSemanticMutants(fixture).find((item) => item.expected_defect.kind === 'authoritative-effect-gap');

  assert.equal(mutant.observations.candidate_created, true);
  assert.equal(mutant.observations.candidate_exact_revision_verified, true);
  assert.equal(mutant.observations.authoritative_development_branch_changed, false);
  assert.equal(mutant.expected_defect.required_finding, 'missing-authoritative-integration-effect');
});

test('benchmark scores required outcome-integrity metrics against revision-bound cases', () => {
  const fixture = createKnownGoodFixture({ revision: '203d4b1b919ca77108fc4188934fdee6d423ff94' });
  const cases = deriveSemanticMutants(fixture);
  const report = evaluateOutcomeIntegrityBenchmark(cases, (benchmarkCase) => ({
    finding: benchmarkCase.expected_defect.required_finding,
    defect_kind: benchmarkCase.expected_defect.kind,
    claim_path: benchmarkCase.expected_defect.claim_path,
    minimal_missing_obligation: benchmarkCase.expected_defect.minimal_missing_obligation,
    repair: benchmarkCase.expected_defect.minimal_repair,
    counterexample_valid: true,
    revision: benchmarkCase.fixture_revision,
  }));

  assert.equal(report.fixture_revision, fixture.revision);
  assert.equal(report.review_contract_version, OUTCOME_INTEGRITY_REVIEW_CONTRACT_VERSION);
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
  ]) assert.equal(report.metrics[metric], 1);
});