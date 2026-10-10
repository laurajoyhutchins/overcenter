import {
  explainRelationalEvent,
  type RelationalEventExplanation,
  type RelationalExplanationInput,
} from './relational-explanation.ts';
import type { SettlementRelations } from './settlement.ts';

export type RecoveryEvent = 'reconcile' | 'retry' | 'settle';
export type PossibleEffectOutcome = 'postcondition-asserted' | 'not-dispatched';

export interface PossibleEffectWorld {
  coordinate: string;
  outcome: PossibleEffectOutcome;
}

export interface RecoveryPlan {
  coordinate: string;
  worlds: PossibleEffectWorld[];
  permitted: RecoveryEvent[];
  preferred: RecoveryEvent;
}

export type RecoveryDisposition =
  | 'settle'
  | 'retry-fresh-execution'
  | 'reobserve'
  | 'degrade'
  | 'escalate'
  | 'safe-hold';

export interface RecoveryEffectAuthority {
  effect_contract: string;
  coordinate: string;
}

export interface RecoveryFallback {
  obligation_id: string;
  admitted: boolean;
  required_safety_supported: boolean;
  ordinary_authority: RecoveryEffectAuthority[];
  fallback_authority: RecoveryEffectAuthority[];
}

export interface RecoveryPolicy {
  observation_available: boolean;
  observation_attempts_remaining: number;
  fallback?: RecoveryFallback;
  operator_judgment_available: boolean;
}

export interface RecoveryDecision {
  effect_plan: RecoveryPlan;
  disposition: RecoveryDisposition;
  reason:
    | 'postcondition-established'
    | 'safe-retry-established'
    | 'observation-budget-available'
    | 'admitted-authority-narrowing-fallback'
    | 'conflicting-terminal-evidence'
    | 'operator-judgment-required'
    | 'no-safe-recovery-action';
  fallback_obligation_id?: string;
}

const RECOVERY_EVENTS = [
  'reconcile',
  'retry',
  'settle',
] as const satisfies readonly RecoveryEvent[];

function retryEstablished(relations: SettlementRelations): boolean {
  if (relations.object_supports_not_dispatched) return true;
  return (
    relations.object_supports_accepted_absence &&
    (!relations.accepted_absence_requires_replay_safety || relations.object_supports_replay_safety)
  );
}

function world(coordinate: string, outcome: PossibleEffectOutcome): PossibleEffectWorld {
  return { coordinate, outcome };
}

export function possibleEffectWorlds(
  coordinate: string,
  relations: SettlementRelations,
): PossibleEffectWorld[] {
  if (!coordinate) throw new Error('RECOVERY_COORDINATE_INVALID');

  const success = relations.event_asserts_postcondition;
  const retry = retryEstablished(relations);

  if (success && !retry) return [world(coordinate, 'postcondition-asserted')];
  if (retry && !success) return [world(coordinate, 'not-dispatched')];

  // No terminal fact means both outcomes remain compatible. Conflicting terminal
  // facts are treated the same way: preserve both worlds and fail closed.
  return [world(coordinate, 'postcondition-asserted'), world(coordinate, 'not-dispatched')];
}

function eventId(event: RecoveryEvent): string {
  return `recovery-event:${event}`;
}

function eventRoot(event: RecoveryEvent): string {
  return `recovery-permitted:${event}`;
}

function outcomeProposition(outcome: PossibleEffectOutcome): string {
  return `effect-outcome:${outcome}`;
}

function relationalWorld(
  currentCoordinate: string,
  candidate: PossibleEffectWorld,
): RelationalExplanationInput {
  const success = outcomeProposition('postcondition-asserted');
  const notDispatched = outcomeProposition('not-dispatched');
  const evidence = `world-evidence:${candidate.outcome}`;

  return {
    coordinates: [...new Set([currentCoordinate, candidate.coordinate])].map((id) => ({ id })),
    objects: [
      { id: 'recovery-observer', coordinate: currentCoordinate },
      { id: 'recovery-authority', coordinate: candidate.coordinate },
      { id: evidence, coordinate: candidate.coordinate },
    ],
    events: RECOVERY_EVENTS.map((event) => ({
      id: eventId(event),
      coordinate: currentCoordinate,
    })),
    propositions: [
      ...RECOVERY_EVENTS.map((event) => ({
        id: eventRoot(event),
        coordinate: currentCoordinate,
      })),
      { id: success, coordinate: currentCoordinate },
      { id: notDispatched, coordinate: currentCoordinate },
    ],
    permits: [
      { object: 'recovery-observer', event: eventId('reconcile') },
      { object: 'recovery-authority', event: eventId('retry') },
      { object: 'recovery-authority', event: eventId('settle') },
    ],
    supports: [{ object: evidence, proposition: outcomeProposition(candidate.outcome) }],
    requires: [
      { proposition: eventRoot('retry'), required: notDispatched },
      { proposition: eventRoot('settle'), required: success },
    ],
  };
}

export function explainRecoveryEvent(
  currentCoordinate: string,
  candidate: PossibleEffectWorld,
  event: RecoveryEvent,
): RelationalEventExplanation {
  if (!currentCoordinate) throw new Error('RECOVERY_COORDINATE_INVALID');
  return explainRelationalEvent(
    relationalWorld(currentCoordinate, candidate),
    eventId(event),
    eventRoot(event),
  );
}

function eventPermitted(explanation: RelationalEventExplanation): boolean {
  return (
    explanation.permitted_by.length > 0 &&
    explanation.requirements.every((requirement) => requirement.state === 'supported')
  );
}

export function recoveryEventsPermittedInAllWorlds(
  currentCoordinate: string,
  worlds: readonly PossibleEffectWorld[],
): RecoveryEvent[] {
  if (!currentCoordinate) throw new Error('RECOVERY_COORDINATE_INVALID');
  if (worlds.length === 0) return ['reconcile'];

  return RECOVERY_EVENTS.filter((event) =>
    worlds.every((candidate) =>
      eventPermitted(explainRecoveryEvent(currentCoordinate, candidate, event)),
    ),
  );
}

export function deriveRecoveryPlan(
  coordinate: string,
  relations: SettlementRelations,
): RecoveryPlan {
  const worlds = possibleEffectWorlds(coordinate, relations);
  const permitted = recoveryEventsPermittedInAllWorlds(coordinate, worlds);
  const preferred = permitted.includes('settle')
    ? 'settle'
    : permitted.includes('retry')
      ? 'retry'
      : 'reconcile';
  return { coordinate, worlds, permitted, preferred };
}

function effectAuthorityKey(authority: RecoveryEffectAuthority): string | null {
  if (!authority.effect_contract || !authority.coordinate) return null;
  return `${authority.effect_contract}\u0000${authority.coordinate}`;
}

function effectAuthoritySet(values: readonly RecoveryEffectAuthority[]): Set<string> | null {
  const authorities = new Set<string>();
  for (const value of values) {
    const key = effectAuthorityKey(value);
    if (!key) return null;
    authorities.add(key);
  }
  return authorities;
}

export function fallbackPreservesAuthority(fallback: RecoveryFallback): boolean {
  if (!fallback.obligation_id) return false;

  const ordinary = effectAuthoritySet(fallback.ordinary_authority);
  const degraded = effectAuthoritySet(fallback.fallback_authority);
  if (!ordinary || !degraded) return false;

  return [...degraded].every((authority) => ordinary.has(authority));
}

function fallbackAdmissible(fallback: RecoveryFallback): boolean {
  return (
    fallback.admitted && fallback.required_safety_supported && fallbackPreservesAuthority(fallback)
  );
}

function validObservationBudget(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function deriveRecoveryDecision(
  coordinate: string,
  relations: SettlementRelations,
  policy: RecoveryPolicy,
): RecoveryDecision {
  if (!validObservationBudget(policy.observation_attempts_remaining)) {
    throw new Error('RECOVERY_OBSERVATION_BUDGET_INVALID');
  }

  const effectPlan = deriveRecoveryPlan(coordinate, relations);
  if (effectPlan.preferred === 'settle') {
    return {
      effect_plan: effectPlan,
      disposition: 'settle',
      reason: 'postcondition-established',
    };
  }
  if (effectPlan.preferred === 'retry') {
    return {
      effect_plan: effectPlan,
      disposition: 'retry-fresh-execution',
      reason: 'safe-retry-established',
    };
  }

  if (policy.observation_available && policy.observation_attempts_remaining > 0) {
    return {
      effect_plan: effectPlan,
      disposition: 'reobserve',
      reason: 'observation-budget-available',
    };
  }

  const conflictingTerminalEvidence =
    relations.event_asserts_postcondition && retryEstablished(relations);
  if (!conflictingTerminalEvidence && policy.fallback && fallbackAdmissible(policy.fallback)) {
    return {
      effect_plan: effectPlan,
      disposition: 'degrade',
      reason: 'admitted-authority-narrowing-fallback',
      fallback_obligation_id: policy.fallback.obligation_id,
    };
  }

  if (policy.operator_judgment_available) {
    return {
      effect_plan: effectPlan,
      disposition: 'escalate',
      reason: conflictingTerminalEvidence
        ? 'conflicting-terminal-evidence'
        : 'operator-judgment-required',
    };
  }

  return {
    effect_plan: effectPlan,
    disposition: 'safe-hold',
    reason: conflictingTerminalEvidence
      ? 'conflicting-terminal-evidence'
      : 'no-safe-recovery-action',
  };
}
