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

# Stage 8: Delete orchestration now derivable in software

Apply the standing test repo-wide and remove agent/workflow judgment that is now a deterministic consequence of the relational kernel.

## Scope

- Inventory prompts, worker decisions, workflow routing, recovery choices, evidence selection, authority checks, and explanation paths.
- For each, ask whether the result follows mechanically from permits/asserts/supports/requires at a Coordinate.
- Replace deterministic agent judgments with kernel queries or generated plans.
- Retain agents only where genuine underdetermined judgment remains.
- Require deletion-dominant changes and explicit proof of each surviving agent boundary.

## Required evidence

- [ ] Removed agent decisions have deterministic replacements with exact tests.
- [ ] No deleted judgment was carrying hidden policy or value choice.
- [ ] Operational behavior remains fail-closed under missing/ambiguous data.
- [ ] Repository LOC and semantic owner count decrease without losing invariants.
- [ ] Fresh exact-head Merge gate and relevant formal evidence pass.

## Deletion / generation ledger

This PR should be strongly deletion-dominant. Every surviving agent decision must state why it is not derivable deterministically.

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

Stop on any decision that depends on genuine judgment, policy choice, or missing world knowledge. Surface that boundary instead of automating it deceptively.

## Completion note

Do not mark ready until the exact-head handoff above is written here.


## Integration repair for PR #559

Reconciled with repaired #556–#558. Removed the production judgment-frontier implementation, exports, and redundant dispatch metadata; authoritative project state, unresolved reservations, `isSystemEvidenceWork()`, and supported packet kinds own routing. Source work still requires reasoning; operator decisions and unsupported packets remain blocked; unresolved mutations take priority.

The deleted classifier test entry point is retained with live protocol regressions for system evidence, operator judgment, and unsupported work. These tests moved from the existing protocol suite and share its unchanged fixture setup. This preserves test migration under immutable-base replay without restoring the classifier or changing the replay verifier. Ambiguous-reservation and source-reasoning tests remain in the protocol suite.

Typecheck passes; focused live protocol and refinement tests are required, followed by hosted immutable-base replay and exact-head certification. This stage removes one production semantic owner and remains deletion-dominant.

The legacy hostile-evidence source label no longer bypasses source reasoning. This is an explicit routing policy correction, not an equivalence claim for that retired heuristic. Declared system-evidence packets keep the deterministic path. The protected architecture registry and its hosted evidence dependencies remain unchanged. An empty module preserves its registered artifact path until a separately admitted architecture change can remove it; it exports no classifier and has no routing behavior.
