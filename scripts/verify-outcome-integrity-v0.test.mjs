import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createKnownGoodFixture,
  deriveSemanticMutants,
  evaluateOutcomeIntegrityBenchmark,
} from '../lib/outcome-integrity-semantic-mutation-benchmark.js';
import {
  classifyOutcomeIntegrityNextAction,
  inspectOutcomeIntegrity,
  projectDefinitionToOutcomeIntegrityInput,
  reviewOutcomeIntegrityBenchmarkCase,
} from '../lib/outcome-integrity-inspection.js';

function exactHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('semantic mutation benchmark scores the real Outcome Integrity inspector without hidden conversation state', () => {
  const revision = exactHead();
  const fixture = createKnownGoodFixture({ revision });
  const cases = deriveSemanticMutants(fixture);
  const report = evaluateOutcomeIntegrityBenchmark(cases, reviewOutcomeIntegrityBenchmarkCase);

  assert.equal(report.fixture_revision, revision);
  assert.equal(report.case_count, 9);
  assert.equal(report.metrics.defect_recall, 1);
  assert.equal(report.metrics.finding_precision, 1);
  assert.equal(report.metrics.false_blocker_rate, 0);
  assert.equal(report.metrics.counterexample_validity, 1);
  assert.equal(report.metrics.correct_claim_argument_path, 1);
  assert.equal(report.metrics.minimal_missing_obligation_accuracy, 1);
  assert.equal(report.metrics.repair_minimality, 1);
  assert.equal(report.metrics.paraphrase_stability, 1);
  assert.equal(report.metrics.revision_binding_correctness, 1);
});

test('fresh exact-revision project definition produces a traceable non-authoritative live review', async () => {
  const revision = exactHead();
  const definition = JSON.parse(await readFile(new URL('../.overcenter/definitions/target-architecture.json', import.meta.url), 'utf8'));
  const input = projectDefinitionToOutcomeIntegrityInput({
    project_ref: definition.project_ref,
    authority_revision: revision,
    definition,
    root: 'verify-target-architecture-completion',
  });
  const report = inspectOutcomeIntegrity(input);

  assert.equal(report.project_ref, definition.project_ref);
  assert.equal(report.authority.revision, revision);
  assert.equal(report.authority.derivation, 'overcenter-project-graph-v1');
  assert.equal(report.selected_horizon.root, 'verify-target-architecture-completion');
  assert.equal(report.reasoning_review.authoritative, false);
  assert.equal('semantically_valid' in report, false);

  const transitionIds = new Set(definition.transitions.map((transition) => transition.id));
  const traceableSubjects = report.objective_violations.map((finding) => finding.subject).filter((subject) => transitionIds.has(subject));
  const derivationSubjects = report.positive_derivation.argument_steps.flatMap((step) => [...step.premises, step.conclusion]).filter((subject) => transitionIds.has(subject));
  assert.ok(traceableSubjects.length > 0 || derivationSubjects.length > 0, 'review must trace to authoritative transition coordinates');
  assert.ok(['deterministic', 'judgment_required', 'no_action'].includes(classifyOutcomeIntegrityNextAction(report)));
});
