import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveRecoveryDecision,
  deriveRecoveryPlan,
  explainRecoveryEvent,
  fallbackPreservesAuthority,
  possibleEffectWorlds,
  recoveryEventsPermittedInAllWorlds,
  shadowRecoveryRouting,
  type PossibleEffectWorld,
  type RecoveryPolicy,
} from '../src/authority/recovery.ts';
import type { SettlementRelations } from '../src/authority/settlement.ts';

const coordinate = 'coordinate-current';
const bools = [false, true] as const;

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

function retryEstablished(value: SettlementRelations): boolean {
  return (
    value.object_supports_not_dispatched ||
    (value.object_supports_accepted_absence &&
      (!value.accepted_absence_requires_replay_safety || value.object_supports_replay_safety))
  );
}

function policy(overrides: Partial<RecoveryPolicy> = {}): RecoveryPolicy {
  return {
    observation_available: false,
    observation_attempts_remaining: 0,
    operator_judgment_available: false,
    ...overrides,
  };
}

test('possible-world recovery shadows every reachable settlement relation valuation', () => {
  for (const asserts of bools) {
    for (const supportsAbsence of bools) {
      for (const supportsNotDispatched of bools) {
        for (const requiresReplaySafety of bools) {
          for (const supportsReplaySafety of bools) {
            const value = relations({
              event_asserts_postcondition: asserts,
              object_supports_accepted_absence: supportsAbsence,
              object_supports_not_dispatched: supportsNotDispatched,
              accepted_absence_requires_replay_safety: requiresReplaySafety,
              object_supports_replay_safety: supportsReplaySafety,
            });
            const shadow = shadowRecoveryRouting(coordinate, value);
            const contradictory = asserts && retryEstablished(value);
            if (contradictory) {
              assert.equal(shadow.derived, 'reconcile');
              assert.equal(shadow.agrees, false);
            } else {
              assert.equal(shadow.agrees, true);
            }
          }
        }
      }
    }
  }
});

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
  assert.equal(
    shadowRecoveryRouting(
      coordinate,
      relations({
        event_asserts_postcondition: true,
        object_supports_not_dispatched: true,
      }),
    ).agrees,
    false,
  );
});

test('recovery decision settles or retries before considering degraded operation', () => {
  const fallback = {
    obligation_id: 'degraded',
    admitted: true,
    required_safety_supported: true,
    ordinary_authority: [{ effect_contract: 'github-status', coordinate }],
    fallback_authority: [],
  };
  assert.equal(
    deriveRecoveryDecision(
      coordinate,
      relations({ event_asserts_postcondition: true }),
      policy({ fallback }),
    ).disposition,
    'settle',
  );
  assert.equal(
    deriveRecoveryDecision(
      coordinate,
      relations({ object_supports_not_dispatched: true }),
      policy({ fallback }),
    ).disposition,
    'retry-fresh-execution',
  );
});

test('ambiguous recovery spends bounded observation before degrading', () => {
  const decision = deriveRecoveryDecision(
    coordinate,
    relations(),
    policy({
      observation_available: true,
      observation_attempts_remaining: 2,
      fallback: {
        obligation_id: 'read-only-fallback',
        admitted: true,
        required_safety_supported: true,
        ordinary_authority: [{ effect_contract: 'provider-write', coordinate }],
        fallback_authority: [],
      },
    }),
  );
  assert.equal(decision.disposition, 'reobserve');
  assert.equal(decision.reason, 'observation-budget-available');
});

test('admitted fallback may remove effect authority but never add it', () => {
  const narrower = {
    obligation_id: 'read-only-fallback',
    admitted: true,
    required_safety_supported: true,
    ordinary_authority: [
      { effect_contract: 'provider-read', coordinate: 'resource-a' },
      { effect_contract: 'provider-write', coordinate: 'resource-a' },
    ],
    fallback_authority: [{ effect_contract: 'provider-read', coordinate: 'resource-a' }],
  };
  assert.equal(fallbackPreservesAuthority(narrower), true);
  assert.deepEqual(
    deriveRecoveryDecision(coordinate, relations(), policy({ fallback: narrower })),
    {
      effect_plan: deriveRecoveryPlan(coordinate, relations()),
      disposition: 'degrade',
      reason: 'admitted-authority-narrowing-fallback',
      fallback_obligation_id: 'read-only-fallback',
    },
  );

  assert.equal(
    fallbackPreservesAuthority({
      ...narrower,
      fallback_authority: [
        { effect_contract: 'provider-read', coordinate: 'resource-a' },
        { effect_contract: 'break-glass-admin', coordinate: 'resource-a' },
      ],
    }),
    false,
  );
});

test('admitted fallback without supported safety proposition cannot degrade', () => {
  const decision = deriveRecoveryDecision(
    coordinate,
    relations(),
    policy({
      fallback: {
        obligation_id: 'unsupported-fallback',
        admitted: true,
        required_safety_supported: false,
        ordinary_authority: [{ effect_contract: 'provider-write', coordinate }],
        fallback_authority: [],
      },
      operator_judgment_available: true,
    }),
  );
  assert.equal(decision.disposition, 'escalate');
  assert.equal(decision.reason, 'operator-judgment-required');
});

test('same effect contract at a different coordinate is not authority preserving', () => {
  assert.equal(
    fallbackPreservesAuthority({
      obligation_id: 'coordinate-drift',
      admitted: true,
      required_safety_supported: true,
      ordinary_authority: [{ effect_contract: 'provider-write', coordinate: 'resource-a' }],
      fallback_authority: [{ effect_contract: 'provider-write', coordinate: 'resource-b' }],
    }),
    false,
  );
});

test('broader or unadmitted fallback cannot escape into degraded operation', () => {
  const broader = {
    obligation_id: 'overpowered-fallback',
    admitted: true,
    required_safety_supported: true,
    ordinary_authority: [{ effect_contract: 'provider-read', coordinate: 'resource-a' }],
    fallback_authority: [
      { effect_contract: 'provider-read', coordinate: 'resource-a' },
      { effect_contract: 'provider-write', coordinate: 'resource-a' },
    ],
  };
  assert.equal(
    deriveRecoveryDecision(
      coordinate,
      relations(),
      policy({ fallback: broader, operator_judgment_available: true }),
    ).disposition,
    'escalate',
  );

  assert.equal(
    deriveRecoveryDecision(
      coordinate,
      relations(),
      policy({
        fallback: {
          ...broader,
          admitted: false,
          required_safety_supported: true,
          fallback_authority: [],
        },
      }),
    ).disposition,
    'safe-hold',
  );
});

test('conflicting terminal evidence never selects a degraded fallback', () => {
  const decision = deriveRecoveryDecision(
    coordinate,
    relations({
      event_asserts_postcondition: true,
      object_supports_not_dispatched: true,
    }),
    policy({
      fallback: {
        obligation_id: 'otherwise-safe-fallback',
        admitted: true,
        required_safety_supported: true,
        ordinary_authority: [{ effect_contract: 'provider-write', coordinate }],
        fallback_authority: [],
      },
      operator_judgment_available: true,
    }),
  );
  assert.equal(decision.disposition, 'escalate');
  assert.equal(decision.reason, 'conflicting-terminal-evidence');
});

test('exhausted recovery with no admitted fallback or judgment holds safely', () => {
  const decision = deriveRecoveryDecision(
    coordinate,
    relations(),
    policy({ observation_available: true, observation_attempts_remaining: 0 }),
  );
  assert.equal(decision.disposition, 'safe-hold');
  assert.equal(decision.reason, 'no-safe-recovery-action');
});

test('invalid observation budgets fail closed', () => {
  assert.throws(
    () =>
      deriveRecoveryDecision(
        coordinate,
        relations(),
        policy({ observation_attempts_remaining: -1 }),
      ),
    /RECOVERY_OBSERVATION_BUDGET_INVALID/,
  );
});
