import type { Disposition } from '../model.ts';

export type SettlementDisposition = Exclude<Disposition, 'WAITING'>;

export interface SettlementRelations {
  event_asserts_postcondition: boolean;
  object_supports_accepted_absence: boolean;
  object_supports_not_dispatched: boolean;
  accepted_absence_requires_replay_safety: boolean;
  object_supports_replay_safety: boolean;
}

export function settlementDispositionFromRelations(
  relations: SettlementRelations,
): SettlementDisposition {
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

export function shadowSettlementDisposition(
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
        `supports_not_dispatched=${Number(relations.object_supports_not_dispatched)}`,
        `requires_replay_safety=${Number(relations.accepted_absence_requires_replay_safety)}`,
        `supports_replay_safety=${Number(relations.object_supports_replay_safety)}`,
        `legacy=${legacy}`,
        `projected=${projected}`,
      ].join(':'),
    );
  }
  return legacy;
}
