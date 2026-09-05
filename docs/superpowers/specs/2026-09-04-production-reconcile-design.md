# Production Reconciliation Design

## Outcome

Make `production.reconcile({ repo })` the normal operator-facing dev-to-production operation.

The caller expresses desired production truth using repository identity only. Overcenter derives development and production branch roles, exact Git revisions, exact-revision verification evidence, materialization state, retry identity, and recovery bookkeeping. Success means the current production Git revision and verified immutable Hatchable runtime identify the same exact revision.

## Existing safety owners

Overcenter already owns exact Git promotion through `production.promote({ repo })`. The production branch already triggers a serialized `Production materialization` GitHub Actions workflow, which materializes the exact production revision into Hatchable and verifies the immutable deployment receipt, source manifest, and production regression suite.

`production.reconcile` composes these boundaries. It does not reimplement weaker versions of promotion or deployment.

## Public contract

Input is exactly:

```json
{"repo":"owner/repository"}
```

Caller-selected branch names, SHAs, verification run IDs, runtime project/version coordinates, workflow run IDs, and idempotency keys are invalid.

## Convergence model

1. Resolve declared development and production branch roles.
2. Read exact authoritative branch heads.
3. Verify the exact current development revision.
4. Observe verified immutable production-runtime evidence.
5. If Git production and runtime already identify the verified development revision, return `already_converged` without mutation.
6. If Git production is stale, invoke existing `production.promote({repo})`.
7. Reread Git authority. No runtime effect may be considered until readback proves production equals the selected exact revision and development has not moved.
8. If runtime is stale, invoke the existing serialized production-materialization boundary for that exact production revision. A promotion-triggered run is reused; if the production push did not leave a usable run, recovery may dispatch the same repository-owned workflow with an exact-revision input.
9. If materialization is still queued or running, return a typed pending outcome. Do not replay promotion or dispatch duplicate materialization blindly.
10. After successful materialization, freshly reread Git production and runtime evidence. Return success only if both bind the same selected SHA.

Repeated calls are state-derived. Partial completion resumes from observed authority rather than procedural phase memory.

## Materialization recovery

The existing `production-materialization.yml` remains the single production-runtime writer. It gains a `workflow_dispatch` recovery entrypoint accepting one exact revision. Both push and dispatch execution must fence the requested revision against the current production branch before any Hatchable mutation.

A dispatch is a real external effect. Overcenter therefore observes exact matching workflow runs before dispatch, records/returns the created run identity when GitHub provides it, and treats uncertain dispatch transport as indeterminate rather than blindly retryable.

A successful materialization workflow is authoritative evidence only when it is for the exact selected revision and the workflow itself completed immutable Hatchable receipt/manifest/regression verification.

## Pure coordinator

`reconcileProduction(intent, ports)` is provider-neutral. Its ports expose branch roles, exact heads, exact development verification, current runtime observation, exact promotion, runtime reconciliation, and final-state verification. The coordinator owns ordering, state classification, exact-SHA continuity, pending outcomes, and mutation-certainty propagation.

## Overcenter host

The Hatchable host adapter binds the pure coordinator to:

- stored repository branch roles;
- GitHub App branch-head reads;
- exact-revision V8 verification evidence;
- `productionPromotionFor({db}).promote({repo})`;
- the existing `Production materialization` workflow and its exact workflow-run evidence;
- immutable runtime evidence produced by that workflow.

## Safety invariants

- GitHub is source/ref authority.
- Branch roles are repository configuration, not caller input.
- Verification evidence authorizes only the exact revision it names.
- Promotion remains non-force exact-SHA promotion.
- No dependent runtime effect occurs before authoritative post-promotion Git readback.
- Existing materialization remains the only Hatchable production writer.
- An indeterminate external effect is never blind-retried.
- `may_have_mutated` truth is preserved across composed failures.
- Final success requires fresh same-SHA Git production and verified immutable runtime evidence.
- A manually changed Hatchable deployment without matching verified materialization evidence is not accepted as current production.
- This does not claim to eliminate Hatchable issue #161's mutable draft-to-deploy atomicity limitation.

## Required regressions

The first regression proves a disposable caller supplying only `{repo}` can converge verified development + stale production + stale runtime through exact promotion, authoritative production reread, exact same-SHA materialization, immutable runtime verification, and final convergence evidence. It must prove runtime reconciliation is impossible before post-promotion readback.

Additional tests cover:

- already-converged verified no-op;
- production-current/runtime-stale recovery without promotion;
- missing development verification;
- development or production drift after promotion;
- indeterminate promotion preventing runtime effects;
- materialization pending without duplicate mutation;
- indeterminate materialization dispatch;
- immutable runtime mismatch;
- final readback drift;
- rejection of caller mechanical coordinates.

## Operator experience

`production.reconcile({repo})` is the default command. `production.promote({repo})` remains available as a narrower lower-level primitive for exact Git promotion. Normal callers should not need to know which stage is stale or reconstruct provider bookkeeping.