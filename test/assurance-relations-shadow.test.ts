import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveAffectedAssuranceProperties,
  deriveAssuranceChangePlan,
} from '../src/architecture/change-planner.ts';
import { loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import {
  assuranceChangePlanFromRelations,
  minimumSupportCover,
  shadowAssuranceChangePlan,
} from '../src/authority/assurance-relations.ts';
import { GOLDEN_TRANSACTION_CASE } from './fixtures/golden-transaction.ts';

test('requires/supports planner is equivalent for every current assurance property', () => {
  const db = loadArchitectureDatabase();
  try {
    const properties = db
      .prepare('SELECT property_id FROM assurance_property ORDER BY property_id')
      .all() as unknown as Array<{ property_id: string }>;

    for (const { property_id } of properties) {
      const legacy = deriveAssuranceChangePlan(db, property_id);
      assert.deepEqual(assuranceChangePlanFromRelations(db, property_id), legacy, property_id);
      assert.deepEqual(shadowAssuranceChangePlan(db, property_id), legacy, property_id);
    }
  } finally {
    db.close();
  }
});

test('golden transaction keeps the same minimum sufficient evidence set', () => {
  const db = loadArchitectureDatabase();
  try {
    const evidence = [
      ...new Map(
        GOLDEN_TRANSACTION_CASE.expected_assurance_impacts
          .flatMap((impact) => assuranceChangePlanFromRelations(db, impact.property_id).evidence)
          .map((item) => [item.evidence_id, item]),
      ).values(),
    ].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));

    assert.deepEqual(evidence, GOLDEN_TRANSACTION_CASE.expected_minimum_evidence);
  } finally {
    db.close();
  }
});

test('representative repository deltas preserve legacy proof selection', () => {
  const cases = [
    ['src/providers/github/status-effect.ts'],
    ['experiments/authority-flow-analysis/analyzer.ts'],
    ['.github/workflows/distributed-authority-chaos.yml'],
    ['src/execution/confinement/main.rs'],
  ];

  const db = loadArchitectureDatabase();
  try {
    for (const changed of cases) {
      const impacts = deriveAffectedAssuranceProperties(db, changed, (roots) => roots);
      assert.ok(impacts.length > 0, changed.join(','));

      for (const impact of impacts) {
        assert.deepEqual(
          assuranceChangePlanFromRelations(db, impact.property_id),
          deriveAssuranceChangePlan(db, impact.property_id),
          `${changed.join(',')}:${impact.property_id}`,
        );
      }
    }
  } finally {
    db.close();
  }
});

test('coordinate-mismatched support cannot satisfy a proposition', () => {
  assert.throws(
    () =>
      minimumSupportCover(
        ['obligation:authoritative-settlement'],
        [
          {
            object_id: 'provider-observation-proof',
            proposition_id: 'obligation:authoritative-settlement',
            coordinate: 'revision:other',
          },
        ],
        'revision:expected',
      ),
    /ASSURANCE_SUPPORT_INCOMPLETE:obligation:authoritative-settlement/,
  );
});

test('missing support fails closed', () => {
  const db = loadArchitectureDatabase();
  try {
    db.prepare(
      "DELETE FROM evidence_witnesses_obligation WHERE obligation_id = 'authoritative-settlement'",
    ).run();

    assert.throws(
      () => assuranceChangePlanFromRelations(db, 'github-commit-status-provider'),
      /ASSURANCE_SUPPORT_INCOMPLETE:obligation:authoritative-settlement/,
    );
  } finally {
    db.close();
  }
});
