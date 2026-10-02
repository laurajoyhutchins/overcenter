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

# Stage 2: Derive explanations from the relational model

Replace special-purpose blocked-work and authority explanations with deterministic queries over permits/requires/supports and Coordinates.

## Scope

- Derive why an Event is not permitted from missing/stale propositions and requirements.
- Derive which required Proposition is unsupported and which Objects could support it.
- Derive coordinate drift explanations without a second semantics.
- Route existing project/CLI explanation surfaces through the relational result.
- Keep human-facing wording outside the semantic kernel.

## Required evidence

- [ ] Existing explanation fixtures are reproduced or become strictly more precise.
- [ ] Same semantic state yields the same machine explanation independent of caller.
- [ ] Stale support and stale authority explain distinctly.
- [ ] No explanation path can grant authority or alter state.
- [ ] Fresh exact-head Merge gate passes.

## Deletion / generation ledger

Delete bespoke explanation logic that duplicates relational derivation; retain presentation adapters only.

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

Stop if an explanation requires information absent from the authoritative model. Add missing observation/provenance data, not an explanatory side-channel.

## Completion note

Do not mark ready until the exact-head handoff above is written here.
