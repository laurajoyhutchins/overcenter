prelude
import Init.Notation

namespace Overcenter.FourByFour

structure AdmissionGuards where
  run : Bool
  obligation : Bool
  revision : Bool
  claim : Bool
  obligationKey : Bool
  generation : Bool
  authorityCommit : Bool
  capabilityBinding : Bool
  presentedCapability : Bool
  unresolvedEffect : Bool

inductive AdmissionDecision where
  | permits
  | staleExecution
  | unresolvedEffect

def executionPermits (g : AdmissionGuards) : Bool :=
  g.run && g.obligation && g.revision && g.claim && g.obligationKey &&
  g.generation && g.authorityCommit && g.capabilityBinding && g.presentedCapability

def admissionDecision (g : AdmissionGuards) : AdmissionDecision :=
  match executionPermits g, g.unresolvedEffect with
  | false, _ => .staleExecution
  | true, true => .unresolvedEffect
  | true, false => .permits

end Overcenter.FourByFour
