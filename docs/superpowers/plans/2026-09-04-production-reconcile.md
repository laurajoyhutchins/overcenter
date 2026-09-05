# Production Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `production.reconcile({ repo })` as the normal intent-first dev-to-production convergence command.

**Architecture:** Add a pure state-derived coordinator and a thin Overcenter host adapter. Reuse exact-SHA `production.promote` and the existing serialized production-materialization workflow/runtime evidence instead of adding another deployment path.

**Tech Stack:** Node 22, JavaScript modules, TypeScript validation/build, GitHub App APIs, GitHub Actions, Hatchable, Overcenter semantic command/journal infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-04-production-reconcile-design.md`

## Global Constraints

- Public input is repo-only.
- GitHub remains source/ref authority.
- Reuse existing promotion and materialization safety owners.
- Do not blind-retry an indeterminate mutation.
- Require authoritative readback before dependent effects.
- Preserve `may_have_mutated` semantics.
- Final success requires same-SHA production Git and immutable runtime evidence.
- Do not claim to solve Hatchable #161.

---

### Task 1: Pure convergence coordinator

**Files:** create `lib/production-reconcile-operation.js`; create `scripts/production-reconcile-operation.test.mjs`; modify `scripts/test.mjs`.

**Interfaces:** produce `reconcileProduction(intent, ports)` with repo-only intent and ports for authority observation, promotion, materialization observation, and final verification.

- [ ] Write the disposable-caller test first. It must assert promotion -> production reread -> materialization observation ordering and exact selected-SHA continuity.
- [ ] Run the focused test and capture expected RED because the operation does not exist.
- [ ] Implement minimal normalization, verification gating, state classification, post-promotion fencing, waiting behavior, final verification, and uncertainty propagation.
- [ ] Add fail-closed tests for already converged, runtime stale, missing verification, production drift, indeterminate promotion, runtime mismatch, and final drift.
- [ ] Run focused tests green.

### Task 2: Overcenter host composition

**Files:** create `lib/production-reconcile-overcenter-host.js`; create focused host tests.

**Interfaces:** produce `productionReconciliationFor(options).reconcile({repo})` by binding the pure coordinator to stored branch roles, GitHub exact heads/verification runs, `productionPromotionFor`, production-materialization workflow observation, and immutable runtime receipt observation.

- [ ] Write host-composition tests first.
- [ ] Verify RED.
- [ ] Implement only the adapters needed to reuse existing promotion/materialization mechanisms.
- [ ] Verify GREEN.

### Task 3: Primary semantic command

**Files:** modify `lib/semantic-command-descriptors.js` and `lib/worker-transport.js`; create `mcp/production.reconcile.js`; update semantic/worker verification scripts.

- [ ] Write a failing discovery/schema test proving primary MCP exposure and repo-only input.
- [ ] Register descriptor, worker binding, and MCP boundary.
- [ ] Verify unsupported mechanical fields fail closed.
- [ ] Run focused command-surface tests green.

### Task 4: Operator documentation

**Files:** update `public/docs/semantic-command-descriptors.md`; add/update focused production reconciliation docs.

- [ ] Document `production.reconcile` as normal operator path and `production.promote` as lower-level primitive.
- [ ] Document convergent reinvocation, waiting state, evidence, and #161 limitation using actual implementation field names.

### Task 5: Whole-feature verification and settlement

- [ ] Re-run disposable-caller and fail-closed focused tests.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run verify` or the exact repository-equivalent canonical checks required by CI.
- [ ] Review the complete diff against the spec acceptance list.
- [ ] Settle the Overcenter transition only with exact commit and test/check evidence.
- [ ] Update issue #217 only after implementation evidence exists. Close #188 only if live materialization-after-promotion behavior is actually verified.