namespace Overcenter.FourByFour

inductive Noun where
  | object
  | event
  | proposition
  | coordinate
  deriving DecidableEq, Repr

inductive Verb where
  | permits
  | asserts
  | supports
  | requires
  deriving DecidableEq, Repr

structure Coordinate where
  revision : Nat
  generation : Nat
  deriving DecidableEq, Repr

inductive LiveEvent where
  | reserve
  | observePresent
  | releaseNotDispatched
  | settle
  deriving DecidableEq, Repr

def boundaryNoun : LiveEvent → Noun
  | .reserve => .object
  | .observePresent => .event
  | .releaseNotDispatched => .object
  | .settle => .proposition

def boundaryVerb : LiveEvent → Verb
  | .reserve => .permits
  | .observePresent => .asserts
  | .releaseNotDispatched => .supports
  | .settle => .requires

structure World where
  authorityCoordinate : Coordinate
  executionCoordinate : Coordinate
  reservation : Bool
  observedPresent : Bool
  releaseEvidence : Bool
  settled : Bool
  deriving DecidableEq, Repr

def currentAuthority (world : World) : Prop :=
  world.executionCoordinate = world.authorityCoordinate

def permitted (world : World) : LiveEvent → Prop
  | .reserve => currentAuthority world ∧ world.reservation = false
  | .observePresent => world.reservation = true
  | .releaseNotDispatched => world.reservation = true ∧ world.releaseEvidence = true
  | .settle =>
      currentAuthority world ∧
        world.reservation = true ∧
        world.observedPresent = true

def apply (world : World) : LiveEvent → World
  | .reserve => { world with reservation := true }
  | .observePresent => { world with observedPresent := true }
  | .releaseNotDispatched => { world with reservation := false, releaseEvidence := false }
  | .settle => { world with settled := true }

theorem reserve_refines_permits (world : World) (h : permitted world .reserve) :
    (apply world .reserve).reservation = true ∧ currentAuthority world := by
  constructor
  · rfl
  · exact h.1

theorem observation_refines_asserts (world : World) (h : permitted world .observePresent) :
    (apply world .observePresent).observedPresent = true ∧ world.reservation = true := by
  constructor
  · rfl
  · exact h

theorem release_refines_supports (world : World) (h : permitted world .releaseNotDispatched) :
    (apply world .releaseNotDispatched).reservation = false ∧ world.releaseEvidence = true := by
  constructor
  · rfl
  · exact h.2

theorem settlement_refines_requires (world : World) (h : permitted world .settle) :
    (apply world .settle).settled = true ∧
      currentAuthority world ∧
      world.reservation = true ∧
      world.observedPresent = true := by
  constructor
  · rfl
  · exact h

private def coordinate0 : Coordinate := { revision := 0, generation := 1 }
private def coordinate1 : Coordinate := { revision := 1, generation := 1 }

def staleReservation : World := {
  authorityCoordinate := coordinate1
  executionCoordinate := coordinate0
  reservation := true
  observedPresent := false
  releaseEvidence := false
  settled := false
}

def uncertainRecovery : World := {
  authorityCoordinate := coordinate0
  executionCoordinate := coordinate0
  reservation := true
  observedPresent := false
  releaseEvidence := false
  settled := false
}

theorem reservation_existence_is_not_authority :
    staleReservation.reservation = true ∧ ¬currentAuthority staleReservation := by
  constructor
  · rfl
  · intro h
    have revisionMismatch : (0 : Nat) = 1 := congrArg Coordinate.revision h
    cases revisionMismatch

theorem recovery_without_observation_is_not_settlement :
    uncertainRecovery.reservation = true ∧
      uncertainRecovery.observedPresent = false ∧
      uncertainRecovery.settled = false := by
  constructor
  · rfl
  · constructor
    · rfl
    · rfl

end Overcenter.FourByFour
