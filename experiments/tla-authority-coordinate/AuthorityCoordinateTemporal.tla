---- MODULE AuthorityCoordinateTemporal ----
EXTENDS Naturals

CONSTANTS
  RequireSuccessor,
  RequirePredecessor,
  RequireReceiptCurrent

Authorities == {"A0", "A1"}

VARIABLES
  currentGeneration,
  currentAuthority,
  advanced,
  badAdvance,
  staleReceiptAccepted

vars == <<
  currentGeneration,
  currentAuthority,
  advanced,
  badAdvance,
  staleReceiptAccepted
>>

Init ==
  /\ currentGeneration = 1
  /\ currentAuthority = "A0"
  /\ advanced = FALSE
  /\ badAdvance = FALSE
  /\ staleReceiptAccepted = FALSE

Advance(candidateGeneration, candidatePredecessor) ==
  /\ ~advanced
  /\ candidateGeneration \in 1..2
  /\ candidatePredecessor \in Authorities
  /\ (~RequireSuccessor \/ candidateGeneration = currentGeneration + 1)
  /\ (~RequirePredecessor \/ candidatePredecessor = currentAuthority)
  /\ currentGeneration' = candidateGeneration
  /\ currentAuthority' = "A1"
  /\ advanced' = TRUE
  /\ badAdvance' =
       (badAdvance \/
        candidateGeneration # currentGeneration + 1 \/
        candidatePredecessor # currentAuthority)
  /\ UNCHANGED staleReceiptAccepted

AcceptOldReceipt ==
  /\ advanced
  /\ (~RequireReceiptCurrent \/
       (currentGeneration = 1 /\ currentAuthority = "A0"))
  /\ staleReceiptAccepted' =
       (staleReceiptAccepted \/
        ~(currentGeneration = 1 /\ currentAuthority = "A0"))
  /\ UNCHANGED <<currentGeneration, currentAuthority, advanced, badAdvance>>

Next ==
  \/ \E generation \in 1..2 :
       \E predecessor \in Authorities :
         Advance(generation, predecessor)
  \/ AcceptOldReceipt

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ currentGeneration \in 1..2
  /\ currentAuthority \in Authorities
  /\ advanced \in BOOLEAN
  /\ badAdvance \in BOOLEAN
  /\ staleReceiptAccepted \in BOOLEAN

NoBadAdvance == ~badAdvance
NoStaleReceipt == ~staleReceiptAccepted

====
