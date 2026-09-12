import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertExecutionIdentity,
  canTransition,
  classifyRecovery,
  mutationCertaintyFromFacts,
} from '../lib/execution-transaction.js';

function snapshot(lifecycle, mutation_certainty) {
  return {
    identity: {
      execution_id: 'execution-1',
      operation_id: 'operation-1',
      project_ref: 'project-1',
      subject_key: 'subject-1',
      run_id: 'run-1',
      lease_ref: 'lease-1',
      lease_epoch: 1,
      authority_epoch: 3,
      authority_repository: 'laurajoyhutchins/overcenter',
      authority_revision: 'a'.repeat(40),
      graph_fingerprint: 'graph-hash',
      transition_fingerprint: 'transition-hash',
      idempotency_scope: 'project',
      idempotency_key: 'intent-1',
      intent_sha256: 'intent-hash',
    },
    lifecycle,
    attempt_epoch: 1,
    mutation_certainty,
    effect_ref: null,
    proof_ids: [],
    settled: false,
  };
}

test('kernel exposes one monotonic lifecycle transition table', () => {
  assert.equal(canTransition('prepared', 'executing'), true);
  assert.equal(canTransition('prepared', 'rejected'), true);
  assert.equal(canTransition('executing', 'effect_uncertain'), true);
  assert.equal(canTransition('effect_uncertain', 'effect_confirmed'), true);
  assert.equal(canTransition('effect_uncertain', 'effect_absent'), true);
  assert.equal(canTransition('effect_confirmed', 'settled'), true);
  assert.equal(canTransition('effect_confirmed', 'effect_absent'), false);
  assert.equal(canTransition('settled', 'executing'), false);
});

test('unknown provider outcome is never a blind retry permission', () => {
  assert.equal(mutationCertaintyFromFacts({
    transport: 'unknown',
    committed: null,
    effect_ref: null,
    response_sha256: null,
    evidence: null,
  }), 'may_have_mutated');

  assert.equal(classifyRecovery(snapshot('effect_uncertain', 'may_have_mutated')), 'confirm_only');
});

test('confirmed and absent provider facts settle without repeating the effect', () => {
  assert.equal(mutationCertaintyFromFacts({
    transport: 'accepted',
    committed: true,
    effect_ref: 'provider-effect-1',
    response_sha256: 'response-hash',
    evidence: {},
  }), 'confirmed_mutated');

  assert.equal(mutationCertaintyFromFacts({
    status: 'confirmed',
    effect_ref: 'provider-effect-1',
    predicate: 'exact-effect',
    evidence: {},
  }), 'confirmed_mutated');

  assert.equal(mutationCertaintyFromFacts({
    status: 'absent',
    effect_ref: null,
    predicate: 'exact-effect',
    evidence: {},
  }), 'definitely_not_mutated');

  assert.equal(classifyRecovery(snapshot('effect_uncertain', 'confirmed_mutated')), 'settle_confirmed');
  assert.equal(classifyRecovery(snapshot('effect_uncertain', 'definitely_not_mutated')), 'settle_no_effect');
});

test('prepared execution is retryable only before an effect attempt', () => {
  assert.equal(classifyRecovery(snapshot('prepared', 'definitely_not_mutated')), 'retry_before_effect');
  assert.equal(classifyRecovery(snapshot('executing', 'definitely_not_mutated')), 'retry_before_effect');
});


test('postgres store binds proof and settlement replay to every exact fact', async () => {
  const source = await readFile(new URL('../src/adapters/postgres/execution-transaction-store.ts', import.meta.url), 'utf8');
  assert.match(source, /text\(row\.authority_repository\) !== input\.authority_repository/);
  assert.match(source, /text\(row\.predicate_kind\) !== input\.predicate/);
  assert.match(source, /integer\(row\.attempt_epoch, 'attempt_epoch'\) !== input\.attempt_epoch/);
  assert.match(source, /integer\(row\.authority_epoch, 'authority_epoch'\) !== input\.authority_epoch/);
  assert.match(source, /receipt\.disposition !== input\.disposition/);
  assert.match(source, /receipt\.effect_ref !== input\.effect_ref/);
  assert.match(source, /integer\(current\.current_attempt_epoch, 'current_attempt_epoch'\) !== input\.attempt_epoch/);
});


test('identity validation rejects an unknown subject kind at the kernel boundary', () => {
  const identity = {
    ...snapshot('prepared', 'definitely_not_mutated').identity,
    subject_kind: 'unknown_subject_kind',
  };
  assert.throws(
    () => assertExecutionIdentity(identity),
    /subject_kind is invalid/,
  );
});
