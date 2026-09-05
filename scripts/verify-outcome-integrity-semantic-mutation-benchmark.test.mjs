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
  assert.ok(mutants.every((mutant) => mutant.mutation.operation));

  const byKind = new Map(mutants.map((mutant) => [mutant.expected_defect.kind, mutant]));
  assert.equal(byKind.get('missing-work').graph.obligations.some((item) => item.id === 'integrate'), false);
  assert.equal(byKind.get('weak-evidence').graph.evidence.find((item) => item.claim === 'authoritative-development-effect').kind, 'adjacent-test');
  assert.equal(byKind.get('hidden-assumption').graph.assumptions.length, 0);
  assert.deepEqual(byKind.get('incompatible-sibling-strategies').graph.strategies, ['direct-merge', 'never-change-dev']);
  assert.ok(byKind.get('semantic-justification-cycle').graph.argument.some((step) => step[0] === 'root-outcome' && step[1] === 'supporting-claim'));
  assert.notEqual(byKind.get('stale-exact-revision-assurance').reviewed_revision, byKind.get('stale-exact-revision-assurance').current_authoritative_revision);
  assert.ok(byKind.get('orphan-work').graph.obligations.some((item) => item.id === 'irrelevant-cleanup' && !item.produces));
});

test('authoritative-effect-gap keeps a defeater when candidate verification succeeds but dev authority is unchanged', () => {
  const fixture = createKnownGoodFixture({ revision: '203d4b1b919ca77108fc4188934fdee6d423ff94' });
  const mutant = deriveSemanticMutants(fixture).find((item) => item.expected_defect.kind === 'authoritative-effect-gap');

  assert.equal(mutant.observations.candidate_created, true);
  assert.equal(mutant.observations.candidate_exact_revision_verified, true);
  assert.equal(mutant.observations.authoritative_development_branch_changed, false);
  assert.equal(mutant.expected_defect.required_finding, 'missing-authoritative-integration-effect');
});

test('all-leaf-success mutant preserves local success while the root outcome stays false', () => {
  const fixture = createKnownGoodFixture({ revision: '203d4b1b919ca77108fc4188934fdee6d423ff94' });
  const mutant = deriveSemanticMutants(fixture).find((item) => item.expected_defect.kind === 'vacuous-leaf-success');
  assert.equal(mutant.observations.every_leaf_success, true);
  assert.equal(mutant.observations.root_outcome_established, false);
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
    'counterexample_validity',
    'correct_claim_argument_path',
    'minimal_missing_obligation_accuracy',
    'repair_minimality',
    'paraphrase_stability',
    'revision_binding_correctness',
  ]) assert.equal(report.metrics[metric], 1);
  assert.equal(report.metrics.false_blocker_rate, 0);
});