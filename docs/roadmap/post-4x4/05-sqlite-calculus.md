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

## Implementation

`src/authority/sqlite-calculus.ts` materializes the existing `FourByFourProjection` into nine typed SQLite tables: the four nouns, the four relations, and one projection-head binding. It imports the frozen projection type instead of declaring parallel `FourByFour*` vocabulary.

The materialized calculus is a reconstructible projection, not durable authority. Every read transaction verifies that its materialized head still equals the embedded SQLite fact store's durable `authority.head`. If durable history advances, reads fail closed with `FOUR_BY_FOUR_PROJECTION_STALE`; replacement also checks the durable head before and after materialization.

The unresolved-event query intentionally matches the existing effect-admission projection semantics: an `effect-attempt` remains unresolved until an asserted `not-dispatched` Proposition identifies the same reservation. It does not use the tempting but false shortcut "the same Event has no assertion," because effect attempts and receipt/observation Events are distinct in the current projection.

## Required evidence

- [x] SQL and TypeScript reference semantics agree over representative and hostile projections.
- [x] Query plans are bounded and explicitly index-backed for coordinate-scoped permission and recursive requirement access.
- [x] No centralized authority service is introduced; SQLite remains embedded and local to the existing fact-store file.
- [x] Historical replay and durable facts remain valid: projection replacement never mutates `fact_commits`, is reconstructible, and rolls back invalid typed edges.
- [ ] Fresh exact-head Merge gate passes.

Local evidence on Node 22.16.0:

- `node --experimental-strip-types --test test/sqlite-calculus.test.ts`: 9/9 pass.
- `node --experimental-strip-types test/benchmarks/sqlite-4x4-calculus.ts`: 5,000 rows / 64 Coordinates / 40 iterations; SQLite 3.812 ms vs projection-style TypeScript 15.001 ms, 3.93× in this run. This is directional evidence, not a performance threshold.

Hostile cases cover cyclic requirements, coordinate-mismatched support, stale permissions, unresolved/released effect attempts, durable-head drift, invalid typed foreign-key edges, and reconstruction without durable-history mutation.

## Deletion / generation ledger

```text
old owner: TypeScript projection scans for deterministic relation questions
new deterministic owner: typed SQLite materialization and indexed SQL queries
4×4 relation/query: permits; requires closure; exact supports; stale support/permission; unresolved effect-attempt
equivalence evidence: SQL-vs-TypeScript hostile fixture plus current unresolved-effect reservation semantics
hostile invariant preserved: stale durable head fails closed; typed relation endpoints use foreign keys; fact history is untouched
remaining agent judgment: none inside the six queries; production call-site transfer remains a later authority change
```

No TypeScript reference path is deleted in this stage. The SQL owner is shadow/equivalence-proven first; call-site authority transfer must occur only with exact-head hosted evidence.

## Exact-head handoff

- predecessor/base refreshed to `post-4x4/04-minimum-evidence` at `719ecc178a96cf2f591edb145fce6970fa56a0ac` before mutation.
- files changed in this stage: `src/authority/sqlite-calculus.ts`, `test/sqlite-calculus.test.ts`, `test/benchmarks/sqlite-4x4-calculus.ts`, and this manifest.
- semantic claim: the six deterministic calculus queries can execute from the frozen 4×4 projection in embedded SQLite without becoming durable authority or adding ontology.
- hosted evidence: pending on the final PR #527 exact head; keep this PR draft until it passes and the exact run is attached to the PR.
- remaining uncertainty: no production call site has transferred authority to the SQL implementation yet; this stage establishes the typed/indexed execution substrate and equivalence boundary only.
- smallest next action: run the fresh exact-head Merge gate, then transfer only call sites whose shadow comparison is exact.

## Stop condition

Stop if a proposed SQL representation erases type distinctions or turns the model into an untyped triple store.

## Completion note

Do not mark ready until the exact-head hosted handoff is attached and the Merge gate passes.