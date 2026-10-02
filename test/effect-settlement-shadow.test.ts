import assert from 'node:assert/strict';
import test from 'node:test';

import { RECEIPT_SCHEMA, type ReceiptFact } from '../src/authority/facts.ts';
import { projectReceipt } from '../src/authority/replay.ts';
import { sha256 } from '../src/digest.ts';
import type { Obligation } from '../src/model.ts';
import { localFileEnoentEvidence } from '../src/observation/evidence.ts';

type SettlementDisposition = 'DONE' | 'READY' | 'RECOVERY_REQUIRED';

interface SettlementRelations {
  event_asserts_postcondition: boolean;
  object_supports_accepted_absence: boolean;
  accepted_absence_requires_replay_safety: boolean;
  object_supports_replay_safety: boolean;
}

function settlementDispositionFromRelations(relations: SettlementRelations): SettlementDisposition {
  if (relations.event_asserts_postcondition) return 'DONE';
  if (
    relations.object_supports_accepted_absence &&
    (!relations.accepted_absence_requires_replay_safety || relations.object_supports_replay_safety)
  ) {
    return 'READY';
  }
  return 'RECOVERY_REQUIRED';
}

function shadowSettlementDisposition(
  legacy: SettlementDisposition,
  relations: SettlementRelations,
): SettlementDisposition {
  const projected = settlementDispositionFromRelations(relations);
  if (legacy !== projected) {
    throw new Error(
      [
        'SETTLEMENT_SHADOW_DIVERGENCE',
        `asserts=${Number(relations.event_asserts_postcondition)}`,
        `supports_absence=${Number(relations.object_supports_accepted_absence)}`,
        `requires_replay_safety=${Number(relations.accepted_absence_requires_replay_safety)}`,
        `supports_replay_safety=${Number(relations.object_supports_replay_safety)}`,
        `legacy=${legacy}`,
        `projected=${projected}`,
      ].join(':'),
    );
  }
  return legacy;
}

const bools = [false, true] as const;

function legacyDisposition(relations: SettlementRelations): SettlementDisposition {
  if (relations.event_asserts_postcondition) return 'DONE';
  if (
    relations.object_supports_accepted_absence &&
    (!relations.accepted_absence_requires_replay_safety || relations.object_supports_replay_safety)
  ) {
    return 'READY';
  }
  return 'RECOVERY_REQUIRED';
}

test('4x4 settlement matches the legacy disposition truth table', () => {
  for (const asserts of bools) {
    for (const supportsAbsence of bools) {
      for (const requiresReplaySafety of bools) {
        for (const supportsReplaySafety of bools) {
          const relations: SettlementRelations = {
            event_asserts_postcondition: asserts,
            object_supports_accepted_absence: supportsAbsence,
            accepted_absence_requires_replay_safety: requiresReplaySafety,
            object_supports_replay_safety: supportsReplaySafety,
          };
          const expected = legacyDisposition(relations);
          assert.equal(settlementDispositionFromRelations(relations), expected);
          assert.equal(shadowSettlementDisposition(expected, relations), expected);
        }
      }
    }
  }
});

test('presence, admitted absence, ambiguity, and unresolved reservations stay distinct', () => {
  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: true,
      object_supports_accepted_absence: false,
      accepted_absence_requires_replay_safety: false,
      object_supports_replay_safety: false,
    }),
    'DONE',
  );

  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: false,
      object_supports_accepted_absence: true,
      accepted_absence_requires_replay_safety: false,
      object_supports_replay_safety: false,
    }),
    'READY',
  );

  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: false,
      object_supports_accepted_absence: false,
      accepted_absence_requires_replay_safety: false,
      object_supports_replay_safety: false,
    }),
    'RECOVERY_REQUIRED',
  );

  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: false,
      object_supports_accepted_absence: true,
      accepted_absence_requires_replay_safety: true,
      object_supports_replay_safety: false,
    }),
    'RECOVERY_REQUIRED',
  );

  assert.equal(
    settlementDispositionFromRelations({
      event_asserts_postcondition: false,
      object_supports_accepted_absence: true,
      accepted_absence_requires_replay_safety: true,
      object_supports_replay_safety: true,
    }),
    'READY',
  );
});

test('shadow settlement fails closed on a hostile 4x4 disposition', () => {
  const relations: SettlementRelations = {
    event_asserts_postcondition: false,
    object_supports_accepted_absence: true,
    accepted_absence_requires_replay_safety: false,
    object_supports_replay_safety: false,
  };

  assert.throws(
    () => shadowSettlementDisposition('RECOVERY_REQUIRED', relations),
    new Error(
      'SETTLEMENT_SHADOW_DIVERGENCE:asserts=0:supports_absence=1:' +
        'requires_replay_safety=0:supports_replay_safety=0:' +
        'legacy=RECOVERY_REQUIRED:projected=READY',
    ),
  );
});

const settledAt = '2026-10-01T00:00:00.000Z';

function observationReceipt(
  work: Obligation,
  observed: NonNullable<ReceiptFact['observed']>,
): ReceiptFact {
  return {
    schema: RECEIPT_SCHEMA,
    run_id: 'run-shadow',
    obligation_id: work.id,
    claimed_revision: 'revision-shadow',
    claim_commit: 'claim-shadow',
    execution_generation: 1,
    execution_authority_commit: 'authority-shadow',
    kind: 'observation',
    observed,
    settled_at: settledAt,
  };
}

test('projectReceipt shadows the stage-5 hostile settlement cases', () => {
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

  const present = observationReceipt(work, {
    verifier: 'file-content-equals/v1',
    path,
    expected_sha256: digest,
    actual_sha256: digest,
    mutation_certainty: 'present',
  });
  assert.equal(projectReceipt(present, work).disposition, 'DONE');

  const absent = observationReceipt(work, {
    verifier: 'file-content-equals/v1',
    path,
    expected_sha256: digest,
    mutation_certainty: 'absent',
    absence_evidence: localFileEnoentEvidence(path),
  });
  assert.equal(projectReceipt(absent, work).disposition, 'READY');
  assert.equal(projectReceipt(absent, work, undefined, true).disposition, 'RECOVERY_REQUIRED');

  const uncertain = observationReceipt(work, {
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
  const nonFinalAbsence = observationReceipt(eventualWork, {
    verifier: 'eventually-consistent-file-content-equals/v1',
    path,
    expected_sha256: digest,
    mutation_certainty: 'absent',
    absence_evidence: localFileEnoentEvidence(path),
  });
  assert.equal(projectReceipt(nonFinalAbsence, eventualWork).disposition, 'RECOVERY_REQUIRED');
});
