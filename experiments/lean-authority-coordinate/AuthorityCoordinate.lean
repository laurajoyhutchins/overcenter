prelude
import Init.Notation

namespace Overcenter.AuthorityCoordinate

inductive AdvanceError where
  | ok
  | runMismatch
  | obligationMismatch
  | generationNotSuccessor
  | predecessorMismatch

structure AdvanceGuards where
  run : Bool
  obligation : Bool
  successorGeneration : Bool
  predecessorAuthority : Bool

def advanceError (g : AdvanceGuards) : AdvanceError :=
  if !g.run then
    .runMismatch
  else if !g.obligation then
    .obligationMismatch
  else if !g.successorGeneration then
    .generationNotSuccessor
  else if !g.predecessorAuthority then
    .predecessorMismatch
  else
    .ok

inductive ReceiptError where
  | ok
  | runMismatch
  | obligationMismatch
  | revisionMismatch
  | claimMismatch
  | executionAuthorityMismatch

structure ReceiptGuards where
  run : Bool
  obligation : Bool
  revision : Bool
  claim : Bool
  generation : Bool
  authorityCommit : Bool

def receiptError (g : ReceiptGuards) : ReceiptError :=
  if !g.run then
    .runMismatch
  else if !g.obligation then
    .obligationMismatch
  else if !g.revision then
    .revisionMismatch
  else if !g.claim then
    .claimMismatch
  else if !g.generation || !g.authorityCommit then
    .executionAuthorityMismatch
  else
    .ok

end Overcenter.AuthorityCoordinate
