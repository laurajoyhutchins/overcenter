import assert from 'node:assert/strict';
import test from 'node:test';

import {
  effectAdmissionDecision,
  mutationAdmitted,
  type EffectAdmissionDenial,
  type EffectAdmissionState,
} from '../src/authority/transaction-admission.ts';

const bools = [false, true] as const;

test('4×4 permits owns the complete effect-admission truth table', () => {
  for (const currentAuthority of bools) {
    for (const exactRevision of bools) {
      for (const unresolvedEffect of bools) {
        const state: EffectAdmissionState = {
          current_authority: currentAuthority,
          exact_revision: exactRevision,
          unresolved_effect: unresolvedEffect,
        };
        const expectedPermits = currentAuthority && exactRevision && !unresolvedEffect;
        const expectedDenial: EffectAdmissionDenial =
          !currentAuthority || !exactRevision
            ? 'STALE_EXECUTION_GENERATION'
            : unresolvedEffect
              ? 'UNRESOLVED_EFFECT'
              : null;

        const decision = effectAdmissionDecision(state);
        assert.equal(decision.permits, expectedPermits);
        assert.equal(decision.denial, expectedDenial);
        assert.equal(mutationAdmitted(state), decision.permits);
      }
    }
  }
});

test('legacy mutation admission is only a projection of authoritative permits', () => {
  const admitted: EffectAdmissionState = {
    current_authority: true,
    exact_revision: true,
    unresolved_effect: false,
  };
  const duplicate: EffectAdmissionState = {
    ...admitted,
    unresolved_effect: true,
  };
  const stale: EffectAdmissionState = {
    ...admitted,
    exact_revision: false,
  };

  assert.deepEqual(effectAdmissionDecision(admitted), { permits: true, denial: null });
  assert.deepEqual(effectAdmissionDecision(duplicate), {
    permits: false,
    denial: 'UNRESOLVED_EFFECT',
  });
  assert.deepEqual(effectAdmissionDecision(stale), {
    permits: false,
    denial: 'STALE_EXECUTION_GENERATION',
  });
  assert.equal(mutationAdmitted(admitted), true);
  assert.equal(mutationAdmitted(duplicate), false);
  assert.equal(mutationAdmitted(stale), false);
});
