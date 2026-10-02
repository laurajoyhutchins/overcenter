import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveRecoveryPlan,
  explainRecoveryEvent,
  possibleEffectWorlds,
  recoveryEventsPermittedInAllWorlds,
  type PossibleEffectWorld,
} from '../src/authority/recovery.ts';
import type { SettlementRelations } from '../src/authority/settlement.ts';

const coordinate = 'coordinate-current';
function relations(overrides: Partial<SettlementRelations> = {}): SettlementRelations {
  return {
    event_asserts_postcondition: false,
    object_supports_accepted_absence: false,
    object_supports_not_dispatched: false,
    accepted_absence_requires_replay_safety: false,
    object_supports_replay_safety: false,
    ...overrides,
  };
}

test('known success permits settlement and reconciliation without replay', () => {
  const plan = deriveRecoveryPlan(coordinate, relations({ event_asserts_postcondition: true }));
  assert.deepEqual(plan.worlds, [{ coordinate, outcome: 'postcondition-asserted' }]);
  assert.deepEqual(plan.permitted, ['reconcile', 'settle']);
  assert.equal(plan.preferred, 'settle');
});

test('trusted not-dispatched support permits retry and reconciliation', () => {
  const plan = deriveRecoveryPlan(coordinate, relations({ object_supports_not_dispatched: true }));
  assert.deepEqual(plan.worlds, [{ coordinate, outcome: 'not-dispatched' }]);
  assert.deepEqual(plan.permitted, ['reconcile', 'retry']);
  assert.equal(plan.preferred, 'retry');
});

test('absence only permits retry when replay safety requirements are supported', () => {
  const unsafe = deriveRecoveryPlan(
    coordinate,
    relations({
      object_supports_accepted_absence: true,
      accepted_absence_requires_replay_safety: true,
    }),
  );
  assert.equal(unsafe.preferred, 'reconcile');
  assert.deepEqual(unsafe.permitted, ['reconcile']);

  const safe = deriveRecoveryPlan(
    coordinate,
    relations({
      object_supports_accepted_absence: true,
      accepted_absence_requires_replay_safety: true,
      object_supports_replay_safety: true,
    }),
  );
  assert.equal(safe.preferred, 'retry');
  assert.deepEqual(safe.permitted, ['reconcile', 'retry']);
});

test('ambiguous effect outcome never permits duplicate mutation or settlement', () => {
  const plan = deriveRecoveryPlan(coordinate, relations());
  assert.deepEqual(plan.worlds, [
    { coordinate, outcome: 'postcondition-asserted' },
    { coordinate, outcome: 'not-dispatched' },
  ]);
  assert.deepEqual(plan.permitted, ['reconcile']);
  assert.equal(plan.preferred, 'reconcile');
});

test('crash and restart preserve the same possible-world action intersection', () => {
  const before = possibleEffectWorlds(coordinate, relations());
  const after = JSON.parse(JSON.stringify(before)) as PossibleEffectWorld[];
  assert.deepEqual(recoveryEventsPermittedInAllWorlds(coordinate, after), ['reconcile']);
  assert.deepEqual(after, before);
});

test('ABA coordinate drift cannot revive retry or settlement from stale worlds', () => {
  const staleRetry = possibleEffectWorlds(
    'coordinate-old',
    relations({ object_supports_not_dispatched: true }),
  );
  assert.deepEqual(recoveryEventsPermittedInAllWorlds(coordinate, staleRetry), ['reconcile']);

  const staleSuccess = possibleEffectWorlds(
    'coordinate-old',
    relations({ event_asserts_postcondition: true }),
  );
  assert.deepEqual(recoveryEventsPermittedInAllWorlds(coordinate, staleSuccess), ['reconcile']);
});

test('ABA explanation reports stale authority and stale support before intersecting actions', () => {
  const candidate = {
    coordinate: 'coordinate-old',
    outcome: 'not-dispatched',
  } as const;
  const retry = explainRecoveryEvent(coordinate, candidate, 'retry');
  assert.deepEqual(retry.permitted_by, []);
  assert.deepEqual(retry.stale_authority, ['recovery-authority']);
  assert.deepEqual(
    retry.requirements.map((requirement) => ({
      proposition: requirement.proposition,
      state: requirement.state,
      stale_supporting_objects: requirement.stale_supporting_objects,
    })),
    [
      {
        proposition: 'effect-outcome:not-dispatched',
        state: 'stale-support',
        stale_supporting_objects: ['world-evidence:not-dispatched'],
      },
    ],
  );

  const reconcile = explainRecoveryEvent(coordinate, candidate, 'reconcile');
  assert.deepEqual(reconcile.permitted_by, ['recovery-observer']);
  assert.deepEqual(reconcile.stale_authority, []);
  assert.deepEqual(reconcile.requirements, []);
});

test('conflicting terminal facts preserve both worlds and fail closed', () => {
  const plan = deriveRecoveryPlan(
    coordinate,
    relations({
      event_asserts_postcondition: true,
      object_supports_not_dispatched: true,
    }),
  );
  assert.deepEqual(plan.permitted, ['reconcile']);
  assert.equal(plan.preferred, 'reconcile');
});
