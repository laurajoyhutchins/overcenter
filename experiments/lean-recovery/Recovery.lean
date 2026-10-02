prelude
import Init.Notation

namespace Overcenter.Recovery

inductive RecoveryEvent where
  | reconcile
  | retry
  | settle

structure RecoveryRelations where
  assertsPostcondition : Bool
  supportsAcceptedAbsence : Bool
  supportsNotDispatched : Bool
  requiresReplaySafety : Bool
  supportsReplaySafety : Bool

def retryEstablished (r : RecoveryRelations) : Bool :=
  r.supportsNotDispatched ||
    (r.supportsAcceptedAbsence &&
      (!r.requiresReplaySafety || r.supportsReplaySafety))

def preferred (r : RecoveryRelations) : RecoveryEvent :=
  let success := r.assertsPostcondition
  let retry := retryEstablished r
  if success && !retry then
    .settle
  else if retry && !success then
    .retry
  else
    .reconcile

def preferredAtCoordinate (sameCoordinate : Bool) (r : RecoveryRelations) : RecoveryEvent :=
  if sameCoordinate then preferred r else .reconcile

end Overcenter.Recovery
