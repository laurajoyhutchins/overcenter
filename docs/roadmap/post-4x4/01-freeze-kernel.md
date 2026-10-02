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

# Stage 1: Freeze the 4×4 semantic kernel

Close the ontology after migration and make architectural drift mechanically visible before exploiting the model further.

## Scope

- Declare the eight kernel concepts as the closed semantic boundary.
- Add architecture tests that reject new primitive kernel nouns/relations unless explicitly whitelisted as domain vocabulary.
- Delete remaining migration-only aliases, shadow hooks, or compatibility names that no longer protect a transition.
- Document where provider/storage/workflow concepts are allowed to live.
- Do not change external runtime behavior.

### Vocabulary placement

The reserved `FourByFour*` namespace is the kernel surface. Only the four nouns, four relations, and the explicitly structural `SourceKind`, `Source`, and `Projection` types may live there. Provider, storage, workflow, authority, effect, evidence, capability, and assurance vocabulary remains domain vocabulary above the kernel and is not globally banned.

The mechanical guard lives with the boundary test rather than in protected production or architecture inputs. This stage therefore freezes ontology without changing the trusted source-verification profile or broadening the production claim.

## Required evidence

- [ ] Current effect, settlement, assurance, and authority semantics remain expressible through the eight concepts.
- [ ] Architecture tests distinguish kernel vocabulary from domain vocabulary rather than banning ordinary type names globally.
- [ ] No production behavior changes.
- [ ] Fresh exact-head Merge gate passes.

## Deletion / generation ledger

Prefer net deletion. Any retained migration scaffold must have a named remaining purpose.

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

Stop if a real production distinction is found that cannot be represented without a ninth primitive; capture the smallest counterexample instead of weakening the boundary.

## Completion note

Do not mark ready until the exact-head handoff above is written here.
