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

# Stage 3: Shadow effect admission through permits

Compute effect admission through both the legacy implementation and 4×4 permits while leaving legacy behavior authoritative.

## Scope

- Derive the 4×4 admission decision from the read-only projection.
- Compare it with projectExecutionAuthority()/mutationAdmitted()/beginEffect behavior.
- Fail closed and emit reproducible diagnostics on disagreement.
- Cover current/stale generation, exact/stale revision, unresolved reservation, duplicate reservation, reacquisition, crash/recovery, and concurrency.
- Do not change which effects are dispatched.

## Required evidence

- [ ] Legacy and 4×4 admission agree across focused tests and replay fixtures.
- [ ] Bounded formal exploration preserves authority and reservation invariants.
- [ ] A hostile mutation of either decision path is detected by shadow comparison.
- [ ] Fresh exact-head hosted Merge gate passes.

## Deletion ledger

None. Shadowing must precede authority transfer.

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

Stop on any disagreement. Classify it as legacy bug, projection bug, or algebra insufficiency before proceeding.

## Agent completion note

Before marking ready for review, replace this section with the exact-head handoff described above.
