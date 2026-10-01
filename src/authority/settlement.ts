import type { Disposition } from '../model.ts';

export type SettlementDisposition = Exclude<Disposition, 'WAITING'>;

export interface SettlementRelations {
  event_asserts_postcondition: boolean;
  object_supports_accepted_absence: boolean;
  object_supports_not_dispatched?: boolean;
  accepted_absence_requires_replay_safety: boolean;
  object_supports_replay_safety: boolean;
}

export function settlementDispositionFromRelations(
  relations: SettlementRelations,
): SettlementDisposition {
  if (relations.event_asserts_postcondition) return 'DONE';
  if (relations.object_supports_not_dispatched === true) return 'READY';
  if (
    relations.object_supports_accepted_absence &&
    (!relations.accepted_absence_requires_replay_safety || relations.object_supports_replay_safety)
  ) {
    return 'READY';
  }
  return 'RECOVERY_REQUIRED';
}
