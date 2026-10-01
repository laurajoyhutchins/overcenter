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

# Stage 7: Prove implementation transition refinement

Strengthen selected guard correspondence into a source-linked refinement from consequential implementation transitions to legal 4×4 transitions.

## Scope

- Identify the production transitions that can cause externally consequential Events.
- Derive or extract transition contracts from implementation source where feasible.
- Prove every admitted consequential implementation transition maps to a legal 4×4 transition at the exact Coordinate.
- Prove admitted durable consequences have sufficient provenance through asserts/supports for their required Propositions.
- Retain negative controls for stale authority, evidence migration, ambiguity, ABA, and duplicate-effect hazards.

## Required evidence

- [ ] Formal model is mechanically linked to production transition contracts rather than maintained as an unconstrained twin.
- [ ] No externally consequential transition bypasses a permits proof.
- [ ] Source drift either regenerates a valid contract or fails verification closed.
- [ ] Negative controls still produce intended counterexamples.
- [ ] Fresh exact-head formal and Merge gate evidence passes.

## Deletion / generation ledger

Delete manually duplicated formal predicates/contracts where generated source-derived contracts become authoritative.

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

Stop if source extraction must guess about implementation semantics. Narrow the proved surface rather than fabricating completeness.

## Completion note

Do not mark ready until the exact-head handoff above is written here.
