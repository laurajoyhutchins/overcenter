# Production Reconciliation Implementation Plan

**Goal:** Add `production.reconcile({repo})` as the intent-first production convergence boundary.

**Architecture:** Build a pure state-derived coordinator, then bind it to existing exact promotion and serialized production materialization. Add exact-revision workflow-dispatch recovery rather than a second Hatchable deployment path.

**Spec:** `docs/superpowers/specs/2026-09-04-production-reconcile-design.md`

## Constraints

- Repo-only public input.
- Reuse existing promotion and materialization safety owners.
- One unresolved external mutation boundary at a time.
- Authoritative readback before dependent effects.
- No blind retry after indeterminate mutation.
- Final Git production and immutable runtime must bind the same exact SHA.
- Preserve Hatchable #161 as a known residual platform limitation.

## Task 1: Pure coordinator

- [ ] Add disposable-caller RED regression.
- [ ] Implement `reconcileProduction` with exact-SHA verification, ordering, convergence/no-op, pending outcomes, and mutation-certainty propagation.
- [ ] Add fail-closed matrix and run focused tests green.

## Task 2: Materialization recovery boundary

- [ ] Add exact-revision `workflow_dispatch` input to the existing production-materialization workflow.
- [ ] Fence both push and dispatch materialization against current production branch before Hatchable mutation.
- [ ] Add GitHub App actions-write capability dedicated to production materialization dispatch.
- [ ] Observe/reuse matching exact workflow runs before dispatch; never blind-retry uncertain dispatch.
- [ ] Test pending, succeeded, failed, and indeterminate cases.

## Task 3: Overcenter host

- [ ] Compose branch roles, exact heads, exact V8 verification, `productionPromotionFor`, materialization workflow observation/recovery, and final evidence.
- [ ] Keep provider bookkeeping out of caller input.
- [ ] Add host tests proving the coordinator cannot materialize before post-promotion readback.

## Task 4: Semantic command

- [ ] Add primary repo-only `production.reconcile` descriptor in TypeScript authority and generated runtime mirror.
- [ ] Add worker transport binding and MCP adapter.
- [ ] Reject mechanical coordinates in schema/discovery tests.

## Task 5: Documentation and verification

- [ ] Document `production.reconcile` as normal path and `production.promote` as lower-level primitive.
- [ ] Refresh generated contract evidence.
- [ ] Run focused tests, `npm test`, `npm run typecheck`, `npm run verify`, contract evidence, and exact V8 verification.
- [ ] Integrate exact-head PR through Overcenter.
- [ ] Settle transition only with exact merge/check evidence.
- [ ] Promote/materialize the feature to production and dogfood `production.reconcile({repo})` against Overcenter itself.