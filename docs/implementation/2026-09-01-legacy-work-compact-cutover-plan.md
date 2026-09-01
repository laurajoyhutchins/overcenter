# Legacy Work Compact Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `work_leases`, `work_lease_slots`, historical checkpoints, and historical heartbeats from legacy work execution correctness by moving `work.claim` through `work.settle` onto the same compact `execution_state` and epoch-fencing model used by project transitions.

**Architecture:** This plan executes after `2026-09-01-compact-execution-state.md` has created the compact schema/store and proven project-transition behavior. Legacy work is migrated as a compatibility island: first dual-write, then compare authority/continuation decisions, then cut reads, then prove the old lease tables can be physically absent. The telemetry/archive plan may not drop old lease tables in production until this plan is green.

**Tech Stack:** Node.js 22, TypeScript 5.9.2, PostgreSQL, existing work lease runtime and Node tests, compact-state store from the preceding plan.

**Spec:** `docs/superpowers/specs/2026-09-01-compact-execution-state-and-telemetry-archive-design.md`

## Global Constraints

- Canonical legacy subject identity is deterministic from `(work_ref, gate)` and is never caller-selected arbitrary text.
- Every successful legacy claim increments `execution_state.authority_epoch` for that subject.
- Legacy effecting operations bind the epoch and authoritative work revision before mutation.
- The current checkpoint, bounded progress pair, and current continuation live in `execution_state` after cutover.
- Historical lease/checkpoint/heartbeat rows may remain telemetry during dual-write but may not affect a correctness decision after cutover.
- Existing claim/settlement fail-closed validation and mutation-certainty behavior must remain unchanged.
- No production table drop happens until the physical-absence test in this plan and the archive backfill gate in the telemetry/archive plan both pass.

---

### Task 1: Define canonical legacy-work subject and epoch contract

**Files:**
- Modify: `src/semantic/legacy-work-execution-authority-contracts.ts`
- Modify: `src/semantic/execution-authority-contracts.ts`
- Modify: `src/semantic/execution-authority-core.ts`
- Modify generated mirrors: `lib/legacy-work-execution-authority-contracts.js`, `lib/execution-authority-contracts.js`, `lib/execution-authority-core.js`
- Modify: `type-tests/execution-authority.test.ts`
- Create: `scripts/verify-legacy-work-epoch-authority.test.mjs`

**Interfaces:**
- Consumes: `ExecutionFence` and compact state from the primary compact plan.
- Produces: `legacyWorkSubjectKey(workRef, gate)` and legacy execution authority containing `authority_epoch`.

- [ ] **Step 1: Write the failing subject-key and epoch test**

```ts
import { legacyWorkSubjectKey } from '../src/semantic/legacy-work-execution-authority-contracts.js';

const key = legacyWorkSubjectKey('LJH-512', 'lane:implementation');
const expected: string = 'legacy_work:LJH-512:lane:implementation';
if (key !== expected) throw new Error('legacy work subject key is not canonical');
```

Add a type assertion that `LegacyWorkExecutionAuthority` requires `authority_epoch: number`.

- [ ] **Step 2: Verify failure**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
node --test scripts/verify-legacy-work-epoch-authority.test.mjs
```

Expected: FAIL because the key/epoch contract is absent.

- [ ] **Step 3: Implement the canonical key and authority field**

```ts
export function legacyWorkSubjectKey(workRef: string, gate: string): string {
  const ref = workRef.trim();
  const normalizedGate = gate.trim();
  if (!ref || !normalizedGate) throw new TypeError('work_ref and gate are required');
  return `legacy_work:${ref}:${normalizedGate}`;
}
```

Add `authority_epoch` to `LegacyWorkExecutionAuthority`. `createExecutionAuthorityService().require()` must compare the durable compact row epoch against the authority being returned.

- [ ] **Step 4: Generate and verify mirrors**

```bash
rm -rf dist/lib
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
cp dist/lib/legacy-work-execution-authority-contracts.js lib/legacy-work-execution-authority-contracts.js
cp dist/lib/execution-authority-contracts.js lib/execution-authority-contracts.js
cp dist/lib/execution-authority-core.js lib/execution-authority-core.js
node --test scripts/verify-legacy-work-epoch-authority.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/semantic/legacy-work-execution-authority-contracts.ts src/semantic/execution-authority-contracts.ts src/semantic/execution-authority-core.ts lib/legacy-work-execution-authority-contracts.js lib/execution-authority-contracts.js lib/execution-authority-core.js type-tests/execution-authority.test.ts scripts/verify-legacy-work-epoch-authority.test.mjs
git commit -m "feat: fence legacy work authority with epochs"
```

---

### Task 2: Dual-write `work.claim` into `execution_state`

**Files:**
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`
- Modify: `mcp/work.claim.js`
- Create: `scripts/verify-legacy-work-claim-compact-state.test.mjs`

**Interfaces:**
- Consumes: canonical subject key and compact store.
- Produces: claim result carrying the current epoch while existing `work_leases`/slot rows remain a temporary compatibility write.

- [ ] **Step 1: Add a failing atomic dual-write test**

Acquire one work item and assert all of these facts from the same transaction:

```js
assert.equal(lease.status, 'active');
assert.equal(execution.subject_key, 'legacy_work:LJH-512:lane:implementation');
assert.equal(execution.lease_ref, lease.lease_id);
assert.equal(execution.authority_epoch, 1);
assert.equal(execution.authority_revision, lease.active_revision);
```

Inject failure in the compact write and assert neither the legacy lease nor slot commits.

- [ ] **Step 2: Verify failure**

```bash
node --test lib/work-leases.test.js scripts/verify-legacy-work-claim-compact-state.test.mjs
```

- [ ] **Step 3: Add compact acquisition inside the claim transaction**

After claim validation but before commit, call `acquireExecution` with:

```js
{
  subject_key: legacyWorkSubjectKey(workRef, gate),
  subject_kind: 'legacy_work',
  lease_ref: leaseId,
  run_id: runId,
  authority_repository: repository,
  authority_revision: claimRevision,
  expires_at,
  hard_expires_at,
  active_capability_material: leaseToken,
}
```

Return `authority_epoch` in the server-owned claim receipt/projection. Do not accept an epoch from the caller.

- [ ] **Step 4: Run and commit**

```bash
node --test lib/work-leases.test.js scripts/verify-legacy-work-claim-compact-state.test.mjs
git add lib/work-leases.js lib/work-leases.test.js mcp/work.claim.js scripts/verify-legacy-work-claim-compact-state.test.mjs
git commit -m "feat: dual write legacy claims to compact state"
```

---

### Task 3: Move legacy checkpoint and heartbeat correctness to the current row

**Files:**
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`
- Create: `scripts/verify-legacy-work-progress-no-history.test.mjs`

**Interfaces:**
- Consumes: active `execution_state` row.
- Produces: one current checkpoint and a two-hash liveness window with no historical read requirement.

- [ ] **Step 1: Write the history-deletion test**

Claim, checkpoint, and heartbeat normally. Then execute:

```sql
DELETE FROM work_lease_checkpoints WHERE lease_id = $1;
DELETE FROM work_lease_heartbeats WHERE lease_id = $1;
```

Call resume/heartbeat again and assert the same checkpoint digest, expiry decision, and no-progress classification are obtained from compact state.

- [ ] **Step 2: Verify failure**

```bash
node --test lib/work-leases.test.js scripts/verify-legacy-work-progress-no-history.test.mjs
```

- [ ] **Step 3: Replace correctness reads**

Checkpoint writes overwrite `execution_state.checkpoint/checkpoint_sha256`. Heartbeats update `recent_progress_sha256 = [...old, current].slice(-2)`, count, time, and expiry under the expected lease/epoch. Idempotency replay uses compact operation/idempotency state rather than historical heartbeat/checkpoint rows.

- [ ] **Step 4: Run and commit**

```bash
node --test lib/work-leases.test.js scripts/verify-legacy-work-progress-no-history.test.mjs
git add lib/work-leases.js lib/work-leases.test.js scripts/verify-legacy-work-progress-no-history.test.mjs
git commit -m "refactor: compact legacy work progress state"
```

---

### Task 4: Replace historical continuation reconstruction

**Files:**
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`
- Create: `scripts/verify-legacy-work-continuation-head.test.mjs`

**Interfaces:**
- Consumes: current continuation fields in `execution_state`.
- Produces: successor continuation/no-progress behavior without `listContinuationCandidates()` as a runtime correctness dependency.

- [ ] **Step 1: Capture current legacy behavior in a failing compact-head test**

Create three consecutive settled/recovered executions with the same execution fingerprint and continuation digest. Assert the compact row reaches `no_progress_streak === 3` and the next claim reports stalled continuation even after all predecessor lease rows are deleted.

- [ ] **Step 2: Verify failure**

```bash
node --test lib/work-leases.test.js scripts/verify-legacy-work-continuation-head.test.mjs
```

- [ ] **Step 3: Move the continuation algorithm to current-state update**

At settlement/reconciliation, compute the next continuation packet/digest and streak once, then atomically store:

```text
continuation
continuation_sha256
continuation_execution_fingerprint
no_progress_streak
```

At claim, read those fields directly. Keep the old historical candidate function only for the one-time backfill until cutover verification completes.

- [ ] **Step 4: Run and commit**

```bash
node --test lib/work-leases.test.js scripts/verify-legacy-work-continuation-head.test.mjs
git add lib/work-leases.js lib/work-leases.test.js scripts/verify-legacy-work-continuation-head.test.mjs
git commit -m "refactor: persist legacy continuation head"
```

---

### Task 5: Cut legacy settlement/reconciliation to epoch-fenced compact state

**Files:**
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`
- Modify: `mcp/work.settle.js`
- Create: `scripts/verify-legacy-work-settlement-epoch.test.mjs`

**Interfaces:**
- Consumes: current work authority observation plus expected lease/epoch.
- Produces: settlement/reconciliation that atomically updates continuation and clears current authority.

- [ ] **Step 1: Add stale-epoch settlement regression**

Reacquire the same subject at a newer epoch, then attempt settlement using the predecessor epoch. Assert:

```js
assert.equal(error.code, 'EXECUTION_AUTHORITY_STALE');
assert.equal(currentExecution.authority_epoch, newerEpoch);
assert.equal(currentExecution.lease_ref, newerLeaseId);
```

- [ ] **Step 2: Verify failure**

```bash
node --test lib/work-leases.test.js scripts/verify-legacy-work-settlement-epoch.test.mjs
```

- [ ] **Step 3: Require epoch in server-side settlement authority**

The request may identify the lease, but the server resolves its current epoch and checks it under lock. Settlement transaction order is: fresh work readback, expected subject/epoch check, operation resolution if required, continuation update, active-authority clear, legacy compatibility receipt write, commit.

- [ ] **Step 4: Run and commit**

```bash
node --test lib/work-leases.test.js scripts/verify-legacy-work-settlement-epoch.test.mjs
git add lib/work-leases.js lib/work-leases.test.js mcp/work.settle.js scripts/verify-legacy-work-settlement-epoch.test.mjs
git commit -m "refactor: epoch fence legacy work settlement"
```

---

### Task 6: Prove `work_leases` and slots can be physically absent

**Files:**
- Create: `scripts/verify-legacy-work-history-independence.test.mjs`
- Modify: `scripts/verify-compact-state-history-independence.test.mjs`
- Modify: `scripts/verify-correctness-does-not-query-history.test.mjs`
- Modify: `lib/regression-suite-registry.js`
- Modify: `.github/workflows/regression-suite-registry.yml`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: a hard prerequisite for production retirement of the legacy lease tables.

- [ ] **Step 1: Write the physical-drop test**

Seed current compact legacy-work state, then drop:

```sql
DROP TABLE work_lease_heartbeats;
DROP TABLE work_lease_checkpoints;
DROP TABLE work_lease_slots;
DROP TABLE work_leases;
```

Invoke current authority validation, resume, heartbeat eligibility, continuation, and settlement against compact state. All must behave identically to the pre-drop fixture.

- [ ] **Step 2: Verify failure before cutover cleanup**

```bash
node --test scripts/verify-legacy-work-history-independence.test.mjs
```

- [ ] **Step 3: Remove all remaining legacy correctness queries**

Delete reads of `work_leases`, slots, checkpoint history, and heartbeat history from effect authorization/recovery/continuation. Migration/backfill and telemetry/archive code may remain allowlisted temporarily.

- [ ] **Step 4: Register and run the strengthened compact gate**

```bash
node --test scripts/verify-legacy-work-history-independence.test.mjs scripts/verify-compact-state-history-independence.test.mjs scripts/verify-correctness-does-not-query-history.test.mjs
node scripts/verify-regression-suite-registry.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-legacy-work-history-independence.test.mjs scripts/verify-compact-state-history-independence.test.mjs scripts/verify-correctness-does-not-query-history.test.mjs lib/regression-suite-registry.js .github/workflows/regression-suite-registry.yml
git commit -m "test: prove legacy work is lease-table independent"
```

---

### Task 7: Stop legacy correctness writes and delete obsolete runtime machinery

**Files:**
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`
- Modify: `src/runtime/compact-state-maintenance.ts`
- Modify: `scripts/backfill-compact-execution-state.mjs`
- Create: `scripts/verify-legacy-work-cutover.test.mjs`

**Interfaces:**
- Consumes: physical-history-independence proof.
- Produces: legacy work runtime whose durable correctness state is compact only; old row shapes are available solely to archive/backfill until the companion plan retires them.

- [ ] **Step 1: Add a test that fails on new legacy-table writes**

Instrument the DB binding so INSERT/UPDATE against `work_leases`, `work_lease_slots`, `work_lease_checkpoints`, or `work_lease_heartbeats` throws after cutover mode is enabled. Exercise claim, checkpoint, heartbeat, and settlement. Expect success using compact state only.

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-legacy-work-cutover.test.mjs
```

- [ ] **Step 3: Remove post-cutover legacy writes**

Keep old-table access only in deterministic migration/archive readers. Delete runtime helpers whose only job was historical lease/slot/checkpoint/heartbeat persistence or continuation reconstruction.

- [ ] **Step 4: Run the full work lease suite**

```bash
node --test lib/work-leases.test.js scripts/verify-legacy-work-cutover.test.mjs scripts/verify-legacy-work-history-independence.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/work-leases.js lib/work-leases.test.js src/runtime/compact-state-maintenance.ts scripts/backfill-compact-execution-state.mjs scripts/verify-legacy-work-cutover.test.mjs
git commit -m "refactor: retire legacy work lease correctness writes"
```

---

### Task 8: Run exact-head legacy cutover verification

**Files:**
- No code changes unless a verification gate exposes a genuine defect.

**Interfaces:**
- Consumes: completed legacy cutover.
- Produces: evidence required by the telemetry/archive plan before dropping the old tables in production.

- [ ] **Step 1: Run strict TypeScript/runtime mirror checks**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
rm -rf dist/lib && npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
```

Run the mirror diffs registered by `.github/workflows/semantic-kernel-types.yml`.

- [ ] **Step 2: Run all compact and legacy-work independence gates**

```bash
node --test scripts/verify-legacy-work-epoch-authority.test.mjs scripts/verify-legacy-work-claim-compact-state.test.mjs scripts/verify-legacy-work-progress-no-history.test.mjs scripts/verify-legacy-work-continuation-head.test.mjs scripts/verify-legacy-work-settlement-epoch.test.mjs scripts/verify-legacy-work-history-independence.test.mjs scripts/verify-legacy-work-cutover.test.mjs scripts/verify-compact-state-history-independence.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run canonical regression and exact-revision Hatchable verification**

```bash
node scripts/verify-regression-suite-registry.mjs
```

Run every registered required check and the existing dist-aware exact-revision Hatchable verifier against the same candidate SHA.

- [ ] **Step 4: Record the table-retirement evidence**

The PR evidence must state that `work_leases`, `work_lease_slots`, `work_lease_checkpoints`, and `work_lease_heartbeats` are absent from correctness paths and physically absent in the acceptance test. It must also state that production deletion still waits for archive backfill confirmation.
