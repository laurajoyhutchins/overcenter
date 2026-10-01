import {
  settlementDispositionFromRelations,
  type SettlementDisposition,
  type SettlementRelations,
} from './settlement.ts';

export {
  settlementDispositionFromRelations,
  type SettlementDisposition,
  type SettlementRelations,
} from './settlement.ts';

// Compatibility oracle for immutable Stage-5 tests only. Production settlement
// no longer calls this wrapper; the 4×4 relation decision is authoritative.
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
        `requires_replay_safety=${Number(relations.accepted_absence_requires_replay_safety)}`,
        `supports_replay_safety=${Number(relations.object_supports_replay_safety)}`,
        `legacy=${legacy}`,
        `projected=${projected}`,
      ].join(':'),
    );
  }
  return legacy;
}
