# Busbar Five-Stage Supervisory Lifecycle Design

## Objective

Make `ENABLE → ACQUIRE → EXECUTE → COMMIT → CONFIRM` Busbar's canonical productive operating envelope. Busbar, not workers, owns stage selection and transition legality.

## Model

There are five productive stages and twenty directed transitions between distinct stages. The preferred forward path is strongly biased, but feedback and bypass transitions remain productive when current authoritative facts justify them.

The resolver selects the earliest applicable unsatisfied responsibility from the ordered stage set. A skipped stage is legal only when its responsibility is satisfied or not applicable. `DONE` is reached only when all applicable responsibilities are satisfied.

`HOLD`, `FAULT`, `INDETERMINATE`, and `OPERATOR_HOLD` are operating conditions orthogonal to productive stage. Recovery never hard-codes a return destination; clearing an off-nominal condition triggers fresh resolution against current facts.

## Controls vocabulary

- Permissive: fact that must be true before an operation may start.
- Guard: predicate authorizing a transition.
- Interlock: condition actively preventing an otherwise possible operation.
- Trip: immediate removal from nominal execution after a protected invariant is violated.
- Reset: clearing a latched off-nominal condition after its cause is removed.
- Recovery: deterministic procedure that restores reset/re-entry conditions.

## Execution boundary

The five highest-level stage commands are `work.enable`, `work.acquire`, `work.execute`, `work.commit`, and `work.confirm`. A worker reports observations and evidence for its bounded stage; it does not select the successor stage. Existing low-level Busbar and GitHub primitives remain implementation mechanisms beneath the stage command.

Legacy `lane:*` labels are projection-only during migration. They must not remain the authority for lifecycle routing.

## Safety

Unknown stages, conditions, or responsibility keys fail closed. Indeterminate external effects interlock retries until reconciliation establishes effect truth. Repository disposition and exact-revision protections remain authoritative constraints.

## Verification

Regression coverage must enumerate all twenty productive transitions, forward bypass, feedback, completion, not-applicable stages, off-nominal preservation, fresh recovery resolution, and invalid-input rejection. Integration tests must prove worker-facing settlement no longer accepts caller-selected `next_state`/`next_lane` routing.
