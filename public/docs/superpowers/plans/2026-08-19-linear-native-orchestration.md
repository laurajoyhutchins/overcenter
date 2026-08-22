# Linear-Native Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Linear lifecycle mutations from runtime ownership, generalize orchestration to campaign projects, and retire the legacy single-project dispatch architecture without weakening lease safety.

**Architecture:** Linear remains durable work/planning authority while Hatchable alone owns transient execution. New leases claim `Todo` work without changing Linear status; existing legacy `In Progress` leases remain compatible during cutover. Run scope becomes team-wide with optional project constraints, and work-surface reconciliation can place admitted work into campaign projects.

**Tech Stack:** Hatchable JavaScript isolate functions, PostgreSQL, Linear GraphQL API/connector, existing command-response-v1 orchestration transport.

**Spec:** `public/docs/superpowers/specs/2026-08-19-linear-native-orchestration-design.md`

## Global Constraints

- Do not add a planner, scheduler, task database, shadow queue, or second portfolio authority.
- Preserve lease exclusivity, idempotency, run-budget fencing, execution-fingerprint fencing, checkpoint continuity, and ambiguous-effect recovery.
- Prefer deletion of Linear synchronization/recovery machinery over new coordination state.
- Keep GitHub as implementation truth and Linear as durable work/planning truth.

---

### Task 1: Non-mutating lease claims

**Files:**
- Modify: `lib/work-leases.test.js`
- Modify: `lib/work-leases.js`
- Modify: `lib/orchestration-recovery.js`
- Modify: `lib/orchestration-journal.js`

**Interfaces:**
- Consumes: existing `work.claim`, `work.settle`, `work.checkpoint`, `work.heartbeat` contracts.
- Produces: claims whose authoritative Linear lifecycle remains `Todo`; legacy leases with old `In Progress` claim receipts continue to settle/recover.

- [x] Add failing tests proving successful claim leaves Linear `Todo`, second claimant is still rejected by the lease slot, expiry does not require a Linear restore, and settlement can advance the lane from `Todo`.
- [x] Run orchestration diagnostics and confirm the new tests fail for the expected `In Progress` mutation.
- [x] Implement the smallest compatibility-aware lease change.
- [x] Run all lease/orchestration diagnostics and dry-run deploy.

### Task 2: Team-wide campaign scope

**Files:**
- Modify: `lib/orchestration.test.js`
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/work-leases.js`
- Modify: `lib/orchestration-journal.js`

**Interfaces:**
- Consumes: `orchestration.start.scope`.
- Produces: scope with `team`, optional `projects`, `lanes`, and `repositories`; legacy `project` input remains accepted during transition.

- [x] Add failing tests for team-wide unrestricted project scope and explicit project allowlists.
- [x] Verify failures reflect current required single-project behavior.
- [x] Implement normalized scope and claim/horizon fencing.
- [x] Run orchestration diagnostics and dry-run deploy.

### Task 3: Campaign-aware work-surface reconciliation

**Files:**
- Modify: `lib/portfolio-reconcile-work-surface.test.js`
- Modify: `lib/portfolio-reconcile-work-surface.js`
- Modify: `mcp/portfolio_reconcile_work_surface.js`

**Interfaces:**
- Consumes: explicit `project` per reconciliation request or item.
- Produces: admitted Linear issues in the requested active campaign project while preserving source identity and idempotency.

- [x] Add failing tests for reconciling into a non-legacy project in the same team.
- [x] Implement project resolution without hard-coded project-name authority, including team-wide fallback identity discovery.
- [x] Run reconciliation diagnostics and dry-run deploy.

### Task 4: Live cutover and verification

**Files:**
- Update: `public/docs/control-plane-surface-inventory.md`
- Update: `public/docs/work-continuation-v1.md` if lifecycle wording is stale.

**Interfaces:**
- Produces: deployed compatibility cutover and evidence that claims no longer alter Linear lifecycle.

- [x] Confirm no live lease slot exists before deploy.
- [x] Deploy with a bounded changelog.
- [x] Run diagnostics and a selected safe claim/requeue canary proving Linear remains `Todo` while the lease is active and requeue performs no Linear mutation.
- [x] Verify scheduled maintenance and orchestration status are healthy.

### Task 5: Linear structure migration

**Files:** Linear workspace state plus only the narrow API primitives actually required.

**Interfaces:**
- Produces: campaign projects/milestones, semantic lanes only, retired legacy dispatcher/routing surfaces.

- [x] Create/move campaign projects only where existing work forms a genuine multi-session objective.
- [x] Retire old `route:*`, `lane:dispatch`, `lane:systems`, and `lane:product-data` labels without erasing history.
- [x] Complete/archive `LJH-83` once its responsibilities are structurally represented.
- [x] Remove `In Progress` semantics after runtime verification. Linear refused archival of the team's final started-category state, so it was renamed `Started (unused)` with explicit non-authoritative guidance; zero active issues use it.
- [x] Archive the legacy `Portfolio Orchestration` project after its remaining useful resources/issues are migrated.