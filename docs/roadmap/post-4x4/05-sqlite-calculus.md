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

# Stage 5: Execute the 4×4 calculus in SQLite

Move deterministic relational queries onto the SQLite hot path while preserving typed schema and avoiding a generic triple store.

## Scope

- Express permitted-event, unsupported-requirement, transitive-requirement, stale-support, stale-permission, and unresolved-event queries in SQLite.
- Keep typed relational tables and useful indexes rather than collapsing into EAV/RDF-like storage.
- Make TypeScript a typed boundary around relational authority instead of recomputing the same semantics.
- Benchmark representative hot paths against current projection code.
- Preserve reconstructibility and exact-coordinate semantics.

## Required evidence

- [ ] SQL and TypeScript reference semantics agree over representative and hostile histories.
- [ ] Query plans are bounded and indexed for expected production access patterns.
- [ ] No centralized authority service is introduced; SQLite remains embedded/local authority.
- [ ] Historical replay and durable facts remain valid.
- [ ] Fresh exact-head Merge gate passes.

## Deletion / generation ledger

Delete TypeScript recomputation proven equivalent to authoritative SQL queries. Retain typed adapters and validation at system boundaries.

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

Stop if a proposed SQL representation erases type distinctions or turns the model into an untyped triple store.

## Completion note

Do not mark ready until the exact-head handoff above is written here.
