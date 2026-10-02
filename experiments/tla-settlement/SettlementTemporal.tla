---- MODULE SettlementTemporal ----
EXTENDS Naturals

CONSTANTS
  ClearOnTerminal,
  PreserveOnRecovery,
  BlockAfterTerminal,
  AbsentWithoutReservationReady

Phases == {"Open", "Present", "Absent", "Uncertain", "Done", "Ready", "Recovery"}

VARIABLES
  phase,
  unresolved,
  recoveryStartedUnresolved,
  terminalOverwritten

vars == <<phase, unresolved, recoveryStartedUnresolved, terminalOverwritten>>

Init ==
  /\ phase = "Open"
  /\ unresolved = FALSE
  /\ recoveryStartedUnresolved = FALSE
  /\ terminalOverwritten = FALSE

Reserve ==
  /\ phase = "Open"
  /\ ~unresolved
  /\ unresolved' = TRUE
  /\ UNCHANGED <<phase, recoveryStartedUnresolved, terminalOverwritten>>

ObservePresent ==
  /\ phase = "Open"
  /\ phase' = "Present"
  /\ UNCHANGED <<unresolved, recoveryStartedUnresolved, terminalOverwritten>>

ObserveAbsent ==
  /\ phase = "Open"
  /\ phase' = "Absent"
  /\ UNCHANGED <<unresolved, recoveryStartedUnresolved, terminalOverwritten>>

ObserveUncertain ==
  /\ phase = "Open"
  /\ phase' = "Uncertain"
  /\ UNCHANGED <<unresolved, recoveryStartedUnresolved, terminalOverwritten>>

SettlePresent ==
  /\ phase = "Present"
  /\ phase' = "Done"
  /\ unresolved' = IF ClearOnTerminal THEN FALSE ELSE unresolved
  /\ UNCHANGED <<recoveryStartedUnresolved, terminalOverwritten>>

SettleAbsent ==
  /\ phase = "Absent"
  /\ IF unresolved
        THEN
          /\ phase' = "Recovery"
          /\ recoveryStartedUnresolved' = TRUE
          /\ unresolved' = IF PreserveOnRecovery THEN TRUE ELSE FALSE
        ELSE
          /\ phase' = IF AbsentWithoutReservationReady THEN "Ready" ELSE "Recovery"
          /\ recoveryStartedUnresolved' = FALSE
          /\ unresolved' = FALSE
  /\ UNCHANGED terminalOverwritten

SettleUncertain ==
  /\ phase = "Uncertain"
  /\ phase' = "Recovery"
  /\ recoveryStartedUnresolved' = unresolved
  /\ unresolved' = IF unresolved /\ ~PreserveOnRecovery THEN FALSE ELSE unresolved
  /\ UNCHANGED terminalOverwritten

OverwriteTerminal ==
  /\ phase \in {"Done", "Ready"}
  /\ ~BlockAfterTerminal
  /\ phase' = "Recovery"
  /\ terminalOverwritten' = TRUE
  /\ UNCHANGED <<unresolved, recoveryStartedUnresolved>>

Next ==
  \/ Reserve
  \/ ObservePresent
  \/ ObserveAbsent
  \/ ObserveUncertain
  \/ SettlePresent
  \/ SettleAbsent
  \/ SettleUncertain
  \/ OverwriteTerminal

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in Phases
  /\ unresolved \in BOOLEAN
  /\ recoveryStartedUnresolved \in BOOLEAN
  /\ terminalOverwritten \in BOOLEAN

TerminalClearsReservation ==
  phase \in {"Done", "Ready"} => ~unresolved

RecoveryPreservesReservation ==
  recoveryStartedUnresolved => unresolved

TerminalFinality ==
  ~terminalOverwritten

NoFalseDone ==
  phase = "Done" => ~unresolved

====
