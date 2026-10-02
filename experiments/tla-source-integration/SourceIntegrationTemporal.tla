---- MODULE SourceIntegrationTemporal ----
EXTENDS Naturals

CONSTANTS
  RequireReservation,
  RequireWorkShape,
  RequireBinding,
  RetryRequiresClear

VARIABLES
  reserved,
  workValid,
  bindingValid,
  settled,
  retried,
  unsafeAction

vars == <<reserved, workValid, bindingValid, settled, retried, unsafeAction>>

Init ==
  /\ reserved = FALSE
  /\ workValid = TRUE
  /\ bindingValid = TRUE
  /\ settled = FALSE
  /\ retried = FALSE
  /\ unsafeAction = FALSE

Reserve ==
  /\ ~reserved
  /\ ~settled
  /\ ~retried
  /\ reserved' = TRUE
  /\ UNCHANGED <<workValid, bindingValid, settled, retried, unsafeAction>>

CorruptWork ==
  /\ ~settled
  /\ ~retried
  /\ workValid
  /\ workValid' = FALSE
  /\ UNCHANGED <<reserved, bindingValid, settled, retried, unsafeAction>>

CorruptBinding ==
  /\ ~settled
  /\ ~retried
  /\ bindingValid
  /\ bindingValid' = FALSE
  /\ UNCHANGED <<reserved, workValid, settled, retried, unsafeAction>>

SettleSource ==
  /\ ~settled
  /\ ~retried
  /\ (~RequireReservation \/ reserved)
  /\ (~RequireWorkShape \/ workValid)
  /\ (~RequireBinding \/ bindingValid)
  /\ settled' = TRUE
  /\ reserved' = FALSE
  /\ unsafeAction' =
       (unsafeAction \/ ~reserved \/ ~workValid \/ ~bindingValid)
  /\ UNCHANGED <<workValid, bindingValid, retried>>

RetrySource ==
  /\ ~settled
  /\ ~retried
  /\ (~RetryRequiresClear \/ ~reserved)
  /\ retried' = TRUE
  /\ unsafeAction' = (unsafeAction \/ reserved)
  /\ UNCHANGED <<reserved, workValid, bindingValid, settled>>

Next ==
  \/ Reserve
  \/ CorruptWork
  \/ CorruptBinding
  \/ SettleSource
  \/ RetrySource

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ reserved \in BOOLEAN
  /\ workValid \in BOOLEAN
  /\ bindingValid \in BOOLEAN
  /\ settled \in BOOLEAN
  /\ retried \in BOOLEAN
  /\ unsafeAction \in BOOLEAN

NoUnsafeSourceAction == ~unsafeAction
TerminalChoice == ~(settled /\ retried)

====
