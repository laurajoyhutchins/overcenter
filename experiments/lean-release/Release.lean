prelude
import Init.Notation

namespace Overcenter.Release

inductive ReleaseDecision where
  | ready
  | noReservation
  | provenanceInvalid
  | bindingMismatch
  | witnessUnauthorized

structure ReleaseGuards where
  reservationExists : Bool
  trustedWitness : Bool
  exactBinding : Bool
  witnessAuthorized : Bool

def releaseDecision (g : ReleaseGuards) : ReleaseDecision :=
  if !g.reservationExists then
    .noReservation
  else if !g.trustedWitness then
    .provenanceInvalid
  else if !g.exactBinding then
    .bindingMismatch
  else if !g.witnessAuthorized then
    .witnessUnauthorized
  else
    .ready

end Overcenter.Release
