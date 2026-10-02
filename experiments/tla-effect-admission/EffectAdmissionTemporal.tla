---- MODULE EffectAdmissionTemporal ----
EXTENDS Naturals, FiniteSets

CONSTANTS W1, W2, MaxGeneration, CheckFence, BlockDuplicateReservation

Workers == {W1, W2}

VARIABLES
  authorityGeneration,
  permitGeneration,
  reserved,
  dispatched,
  badAuthorityUse

vars == << authorityGeneration, permitGeneration, reserved, dispatched, badAuthorityUse >>

Init ==
  /\ authorityGeneration = 1
  /\ permitGeneration = [w \in Workers |-> IF w = W1 THEN 1 ELSE 0]
  /\ reserved = {}
  /\ dispatched = {}
  /\ badAuthorityUse = FALSE

RotateAuthority ==
  /\ authorityGeneration < MaxGeneration
  /\ authorityGeneration' = authorityGeneration + 1
  /\ UNCHANGED << permitGeneration, reserved, dispatched, badAuthorityUse >>

RefreshPermit(w) ==
  /\ permitGeneration[w] # authorityGeneration
  /\ permitGeneration' = [permitGeneration EXCEPT ![w] = authorityGeneration]
  /\ UNCHANGED << authorityGeneration, reserved, dispatched, badAuthorityUse >>

Reserve(w) ==
  /\ w \notin reserved
  /\ (~BlockDuplicateReservation \/ reserved = {})
  /\ (~CheckFence \/ permitGeneration[w] = authorityGeneration)
  /\ reserved' = reserved \cup {w}
  /\ badAuthorityUse' = (badAuthorityUse \/ (permitGeneration[w] # authorityGeneration))
  /\ UNCHANGED << authorityGeneration, permitGeneration, dispatched >>

Dispatch(w) ==
  /\ w \in reserved
  /\ w \notin dispatched
  /\ dispatched' = dispatched \cup {w}
  /\ UNCHANGED << authorityGeneration, permitGeneration, reserved, badAuthorityUse >>

Next ==
  \/ RotateAuthority
  \/ \E w \in Workers : RefreshPermit(w)
  \/ \E w \in Workers : Reserve(w)
  \/ \E w \in Workers : Dispatch(w)

TypeOK ==
  /\ authorityGeneration \in 1..MaxGeneration
  /\ permitGeneration \in [Workers -> 0..MaxGeneration]
  /\ reserved \subseteq Workers
  /\ dispatched \subseteq Workers
  /\ badAuthorityUse \in BOOLEAN

NoStaleReservation == ~badAuthorityUse
NoDuplicateReservation == Cardinality(reserved) <= 1
NoDoubleExecution == Cardinality(dispatched) <= 1

Spec == Init /\ [][Next]_vars

====
