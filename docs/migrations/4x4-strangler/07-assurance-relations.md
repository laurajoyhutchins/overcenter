# 4×4 strangler migration

Canonical kernel:

```text
Object      permits   Event
Event       asserts   Proposition
Object      supports  Proposition
Proposition requires  Proposition

Coordinate situates the world.
```

## Agent operating contract

- Refresh the exact base branch/head before mutation; never trust handoff SHAs blindly.
- No fifth primitive. If one appears necessary, produce the smallest counterexample showing why the existing eight concepts cannot distinguish two worlds requiring different safe actions.
- Do not weaken trusted-code, admission, branch-protection, exact-head, or fail-closed behavior.
- Shadow before authority transfer. Prove equivalence before deleting the old semantic owner.
- No parallel durable authority store. Existing SQLite facts remain the durable substrate unless a later PR proves a replacement.
- Generated output is not verified output. Every semantic claim needs exact-head evidence.
- Prefer deletion. Every removed semantic rule must identify the surviving 4×4 expression that owns it.
- Keep provider nouns and storage shapes outside the kernel unless formal evidence forces them inward.
- If the base changes materially, rebase/reconcile and repeat the relevant equivalence evidence before continuing.

## Required handoff at each agent boundary

Record: exact base/head; files changed; semantic claim; hostile cases exercised; local evidence; hosted evidence; remaining uncertainty; and the smallest next action. Do not hand off an unclassified disagreement.

# Stage 7: Derive assurance planning from requires and supports

Translate obligations and evidence planning into proposition closure over requires/supports, then prove planner equivalence.

## Scope

- Map obligations/proof obligations to Propositions.
- Map dependency edges to requires.
- Map evidence artifacts and certified reads to Objects with supports relations.
- Derive the minimum missing evidence set from transitive requirements.
- Shadow the current assurance/evidence planner on the golden transaction and representative repository deltas.
- Delete the hard-coded evidence router only if selection equivalence is established.

## Required evidence

- [x] Golden transaction produces the same minimum sufficient evidence set.
- [x] Protected/trusted-code deltas remain fail-closed.
- [x] Missing evidence cannot be satisfied by coordinate-mismatched support.
- [x] No broader production claim is introduced.
- [x] Fresh exact-head hosted Merge gate passes before this PR is marked ready; the authoritative receipt is the current-head PR check, not this prose.

## Deletion ledger

Preferred deletion target: hard-coded evidence routing/planning that is proven equivalent to requires/supports closure.

For every deletion made in this PR, record:

```text
old owner:
surviving 4×4 expression:
equivalence evidence:
representation retained:
hostile invariant preserved:
new primitive: none
```

## Stop condition

Stop on planner disagreement; preserve the stricter result until the cause is proved.

## Agent completion note

- **Exact base:** `8788f304900ad7ca66b0e2db60f49f96cd2283b9` (stage 6 / PR #519 at this handoff).
- **Verified implementation head:** `e5405e0f3050fc7746d3d66caec8e04ef3f1af55`. The semantic module and test blobs are unchanged here; this handoff commit is rebased onto the exact base above and adds only the completed migration note. Use the current PR head and its exact-head Merge gate as the final receipt.
- **Files changed:** this migration note, `src/authority/assurance-relations.ts`, and `test/assurance-relations-shadow.test.ts`.
- **Semantic claim:** assurance obligations and proof obligations can be projected to Propositions, closed transitively through `requires`, and covered minimally by same-coordinate Objects through `supports`, with the same plan selected by the current architecture planner.
- **Equivalence evidence:** the shadow planner matches the legacy planner for every assurance property in the current architecture model, preserves the golden transaction's minimum evidence set, and matches representative provider, authority-flow, distributed-authority, and confinement deltas.
- **Hostile cases:** support at the wrong Coordinate cannot discharge a Proposition; deleting support for `authoritative-settlement` fails closed.
- **Hosted evidence on the verified implementation head:** lint, typecheck, unit tests, immutable-base replay, TCB analysis, semantic-scaling marginal TCB, production-code witnesses, adapter diagnosability, authority-flow analysis, authority-storage decomposition, substrate admission, distributed-authority handoff/chaos, and the PR preflight all passed.
- **Production boundary:** the existing protected `src/architecture/change-planner.ts` remains authoritative. The 4×4 planner is shadow-only, so this PR does not broaden the production claim or bypass source-verification policy.
- **Remaining uncertainty:** none in selection equivalence for the current model. Authority transfer and deletion of the protected legacy planner are intentionally deferred to a later trusted transition.
- **Smallest next action:** require a fresh exact-head Merge gate for the current PR head; only then mark the PR ready.

### Deletion ledger

```text
old owner: src/architecture/change-planner.ts obligation/evidence planner
surviving 4×4 expression: Proposition requires Proposition + Object supports Proposition at one Coordinate
equivalence evidence: all current assurance properties + golden transaction + representative repository deltas
representation retained: existing SQLite assurance/evidence tables projected into 4×4 relations
hostile invariant preserved: missing or coordinate-mismatched support fails closed
new primitive: none
deletion: deferred because the old owner is protected and remains authoritative in this shadow stage
```
