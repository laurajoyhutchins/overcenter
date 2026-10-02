prelude
import Init.Notation

namespace Overcenter.SourceIntegration

inductive SettlementError where
  | ok
  | noReservation
  | workInvalid
  | evidenceMismatch

structure SettlementGuards where
  unresolvedEffect : Bool
  sourceWork : Bool
  sourceEffect : Bool
  sourceVerifier : Bool
  run : Bool
  obligationKey : Bool
  sourceRevision : Bool

def settlementError (g : SettlementGuards) : SettlementError :=
  if !g.unresolvedEffect then
    .noReservation
  else if !g.sourceWork || !g.sourceEffect || !g.sourceVerifier then
    .workInvalid
  else if !g.run || !g.obligationKey || !g.sourceRevision then
    .evidenceMismatch
  else
    .ok

end Overcenter.SourceIntegration
