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

# Stage 4: Derive the minimum sufficient evidence set

Turn assurance planning into deterministic requirement closure plus evidence minimization.

## Scope

- Compute transitive Proposition requirements from a goal.
- Subtract propositions already supported at the exact Coordinate.
- Select a minimum sufficient evidence frontier from available Objects/certified reads.
- Produce a deterministic explanation for each missing proof.
- Remove remaining agent/workflow decisions whose only job is choosing mechanically required evidence.

## Required evidence

- [ ] Golden transaction produces the same or stricter minimum sufficient evidence set.
- [ ] Coordinate-mismatched support never satisfies a requirement.
- [ ] Protected-code and trusted-scope deltas remain fail-closed.
- [ ] Multiple valid minimal sets are handled deterministically or explicitly surfaced without semantic ambiguity.
- [ ] Fresh exact-head Merge gate passes.

## Deletion / generation ledger

Delete hard-coded evidence selection/routing proven equivalent to requirement closure and minimization.

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

Stop if evidence choice depends on genuine value judgment or cost policy not present in the model; expose that policy boundary instead of smuggling it into the kernel.

## Completion note

Do not mark ready until the exact-head handoff above is written here.
