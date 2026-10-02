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

- [x] Golden transaction produces the same or stricter minimum sufficient evidence set.
- [x] Coordinate-mismatched support never satisfies a requirement.
- [x] Protected-code and trusted-scope deltas remain fail-closed.
- [x] Multiple valid minimal sets are handled deterministically or explicitly surfaced without semantic ambiguity.
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

- **Exact predecessor used for the semantic implementation:** `dea7620f42ba51f608db72ecfcedb8304c114d7c` (PR #525).
- **Verified semantic implementation head:** `74966dba2ee4fd726ff11b268134d87f03aeeb43`.
- **Files changed:** this contract, `src/authority/assurance-relations.ts`,
  `src/source/transaction-planner.ts`, and `test/minimum-sufficient-evidence.test.ts`.
- **Semantic claim:** evidence selection is deterministic closure over `Proposition requires Proposition`
  followed by exact-Coordinate subtraction of existing support and cardinality-minimum
  `Object supports Proposition` cover. Multiple equal minima are ordered deterministically and
  surfaced as alternatives rather than hidden.
- **Transaction scope:** source transaction planning now minimizes all assurance goals for a
  revision as one frontier, rather than unioning independently minimal per-property selections.
  The protected legacy architecture planner remains present as the predecessor equivalence oracle.
- **Fail-closed correction:** direct assurance requirements are stable
  `property:<id> -> proof:<id>` propositions. Evidence witness rows only provide support for those
  propositions, so deleting witness routing cannot erase the proof requirement itself.
- **Hosted semantic evidence on the verified head:** repository typecheck, authority-flow analysis,
  authority-storage decomposition, criticality mutation probe, substrate-capability admission, and
  distributed-authority handoff pass. All six Stage 4 hostile/minimization tests pass. The
  predecessor assurance-authority suite also passes for every current property, including the
  golden transaction and representative repository deltas.
- **Golden transaction:** the assurance relation test retains the pre-migration minimum evidence
  set exactly. The source-transaction regression is red on both this head and exact predecessor
  `dea7620f...`; it is one of six inherited predecessor failures, not a Stage 4 disagreement.
- **Inherited blocker:** exact predecessor `dea7620f...` and this Stage 4 head fail the same six
  unit tests: maintained architecture reconciliation plus five source-transaction regressions.
  The reconciliation failure is the already-removed `mutationAdmitted` symbol still declared in
  maintained architecture. Do not weaken or bypass Merge gate to compensate.
- **Merge status:** fresh exact-head Merge gate remains red solely because the predecessor is red.
  This PR stays draft and the Merge-gate checkbox above stays unchecked.
- **Remaining uncertainty:** none observed in Stage 4 selection semantics. Final merge evidence
  still depends on a green predecessor and a fresh restack/recheck.
- **Smallest next action:** once PR #525 repairs its inherited six-test failure set, restack this
  exact semantic delta onto the new #525 head and rerun exact-head Merge gate before marking ready.

### Deletion / generation ledger

```text
old owner: per-property evidence selection followed by union in source transaction planning
new deterministic owner: assuranceChangePlanForPropertiesFromRelations()
4×4 relation/query: transitive Proposition requires Proposition closure + exact-Coordinate Object supports Proposition minimum cover
equivalence evidence: all current per-property assurance plans, golden transaction, representative repository deltas, and unchanged predecessor failure set
hostile invariant preserved: missing or coordinate-mismatched support fails closed; deleting a direct witness cannot delete the requirement
remaining agent judgment: none for evidence membership; an external cost policy would remain outside the kernel if cardinality ceased to be the intended optimization
```

Do not mark ready until the predecessor is green and a fresh exact-head Merge gate passes.
