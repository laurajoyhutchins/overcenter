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

theorem asserted_is_done (r : ObservationRelations)
    (h : r.assertsPostcondition = true) :
    observationDisposition r = .done := by
  simp [observationDisposition, h]

theorem unsupported_absence_recovers (r : ObservationRelations)
    (ha : r.assertsPostcondition = false)
    (hs : r.supportsAcceptedAbsence = false) :
    observationDisposition r = .recoveryRequired := by
  simp [observationDisposition, ha, hs]

theorem unresolved_absence_without_replay_recovers
    (r : ObservationRelations)
    (ha : r.assertsPostcondition = false)
    (hs : r.supportsAcceptedAbsence = true)
    (hr : r.requiresReplaySafety = true)
    (hp : r.supportsReplaySafety = false) :
    observationDisposition r = .recoveryRequired := by
  simp [observationDisposition, ha, hs, hr, hp]

theorem safe_absence_is_ready
    (r : ObservationRelations)
    (ha : r.assertsPostcondition = false)
    (hs : r.supportsAcceptedAbsence = true)
    (h : r.requiresReplaySafety = false ∨ r.supportsReplaySafety = true) :
    observationDisposition r = .ready := by
  rcases h with h | h
  · simp [observationDisposition, ha, hs, h]
  · simp [observationDisposition, ha, hs, h]

end Overcenter.Settlement
