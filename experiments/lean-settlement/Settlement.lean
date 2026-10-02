prelude
import Init.Notation

namespace Overcenter.Settlement

inductive ReceiptKind where
  | observation
  | judgmentRequired
  | executionTerminated
  | effectNotDispatched
  | sourceRetry

inductive Disposition where
  | done
  | ready
  | recoveryRequired
  | waiting

structure ObservationRelations where
  assertsPostcondition : Bool
  supportsAcceptedAbsence : Bool
  requiresReplaySafety : Bool
  supportsReplaySafety : Bool

def observationDisposition (r : ObservationRelations) : Disposition :=
  if r.assertsPostcondition then
    .done
  else if r.supportsAcceptedAbsence &&
      (!r.requiresReplaySafety || r.supportsReplaySafety) then
    .ready
  else
    .recoveryRequired

def settlementDisposition
    (kind : ReceiptKind)
    (relations : ObservationRelations)
    (notDispatchedRelease : Bool) : Disposition :=
  match kind with
  | .observation => observationDisposition relations
  | .judgmentRequired => .waiting
  | .executionTerminated => .recoveryRequired
  | .effectNotDispatched =>
      if notDispatchedRelease then .ready else .recoveryRequired
  | .sourceRetry => .ready

end Overcenter.Settlement
