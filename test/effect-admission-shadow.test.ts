import assert from 'node:assert/strict';
import test from 'node:test';

import {
  effectAdmissionDecision,
  mutationAdmitted,
  type EffectAdmissionState,
} from '../src/authority/transaction-admission.ts';

const bools = [false, true] as const;

test('4×4 effect admission owns the complete authority/revision/reservation truth table', () => {
  for (const current_authority of bools) {
    for (const exact_revision of bools) {
      for (const unresolved_effect of bools) {
        const state: EffectAdmissionState = {
          current_authority,
          exact_revision,
          unresolved_effect,
        };
        assert.equal(
          effectAdmissionDecision(state),
          current_authority && exact_revision && !unresolved_effect,
        );
      }
    }
  }
});

test('legacy mutation admission is the same function, not a second semantic owner', () => {
  assert.equal(mutationAdmitted, effectAdmissionDecision);
});
