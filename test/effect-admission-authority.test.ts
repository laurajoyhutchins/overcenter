import assert from 'node:assert/strict';
import test from 'node:test';

import {
  effectAdmissionDecision,
  executionPermits,
} from '../src/authority/transaction-admission.ts';
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
  assert.deepEqual(effectAdmissionDecision(run, permit, 'capability', true), {
    permits: false,
    denial: 'UNRESOLVED_EFFECT',
  });
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
  }
  assert.deepEqual(effectAdmissionDecision(run, permit, 'other', false), {
    permits: false,
    denial: 'STALE_EXECUTION_GENERATION',
  });
});
