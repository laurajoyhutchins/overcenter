import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  azelficoastPromotionCoordinate,
  projectAzelficoastPromotionBoundary,
  shadowAzelficoastPromotion,
  type AzelficoastPromotionBoundary,
  type AzelficoastPromotionEvidence,
} from '../src/integrations/azelficoast-promotion.ts';
import { SqliteFourByFourCalculus } from '../src/authority/sqlite-calculus.ts';

const revision = '806630728b472ebaa11d5f991e72d306da90628a';
const durableHead = 'overcenter-shadow-head';
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

function withCalculus(
  run: (calculus: SqliteFourByFourCalculus) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'azelficoast-promotion-'));
  const path = join(root, 'overcenter.sqlite');
  const authority = new DatabaseSync(path);
  authority.exec(`
    CREATE TABLE authority (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      head TEXT,
      sequence INTEGER NOT NULL
    ) STRICT;
  `);
  authority
    .prepare('INSERT INTO authority(singleton, head, sequence) VALUES(1, ?, 1)')
    .run(durableHead);
  const calculus = new SqliteFourByFourCalculus(path);
  try {
    run(calculus);
  } finally {
    calculus.close();
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function shadow(boundary: AzelficoastPromotionBoundary) {
  let result: ReturnType<typeof shadowAzelficoastPromotion> | undefined;
  withCalculus((calculus) => {
    result = shadowAzelficoastPromotion(calculus, durableHead, boundary);
  });
  assert.ok(result);
  return result;
}

test('passing Azelficoast evidence agrees with the SQLite 4x4 shadow', () => {
  const boundary = projectAzelficoastPromotionBoundary(passing, revision);
  const decision = shadow(boundary);

  assert.equal(decision.admitted, true);
  assert.equal(decision.agrees, true);
  assert.equal(decision.exact_permit, true);
  assert.deepEqual(decision.unsupported_requirements, []);
  assert.deepEqual(decision.stale_supports, []);
  assert.deepEqual(decision.stale_permissions, []);
});

test('failed or missing playing-strength evidence cannot satisfy promotion requirements', () => {
  const { superiority_p_value: _superiorityPValue, ...ambiguousChecks } = passing.checks;
  for (const checks of [{ ...passing.checks, superiority_p_value: false }, ambiguousChecks]) {
    const boundary = projectAzelficoastPromotionBoundary(
      { ...passing, checks, admitted: false },
      revision,
    );
    const decision = shadow(boundary);

    assert.equal(decision.admitted, false);
    assert.equal(decision.agrees, true);
    assert.ok(
      decision.unsupported_requirements.includes(
        boundary.ids.check_propositions.superiority_p_value,
      ),
    );
  }
});

test('legacy admission cannot manufacture missing relational evidence', () => {
  const boundary = projectAzelficoastPromotionBoundary(
    {
      ...passing,
      checks: { ...passing.checks, side_balance: false },
      admitted: true,
    },
    revision,
  );
  const decision = shadow(boundary);

  assert.equal(decision.admitted, false);
  assert.equal(decision.agrees, false);
  assert.ok(
    decision.unsupported_requirements.includes(boundary.ids.check_propositions.side_balance),
  );
  assert.ok(decision.reasons.includes('LEGACY_DISAGREEMENT'));
});

test('exact coordinate changes with candidate, experiment, and repository identity', () => {
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
  assert.notEqual(azelficoastPromotionCoordinate(passing, '9'.repeat(40)), original);
});

test('support from a prior coordinate is stale and cannot migrate into a new candidate', () => {
  const original = projectAzelficoastPromotionBoundary(passing, revision);
  const changed = projectAzelficoastPromotionBoundary(
    { ...passing, candidate_checkpoint_digest: `sha256:${'3'.repeat(64)}` },
    revision,
  );
  const results = changed.projection.objects.find((row) => row.role === 'battle-results');
  assert.ok(results);

  changed.projection.coordinates.push({
    id: original.coordinate,
    value: { migrated_from: original.coordinate },
    sources: [],
  });
  results.coordinate = original.coordinate;

  const decision = shadow(changed);
  assert.equal(decision.admitted, false);
  assert.equal(decision.agrees, false);
  assert.ok(decision.stale_supports.length > 0);
  assert.ok(decision.unsupported_requirements.length > 0);
});

test('an incomplete panel leaves panel completeness unsupported', () => {
  const boundary = projectAzelficoastPromotionBoundary(
    { ...passing, battle_count: 31, admitted: true },
    revision,
  );
  const decision = shadow(boundary);

  assert.equal(decision.admitted, false);
  assert.equal(decision.agrees, false);
  assert.ok(
    decision.unsupported_requirements.includes(boundary.ids.panel_complete_proposition),
  );
});

test('the adapter rejects a noncanonical external evidence contract', () => {
  assert.throws(
    () => projectAzelficoastPromotionBoundary({ ...passing, schema_version: 3 }, revision),
    /AZELFICOAST_PROMOTION_INVALID:SCHEMA/,
  );
  assert.throws(
    () =>
      projectAzelficoastPromotionBoundary(
        { ...passing, incumbent_checkpoint_digest: candidate },
        revision,
      ),
    /AZELFICOAST_PROMOTION_INVALID:IDENTICAL_CHECKPOINTS/,
  );
  assert.throws(
    () => projectAzelficoastPromotionBoundary(passing, 'not-a-revision'),
    /AZELFICOAST_PROMOTION_INVALID:REVISION/,
  );
});
