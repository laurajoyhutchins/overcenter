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

- [ ] Golden transaction produces the same minimum sufficient evidence set.
- [ ] Protected/trusted-code deltas remain fail-closed.
- [ ] Missing evidence cannot be satisfied by coordinate-mismatched support.
- [ ] No broader production claim is introduced.
- [ ] Fresh exact-head hosted Merge gate passes.

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

Before marking ready for review, replace this section with the exact-head handoff described above.
