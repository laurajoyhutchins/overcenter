# Recovery Kernel Implementation Plan

**Goal:** Implement `docs/architecture/recovery-kernel-and-self-healing.md` as independently reviewable slices while preserving Overcenter's existing authority, evidence, exact-revision, lease, idempotency, and mutation-certainty semantics.

**Repository baseline:** This file map was checked against `dev` at `3258f01b179a4d85843460d8ca4bf3aeb1c14207`. If a named path has moved when a task starts, update the plan in the same PR rather than creating a parallel subsystem.

## Global constraints

- GitHub remains source authority; Hatchable remains runtime authority; Overcenter owns orchestration and recovery evidence; Linear remains projection only.
- Do not create a second incident authority, journal, recovery queue, or generic logging framework.
- Do not persist capability material, credentials, raw prompts, arbitrary provider objects, or copied source blobs in recovery evidence.
- `unknown` is distinct from `satisfied` and `violated`.
- Never blindly retry an invocation with `may_have_mutated:true`.
- Automatic recovery cannot choose semantic dispositions or resolve authority conflicts.
- Recovery is bounded by the existing automatic-recovery attempt budget in `lib/orchestration-recovery.js`.
- Command success is insufficient for `HEALED`; fresh authoritative readback must prove convergence.
- Reuse `orchestration.diagnose`, `orchestration.resume_packet`, `orchestration.maintain`, command/domain receipts, branch roles, and production reconciliation primitives.
- Every implementation slice is test-first and must be registered in `lib/regression-suite-registry.js` when it introduces a maintained regression suite.

---

## Task 1: Persist execution-time runtime provenance

**Files**
- Create: `migrations/053_orchestration_invocation_runtime_provenance.sql`
- Create: `lib/orchestration-runtime-provenance.js`
- Create: `lib/orchestration-runtime-provenance.test.js`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/regression-suite-registry.js`

**Behavior**

Add nullable `runtime_provenance jsonb` to journal invocations. Capture a bounded allowlisted projection before semantic execution containing source commit, immutable production version, runtime-integrity state, worker transport revision, and stored run contract revisions. Historical rows remain explicit `historical_unknown`; current runtime state must never be backfilled as historical execution identity.

**Regressions**
- Secret/capability keys are dropped.
- Captured provenance survives a later deployment change unchanged.
- Missing historical provenance is represented as unknown rather than inferred.
- Existing command journal idempotency and request hashing are unchanged.

---

## Task 2: Add deterministic `orchestration.fault_packet`

**Files**
- Create: `lib/orchestration-fault-packet.js`
- Create: `lib/orchestration-fault-packet.test.js`
- Create: `mcp/orchestration.fault_packet.js`
- Create: `api/orchestration/fault-packet.js`
- Modify: `lib/orchestration-recovery.js`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/worker-transport.js`
- Modify: `lib/worker-transport.test.js`
- Modify: `lib/regression-suite-registry.js`

**Behavior**

Expose a read-only packet over existing diagnosis, resume state, exact faulting invocation and predecessor, lease/checkpoint evidence, relevant domain receipts, captured runtime provenance, and the fresh authority reads required by the failure class. The service emits evidence and classification only, never an AI-generated root cause.

**Regressions**
- `fault_id` is stable across observation times for the same durable fault.
- Unknown failures do not acquire invented causes or recovery recipes.
- Runtime identity comes from captured invocation provenance, not current `dev` or current Hatchable state.
- Packet generation does not create a recursive invocation in the journal being inspected.
- Lists, strings, and evidence projections remain bounded.

---

## Task 3: Add bounded `orchestration.recover`

**Files**
- Create: `lib/orchestration-recovery-operations.js`
- Create: `lib/orchestration-recover.js`
- Create: `lib/orchestration-recover.test.js`
- Create: `mcp/orchestration.recover.js`
- Create: `api/orchestration/recover.js`
- Modify: `lib/orchestration-recovery.js`
- Modify: `lib/orchestration-maintenance-subjects.js`
- Modify: `lib/worker-transport.js`
- Modify: `lib/worker-transport.test.js`
- Modify: `lib/regression-suite-registry.js`

**Behavior**

The caller supplies `run_id`; server-owned policy chooses only pre-authorized deterministic recovery operations. Reuse current typed recovery classifications and maximum-attempt rules. Recovery must reconcile uncertain external effects before any retry and must stop whenever a semantic disposition or authority conflict requires judgment.

**Initial registry cases**
- stale lease/slot -> existing `orchestration.maintain` path;
- safe transport failure with `may_have_mutated:false` -> one exact bounded retry;
- checkpoint-backed heartbeat exhaustion -> canonical requeue only when the disposition is already determined by policy;
- indeterminate external effect -> authoritative reconciliation only;
- semantic decision required -> stop with required-decision evidence.

**Regressions**
- No blind retry for `may_have_mutated:true`.
- Attempt budget stops repeated safe failures.
- Recovery cannot synthesize `completed`, `requeue`, or `blocked` when facts do not determine it.
- Successful recovery operation without fresh readback remains not healed.

---

## Task 4: Add three-valued `overcenter.health`

**Files**
- Create: `lib/overcenter-health.js`
- Create: `lib/overcenter-health.test.js`
- Create: `mcp/overcenter.health.js`
- Create: `api/overcenter/health.js`
- Modify: `lib/orchestration-recovery.js`
- Modify: `lib/scheduled-cycle-completeness.js`
- Modify: `lib/regression-suite-registry.js`

**Behavior**

Create a registry of bounded invariant evaluators returning `satisfied | violated | unknown`, fault domain, severity, evidence, and optional registered recovery operation. Start with data already owned by work leases, orchestration runs/journal, and scheduled-cycle completeness.

**Initial invariants**
- no expired active work-lease slots;
- no stuck `claiming` or `settling` leases beyond policy bounds;
- no unresolved indeterminate effecting invocations;
- no overdue active orchestration runs;
- scheduled cycles have fired/reconciled within their declared cadence.

**Regressions**
- Authority/read failure yields `unknown`, never healthy or failed by inference.
- Aggregate health cannot be healthy while a required invariant is unknown.
- Health evaluation is read-only and bounded.

---

## Task 5: Add GitHub and production-convergence invariants

**Files**
- Create: `lib/overcenter-production-health.js`
- Create: `lib/overcenter-production-health.test.js`
- Modify: `lib/overcenter-health.js`
- Modify: `lib/repository-branch-roles.js`
- Modify: `lib/github-production-branch-policy.js`
- Modify: `lib/github-production-promotion.js`
- Modify: `lib/exact-revision-verification.js`
- Modify: `scripts/production-materialization.mjs`
- Modify: `lib/regression-suite-registry.js`

**Read-only inputs that remain authoritative**
- `lib/repository-branch-roles.js` for development/production role binding;
- `lib/github-production-branch-policy.js` for production branch policy;
- `lib/github-production-promotion.js` and its receipts for exact promoted SHA;
- `lib/exact-revision-verification.js` for exact-revision verification evidence;
- `scripts/production-materialization.mjs` for the existing GitHub-to-Hatchable materialization contract.

**Invariants**
- configured branch roles are valid;
- production policy is satisfied;
- an exact verified candidate exists where promotion is expected;
- production branch equals the promoted verified candidate;
- materialized source equals the production revision;
- immutable Hatchable deployment source equals that revision;
- canonical production regression evidence exists for that deployment.

**Regressions**
- Exact-coordinate happy path is satisfied.
- Each isolated drift produces a specific violated invariant.
- Unavailable GitHub or Hatchable authority produces unknown, not a fabricated drift result.

---

## Task 6: Add fault-domain quarantine

**Files**
- Create: `migrations/054_fault_domain_quarantine.sql`
- Create: `lib/fault-domain-quarantine.js`
- Create: `lib/fault-domain-quarantine.test.js`
- Modify: `lib/execution-authority-core.js`
- Modify: `lib/work-claim-boundary.js`
- Modify: `lib/work-leases.js`
- Modify: `lib/github-branch-role-runtime.js`
- Modify: `lib/github-production-promotion-runtime.js`
- Modify: `lib/worker-boundary-errors.js`
- Modify: `lib/regression-suite-registry.js`

**Behavior**

Persist only Overcenter-owned coordination facts: fault-domain key, state, reason/evidence digest, created/updated timestamps, and the invariant revision that may clear it. Map effecting semantic boundaries to the smallest domain, such as `work-acquisition`, `work-settlement`, `github-mutation:<repo>`, `production:<repo>`, or `portfolio-projection:<project>`.

**Regressions**
- A quarantined effecting command fails before external mutation with `FAULT_DOMAIN_QUARANTINED` and `may_have_mutated:false`.
- Unrelated domains remain executable.
- Read-only diagnosis, health, fault-packet inspection, and registered reconciliation remain available.
- Callers cannot bypass quarantine with an input flag.
- Clearing requires a fresh satisfied invariant at or after the quarantine revision.

---

## Task 7: Add scheduled deterministic healing

**Files**
- Create: `api/orchestration/recover-scheduled.js`
- Create: `lib/orchestration-scheduled-recovery.js`
- Create: `lib/orchestration-scheduled-recovery.test.js`
- Modify: `lib/orchestration-recover.js`
- Modify: `lib/overcenter-health.js`
- Modify: `lib/regression-suite-registry.js`

**Scheduling pattern**

Follow `api/orchestration/maintain-scheduled.js`: `access = 'scheduler'`, POST only, and an explicit cron. Use a non-colliding minute and keep ordinary maintenance separate.

**Behavior**

Each pass evaluates bounded health, selects only violated invariants that explicitly permit automatic recovery, runs the registered deterministic operation, rereads the invariant, records `healed | still_violated | unknown`, and applies quarantine when policy requires. It contains no reasoning-model call and never creates, prioritizes, or edits portfolio work.

**Regressions**
- Anti-thrash budget stops repeated attempts.
- Unknown invariants are not automatically acted upon.
- Successful command without invariant convergence is not healed.
- Scheduler handler has no user-facing/admin mutation surface.

---

## Task 8: Add end-to-end recovery acceptance scenarios

**Files**
- Create: `lib/orchestration-recovery-acceptance.test.js`
- Create: `scripts/verify-recovery-kernel.test.mjs`
- Modify: `lib/regression-suite-registry.js`
- Modify: `.github/workflows/regression-suite-registry.yml` only if the registry runner requires a new explicit command
- Modify: `docs/architecture/recovery-kernel-and-self-healing.md` only when implementation changes an approved invariant or authority boundary

**Scenarios**
- novel semantic-boundary defect produces exact causal context and no invented automatic fix;
- stale lease self-heals and proves slot release by readback;
- safe transport retry is bounded and exact;
- indeterminate effect reconciles and never blind-retries;
- semantic-decision boundary stops for reasoning/operator input;
- production drift identifies the exact violated coordinate;
- authority outage yields unknown;
- quarantine isolates only the affected domain;
- canonical regression suite remains green.

---

## Task 9: Live dogfood and lifecycle completion

**Source files:** none by default. This task consumes the semantic surfaces created above. Any source change discovered during dogfood becomes a separate Execute slice with its own exact candidate.

**Required live evidence**
1. Promote the exact integrated `dev` revision through the existing `github.production.promote` and production-materialization path.
2. Prove immutable Hatchable deployment evidence binds runtime to that exact revision.
3. Invoke `overcenter.health` and retain invariant evidence.
4. Exercise a reproducible stale-coordination fixture and prove recovery by authoritative readback.
5. Exercise a non-auto-recoverable fault and prove deterministic fault-packet output.
6. Prove an indeterminate-effect fixture does not blind-retry.
7. Prove `api/orchestration/recover-scheduled.js` is registered and firing.
8. Attach exact evidence coordinates to owning GitHub issues and Overcenter settlements.
9. Close implementation work only when GitHub source, deployed runtime, and recovery acceptance evidence agree.

## Completion criteria

Do not call the recovery kernel implemented until:

- runtime provenance is captured at execution time;
- fault packets are bounded and read-only;
- recovery uses a server-owned operation registry;
- semantic decisions stop for reasoning/operator input;
- indeterminate effects reconcile before retry;
- health is three-valued;
- quarantine is fault-domain scoped;
- scheduled healing is bounded and deterministic;
- every healing claim has fresh authoritative readback;
- focused, canonical, and live dogfood verification all pass.
