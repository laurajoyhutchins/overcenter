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

# Stage 4: Make 4×4 permits authoritative for effect admission

Invert the dependency so one 4×4 admission decision owns whether a consequential effect may begin.

## Scope

- Route beginEffect admission through the proven 4×4 decision.
- Preserve existing reservation fact formats and provider adapter contracts.
- Turn legacy admission functions into projections/wrappers or delete them when no longer independently needed.
- Preserve exact revision, current generation, unresolved-effect, and lifecycle fail-closed behavior.
- Remove the shadow comparison only after the new path is the sole semantic owner.

## Required evidence

- [ ] Exact equivalence evidence from the preceding shadow PR remains valid at this head.
- [ ] Existing trusted-effect core-loop tests pass unchanged or become stricter.
- [ ] No effect can dispatch without an admitted reservation.
- [ ] Fresh exact-head hosted Merge gate passes.

## Deletion ledger

The Stage 3 shadow comparator is removed only after the permit decision becomes the runtime owner.

```text
old owner: shadowMutationAdmitted() comparison plus mutationAdmitted() boolean logic
surviving 4×4 expression: effectAdmissionDecision(state), exported under mutationAdmitted only as a compatibility alias
equivalence evidence: exhaustive 2×2×2 authority/revision/reservation truth table
representation retained: existing effect-reservation facts and provider adapter contracts
hostile invariant preserved: stale authority/revision and unresolved reservations deny admission
new primitive: none
```

`mutationAdmitted` remains temporarily as an export alias of `effectAdmissionDecision`; both names resolve to the same function and there is no independent admission rule.

## Stop condition

Stop if authority transfer broadens dispatch eligibility or requires weakening any trusted-code/admission gate.

## Agent completion note

Before marking ready for review, replace this section with the exact-head handoff described above.
