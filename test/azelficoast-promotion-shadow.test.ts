import assert from 'node:assert/strict';
import test from 'node:test';

import {
  azelficoastPromotionCoordinate,
  projectAzelficoastPromotionShadow,
  type AzelficoastPromotionEvidence,
} from '../src/integrations/azelficoast-promotion.ts';
import { evaluatePromotionShadow } from '../src/governance/promotion-shadow.ts';

const revision = '806630728b472ebaa11d5f991e72d306da90628a';
const candidate = `sha256:${'1'.repeat(64)}`;
const incumbent = `sha256:${'2'.repeat(64)}`;
const passing: AzelficoastPromotionEvidence = {
  schema: 'azelficoast.battle-promotion-panel',
  schema_version: 2,
  candidate_checkpoint_digest: candidate,
  incumbent_checkpoint_digest: incumbent,
  deployment: { search_policy_margin: 1 },
  policy: {
    expected_battles: 32,
    max_superiority_p_value: 0.1,
    min_decisive_fraction: 0.75,
  },
  battle_count: 32,
  checks: {
    side_balance: true,
    minimum_decisive_battles: true,
    candidate_wins_more_than_loses: true,
    superiority_p_value: true,
  },
  results_digest: `sha256:${'a'.repeat(64)}`,
  admitted: true,
};

test('Azelficoast promotion is expressible as a 4x4 shadow without a domain primitive', () => {
  const snapshot = projectAzelficoastPromotionShadow(passing, revision);
  const decision = evaluatePromotionShadow(snapshot);

  assert.equal(decision.admitted, true);
  assert.equal(decision.agrees, true);
  assert.equal(decision.required_propositions.length, 5);
  assert.deepEqual(decision.unsupported_requirements, []);
});

test('failed or ambiguous playing-strength evidence cannot permit promotion', () => {
  const { superiority_p_value: _superiorityPValue, ...ambiguousChecks } = passing.checks;
  for (const checks of [
    { ...passing.checks, superiority_p_value: false },
    ambiguousChecks,
  ]) {
    const evidence = { ...passing, checks, admitted: false };
    const decision = evaluatePromotionShadow(projectAzelficoastPromotionShadow(evidence, revision));
    assert.equal(decision.admitted, false);
    assert.equal(decision.agrees, true);
    assert.ok(
      decision.unsupported_requirements.includes('azelficoast:promotion:superiority-p-value'),
    );
  }
});

test('shadow explains a forged legacy admission instead of inheriting it', () => {
  const evidence = {
    ...passing,
    checks: { ...passing.checks, side_balance: false },
    admitted: true,
  };
  const decision = evaluatePromotionShadow(projectAzelficoastPromotionShadow(evidence, revision));

  assert.equal(decision.admitted, false);
  assert.equal(decision.agrees, false);
  assert.deepEqual(decision.reasons, [
    'UNSUPPORTED_REQUIREMENT:azelficoast:promotion:side-balance',
    'LEGACY_DISAGREEMENT',
  ]);
});

test('exact coordinates prevent evidence migration between candidate or experiment identities', () => {
  const original = projectAzelficoastPromotionShadow(passing, revision);
  const changedCandidate = {
    ...passing,
    candidate_checkpoint_digest: `sha256:${'3'.repeat(64)}`,
  };
  const changedExperiment = {
    ...passing,
    results_digest: `sha256:${'b'.repeat(64)}`,
  };
  assert.notEqual(
    azelficoastPromotionCoordinate(changedCandidate, revision),
    original.coordinate,
  );
  assert.notEqual(
    azelficoastPromotionCoordinate(changedExperiment, revision),
    original.coordinate,
  );

  const migrated = projectAzelficoastPromotionShadow(changedCandidate, revision);
  migrated.asserts = original.asserts.map((row) => ({
    ...row,
    event_id: migrated.decision.evaluation_event_id,
  }));
  migrated.supports = original.supports.map((row) => ({ ...row }));
  const decision = evaluatePromotionShadow(migrated);
  assert.equal(decision.admitted, false);
  assert.equal(decision.agrees, false);
  assert.ok(decision.stale_relation_count > 0);
  assert.ok(decision.reasons.some((reason) => reason.startsWith('UNSUPPORTED_REQUIREMENT:')));
});

test('stale promotion permission cannot cross the coordinate boundary', () => {
  const snapshot = projectAzelficoastPromotionShadow(passing, revision);
  snapshot.permits[0] = { ...snapshot.permits[0]!, coordinate: 'sha256:stale' };
  const decision = evaluatePromotionShadow(snapshot);

  assert.equal(decision.admitted, false);
  assert.equal(decision.exact_permit, false);
  assert.equal(decision.stale_relation_count, 1);
  assert.deepEqual(decision.reasons, ['NO_EXACT_PERMIT', 'LEGACY_DISAGREEMENT']);
});

test('incomplete panel support fails closed even if every playing-strength check is true', () => {
  const evidence = { ...passing, battle_count: 31, admitted: true };
  const decision = evaluatePromotionShadow(projectAzelficoastPromotionShadow(evidence, revision));

  assert.equal(decision.admitted, false);
  assert.ok(decision.unsupported_requirements.includes('azelficoast:promotion:panel-complete'));
  assert.equal(decision.agrees, false);
});

test('the adapter rejects a noncanonical external evidence contract', () => {
  assert.throws(
    () => projectAzelficoastPromotionShadow({ ...passing, schema_version: 3 }, revision),
    /AZELFICOAST_PROMOTION_INVALID:SCHEMA/,
  );
  assert.throws(
    () =>
      projectAzelficoastPromotionShadow(
        { ...passing, incumbent_checkpoint_digest: candidate },
        revision,
      ),
    /AZELFICOAST_PROMOTION_INVALID:IDENTICAL_CHECKPOINTS/,
  );
});
