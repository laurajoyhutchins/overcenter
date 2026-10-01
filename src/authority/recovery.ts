import {
  settlementDispositionFromRelations,
  type SettlementRelations,
} from './settlement.ts';

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

export interface RecoveryRoutingShadow {
  legacy: RecoveryEvent;
  derived: RecoveryEvent;
  agrees: boolean;
}

const RECOVERY_EVENTS = ['reconcile', 'retry', 'settle'] as const satisfies readonly RecoveryEvent[];

function retryEstablished(relations: SettlementRelations): boolean {
  if (relations.object_supports_not_dispatched) return true;
  return (
    relations.object_supports_accepted_absence &&
    (!relations.accepted_absence_requires_replay_safety ||
      relations.object_supports_replay_safety)
  );
}

function world(
  coordinate: string,
  outcome: PossibleEffectOutcome,
): PossibleEffectWorld {
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
  return [
    world(coordinate, 'postcondition-asserted'),
    world(coordinate, 'not-dispatched'),
  ];
}

function eventPermittedInWorld(
  event: RecoveryEvent,
  currentCoordinate: string,
  candidate: PossibleEffectWorld,
): boolean {
  if (candidate.coordinate !== currentCoordinate) return event === 'reconcile';
  if (event === 'reconcile') return true;
  if (event === 'settle') return candidate.outcome === 'postcondition-asserted';
  return candidate.outcome === 'not-dispatched';
}

export function recoveryEventsPermittedInAllWorlds(
  currentCoordinate: string,
  worlds: readonly PossibleEffectWorld[],
): RecoveryEvent[] {
  if (!currentCoordinate) throw new Error('RECOVERY_COORDINATE_INVALID');
  if (worlds.length === 0) return ['reconcile'];

  return RECOVERY_EVENTS.filter((event) =>
    worlds.every((candidate) => eventPermittedInWorld(event, currentCoordinate, candidate)),
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

function legacyRecoveryEvent(relations: SettlementRelations): RecoveryEvent {
  const disposition = settlementDispositionFromRelations(relations);
  if (disposition === 'DONE') return 'settle';
  if (disposition === 'READY') return 'retry';
  return 'reconcile';
}

export function shadowRecoveryRouting(
  coordinate: string,
  relations: SettlementRelations,
): RecoveryRoutingShadow {
  const legacy = legacyRecoveryEvent(relations);
  const derived = deriveRecoveryPlan(coordinate, relations).preferred;
  return { legacy, derived, agrees: legacy === derived };
}
