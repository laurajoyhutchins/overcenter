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

# Stage 1: Formalize the 4×4 semantic boundary

Land the four-noun/four-verb formal boundary and source-contract verification without changing runtime behavior.

## Scope

- Add the 4×4 formal model: Object, Event, Proposition, Coordinate; permits, asserts, supports, requires.
- Add Lean and TLA+ proofs for the live effect-lifecycle refinement.
- Add the narrow TypeScript AST extractor that derives the production admission/release/settlement contract.
- Bind verification to exact production source identities and fail closed on unknown extractor shapes.
- Wire the formal checks into repository verification without changing production decisions.

## Required evidence

- [ ] Lean has no sorry/admit/sorryAx.
- [ ] TLA+ positive model completes without invariant violations.
- [ ] Negative controls still falsify recovery certainty and reservation-existence-is-authority.
- [ ] Extractor hostile mutations are rejected.
- [ ] Fresh exact-head hosted Merge gate passes.

## Deletion ledger

None. This PR establishes the proof boundary only.

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

Stop if the formal contract requires a fifth primitive or if the extractor must guess about unsupported TypeScript control flow.

## Agent completion note

Before marking ready for review, replace this section with the exact-head handoff described above.
