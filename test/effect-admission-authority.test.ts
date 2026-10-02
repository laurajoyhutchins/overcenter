import assert from 'node:assert/strict';
import test from 'node:test';

import { executionPermits } from '../src/authority/transaction-admission.ts';
import {
  effectAdmissionDecision,
  effectAdmissionExplanation,
  explainRelationalEvent,
} from '../src/authority/relational-explanation.ts';
import type { ExecutionPermit, Run } from '../src/model.ts';

const run: Run = {
  id: 'run',
  obligation_id: 'obligation',
  claimed_revision: 'revision',
  claim_commit: 'claim',
  obligation_key: 'key',
  execution_generation: 7,
  execution_authority_commit: 'authority',
  execution_capability_sha256: 'capability',
};
const permit: ExecutionPermit = { ...run, execution_capability: 'secret' };

test('4×4 permits owns effect admission through the exact current capability relation', () => {
  assert.equal(executionPermits(run, permit, 'capability'), true);
  assert.deepEqual(effectAdmissionDecision(run, permit, 'capability', false), {
    permits: true,
    denial: null,
  });
  const exact = effectAdmissionExplanation(run, permit, 'capability', false);
  assert.equal(exact.permitted_by.length, 1);
  assert.deepEqual(exact.stale_authority, []);
  assert.deepEqual(
    exact.requirements.map(({ state }) => state),
    ['supported'],
  );
  assert.deepEqual(effectAdmissionDecision(run, permit, 'capability', true), {
    permits: false,
    denial: 'UNRESOLVED_EFFECT',
  });
  const unresolved = effectAdmissionExplanation(run, permit, 'capability', true);
  assert.equal(unresolved.permitted_by.length, 1);
  assert.deepEqual(unresolved.stale_authority, []);
  assert.deepEqual(
    unresolved.requirements.map(({ state }) => state),
    ['unsupported'],
  );
});

test('inexact permits fail closed before reservation state can broaden admission', () => {
  for (const candidate of [
    { ...permit, id: 'other' },
    { ...permit, obligation_id: 'other' },
    { ...permit, claimed_revision: 'other' },
    { ...permit, claim_commit: 'other' },
    { ...permit, obligation_key: 'other' },
    { ...permit, execution_generation: 8 },
    { ...permit, execution_authority_commit: 'other' },
    { ...permit, execution_capability_sha256: 'other' },
  ]) {
    assert.deepEqual(effectAdmissionDecision(run, candidate, 'capability', false), {
      permits: false,
      denial: 'STALE_EXECUTION_GENERATION',
    });
    const explanation = effectAdmissionExplanation(run, candidate, 'capability', false);
    assert.deepEqual(explanation.permitted_by, []);
    assert.equal(explanation.stale_authority.length, 1);
  }
  assert.deepEqual(effectAdmissionDecision(run, permit, 'other', false), {
    permits: false,
    denial: 'STALE_EXECUTION_GENERATION',
  });
  const wrongCapability = effectAdmissionExplanation(run, permit, 'other', false);
  assert.deepEqual(wrongCapability.permitted_by, []);
  assert.equal(wrongCapability.stale_authority.length, 1);
});

test('stale support and stale authority remain distinct coordinate failures', () => {
  const input = {
    coordinates: [{ id: 'current' }, { id: 'historical' }],
    objects: [
      { id: 'historical-authority', coordinate: 'historical' },
      { id: 'historical-evidence', coordinate: 'historical' },
    ],
    events: [{ id: 'attempt', coordinate: 'current' }],
    propositions: [
      { id: 'admitted', coordinate: 'current' },
      { id: 'supported', coordinate: 'current' },
    ],
    permits: [{ object: 'historical-authority', event: 'attempt' }],
    supports: [{ object: 'historical-evidence', proposition: 'supported' }],
    requires: [{ proposition: 'admitted', required: 'supported' }],
  } as const;
  const before = structuredClone(input);
  const explanation = explainRelationalEvent(input, 'attempt', 'admitted');

  assert.deepEqual(explanation.permitted_by, []);
  assert.deepEqual(explanation.stale_authority, ['historical-authority']);
  assert.deepEqual(
    explanation.requirements.map(({ state }) => state),
    ['stale-support'],
  );
  assert.deepEqual(input, before);
  assert.deepEqual(
    explainRelationalEvent(
      {
        ...input,
        coordinates: [...input.coordinates].reverse(),
        objects: [...input.objects].reverse(),
      },
      'attempt',
      'admitted',
    ),
    explanation,
  );
});
