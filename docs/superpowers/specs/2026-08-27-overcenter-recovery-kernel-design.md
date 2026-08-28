# Overcenter Recovery Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Turn Overcenter's existing recovery evidence and deterministic maintenance machinery into a bounded recovery kernel that can package novel faults, mechanically heal known-safe faults, evaluate explicit health invariants, and quarantine only affected mutation domains.

**Architecture:** Extend the existing orchestration journal with execution-time runtime provenance. Build a read-only fault-packet assembler over `orchestration.diagnose`, `orchestration.resume_packet`, the journal, leases/checkpoints, receipts, and fresh authority reads. Add a recovery executor whose server-owned registry can invoke only existing approved semantic recovery operations and must prove healing by readback. Add a three-valued health invariant registry, then fault-domain quarantine and scheduled deterministic healing.

**Tech Stack:** JavaScript ES modules in Hatchable V8 runtime, PostgreSQL migrations and `db` binding, existing command-response/orchestration journal framework, Overcenter MCP/API semantic surfaces, GitHub App adapters, Node `assert`-style repository regression suites.

**Spec:** `docs/superpowers/specs/2026-08-27-overcenter-recovery-kernel-design.md`

**Global Constraints:**
- GitHub remains source authority; Hatchable remains runtime authority; Overcenter owns orchestration/recovery evidence; Linear remains projection only.
- Do not create a second incident authority or generic logging framework.
- Do not persist lease tokens, credentials, raw prompts, arbitrary provider objects, or source blobs in fault evidence.
- `unknown` is distinct from `satisfied` and `violated`.
- Never blindly retry an invocation with `may_have_mutated:true`.
- Automatic recovery cannot choose semantic dispositions or resolve authority conflicts.
- Automatic recovery is bounded by the existing maximum recovery-attempt policy.
- A recovery command succeeding is insufficient for `HEALED`; fresh authoritative readback must prove the affected invariant.
- Reuse `orchestration.diagnose`, `orchestration.resume_packet`, `orchestration.maintain`, domain receipts, branch roles, and production reconciliation primitives instead of replacing them.
- Keep the implementation slices independently reviewable and mergeable.

---

## Task 1: Persist execution-time runtime provenance on journal invocations

**Files:**
- Create: `migrations/053_orchestration_invocation_runtime_provenance.sql`
- Create: `lib/orchestration-runtime-provenance.js`
- Create: `lib/orchestration-runtime-provenance.test.js`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/regression-suite-registry.js`

### Behavior

`orchestration_command_invocations` gains a nullable `runtime_provenance jsonb` column. New invocations capture a bounded provenance projection before the semantic operation executes.

The service must expose a shape equivalent to:

```js
{
  source_commit: string | null,
  production_version: string | null,
  runtime_integrity: 'verified' | 'unverified' | 'indeterminate' | 'unknown',
  worker_transport_revision: string | null,
  contract_revisions: {
    project_instructions: string | null,
    fast_forward_skill: string | null,
    execution_ownership_skill: string | null,
  },
}
```

Historical rows without the column value read as `{ status: 'historical_unknown' }` at projection time.

### Steps

- [ ] **Write failing provenance regression**

In `lib/orchestration-runtime-provenance.test.js`, create a deterministic fake provenance provider and assert:

```js
const projection = normalizeRuntimeProvenance({
  source_commit: 'a'.repeat(40),
  production_version: '356',
  runtime_integrity: 'verified',
  worker_transport_revision: 'worker-transport-v2',
  contract_revisions: { project_instructions:'p1', fast_forward_skill:'f1', execution_ownership_skill:'e1' },
  lease_token: 'must-not-survive',
  authorization: 'must-not-survive',
});

assert.deepEqual(projection, {
  source_commit: 'a'.repeat(40),
  production_version: '356',
  runtime_integrity: 'verified',
  worker_transport_revision: 'worker-transport-v2',
  contract_revisions: { project_instructions:'p1', fast_forward_skill:'f1', execution_ownership_skill:'e1' },
});
```

Also assert invalid SHAs, oversized strings, and unknown integrity states fail closed or normalize to explicit `unknown` according to the helper contract.

- [ ] **Add migration**

`migrations/053_orchestration_invocation_runtime_provenance.sql`:

```sql
ALTER TABLE orchestration_command_invocations
ADD COLUMN IF NOT EXISTS runtime_provenance jsonb;
```

Do not backfill historical rows.

- [ ] **Implement provenance helper**

`lib/orchestration-runtime-provenance.js` should:
- use an explicit allowlist;
- derive contract revisions from stored run provenance when a `run_id` exists;
- obtain production/source identity from the existing verified runtime-source/materialization evidence surface;
- return explicit unknowns if the identity cannot be proven;
- never read current `dev` and pretend it is execution provenance.

Dependency injection should allow tests to supply runtime/source observations without external calls.

- [ ] **Capture provenance in the journal**

In `lib/orchestration-journal.js`, extend `journal.start(...)` to accept `runtime_provenance`.

In `executeCorrelatedCommand(...)`, resolve provenance before `journal.start(...)`, then persist it with the invocation. Provenance lookup failure must not fabricate a value. If the command is effecting and existing runtime-source integrity policy requires verified source, preserve that existing fail-closed behavior.

- [ ] **Add journal read projection**

When journal invocations are exposed through recovery services, include only the safe bounded runtime provenance projection.

- [ ] **Run focused regression**

Run the repository regression entry for runtime provenance plus the existing orchestration journal suite. Expected: all pass.

- [ ] **Run canonical regression suite**

Expected: no existing command-response, journal, lease, or evidence regressions change semantics.

---

## Task 2: Add deterministic `orchestration.fault_packet`

**Files:**
- Create: `lib/orchestration-fault-packet.js`
- Create: `lib/orchestration-fault-packet.test.js`
- Create: `mcp/orchestration.fault_packet.js`
- Create: `api/orchestration/fault-packet.js`
- Modify: `lib/orchestration-recovery.js`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/regression-suite-registry.js`

### Behavior

Input:

```json
{ "run_id": "run-123", "invocation_id": "optional-uuid" }
```

Output schema: `orchestration-fault-packet-v1`.

The service is read-only and composes current recovery evidence. It does not create an incident row and does not call AI.

### Steps

- [ ] **Write failing packet assembly test**

Create fixtures with:
- one successful command;
- one failed command with `REQUEST_INVALID`;
- captured runtime provenance;
- no active lease;
- current authoritative work observation.

Assert packet includes:
- stable faulting invocation identity;
- preceding successful invocation;
- failure state and mutation certainty;
- exact captured runtime provenance;
- authority observations;
- `safe_to_execute:false` for unknown failure;
- `requires_reasoning:true`;
- no invented root cause.

- [ ] **Write stable identity test**

Call the assembler twice with different `observed_at` timestamps and assert `fault_id` is unchanged.

Derive the identity from canonical durable fields such as:

```js
{
  run_id,
  invocation_id,
  result_sha256,
  outcome,
  runtime_provenance,
}
```

Do not include observation time.

- [ ] **Write read-only recursion test**

Ensure fault-packet inspection does not journal itself into the run being inspected. Extend the existing journal exclusion currently used for `orchestration.diagnose` and `orchestration.resume_packet`.

- [ ] **Implement assembler**

`lib/orchestration-fault-packet.js` should depend on narrow readers/services:
- diagnosis service;
- resume-packet service;
- journal invocation reader;
- lease/checkpoint reader;
- domain receipt readers;
- authoritative readers selected by the classified failure.

Reuse the public bounded projections already exposed by recovery code rather than hydrating raw database/provider rows.

- [ ] **Add MCP command**

`mcp/orchestration.fault_packet.js`:
- `access = 'admin'`;
- required `run_id`;
- optional `invocation_id`;
- `additionalProperties:false`;
- command response envelope consistent with other orchestration reads.

- [ ] **Add HTTP compatibility endpoint**

`api/orchestration/fault-packet.js` should route through the same semantic implementation, not duplicate packet logic.

- [ ] **Register and run regressions**

Add `orchestration_fault_packet` to `lib/regression-suite-registry.js`, run focused suite, then canonical suite.

---

## Task 3: Add bounded `orchestration.recover`

**Files:**
- Create: `lib/orchestration-recovery-operations.js`
- Create: `lib/orchestration-recover.js`
- Create: `lib/orchestration-recover.test.js`
- Create: `mcp/orchestration.recover.js`
- Create: `api/orchestration/recover.js`
- Modify: `lib/orchestration-failures.js`
- Modify: `lib/regression-suite-registry.js`

### Behavior

Input:

```json
{ "run_id": "run-123" }
```

The caller does not provide a recovery recipe.

Return one of:

```text
HEALED
ESCALATION_REQUIRED
RECOVERY_FAILED
NO_ACTIVE_FAULT
```

with a bounded attempt trace and a fault packet when recovery stops.

### Steps

- [ ] **Write registry test for allowed operations**

Initial registry entries:
- `STALE_LEASE` -> `orchestration.maintain`;
- safe `TRANSPORT_UNAVAILABLE` with `may_have_mutated:false` -> exact same semantic request, bounded by classifier budget;
- `HEARTBEAT_BUDGET_EXHAUSTED` only when durable checkpoint + lease reference already permit canonical `work.settle` requeue;
- `INDETERMINATE_EXTERNAL_EFFECT` -> reconciliation operation only, never mutation replay.

Assert unknown failure has no automatic executor.

- [ ] **Write semantic-decision stop test**

Fixture: `ACTIVE_LEASE_REMAINS` where `orchestration.finish` requires `active_lease_settlement.disposition`.

Assert:

```js
result.status === 'ESCALATION_REQUIRED'
result.required_decisions.includes('active_lease_settlement.disposition')
```

and no settlement command was invoked.

- [ ] **Write indeterminate-effect test**

Fixture `may_have_mutated:true`.

Assert exact retry executor invocation count is zero until an authoritative reconciler proves the effect absent.

- [ ] **Write bounded retry test**

Return the same recoverable transport failure repeatedly. Assert at most `MAX_AUTOMATIC_RECOVERY_ATTEMPTS` are executed and the final state is `RECOVERY_FAILED`.

- [ ] **Write healing readback test**

Make the operation return success but leave diagnosis/invariant state violated. Assert the result is not `HEALED`.

Then make the post-operation authority read converge and assert `HEALED`.

- [ ] **Implement server-owned operation registry**

`lib/orchestration-recovery-operations.js` maps typed failure states to internal executors. The registry receives canonical recovery details from classification/resume evidence. It must not accept arbitrary command names from the caller.

- [ ] **Implement recover loop**

`lib/orchestration-recover.js`:
1. diagnose;
2. return `NO_ACTIVE_FAULT` if none;
3. resolve registry operation;
4. stop if automatic recovery is disallowed;
5. execute one attempt;
6. re-diagnose and perform required readback;
7. repeat only while same safe class remains and budget remains;
8. return fault packet on stop.

- [ ] **Add MCP and HTTP surfaces**

Follow existing command-response and admin access patterns.

- [ ] **Register and run regressions**

Focused recovery suite first, then canonical regressions.

---

## Task 4: Introduce the three-valued health invariant registry

**Files:**
- Create: `lib/overcenter-health.js`
- Create: `lib/overcenter-health.test.js`
- Create: `mcp/overcenter.health.js`
- Create: `api/overcenter/health.js`
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/scheduled-cycle-completeness.js`
- Modify: `lib/regression-suite-registry.js`

### Behavior

Every evaluator returns:

```js
{
  key,
  status: 'satisfied' | 'violated' | 'unknown',
  fault_domain,
  severity: 'info' | 'degraded' | 'blocked',
  observed_at,
  evidence,
  automatic_recovery_allowed,
  recovery_operation,
}
```

Initial invariants should reuse existing queries rather than introduce duplicate scans.

### Steps

- [ ] **Write three-valued state tests**

Assert:
- positive proof -> `satisfied`;
- positive contradiction -> `violated`;
- authority/read failure -> `unknown`.

Assert aggregate cannot be `healthy` if any required invariant is `unknown`.

- [ ] **Implement coordination evaluators**

Reuse the data behind `orchestration.status` for:
- expired active slots;
- stuck claiming leases;
- stuck settling leases;
- unresolved indeterminate effects;
- overdue active runs.

Refactor shared query/read logic out of `lib/orchestration-runs.js` only as needed; keep `orchestration.status` backward-compatible.

- [ ] **Implement scheduled execution evaluators**

Reuse `lib/scheduled-cycle-completeness.js` projections for scheduler/cycle recency. Missing scheduler evidence must return `unknown` when the platform cannot be read, not `violated`.

- [ ] **Implement aggregate**

Suggested aggregate:
- `healthy`: all required invariants satisfied;
- `degraded`: at least one required invariant unknown, or non-blocking invariant violated;
- `blocked`: blocking invariant violated/quarantined.

Return the complete invariant list with evidence.

- [ ] **Add MCP and HTTP reads**

Both are read-only. Ensure they do not recursively alter the run/journal being diagnosed.

- [ ] **Register and run regressions**

Focused health suite and existing orchestration status/scheduled-cycle suites, then canonical regressions.

---

## Task 5: Add GitHub and production convergence invariants

**Files:**
- Create: `lib/production-convergence.js`
- Create: `lib/production-convergence.test.js`
- Modify: `lib/overcenter-health.js`
- Modify: `lib/repository-branch-roles.js`
- Modify: `lib/github-production-promotion.js`
- Modify: `lib/source-materialization.js` or the current production source-materialization module identified by repository search before editing
- Modify: `lib/regression-suite-registry.js`

### Behavior

Add invariants:
- `github.branch_roles_valid`
- `github.development_policy_valid`
- `github.production_policy_valid`
- `production.candidate_verified`
- `production.main_matches_verified_candidate`
- `production.runtime_matches_main`
- `production.runtime_regression_verified`

### Steps

- [ ] **Locate the current production materialization implementation**

Before editing, search the exact current `dev` revision for the module that owns production source-materialization receipts. Use that actual module in place of the descriptive `lib/source-materialization.js` path above if the name differs. Do not create a parallel materialization service.

- [ ] **Write exact-coordinate convergence fixture**

Fixture:
- stored development branch `dev`;
- stored production branch `main`;
- verified candidate SHA `a...`;
- GitHub main SHA `a...`;
- materialization receipt SHA `a...`;
- immutable Hatchable deployment receipt SHA `a...`;
- canonical regression success.

Assert all production invariants are satisfied.

- [ ] **Write drift fixture**

Change runtime receipt SHA only. Assert:
- `production.runtime_matches_main` is violated;
- other proven coordinates remain satisfied;
- recovery operation identifies the existing production materialization/reconciliation path.

- [ ] **Write authority-unavailable fixture**

Make GitHub/Hatchable observation throw. Assert affected invariant is `unknown`, not violated.

- [ ] **Implement convergence reader**

`lib/production-convergence.js` reads:
- repository branch-role binding;
- exact GitHub heads;
- existing promotion receipt;
- existing materialization/deployment receipt;
- immutable deployment verification/regression receipt.

It must not infer deployment identity from mutable Hatchable workspace state.

- [ ] **Integrate with health**

Map each failed/unknown observation to a narrow `production:<repo>` or `github-mutation:<repo>` fault domain.

- [ ] **Run production regression suites**

Run promotion/materialization exact-revision regressions plus health suite and canonical regressions.

---

## Task 6: Add fault-domain quarantine

**Files:**
- Create: `migrations/054_fault_domain_quarantine.sql`
- Create: `lib/fault-domain-quarantine.js`
- Create: `lib/fault-domain-quarantine.test.js`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/orchestration-recover.js`
- Modify: `lib/regression-suite-registry.js`

### Data model

Use one current-state table with durable audit fields, for example:

```sql
CREATE TABLE IF NOT EXISTS orchestration_fault_domains (
  domain text PRIMARY KEY,
  state text NOT NULL,
  source_fault_id text,
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);
```

Add a CHECK constraint limiting state to `degraded` and `quarantined` for active rows, or use an equivalent explicit state model. Healthy need not occupy a row.

### Steps

- [ ] **Write domain mapping tests**

Examples:
- `work.claim` -> `work-acquisition`;
- `work.settle` -> `work-settlement`;
- GitHub mutation for repo -> `github-mutation:<repo>`;
- production promotion/materialization -> `production:<repo>`;
- read-only `orchestration.diagnose`, `orchestration.fault_packet`, `overcenter.health` -> no blocked mutation domain.

Keep this mapping small and command-owned.

- [ ] **Write quarantine block test**

Insert quarantine for `github-mutation:owner/repo`. Attempt an effecting GitHub command for that repo.

Assert failure occurs before external adapter call with:
- `FAULT_DOMAIN_QUARANTINED`;
- `may_have_mutated:false`;
- domain/reason evidence.

Assert an unrelated repo mutation is not blocked.

- [ ] **Write recovery-access test**

Diagnosis, health, fault packet, and registered authoritative reconciliation remain readable/executable while the affected domain is quarantined.

Do not expose a caller boolean such as `bypass_quarantine`.

- [ ] **Implement persistence service**

`lib/fault-domain-quarantine.js` owns:
- `observe(domain)`;
- `quarantine(domain, fault)`;
- `degrade(domain, fault)`;
- `clearIfSatisfied(domain, invariantEvidence)`;
- command-to-domain mapping.

Clearing must require a fresh satisfied invariant result.

- [ ] **Add central pre-effect guard**

Integrate the guard at the semantic execution boundary shared by effecting correlated commands. Preserve read-only commands and the server-owned recovery reconciliation path.

If a command does not pass through that boundary, add the same narrow guard to its existing canonical effecting boundary rather than introducing a second command dispatcher.

- [ ] **Run regressions**

Focused quarantine tests, semantic worker command tests, GitHub mutation tests, then canonical regressions.

---

## Task 7: Add scheduled deterministic healing

**Files:**
- Create: `api/orchestration/recover-scheduled.js`
- Create: `lib/orchestration-recover-scheduled.test.js`
- Modify: `lib/orchestration-recover.js`
- Modify: `lib/overcenter-health.js`
- Modify: `lib/regression-suite-registry.js`

### Behavior

The schedule is separate from `api/orchestration/maintain-scheduled.js`.

Use a declared hourly schedule at a minute that does not collide with existing scheduled reconcilers after checking current `list_cron_jobs`.

The scheduler:
1. reads bounded health;
2. selects only invariants with `status:'violated'` and `automatic_recovery_allowed:true`;
3. performs the registered deterministic recovery;
4. rereads the invariant;
5. records healed/still-violated/unknown;
6. quarantines when policy requires;
7. never selects, creates, prioritizes, or semantically edits portfolio work.

### Steps

- [ ] **Write no-work-selection test**

Inject fake portfolio/work selectors that throw if called. Scheduled recovery must complete without touching them.

- [ ] **Write allowlist test**

Give one auto-recoverable stale-lease invariant and one authority-conflict invariant. Assert only the stale-lease recovery executes.

- [ ] **Write anti-thrash test**

Repeated failed recovery reaches bounded failure/quarantine and is not attempted indefinitely each scheduler tick without a changed authoritative observation.

- [ ] **Implement scheduled handler**

`api/orchestration/recover-scheduled.js`:
- `access = 'scheduler'`;
- `methods = ['POST']`;
- declared hourly `schedule`;
- invokes the same recovery services used by the semantic command.

No AI call.

- [ ] **Verify scheduler registration**

After deployment, use Hatchable function/cron introspection to prove the route is registered, active, and firing.

- [ ] **Run regressions**

Scheduled recovery suite plus existing maintenance and scheduled-cycle suites, then canonical regressions.

---

## Task 8: Add end-to-end recovery acceptance scenarios

**Files:**
- Create: `lib/recovery-kernel-acceptance.test.js`
- Modify: `lib/regression-suite-registry.js`
- Modify: `docs/superpowers/specs/2026-08-27-overcenter-recovery-kernel-design.md` only if implementation discoveries require a factual correction

### Scenarios

- [ ] **Novel semantic-boundary defect**

Model the GitHub #135 shape:
- valid semantic caller input;
- internal `REQUEST_INVALID`;
- `may_have_mutated:false`.

Assert fault packet contains exact runtime provenance and causal context but does not invent an automatic fix.

- [ ] **Stale lease self-heal**

Create expired slot/lease state. Run `orchestration.recover`. Assert:
- maintenance executes;
- slot is released;
- fresh diagnosis is clear;
- affected coordination invariant is satisfied;
- result is `HEALED`.

- [ ] **Transport retry**

Fail twice with safe no-mutation transport errors, succeed on third attempt. Assert exact semantic request identity is preserved and attempt count is three.

- [ ] **Indeterminate external effect**

Return `may_have_mutated:true`. Assert:
- mutation replay count remains zero;
- authoritative reconciliation runs;
- inability to prove effect yields escalation/quarantine.

- [ ] **Semantic decision boundary**

Require a lease settlement disposition. Assert recovery returns required decision and does not choose one.

- [ ] **Production drift**

Create exact GitHub/Hatchable mismatch. Assert health reports the one violated convergence invariant and a bounded production recovery target.

- [ ] **Authority outage**

Make GitHub/Hatchable read unavailable. Assert relevant health state is `unknown`, aggregate is not healthy, and no speculative repair executes.

- [ ] **Quarantine isolation**

Quarantine production for repository A. Assert unrelated repository B and read-only inspection remain available.

- [ ] **Canonical suite**

Run all registered regressions. No recovery feature may weaken existing exact-revision, idempotency, lease, evidence, or authority tests.

---

## Task 9: Live dogfood verification and lifecycle completion

**Files:** No new architecture files. Use the deployed semantic surfaces and exact GitHub/Hatchable authorities.

- [ ] Deploy the exact integrated `dev` revision through the normal Overcenter production promotion/materialization path.
- [ ] Verify immutable Hatchable deployment evidence binds the runtime to the exact promoted SHA.
- [ ] Invoke `overcenter.health` and retain the invariant evidence.
- [ ] Create a bounded disposable/reproducible stale coordination fault in a test-safe fixture path, then invoke `orchestration.recover`.
- [ ] Prove the fault is healed by authoritative readback, not merely command success.
- [ ] Exercise an unknown/non-auto-recoverable fault fixture and prove a deterministic fault packet is returned.
- [ ] Verify an indeterminate-effect fixture does not blind-retry.
- [ ] Inspect scheduled task registration and prove deterministic recovery scheduling is active.
- [ ] Record exact evidence coordinates in the owning GitHub issues and Overcenter work settlements.
- [ ] Close implementation issues only after GitHub source, deployed runtime, and recovery acceptance evidence agree.

## Completion criteria

Do not call the recovery kernel complete until:
- provenance is captured at execution time;
- fault packets are bounded and read-only;
- recovery is server-registered and cannot execute arbitrary caller recipes;
- semantic decisions stop for reasoning;
- indeterminate effects reconcile before retry;
- health is three-valued;
- quarantine is fault-domain scoped;
- scheduled healing is bounded and deterministic;
- all healing claims are backed by fresh authoritative readback;
- canonical regressions and live dogfood verification both pass.
