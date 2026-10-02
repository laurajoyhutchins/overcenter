---- MODULE FourByFourEffect ----
EXTENDS Naturals

CONSTANT AllowUncertainSettlement

Coordinates == {0, 1}
Effects == {"Absent", "Present"}
Knowledge == {"Unknown", "Absent", "Present"}

VARIABLES authorityCoordinate, executionCoordinate, reservation, effect, knowledge, releaseProof, settled
vars == <<authorityCoordinate, executionCoordinate, reservation, effect, knowledge, releaseProof, settled>>

CurrentAuthority == executionCoordinate = authorityCoordinate

Init ==
    /\ authorityCoordinate = 0
    /\ executionCoordinate = 0
    /\ reservation = FALSE
    /\ effect = "Absent"
    /\ knowledge = "Unknown"
    /\ releaseProof = FALSE
    /\ settled = FALSE

Reserve ==
    /\ CurrentAuthority
    /\ ~reservation
    /\ ~settled
    /\ reservation' = TRUE
    /\ UNCHANGED <<authorityCoordinate, executionCoordinate, effect, knowledge, releaseProof, settled>>

LoseAuthority ==
    /\ CurrentAuthority
    /\ ~settled
    /\ authorityCoordinate' \in Coordinates
    /\ authorityCoordinate' # authorityCoordinate
    /\ UNCHANGED <<executionCoordinate, reservation, effect, knowledge, releaseProof, settled>>

ReacquireAuthority ==
    /\ ~CurrentAuthority
    /\ ~settled
    /\ executionCoordinate' = authorityCoordinate
    /\ UNCHANGED <<authorityCoordinate, reservation, effect, knowledge, releaseProof, settled>>

DispatchAmbiguous ==
    /\ CurrentAuthority
    /\ reservation
    /\ ~releaseProof
    /\ ~settled
    /\ knowledge = "Unknown"
    /\ effect' \in Effects
    /\ UNCHANGED <<authorityCoordinate, executionCoordinate, reservation, knowledge, releaseProof, settled>>

Observe ==
    /\ reservation
    /\ knowledge = "Unknown"
    /\ knowledge' = effect
    /\ UNCHANGED <<authorityCoordinate, executionCoordinate, reservation, effect, releaseProof, settled>>

ProveNotDispatched ==
    /\ reservation
    /\ effect = "Absent"
    /\ knowledge = "Unknown"
    /\ releaseProof' = TRUE
    /\ UNCHANGED <<authorityCoordinate, executionCoordinate, reservation, effect, knowledge, settled>>

Release ==
    /\ reservation
    /\ releaseProof
    /\ ~settled
    /\ reservation' = FALSE
    /\ releaseProof' = FALSE
    /\ UNCHANGED <<authorityCoordinate, executionCoordinate, effect, knowledge, settled>>

Settle ==
    /\ CurrentAuthority
    /\ reservation
    /\ (knowledge = "Present" \/ AllowUncertainSettlement)
    /\ settled' = TRUE
    /\ UNCHANGED <<authorityCoordinate, executionCoordinate, reservation, effect, knowledge, releaseProof>>

Next ==
    \/ Reserve
    \/ LoseAuthority
    \/ ReacquireAuthority
    \/ DispatchAmbiguous
    \/ Observe
    \/ ProveNotDispatched
    \/ Release
    \/ Settle

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ authorityCoordinate \in Coordinates
    /\ executionCoordinate \in Coordinates
    /\ reservation \in BOOLEAN
    /\ effect \in Effects
    /\ knowledge \in Knowledge
    /\ releaseProof \in BOOLEAN
    /\ settled \in BOOLEAN

NoSettlementWithoutKnowledge == settled => knowledge = "Present"
NoSettlementWithoutReservation == settled => reservation
NoSettlementWithoutAuthority == settled => CurrentAuthority

\* These are intentionally false beliefs. Negative-control configs ask TLC to
\* falsify them against the same transition system used by the positive model.
RecoveryCertainty == (reservation /\ knowledge = "Unknown") => effect = "Absent"
ReservationExistenceIsAuthority == reservation => CurrentAuthority

====
