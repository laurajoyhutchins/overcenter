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

# Stage 6: Make 4×4 semantics authoritative for settlement and recovery

Transfer disposition, recovery, and not-dispatched release authority to the 4×4 model.

## Scope

- Derive settlement disposition from situated propositions and support.
- Express trusted not-dispatched release as evidence supporting a not-dispatched proposition bound to the exact attempt.
- Express replay eligibility as requirements on a new Event rather than a separate retry primitive.
- Keep provider-specific witness validation thin and exact.
- Remove independent policy ownership from projectReceipt/settlement helpers where equivalence is proven.

## Required evidence

- [ ] DONE cannot occur without supported authoritative success.
- [ ] READY cannot occur without accepted final absence or trusted not-dispatched evidence.
- [ ] Ambiguous outcomes cannot authorize replay.
- [ ] Terminal historical outcomes cannot be revived by stale lifecycle state.
- [ ] Fresh exact-head hosted Merge gate passes.

## Deletion ledger

Delete duplicated settlement/retry/release policy only after each removed rule has a named surviving 4×4 expression.

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

Stop if recovery becomes less conservative or if any provider-specific uncertainty is collapsed.

## Agent completion note

Before marking ready for review, replace this section with the exact-head handoff described above.
