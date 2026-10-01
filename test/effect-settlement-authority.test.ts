import assert from 'node:assert/strict';
import test from 'node:test';

import { RECEIPT_SCHEMA, type ReceiptFact } from '../src/authority/facts.ts';
import { projectReceipt } from '../src/authority/replay.ts';
import { sha256 } from '../src/digest.ts';
import type { Obligation } from '../src/model.ts';
import { localFileEnoentEvidence } from '../src/observation/evidence.ts';

import {
  settlementDispositionFromRelations,
  type SettlementDisposition,
  type SettlementRelations,
} from '../src/authority/settlement.ts';

const bools = [false, true] as const;

function legacyDisposition(relations: SettlementRelations): SettlementDisposition {
  if (relations.event_asserts_postcondition) return 'DONE';
  if (relations.object_supports_not_dispatched) return 'READY';
  if (
    relations.object_supports_accepted_absence &&
    (!relations.accepted_absence_requires_replay_safety || relations.object_supports_replay_safety)
  ) {
    return 'READY';
  }
  return 'RECOVERY_REQUIRED';
}

test('4x4 settlement owns the proven disposition truth table', () => {
  for (const asserts of bools) {
    for (const supportsAbsence of bools) {
      for (const supportsNotDispatched of bools) {
        for (const requiresReplaySafety of bools) {
          for (const supportsReplaySafety of bools) {
            const relations: SettlementRelations = {
              event_asserts_postcondition: asserts,
              object_supports_accepted_absence: supportsAbsence,
              object_supports_not_dispatched: supportsNotDispatched,
              accepted_absence_requires_replay_safety: requiresReplaySafety,
              object_supports_replay_safety: supportsReplaySafety,
            };
            const expected = legacyDisposition(relations);
            assert.equal(settlementDispositionFromRelations(relations), expected);
          }
        }
      }
    }
  }
});

test('presence, admitted absence, ambiguity, unresolved reservations, and release stay distinct', () => {
  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: true,
      object_supports_accepted_absence: false,
      object_supports_not_dispatched: false,
      accepted_absence_requires_replay_safety: false,
      object_supports_replay_safety: false,
    }),
    'DONE',
  );

  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: false,
      object_supports_accepted_absence: true,
      object_supports_not_dispatched: false,
      accepted_absence_requires_replay_safety: false,
      object_supports_replay_safety: false,
    }),
    'READY',
  );

  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: false,
      object_supports_accepted_absence: false,
      object_supports_not_dispatched: false,
      accepted_absence_requires_replay_safety: false,
      object_supports_replay_safety: false,
    }),
    'RECOVERY_REQUIRED',
  );

  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: false,
      object_supports_accepted_absence: true,
      object_supports_not_dispatched: false,
      accepted_absence_requires_replay_safety: true,
      object_supports_replay_safety: false,
    }),
    'RECOVERY_REQUIRED',
  );

  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: false,
      object_supports_accepted_absence: true,
      object_supports_not_dispatched: false,
      accepted_absence_requires_replay_safety: true,
      object_supports_replay_safety: true,
    }),
    'READY',
  );

  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: false,
      object_supports_accepted_absence: false,
      object_supports_not_dispatched: true,
      accepted_absence_requires_replay_safety: true,
      object_supports_replay_safety: false,
    }),
    'READY',
  );
});

const settledAt = '2026-10-01T00:00:00.000Z';

function receipt(
  work: Obligation,
  kind: ReceiptFact['kind'],
  observed: ReceiptFact['observed'],
): ReceiptFact {
  return {
    schema: RECEIPT_SCHEMA,
    run_id: 'run-shadow',
    obligation_id: work.id,
    claimed_revision: 'revision-shadow',
    claim_commit: 'claim-shadow',
    execution_generation: 1,
    execution_authority_commit: 'authority-shadow',
    kind,
    observed,
    settled_at: settledAt,
  };
}

test('projectReceipt preserves the stage-5 hostile settlement cases', () => {
  const path = '/tmp/shadow-settlement';
  const content = 'expected';
  const work: Obligation = {
    id: 'shadow-file',
    dependencies: [],
    packet: { effect_contract: 'unregistered/effect' },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path,
      content,
    },
  };
  const digest = sha256(content);

  const present = receipt(work, 'observation', {
    verifier: 'file-content-equals/v1',
    path,
    expected_sha256: digest,
    actual_sha256: digest,
    mutation_certainty: 'present',
  });
  assert.equal(projectReceipt(present, work).disposition, 'DONE');

  const absent = receipt(work, 'observation', {
    verifier: 'file-content-equals/v1',
    path,
    expected_sha256: digest,
    mutation_certainty: 'absent',
    absence_evidence: localFileEnoentEvidence(path),
  });
  assert.equal(projectReceipt(absent, work).disposition, 'READY');
  assert.equal(projectReceipt(absent, work, undefined, true).disposition, 'RECOVERY_REQUIRED');

  const uncertain = receipt(work, 'observation', {
    verifier: 'file-content-equals/v1',
    path,
    expected_sha256: digest,
    mutation_certainty: 'uncertain',
    observation_error: 'TRANSPORT_AMBIGUOUS',
  });
  assert.equal(projectReceipt(uncertain, work).disposition, 'RECOVERY_REQUIRED');

  const eventualWork: Obligation = {
    ...work,
    id: 'shadow-eventual-file',
    postcondition: {
      verifier: 'eventually-consistent-file-content-equals/v1',
      path,
      content,
    },
  };
  const nonFinalAbsence = receipt(eventualWork, 'observation', {
    verifier: 'eventually-consistent-file-content-equals/v1',
    path,
    expected_sha256: digest,
    mutation_certainty: 'absent',
    absence_evidence: localFileEnoentEvidence(path),
  });
  assert.equal(projectReceipt(nonFinalAbsence, eventualWork).disposition, 'RECOVERY_REQUIRED');
});

test('projectReceipt makes trusted not-dispatched release authoritative without weakening recovery', () => {
  const work: Obligation = {
    id: 'shadow-release',
    dependencies: [],
    packet: { effect_contract: 'unregistered/effect' },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/tmp/shadow-release',
      content: 'expected',
    },
  };
  const notDispatched = receipt(work, 'effect-not-dispatched', null);
  const terminated = receipt(work, 'execution-terminated', null);

  assert.equal(projectReceipt(notDispatched, work).disposition, 'RECOVERY_REQUIRED');
  assert.equal(projectReceipt(notDispatched, work, undefined, true, true).disposition, 'READY');
  assert.equal(projectReceipt(terminated, work).disposition, 'RECOVERY_REQUIRED');
});
