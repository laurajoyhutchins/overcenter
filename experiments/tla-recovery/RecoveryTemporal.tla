---- MODULE RecoveryTemporal ----
EXTENDS Naturals

CONSTANTS ProtectAmbiguity, ProtectCoordinate

Coordinates == {"C0", "C1"}
Outcomes == {"Unknown", "Success", "NotDispatched"}

VARIABLES
  currentCoordinate,
  evidenceCoordinate,
  outcome,
  unsafeAction

vars == <<currentCoordinate, evidenceCoordinate, outcome, unsafeAction>>

Init ==
  /\ currentCoordinate = "C0"
  /\ evidenceCoordinate = "C0"
  /\ outcome = "Unknown"
  /\ unsafeAction = FALSE

ObserveSuccess ==
  /\ outcome = "Unknown"
  /\ outcome' = "Success"
  /\ evidenceCoordinate' = currentCoordinate
  /\ UNCHANGED <<currentCoordinate, unsafeAction>>

ObserveNotDispatched ==
  /\ outcome = "Unknown"
  /\ outcome' = "NotDispatched"
  /\ evidenceCoordinate' = currentCoordinate
  /\ UNCHANGED <<currentCoordinate, unsafeAction>>

RotateCoordinate ==
  /\ currentCoordinate = "C0"
  /\ currentCoordinate' = "C1"
  /\ UNCHANGED <<evidenceCoordinate, outcome, unsafeAction>>

Retry ==
  /\ (outcome = "NotDispatched" \/ (~ProtectAmbiguity /\ outcome = "Unknown"))
  /\ (~ProtectCoordinate \/ evidenceCoordinate = currentCoordinate)
  /\ unsafeAction' =
       (unsafeAction \/ outcome # "NotDispatched" \/ evidenceCoordinate # currentCoordinate)
  /\ UNCHANGED <<currentCoordinate, evidenceCoordinate, outcome>>

Settle ==
  /\ (outcome = "Success" \/ (~ProtectAmbiguity /\ outcome = "Unknown"))
  /\ (~ProtectCoordinate \/ evidenceCoordinate = currentCoordinate)
  /\ unsafeAction' =
       (unsafeAction \/ outcome # "Success" \/ evidenceCoordinate # currentCoordinate)
  /\ UNCHANGED <<currentCoordinate, evidenceCoordinate, outcome>>

Reconcile ==
  /\ UNCHANGED vars

Next ==
  \/ ObserveSuccess
  \/ ObserveNotDispatched
  \/ RotateCoordinate
  \/ Retry
  \/ Settle
  \/ Reconcile

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ currentCoordinate \in Coordinates
  /\ evidenceCoordinate \in Coordinates
  /\ outcome \in Outcomes
  /\ unsafeAction \in BOOLEAN

NoUnsafeRecoveryAction == ~unsafeAction

====
