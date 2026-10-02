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

Record exact base/head, files changed, semantic claim, hostile cases exercised, local evidence, hosted evidence, remaining uncertainty, and the smallest next action. Do not hand off an unclassified disagreement.

# Stage 8: Collapse authority semantics into permits

Remove independent authority lifecycle semantics once capability identity, scope, generation, and decay are derived through Objects, Propositions, Coordinates, and permits.

## Scope

- Represent capability identities as Objects, not a fifth primitive.
- Represent holder/scope/generation/resource bindings as domain propositions situated at Coordinates.
- Derive current authorization from those propositions plus permits.
- Preserve cryptographic/runtime capability tokens as implementation mechanisms, not ontology.
- Migrate delegation and execution authority one slice at a time.
- Delete duplicate authority projections only after exact equivalence.

## Required evidence

- [x] Stale authority cannot resurrect.
- [x] Capability Object existence does not imply current permission.
- [x] Generation and exact-revision confinement remain enforced.
- [x] Delegation cannot broaden scope.
- [ ] Fresh exact-head hosted Merge gate passes.

## Deletion ledger

Target redundant authority projection/state-machine code, not runtime capability enforcement.

```text
old owner: repeated current-authority/exact-revision checks outside admission
surviving 4×4 expression: executionPermits() is the single boolean Object permits Event relation; projectExecutionAuthority() remains only as the accepted verifier's decomposed projection, and mutationAdmitted is an alias of effectAdmissionDecision
equivalence evidence: stage-4 admission tests and test/hostile.test.ts exercise the surviving relation directly; test/execution-permits-effect.test.ts covers stale generation, forged metadata, exact-coordinate mismatch, and copied-scope broadening; authority-flow hostile mutation deletes the revision binding
representation retained: ExecutionAuthorityFact, capability digest/token enforcement, EffectReservationFact, provider adapters, and SQLite durable facts
hostile invariant preserved: stale authority cannot resurrect and copied capability metadata cannot broaden scope
new primitive: none
```

## Stop condition

Stop if any deletion would weaken possession, scope, generation, or exact-coordinate enforcement.

## Agent progress note

Base after reconciliation: `e5405e0f3050fc7746d3d66caec8e04ef3f1af55`.

Files changed: `src/authority/transaction-admission.ts`, `src/authority/engine.ts`, `test/execution-permits-effect.test.ts`, `test/hostile.test.ts`, the source contract, and this checklist.

Semantic claim: effect permission is one relation over the current permit, exact Coordinate, and
runtime capability possession. The authoritative admission decision consumes that relation plus
reservation state. Durable authority/capability representations remain enforcement mechanisms.

Hostile cases: stale generation, forged current-generation metadata with stale possession,
claim-coordinate mismatch, capability-object-without-possession, attempted scope broadening, and
removal of exact-revision binding from the static authority fence.

Hosted evidence: exact-head checks must confirm the accepted authority-flow verifier still passes unchanged; this stage does not modify protected experiment machinery.

Remaining uncertainty: Stage 7 remains the predecessor merge boundary. Do not mark this PR ready or
land it around a red or semantically unresolved predecessor.
