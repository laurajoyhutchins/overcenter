# Production Reconciliation Design

## Outcome

Make the normal production operation `production.reconcile({ repo })`.

The caller supplies repository identity only. Overcenter derives development and production branch roles, exact heads, exact-revision verification evidence, mutation/retry identity, and current production-runtime evidence. Success means the declared production Git revision and the verified immutable Hatchable runtime projection identify the same exact revision.

## Existing machinery

Overcenter already owns exact-SHA Git promotion through `production.promote({ repo })`. The production branch push already triggers the serialized `.github/workflows/production-materialization.yml`, which checks out the exact pushed SHA and runs the existing production materialization protocol. The new command coordinates and verifies these existing safety boundaries rather than adding a second deployment implementation.

## Public contract

Input is exactly:

```json
{"repo":"owner/repository"}
```

Caller-selected branch names, SHAs, workflow-run IDs, Hatchable project/version coordinates, runtime refs, and idempotency keys are invalid.

A successful result is bounded evidence containing the repository, selected development revision, production revision, verified runtime revision, development verification evidence, runtime verification evidence, and deployment version. `already_converged` is a successful no-op outcome.

## Convergence algorithm

1. Resolve declared development and production branch roles.
2. Read exact authoritative branch heads.
3. Locate exact-revision verification evidence for the current development head.
4. Observe the verified production runtime projection.
5. If production and runtime already identify the verified development revision, return `already_converged` without mutation.
6. If production is stale, invoke the existing `production.promote({ repo })` safety boundary.
7. Reread production authority. Materialization may not be considered until readback proves the exact selected revision.
8. Observe the existing production-materialization workflow/runtime evidence for that exact revision. If materialization is still in flight, return a typed waiting result rather than replaying promotion or inventing a second deployment path.
9. If production is already current but runtime is stale and no matching materialization is active/successful, invoke only an existing repository-owned deterministic materialization trigger if one exists and can be safely fenced. Otherwise report the unmet invariant without unsafe mutation.
10. Freshly reread production and immutable runtime evidence before returning convergence success.

Reinvocation is state-derived. A prior promotion that succeeded but whose caller lost the response is discovered by authority reread and is not blindly replayed.

## Authority and safety invariants

- GitHub remains source/ref authority.
- Stored branch roles choose development and production branches.
- Exact verification evidence authorizes only the exact revision it describes.
- Hatchable mutable workspace state is not production evidence.
- Immutable deployment receipt/evidence must bind runtime to the same exact production revision.
- Existing promotion and materialization primitives remain safety owners for their mutations.
- At most one unresolved external mutation boundary is crossed at a time.
- Dependent effects require authoritative readback of the prior effect.
- Indeterminate mutations are never blind-retried.
- Failures preserve `may_have_mutated` truth.
- Final success requires fresh same-SHA Git production and immutable runtime evidence.
- This does not claim to eliminate Hatchable #161's mutable draft-to-deploy atomicity gap.

## Components

### `lib/production-reconcile-operation.js`

Pure convergence coordinator. No credentials or network calls. It classifies current state, sequences ports, propagates mutation uncertainty, and validates final same-revision evidence.

### `lib/production-reconcile-overcenter-host.js`

Binds the coordinator to existing branch-role, exact-verification, `productionPromotionFor`, GitHub Actions observation, and production-runtime receipt observation services. It must reuse the repository-owned production-materialization workflow rather than duplicate deployment logic.

### `mcp/production.reconcile.js` and semantic worker binding

Primary admin semantic command using the standard descriptor and correlated-command journal. Schema accepts only `repo`.

## Required regressions

The first regression proves a disposable caller supplies only `{repo}` and, starting from verified dev + stale production + stale runtime, the command selects the exact verified revision, promotes it, rereads production authority, refuses to consider materialization before that readback, observes the exact same-SHA materialization evidence, and returns final convergence evidence without caller mechanical coordinates.

Additional regressions cover already-converged no-op, production-current/runtime-stale, missing verification, post-observation production drift, indeterminate promotion preventing continuation, runtime/receipt mismatch, final readback drift, and rejection of caller mechanical fields.

## Operator experience

`production.reconcile({repo})` is the normal path. `production.promote` remains a lower-level semantic primitive. The command is convergent: repeated calls describe desired production truth rather than a procedural phase.

## Acceptance

- Primary discovery exposes repo-only `production.reconcile`.
- The disposable-caller regression is demonstrated red before implementation and green after it.
- Existing promotion/materialization safety contracts are reused.
- Partial completion resumes from observed authority.
- Unknown or indeterminate state fails closed.
- Fresh final evidence binds production Git and immutable runtime to one exact SHA.
- Relevant canonical verification is green.