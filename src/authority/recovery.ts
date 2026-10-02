import {
  explainRelationalEvent,
  type RelationalEventExplanation,
  type RelationalExplanationInput,
} from './project-state.ts';

export type RecoveryEvent = 'reconcile' | 'retry' | 'settle';

export interface RecoveryRelations {
  event_asserts_postcondition: boolean;
  object_supports_accepted_absence: boolean;
  object_supports_not_dispatched: boolean;
  accepted_absence_requires_replay_safety: boolean;
  object_supports_replay_safety: boolean;
}
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

const RECOVERY_EVENTS = [
  'reconcile',
  'retry',
  'settle',
] as const satisfies readonly RecoveryEvent[];

function retryEstablished(relations: RecoveryRelations): boolean {
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
  relations: RecoveryRelations,
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
  relations: RecoveryRelations,
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

function legacyRecoveryEvent(relations: RecoveryRelations): RecoveryEvent {
  if (relations.event_asserts_postcondition) return 'settle';
  if (
    relations.object_supports_not_dispatched ||
    (relations.object_supports_accepted_absence &&
      (!relations.accepted_absence_requires_replay_safety ||
        relations.object_supports_replay_safety))
  ) {
    return 'retry';
  }
  return 'reconcile';
}

export function shadowRecoveryRouting(
  coordinate: string,
  relations: RecoveryRelations,
): RecoveryRoutingShadow {
  const legacy = legacyRecoveryEvent(relations);
  const derived = deriveRecoveryPlan(coordinate, relations).preferred;
  return { legacy, derived, agrees: legacy === derived };
}
