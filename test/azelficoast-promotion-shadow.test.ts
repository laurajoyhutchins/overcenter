import assert from 'node:assert/strict';
import test from 'node:test';

import {
  azelficoastPromotionCoordinate,
  projectAzelficoastPromotionRelations,
  type AzelficoastPromotionEvidence,
} from '../src/integrations/azelficoast-promotion.ts';

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

test('Azelficoast promotion projects into only the canonical 4x4 relations', () => {
  const projection = projectAzelficoastPromotionRelations(passing, revision);

  assert.equal(projection.objects.length, 4);
  assert.equal(projection.events.length, 2);
  assert.equal(projection.propositions.length, 6);
  assert.equal(projection.permits.length, 1);
  assert.equal(projection.asserts.length, 4);
  assert.equal(projection.supports.length, 1);
  assert.equal(projection.requires.length, 5);
  assert.equal(projection.legacy.admitted, true);

  for (const relation of [
    ...projection.permits,
    ...projection.asserts,
    ...projection.supports,
    ...projection.requires,
  ]) {
    assert.equal(relation.coordinate, projection.coordinate);
  }
});

test('failed or ambiguous playing-strength evidence is not projected as an assertion', () => {
  const { superiority_p_value: _superiorityPValue, ...ambiguousChecks } = passing.checks;
  for (const checks of [{ ...passing.checks, superiority_p_value: false }, ambiguousChecks]) {
    const projection = projectAzelficoastPromotionRelations(
      { ...passing, checks, admitted: false },
      revision,
    );
    const asserted = new Set(projection.asserts.map((row) => row.proposition_id));

    assert.equal(
      asserted.has(projection.ids.check_propositions.superiority_p_value),
      false,
    );
  }
});

test('legacy admission never synthesizes missing 4x4 evidence', () => {
  const projection = projectAzelficoastPromotionRelations(
    {
      ...passing,
      checks: { ...passing.checks, side_balance: false },
      admitted: true,
    },
    revision,
  );
  const asserted = new Set(projection.asserts.map((row) => row.proposition_id));

  assert.equal(projection.legacy.admitted, true);
  assert.equal(asserted.has(projection.ids.check_propositions.side_balance), false);
  assert.ok(
    projection.requires.some(
      (row) =>
        row.proposition_id === projection.ids.promotion_proposition &&
        row.required_proposition_id === projection.ids.check_propositions.side_balance,
    ),
  );
});

test('exact coordinates change with candidate, experiment, or repository identity', () => {
  const original = azelficoastPromotionCoordinate(passing, revision);
  assert.notEqual(
    azelficoastPromotionCoordinate(
      { ...passing, candidate_checkpoint_digest: `sha256:${'3'.repeat(64)}` },
      revision,
    ),
    original,
  );
  assert.notEqual(
    azelficoastPromotionCoordinate(
      { ...passing, results_digest: `sha256:${'b'.repeat(64)}` },
      revision,
    ),
    original,
  );
  assert.notEqual(
    azelficoastPromotionCoordinate(passing, '9'.repeat(40)),
    original,
  );
});

test('incomplete panel evidence does not support panel completeness', () => {
  const projection = projectAzelficoastPromotionRelations(
    { ...passing, battle_count: 31, admitted: true },
    revision,
  );

  assert.equal(projection.supports.length, 0);
  assert.ok(
    projection.requires.some(
      (row) =>
        row.proposition_id === projection.ids.promotion_proposition &&
        row.required_proposition_id === projection.ids.panel_complete_proposition,
    ),
  );
});

test('the adapter rejects a noncanonical external evidence contract', () => {
  assert.throws(
    () => projectAzelficoastPromotionRelations({ ...passing, schema_version: 3 }, revision),
    /AZELFICOAST_PROMOTION_INVALID:SCHEMA/,
  );
  assert.throws(
    () =>
      projectAzelficoastPromotionRelations(
        { ...passing, incumbent_checkpoint_digest: candidate },
        revision,
      ),
    /AZELFICOAST_PROMOTION_INVALID:IDENTICAL_CHECKPOINTS/,
  );
  assert.throws(
    () => projectAzelficoastPromotionRelations(passing, 'not-a-revision'),
    /AZELFICOAST_PROMOTION_INVALID:REVISION/,
  );
});
