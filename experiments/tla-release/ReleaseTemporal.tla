---- MODULE ReleaseTemporal ----
EXTENDS Naturals

CONSTANTS
  ClearOnRelease,
  BlockPossibleDispatchRelease,
  RequireExactBinding

Outcomes == {"None", "PreDispatch", "PossibleDispatch"}

VARIABLES
  reserved,
  outcome,
  bindingValid,
  released,
  unsafeRelease

vars == <<reserved, outcome, bindingValid, released, unsafeRelease>>

Init ==
  /\ reserved = FALSE
  /\ outcome = "None"
  /\ bindingValid = TRUE
  /\ released = FALSE
  /\ unsafeRelease = FALSE

Reserve ==
  /\ ~reserved
  /\ ~released
  /\ reserved' = TRUE
  /\ UNCHANGED <<outcome, bindingValid, released, unsafeRelease>>

CorruptBinding ==
  /\ reserved
  /\ bindingValid
  /\ bindingValid' = FALSE
  /\ UNCHANGED <<reserved, outcome, released, unsafeRelease>>

PreDispatchFailure ==
  /\ reserved
  /\ outcome = "None"
  /\ outcome' = "PreDispatch"
  /\ UNCHANGED <<reserved, bindingValid, released, unsafeRelease>>

PossibleDispatch ==
  /\ reserved
  /\ outcome = "None"
  /\ outcome' = "PossibleDispatch"
  /\ UNCHANGED <<reserved, bindingValid, released, unsafeRelease>>

Release ==
  /\ reserved
  /\ (
        (outcome = "PreDispatch" /\ (~RequireExactBinding \/ bindingValid))
        \/
        (~BlockPossibleDispatchRelease /\ outcome = "PossibleDispatch")
      )
  /\ released' = TRUE
  /\ unsafeRelease' =
       (unsafeRelease \/ outcome # "PreDispatch" \/ ~bindingValid)
  /\ reserved' = IF ClearOnRelease THEN FALSE ELSE TRUE
  /\ UNCHANGED outcome
  /\ UNCHANGED bindingValid

Next ==
  \/ Reserve
  \/ CorruptBinding
  \/ PreDispatchFailure
  \/ PossibleDispatch
  \/ Release

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ reserved \in BOOLEAN
  /\ outcome \in Outcomes
  /\ bindingValid \in BOOLEAN
  /\ released \in BOOLEAN
  /\ unsafeRelease \in BOOLEAN

NoUnsafeRelease == ~unsafeRelease
ReleasedClearsReservation == released => ~reserved

====
