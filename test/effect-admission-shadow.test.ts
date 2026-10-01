import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mutationAdmitted,
  shadowMutationAdmitted,
  type ExecutionAuthorityProjection,
} from '../src/authority/transaction-admission.ts';

type AdmissionState = ExecutionAuthorityProjection & { unresolved_effect: boolean };

const bools = [false, true] as const;

test('shadow effect admission preserves the legacy truth table when permits agrees', () => {
  for (const currentAuthority of bools) {
    for (const exactRevision of bools) {
      for (const unresolvedEffect of bools) {
        const state: AdmissionState = {
          current_authority: currentAuthority,
          exact_revision: exactRevision,
          unresolved_effect: unresolvedEffect,
        };
        const expected = currentAuthority && exactRevision && !unresolvedEffect;

        assert.equal(mutationAdmitted(state), expected);
        assert.equal(shadowMutationAdmitted(state, expected), expected);
      }
    }
  }
});

test('shadow effect admission fails closed on a hostile permits decision', () => {
  const state: AdmissionState = {
    current_authority: true,
    exact_revision: true,
    unresolved_effect: false,
  };

  assert.throws(
    () => shadowMutationAdmitted(state, false),
    new Error(
      'EFFECT_ADMISSION_SHADOW_DIVERGENCE:current_authority=1:exact_revision=1:' +
        'unresolved_effect=0:legacy=1:permits=0',
    ),
  );
});

test('shadow effect admission rejects a permits grant when legacy denies mutation', () => {
  const state: AdmissionState = {
    current_authority: true,
    exact_revision: true,
    unresolved_effect: true,
  };

  assert.throws(
    () => shadowMutationAdmitted(state, true),
    new Error(
      'EFFECT_ADMISSION_SHADOW_DIVERGENCE:current_authority=1:exact_revision=1:' +
        'unresolved_effect=1:legacy=0:permits=1',
    ),
  );
});
