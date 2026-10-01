import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAffectedAssuranceProperties } from '../src/architecture/change-planner.ts';
import { loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import {
  ASSURANCE_RELATION_COORDINATE,
  assuranceRequirementClosure,
  deriveAssuranceChangePlan,
  deriveAssuranceEvidenceFrontier,
  minimumSufficientEvidenceSet,
} from '../src/authority/assurance-relations.ts';
import { GOLDEN_TRANSACTION_CASE } from './fixtures/golden-transaction.ts';

test('assurance requirements close transitively through requires', () => {
  const db = loadArchitectureDatabase();
  try {
    assert.deepEqual(assuranceRequirementClosure(db, 'github-commit-status-provider'), [
      'obligation:authoritative-settlement',
      'obligation:exact-revision-effect',
      'obligation:reserve-before-effect',
      'obligation:unresolved-effect-no-replay',
      'property:broker-mutation-safety',
      'property:github-commit-status-provider',
    ]);
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
          .flatMap((impact) => deriveAssuranceChangePlan(db, impact.property_id).evidence)
          .map((item) => [item.evidence_id, item]),
      ).values(),
    ].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));

    assert.deepEqual(evidence, GOLDEN_TRANSACTION_CASE.expected_minimum_evidence);
  } finally {
    db.close();
  }
});

test('representative repository deltas still derive assurance plans', () => {
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
        assert.doesNotThrow(() => deriveAssuranceChangePlan(db, impact.property_id));
      }
    }
  } finally {
    db.close();
  }
});

test('exact-coordinate support is subtracted before evidence minimization', () => {
  const frontier = minimumSufficientEvidenceSet(
    ['proof:a', 'proof:b'],
    [
      { object_id: 'evidence-a', proposition_id: 'proof:a', coordinate: 'revision:expected' },
      { object_id: 'evidence-b', proposition_id: 'proof:b', coordinate: 'revision:expected' },
    ],
    'revision:expected',
    [{ object_id: 'certified-read-a', proposition_id: 'proof:a', coordinate: 'revision:expected' }],
  );

  assert.deepEqual(frontier.already_supported_propositions, ['proof:a']);
  assert.deepEqual(frontier.selected_object_ids, ['evidence-b']);
  assert.deepEqual(frontier.explanations, [
    {
      proposition_id: 'proof:a',
      resolution: 'already-supported',
      object_ids: ['certified-read-a'],
    },
    {
      proposition_id: 'proof:b',
      resolution: 'selected-evidence',
      object_ids: ['evidence-b'],
    },
  ]);
});

test('coordinate-mismatched support never satisfies a proposition', () => {
  assert.throws(
    () =>
      minimumSufficientEvidenceSet(
        ['obligation:authoritative-settlement'],
        [],
        'revision:expected',
        [
          {
            object_id: 'provider-observation-proof',
            proposition_id: 'obligation:authoritative-settlement',
            coordinate: 'revision:other',
          },
        ],
      ),
    /ASSURANCE_SUPPORT_INCOMPLETE:obligation:authoritative-settlement:coordinate=revision:expected/,
  );
});

test('multiple minimum evidence sets use a deterministic tie-break and surface alternatives', () => {
  const frontier = minimumSufficientEvidenceSet(
    ['proof:a', 'proof:b'],
    [
      { object_id: 'a', proposition_id: 'proof:a', coordinate: 'revision' },
      { object_id: 'b', proposition_id: 'proof:b', coordinate: 'revision' },
      { object_id: 'c', proposition_id: 'proof:a', coordinate: 'revision' },
      { object_id: 'd', proposition_id: 'proof:b', coordinate: 'revision' },
    ],
    'revision',
  );

  assert.deepEqual(frontier.selected_object_ids, ['a', 'b']);
  assert.deepEqual(frontier.alternative_minimum_object_sets, [
    ['a', 'd'],
    ['b', 'c'],
    ['c', 'd'],
  ]);
});

test('missing obligation support fails closed with the exact missing proposition', () => {
  const db = loadArchitectureDatabase();
  try {
    db.prepare(
      "DELETE FROM evidence_witnesses_obligation WHERE obligation_id = 'authoritative-settlement'",
    ).run();

    assert.throws(
      () => deriveAssuranceChangePlan(db, 'github-commit-status-provider'),
      /ASSURANCE_SUPPORT_INCOMPLETE:obligation:authoritative-settlement/,
    );
  } finally {
    db.close();
  }
});

test('terminal protected and trusted-scope proofs remain required when witness routing disappears', () => {
  const db = loadArchitectureDatabase();
  try {
    for (const propertyId of ['authority-flow-integrity', 'substrate-capability-admission-integrity']) {
      db.prepare('DELETE FROM evidence_witnesses_assurance_property WHERE property_id = ?').run(
        propertyId,
      );
      assert.throws(
        () => deriveAssuranceEvidenceFrontier(db, propertyId, ASSURANCE_RELATION_COORDINATE),
        new RegExp(`ASSURANCE_SUPPORT_INCOMPLETE:proof:${propertyId}`),
        propertyId,
      );
    }
  } finally {
    db.close();
  }
});
