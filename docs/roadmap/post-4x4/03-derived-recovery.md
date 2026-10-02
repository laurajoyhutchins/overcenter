# Post-4×4 exploitation stack

This work begins only after the strangler migration through PR #522 has landed or has been reconciled into this branch.

Canonical semantic kernel:

```text
Object      permits   Event
Event       asserts   Proposition
Object      supports  Proposition
Proposition requires  Proposition

Coordinate situates the world.
```

## Agent operating contract

- Refresh the exact predecessor branch/head before mutation. Do not trust stale SHAs.
- Do not add a fifth kernel primitive for implementation convenience.
- A proposed new primitive requires a counterexample: two worlds with identical existing 4×4 representation but different required safe behavior.
- Keep provider/domain vocabulary above the kernel.
- Prefer deterministic software over agent judgment whenever the result follows mechanically from the relations.
- Do not weaken fail-closed behavior, protected-code policy, exact-coordinate binding, or hosted exact-head evidence.
- Preserve the distinction between historical truth and current state.
- Treat uncertainty as a set of possible worlds unless formal evidence forces another representation.
- Every semantic deletion must name the surviving relation/query that now owns the behavior.
- Every authority transfer must be preceded by shadow/equivalence evidence unless the predecessor already provides exact proof.

## Required handoff

Record exact base/head, files changed, semantic claim, local proof/test results, hostile cases, hosted evidence, deletions, remaining uncertainty, and the smallest next action.

# Stage 3: Derive recovery actions from possible worlds

Collapse recovery routing into ordinary permission over the set of worlds still compatible with durable evidence.

## Scope

- Represent ambiguous effect outcomes as multiple possible 4×4 worlds, not a new recovery primitive.
- Derive which next Events are safe in every remaining possible world.
- Permit retry only when not-dispatched is established strongly enough for the effect contract.
- Prefer observation/reconciliation when duplicate mutation is not safe.
- Shadow existing recovery routing before deleting it.

## Required evidence

- [ ] Known not-dispatched permits retry when adapter policy allows it.
- [ ] Known success permits settlement/reconciliation without replay.
- [ ] Ambiguous outcome never permits unsafe duplicate mutation.
- [ ] Crash/restart and ABA hostile histories retain safe behavior.
- [ ] Fresh exact-head Merge gate passes.

## Deletion / generation ledger

Target hand-written recovery action partitioning and retry routing once shadow equivalence is complete.

For each semantic deletion or generated replacement, record:

```text
old owner:
new deterministic owner:
4×4 relation/query:
equivalence evidence:
hostile invariant preserved:
remaining agent judgment:
```

## Stop condition

Stop on any disagreement between derived and legacy recovery. Preserve the stricter action set until the counterexample is classified.

## Completion note

Do not mark ready until the exact-head handoff above is written here.
