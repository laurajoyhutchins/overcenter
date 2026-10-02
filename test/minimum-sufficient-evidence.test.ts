import assert from 'node:assert/strict';
import test from 'node:test';

import { loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import {
  ASSURANCE_RELATION_COORDINATE,
  assuranceEvidenceFrontierFromRelations,
  assuranceRequirementClosure,
  minimumSufficientEvidenceSet,
} from '../src/authority/assurance-relations.ts';

test('assurance requirements close transitively from multiple goals', () => {
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

    assert.deepEqual(
      assuranceRequirementClosure(db, [
        'github-commit-status-provider',
        'authority-flow-integrity',
      ]),
      [
        'obligation:authoritative-settlement',
        'obligation:exact-revision-effect',
        'obligation:reserve-before-effect',
        'obligation:unresolved-effect-no-replay',
        'proof:authority-flow-integrity',
        'property:authority-flow-integrity',
        'property:broker-mutation-safety',
        'property:github-commit-status-provider',
      ],
    );
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

test('coordinate-mismatched support never satisfies a requirement', () => {
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

test('multiple assurance goals are minimized as one evidence frontier', () => {
  const db = loadArchitectureDatabase();
  try {
    db.exec(`
      INSERT INTO assurance_property(property_id) VALUES ('minimum-a'), ('minimum-b');
      INSERT INTO evidence(evidence_id) VALUES ('a-only'), ('b-only'), ('shared-proof');
      INSERT INTO evidence_witnesses_assurance_property(evidence_id, property_id) VALUES
        ('a-only', 'minimum-a'),
        ('b-only', 'minimum-b'),
        ('shared-proof', 'minimum-a'),
        ('shared-proof', 'minimum-b');
    `);

    const frontier = assuranceEvidenceFrontierFromRelations(
      db,
      ['minimum-a', 'minimum-b'],
      'revision:combined',
    );
    assert.deepEqual(frontier.selected_object_ids, ['shared-proof']);
    assert.deepEqual(frontier.required_propositions, ['proof:minimum-a', 'proof:minimum-b']);
  } finally {
    db.close();
  }
});

test('terminal protected and trusted-scope proofs remain required when witness routing disappears', () => {
  const db = loadArchitectureDatabase();
  try {
    for (const propertyId of [
      'authority-flow-integrity',
      'substrate-capability-admission-integrity',
    ]) {
      db.prepare('DELETE FROM evidence_witnesses_assurance_property WHERE property_id = ?').run(
        propertyId,
      );
      assert.throws(
        () => assuranceEvidenceFrontierFromRelations(db, propertyId, ASSURANCE_RELATION_COORDINATE),
        new RegExp(`ASSURANCE_SUPPORT_INCOMPLETE:proof:${propertyId}`),
        propertyId,
      );
    }
  } finally {
    db.close();
  }
});
