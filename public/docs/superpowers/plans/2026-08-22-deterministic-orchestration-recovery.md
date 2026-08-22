# Deterministic Orchestration Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert known orchestration failures into typed, deterministic recovery behavior and remove recovery choreography from worker-facing protocol instructions.

**Architecture:** Extend `command-response-v1` with a pure recovery classifier, derive diagnosis from existing run/journal/lease/Linear state, make semantic claims revision-only, and make `orchestration.finish` settlement-aware. Reuse existing lease reconciliation, settlement, idempotency, and journal primitives instead of introducing another state store or recovery queue.

**Tech Stack:** Hatchable JavaScript isolate functions, PostgreSQL, Linear authority adapter, existing work-lease/orchestration journal kernel, MCP and HTTP command surfaces.

**Spec:** `public/docs/superpowers/specs/2026-08-22-deterministic-orchestration-recovery-design.md`

## Global Constraints

- Preserve exclusive leases, idempotent receipts, stale/orphan recovery safety, durable run state, `command-response-v1`, authority boundaries, and evidence-before-claims behavior.
- Do not revive the Agent Execution Control Plane.
- Do not add a planner, agent, queue, or meta-orchestration layer.
- Do not blind-retry a mutation whose external effect may already have occurred.
- Prefer deletion of obsolete worker recovery prose over parallel compatibility instructions.

---

### Task 1: Typed orchestration failure vocabulary

**Files:**
- Create: `lib/orchestration-failures.js`
- Create: `lib/orchestration-recovery-policy.test.js`
- Modify: `lib/command-response.js`
- Modify: `lib/command-response.test.js`
- Verification surface: `POST /api/verification/regressions` (current replacement for the retired per-suite diagnostic routes)

**Interfaces:**
- Consumes: existing domain `error_code`, `command`, `retryable`, `may_have_mutated`, and structured failure details.
- Produces: `classifyOrchestrationFailure()` and additive failure-envelope fields `failure_state`, `automatic_recovery_allowed`, `recovery_operation`, `escalation_required`, `escalation_reason`.

- [ ] **Step 1: Write failing tests** for the required typed failure classes, transport retryability, mutation ambiguity, and bounded recovery escalation.
- [ ] **Step 2: Run `POST /api/verification/regressions`** and confirm the new suite reports `ok: false` before implementation. HTTP status is transport-only; inspect the JSON result.
- [ ] **Step 3: Implement the pure classifier** with no database or authority access.
- [ ] **Step 4: Integrate it into `command-response-v1`** without changing existing detailed error codes.
- [ ] **Step 5: Run diagnostics** and confirm the taxonomy/envelope tests pass.

### Task 2: Deterministic orchestration diagnosis

**Files:**
- Modify: `lib/orchestration-recovery.js`
- Create: `api/orchestration/diagnose.js`
- Create: `mcp/orchestration.diagnose.js`
- Modify: `lib/worker-transport.js`
- Modify: `lib/worker-transport.test.js`
- Modify: `lib/orchestration-recovery-policy.test.js`

**Interfaces:**
- Consumes: existing run row, invocation journal, lease/slot/checkpoint state, and authoritative Linear issue observation.
- Produces: `orchestration.diagnose` with current run/work/lease state, derived worker health, last success, last typed failure, bounded recovery count, exact recovery operation, and escalation decision.

- [ ] **Step 1: Add failing diagnosis tests** for active lease, stale lease, transport degradation, repeated recovery failure, and historical unobservable termination.
- [ ] **Step 2: Extend the recovery store** with bounded read-only queries for run state, live lease, last success, and recent failures.
- [ ] **Step 3: Implement diagnosis as a read-only projection** that reuses the failure classifier and authoritative work observation.
- [ ] **Step 4: Expose HTTP, MCP, and semantic worker-command surfaces** without adding planning behavior.
- [ ] **Step 5: Run diagnostics** and confirm diagnosis invariants pass.

### Task 3: Remove semantic claim-state reconstruction

**Files:**
- Modify: `lib/operator-commands.js`
- Modify: `lib/worker-transport.js`
- Modify: `mcp/work.claim.js`
- Modify: `lib/worker-transport.test.js`
- Modify: `lib/orchestration.test.js`

**Interfaces:**
- Consumes: `work_ref`, `run_id`, and server-issued `observed_revision` / `authoritative_revision`.
- Produces: canonical lease claim request with `expected_revision` and no caller-owned lifecycle/lane semantic strings.

- [ ] **Step 1: Replace legacy semantic-claim tests** with regression tests proving `Todo / lane:source-implementation` does not need to be reconstructed.
- [ ] **Step 2: Make semantic/MCP claim revision-only** while retaining low-level lease compatibility internally.
- [ ] **Step 3: Preserve deterministic claim idempotency** across the revision-only contract.
- [ ] **Step 4: Run worker/orchestration diagnostics** and confirm freshly observed source-implementation work remains claimable.

### Task 4: Make terminal settlement structural

**Files:**
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/operator-commands.js`
- Modify: `api/orchestration/finish.js`
- Modify: `mcp/orchestration.finish.js`
- Modify: `lib/orchestration.test.js`
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`

**Interfaces:**
- Consumes: run finish semantics plus optional explicit `active_lease_settlement` semantics.
- Produces: one terminal command that safely settles an owned lease through existing `settleByRef`, verifies no live lease remains, then finishes the run.

- [ ] **Step 1: Add failing tests** proving finish can settle-and-finish and cannot terminalize if settlement fails.
- [ ] **Step 2: Add optional active-lease settlement normalization** without guessing disposition.
- [ ] **Step 3: Inject the existing lease service into orchestration run service** and execute settlement before terminal run mutation.
- [ ] **Step 4: Ensure heartbeat budget errors expose a durable checkpoint and exact settlement prescription.**
- [ ] **Step 5: Run diagnostics** and verify terminal runs cannot orphan normal live leases.

### Task 5: Transient dependency recovery and escalation boundary

**Files:**
- Modify: `lib/orchestration-failures.js`
- Modify: `lib/orchestration-recovery.js`
- Modify: `lib/orchestration-recovery-policy.test.js`
- Modify: `lib/orchestration-runs.js`

**Interfaces:**
- Consumes: transport/setup error evidence and bounded recent journal failures.
- Produces: degraded/retryable worker projection for transient outages, disabled/error projection for persistent configuration, `RECOVERY_FAILED` after bounded repeated recovery failure, and `UNOBSERVABLE_SESSION_TERMINATION` for maintenance-terminalized historical sessions.

- [ ] **Step 1: Add failing tests** for transient retry, dependency recovery, persistent setup error, repeated failure escalation, and historical cessation classification.
- [ ] **Step 2: Implement bounded recovery-count derivation from the existing journal.**
- [ ] **Step 3: Change future abandoned-run maintenance reason** to the non-speculative historical classification while retaining compatibility with old evidence.
- [ ] **Step 4: Run diagnostics** and verify no retry loop can remain indefinitely automatic.

### Task 6: Remove obsolete recovery choreography

**Files:**
- Modify: `public/docs/command-response-v1.md`
- Modify: `public/docs/orchestration-recovery.md`
- Modify: `public/docs/control-plane-surface-inventory.md`
- Modify: worker-facing MCP descriptions touched above.

**Interfaces:**
- Consumes: the implemented software recovery contract.
- Produces: one worker rule: execute the canonical command, obey known typed recovery, escalate only machine-declared exceptional boundaries.

- [ ] **Step 1: Delete prose requiring workers to reconstruct claim state or remember settle-then-finish choreography.**
- [ ] **Step 2: Document typed failures, diagnosis, bounded retry/degraded behavior, and escalation boundary.**
- [ ] **Step 3: Search project source for superseded recovery instructions** and remove conflicting guidance.

### Task 7: Verification and deployment

**Files:**
- No new design surface.

**Interfaces:**
- Consumes: complete WIP source.
- Produces: validator-clean deployed project and fresh live evidence.

- [ ] **Step 1: Run `POST /api/verification/regressions` on WIP** and require `ok: true` with zero failed tests.
- [ ] **Step 2: Run Hatchable dry-run deploy** and require no hard errors.
- [ ] **Step 3: Deploy once** with the user request as intent and a specific changelog summary.
- [ ] **Step 4: Run live diagnostics and `orchestration.diagnose`** through admin access.
- [ ] **Step 5: Verify public access is rejected** for the admin-only diagnosis route.
- [ ] **Step 6: Report remaining reasoning-only failure classes and any external scheduler boundary that the control plane does not own.