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

# Stage 2: Project durable effect history into the 4×4 model

Create a deterministic read-only projection from existing durable facts into the 4×4 algebra.

## Scope

- Project claims/execution authority/reservations into Objects, Events, Coordinates, and permits relations.
- Project observations into Event asserts Proposition.
- Project retained evidence/witnesses into Object supports Proposition.
- Project postconditions and dependencies into Proposition requires Proposition.
- Keep SQLite facts and existing public types authoritative; introduce no parallel durable store.
- Add replay fixtures covering success, READY/not-dispatched, recovery-required, stale generation, and terminal history.

## Required evidence

- [ ] Projection is deterministic under replay.
- [ ] No projected semantic fact is invented without a durable source fact or certified observation.
- [ ] Known hostile histories retain the distinctions needed for ABA, stale authority, and uncertainty.
- [ ] Fresh exact-head hosted Merge gate passes.

## Deletion ledger

None unless a helper is demonstrably duplicated by the projection and its removal is behavior-neutral.

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

Stop on any production distinction that cannot be represented without widening the 4×4 algebra; document the counterexample instead.

## Agent completion note

Before marking ready for review, replace this section with the exact-head handoff described above.
