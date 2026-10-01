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

# Stage 5: Shadow settlement through asserts and supports

Compute DONE/READY/RECOVERY_REQUIRED through 4×4 observation/evidence semantics while legacy settlement remains authoritative.

## Scope

- Represent provider observation as Event asserts Proposition.
- Represent retained evidence as Object supports Proposition.
- Represent postcondition and replay prerequisites with requires.
- Derive disposition in shadow and compare with projectReceipt/settlementSemantics/reservedEffectReplaySafe.
- Preserve RECOVERY_REQUIRED as epistemic multiplicity, not a new primitive.
- Cover authoritative presence, accepted absence, non-final absence, uncertain observation, and unresolved reservations.

## Required evidence

- [ ] Legacy and 4×4 dispositions agree across all supported postcondition families in scope.
- [ ] Unknown/ambiguous outcomes remain recovery-required.
- [ ] READY requires admitted absence semantics and replay safety.
- [ ] Fresh exact-head hosted Merge gate passes.

## Deletion ledger

None. This is a shadow-equivalence PR.

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

Stop if a disposition depends on semantics not representable by asserts/supports/requires plus Coordinate.

## Agent completion note

Before marking ready for review, replace this section with the exact-head handoff described above.
