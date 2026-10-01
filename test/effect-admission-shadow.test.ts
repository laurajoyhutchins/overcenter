import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareEffectAdmission,
  effectPermitsFromProjection,
  mutationAdmitted,
  shadowMutationAdmitted,
  type EffectAdmissionState,
} from '../src/authority/transaction-admission.ts';

const bools = [false, true] as const;

test('shadow effect admission agrees across the complete projected truth table', () => {
  for (const currentAuthority of bools) {
    for (const exactRevision of bools) {
      for (const unresolvedEffect of bools) {
        const state: EffectAdmissionState = {
          current_authority: currentAuthority,
          exact_revision: exactRevision,
          unresolved_effect: unresolvedEffect,
        };
        const expected = currentAuthority && exactRevision && !unresolvedEffect;

        assert.equal(mutationAdmitted(state), expected);
        assert.equal(effectPermitsFromProjection(state), expected);
        assert.equal(shadowMutationAdmitted(state), expected);
      }
    }
  }
});

test('shadow comparison detects a hostile legacy-path mutation', () => {
  const state: EffectAdmissionState = {
    current_authority: true,
    exact_revision: true,
    unresolved_effect: false,
  };

  assert.throws(
    () => compareEffectAdmission(state, false, true),
    new Error(
      'EFFECT_ADMISSION_SHADOW_DIVERGENCE:current_authority=1:exact_revision=1:' +
        'unresolved_effect=0:legacy=0:permits=1',
    ),
  );
});

test('shadow comparison detects a hostile permits-path mutation', () => {
  const state: EffectAdmissionState = {
    current_authority: true,
    exact_revision: true,
    unresolved_effect: false,
  };

  assert.throws(
    () => compareEffectAdmission(state, true, false),
    new Error(
      'EFFECT_ADMISSION_SHADOW_DIVERGENCE:current_authority=1:exact_revision=1:' +
        'unresolved_effect=0:legacy=1:permits=0',
    ),
  );
});

test('unresolved reservation remains denied by both independent paths', () => {
  const state: EffectAdmissionState = {
    current_authority: true,
    exact_revision: true,
    unresolved_effect: true,
  };

  assert.equal(mutationAdmitted(state), false);
  assert.equal(effectPermitsFromProjection(state), false);
  assert.equal(shadowMutationAdmitted(state), false);
});
