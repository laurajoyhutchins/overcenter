# Compact Execution Authority Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `execution_state`, `operation_state`, `proof_state`, and bounded `orchestration_runs` state the sole correctness substrate for project-transition execution, legacy `work.*` compatibility, live-run lease checks, and current horizon recovery while leaving legacy history tables physically present but read-only historical inputs.

**Architecture:** Project-transition authority stops mirroring through `work_leases`/`work_lease_slots`. Legacy work moves through an old-authoritative compact-dual-write release, deterministic backfill/equivalence, then a compact-authoritative release. Live-run terminalization and maintenance use `execution_state`/`operation_state`. The durable current horizon becomes a bounded projection on `orchestration_runs`; `orchestration_horizons` ceases to determine the next safe action. The plan ends with physical-absence tests for the four work-lease tables.

**Tech Stack:** Node.js 22, TypeScript 5.9, PostgreSQL 16, `pg`, Node test runner, existing compact-state adapters.

**Spec:** `docs/superpowers/specs/2026-09-02-legacy-execution-history-retirement-design.md`

## Global constraints

- Fresh authority plus compact current state must be sufficient to decide what may safely happen next.
- Historical data may not authorize execution, settlement, retry, recovery, live-run terminalization, proof satisfaction, or next-action selection.
- `execution_state` is the only durable current execution-authority row.
- Every acquisition increments `authority_epoch`; stale epochs cannot mutate or settle newer authority.
- Canonical operation identity remains exactly `(command, idempotency_scope, idempotency_key)`.
- `prepared` and `indeterminate` operations remain durable.
- Lower-level `api/work/{claim,checkpoint,heartbeat,settle}` remains available.
- No SQL compatibility views are introduced.
- Plan A owns migration `059_compact_execution_authority_completion.sql`.
- `057_operation_state_updated_at.sql` and `058_orchestration_run_current_failure.sql` are already occupied on current `dev`. Immediately before the first migration commit, re-read `migrations/`; if `059` is occupied, renumber the whole new 059–063 sequence before writing any migration.
- Do not add telemetry, archive, retention, freeze, or destructive-drop behavior in Plan A.
- Follow TDD and commit after each bounded task.
- Planning files under `docs/superpowers/**` stay off public implementation PRs.

## File map

**Compact schema/contracts**
- Modify: `src/semantic/compact-execution-state.ts`
- Modify: `src/ports/compact-execution-state-store.ts`
- Modify: `src/adapters/postgres/compact-execution-state-store.ts`
- Create: `migrations/059_compact_execution_authority_completion.sql`
- Modify: `scripts/verify-compact-state-migrations-postgres.test.mjs`
- Modify: `scripts/compact-execution-state-postgres.test.mjs`

**Project transition**
- Modify: `lib/project-transition-lease-store.js`
- Modify: `lib/project-transition-leases.js`
- Modify: `scripts/project-transition-compact-authority-postgres.test.mjs`

**Legacy work cutover**
- Create: `lib/legacy-work-compact-state.js`
- Create: `lib/legacy-work-compact-state.test.js`
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`
- Modify: `lib/operator-commands.js`
- Modify: `lib/work-claim-boundary.test.js`
- Modify: `lib/work-progress-boundary.test.js`
- Modify: `lib/work-settle-boundary.test.js`
- Create: `scripts/compact-work-authority-postgres.test.mjs`

**Live-run authority/current horizon/recovery**
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/orchestration.test.js`
- Modify: `lib/orchestration-finish-runtime.js`
- Modify: `lib/orchestration-lease-authority.js`
- Modify: `lib/orchestration-recovery.js`
- Modify: `scripts/compact-recovery-postgres.test.mjs`
- Create: `scripts/verify-work-lease-history-independence-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Evidence**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`

---

## Task 1: Extend compact state with legacy coordinates and bounded current horizon

**Files:**
- Modify: `src/semantic/compact-execution-state.ts`
- Modify: `src/ports/compact-execution-state-store.ts`
- Modify: `src/adapters/postgres/compact-execution-state-store.ts`
- Create: `migrations/059_compact_execution_authority_completion.sql`
- Modify: `scripts/verify-compact-state-migrations-postgres.test.mjs`
- Modify: `scripts/compact-execution-state-postgres.test.mjs`

- [ ] **Step 1: Write failing migration coverage**

Require `execution_state.work_ref`, `execution_state.gate`, and bounded current-horizon fields on `orchestration_runs`:

```sql
ALTER TABLE execution_state
  ADD COLUMN work_ref text,
  ADD COLUMN gate text;

ALTER TABLE orchestration_runs
  ADD COLUMN current_horizon jsonb,
  ADD COLUMN current_horizon_sha256 text,
  ADD COLUMN current_horizon_generation integer NOT NULL DEFAULT 0;
```

Test that an active `subject_kind='legacy_work'` row must have both `work_ref` and `gate`, and that partial coordinates fail SQLSTATE `23514`.

Test that `current_horizon_sha256` is null or lowercase 64-character SHA-256 and generation is nonnegative.

- [ ] **Step 2: Run the failing migration test**

```bash
npm run build:portable
node --test scripts/verify-compact-state-migrations-postgres.test.mjs
```

Expected: FAIL because migration 059/columns do not exist.

- [ ] **Step 3: Create migration 059**

Migration responsibilities are exactly:

1. add nullable `work_ref`/`gate`;
2. add the active-legacy coordinate check;
3. add `execution_state_legacy_subject_idx` on `(work_ref, gate)` for `subject_kind='legacy_work'`;
4. add `execution_state_active_run_idx` on `run_id` where `lease_ref IS NOT NULL`;
5. add the three bounded current-horizon columns/checks to `orchestration_runs`.

Do not create a history table and do not add a unique `(work_ref, gate)` constraint that could silently choose among malformed legacy rows.

- [ ] **Step 4: Extend TypeScript compact-state contracts**

`ExecutionState` gains:

```ts
readonly work_ref: string | null;
readonly gate: string | null;
```

`AcquireExecutionInput` gains:

```ts
readonly work_ref?: string | null;
readonly gate?: string | null;
```

`CompactExecutionStateStore` gains:

```ts
getExecutionByLeaseRef(leaseRef: string): Promise<ExecutionState | null>;
getLegacyExecution(workRef: string, gate: string): Promise<ExecutionState | null>;
getActiveExecutionsForRun(runId: string, observedAt: string): Promise<readonly ExecutionState[]>;
```

Implement exact indexed SQL lookups. Legacy subject coordinates survive settlement; active lease/run/capability/progress fields are cleared according to existing compact settlement semantics.

- [ ] **Step 5: Add compact-store tests**

Acquire a legacy subject, resolve it by lease ref and `(work_ref, gate)`, settle, reacquire, and prove `authority_epoch` increments while subject coordinates remain stable.

- [ ] **Step 6: Run focused tests**

```bash
npm run build:portable
node --test scripts/verify-compact-state-migrations-postgres.test.mjs
node --test scripts/compact-execution-state-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add migrations/059_compact_execution_authority_completion.sql \
  src/semantic/compact-execution-state.ts \
  src/ports/compact-execution-state-store.ts \
  src/adapters/postgres/compact-execution-state-store.ts \
  scripts/verify-compact-state-migrations-postgres.test.mjs \
  scripts/compact-execution-state-postgres.test.mjs
git commit -m "feat: complete compact execution coordinates"
```

---

## Task 2: Make project-transition lease authority compact-only

**Files:**
- Modify: `lib/project-transition-lease-store.js`
- Modify: `lib/project-transition-leases.js`
- Modify: `scripts/project-transition-compact-authority-postgres.test.mjs`

- [ ] **Step 1: Remove legacy tables from the integration fixture**

Apply the required compact migrations through 059 but do not create `work_leases` or `work_lease_slots`. Assert `to_regclass(...)` returns null for both.

- [ ] **Step 2: Run and observe failure**

```bash
node --test scripts/project-transition-compact-authority-postgres.test.mjs
```

Expected: FAIL on current old-table SQL.

- [ ] **Step 3: Replace slot/lease persistence**

Use `execution_state.subject_key` as the slot. Operation identities are:

```text
project_transition.acquire / <transition-subject-key> / <caller-acquire-key>
project_transition.settle  / lease:<lease_ref>        / <caller-settle-key>
```

`getSlot()` becomes a projection of the compact execution row. `getLease()` reads the active row first and then the acquisition operation tombstone for terminal replay. Acquisition and settlement are transactional, epoch-fenced, and never write old lease/slot tables.

- [ ] **Step 4: Preserve checkpoint/heartbeat/settlement semantics**

Fence all current writes by exact subject, lease ref, and authority epoch. Replayed acquire/settle responses come from `operation_state.resolution`, not terminal lease history.

- [ ] **Step 5: Run focused integration**

```bash
node --test scripts/project-transition-compact-authority-postgres.test.mjs
```

Expected: PASS with both old tables absent.

- [ ] **Step 6: Commit**

```bash
git add lib/project-transition-lease-store.js lib/project-transition-leases.js \
  scripts/project-transition-compact-authority-postgres.test.mjs
git commit -m "refactor: make project transition authority compact only"
```

---

## Task 3: Define deterministic legacy-work projection/backfill/equivalence

**Files:**
- Create: `lib/legacy-work-compact-state.js`
- Create: `lib/legacy-work-compact-state.test.js`

- [ ] **Step 1: Write pure failing tests**

Require:

```js
legacyWorkSubjectKey('LJH-500','lane:verification')
=== 'legacy_work:LJH-500:lane:verification'
```

Comparison fields are exactly:

```text
lease_ref
authority_revision
expires_at
hard_expires_at
checkpoint_sha256
recent_progress_sha256
continuation_sha256
no_progress_streak
```

Ambiguous simultaneous authority fails `LEGACY_WORK_BACKFILL_AMBIGUOUS`.

- [ ] **Step 2: Run and observe failure**

```bash
node --input-type=module -e "import { runLegacyWorkCompactStateTests } from './lib/legacy-work-compact-state.test.js'; const r=await runLegacyWorkCompactStateTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

- [ ] **Step 3: Implement canonical projection**

Export:

```js
legacyWorkSubjectKey(workRef, gate)
legacyWorkExecutionFingerprint(input)
projectLegacyWorkCurrentState(input)
compareLegacyWorkCurrentState(oldProjection, compactExecution)
createPostgresLegacyWorkBackfillService({ db })
backfillAllLegacyWorkSubjects(dbBinding)
compareAllLegacyWorkSubjects(dbBinding)
```

Backfill may read old tables because it is migration code. Stable ordering rules are:

- checkpoint: `(created_at DESC, idempotency_key DESC)`;
- heartbeats: `(created_at ASC, idempotency_key ASC)`, retaining final two progress digests;
- subjects: `(work_ref ASC, gate ASC)`.

Reuse existing continuation disposition rules. Never choose between ambiguous current authorities.

- [ ] **Step 4: Run pure tests**

Run Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/legacy-work-compact-state.js lib/legacy-work-compact-state.test.js
git commit -m "feat: add deterministic legacy work compact projection"
```

---

## Task 4: Add temporary old-authoritative/compact dual-write

**Files:**
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`
- Modify: `lib/legacy-work-compact-state.js`

- [ ] **Step 1: Add failing mirror tests**

For committed claim, checkpoint, heartbeat, settle, invalidation, and expiry recovery, assert exactly one idempotent compact mirror transition. Failed old-authority mutations must not record compact success.

- [ ] **Step 2: Run and observe failure**

```bash
node --input-type=module -e "import { runWorkLeaseTests } from './lib/work-leases.test.js'; const r=await runWorkLeaseTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

- [ ] **Step 3: Add explicit migration bridge**

`createWorkLeaseService` accepts `compactMirror=null` with methods:

```js
claimCommitted
checkpointCommitted
heartbeatCommitted
settlementCommitted
invalidationCommitted
expiryCommitted
```

`createPostgresWorkLeaseService` supplies the bridge in the dual-write release. Append compact SQL to the same transaction where the old mutation is already transactional. Contradictory compact state fails closed.

- [ ] **Step 4: Run focused tests**

Run Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/work-leases.js lib/work-leases.test.js lib/legacy-work-compact-state.js
git commit -m "feat: dual write legacy work into compact state"
```

---

## Task 5: Prove old-vs-compact equivalence before authority flip

**Files:**
- Create: `scripts/compact-work-authority-postgres.test.mjs`
- Modify: `lib/legacy-work-compact-state.js`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Create populated Postgres equivalence fixtures**

Seed three subjects: active with checkpoint/two heartbeats, settled with continuation, and expired/reconciled. Backfill and require zero mismatches. Corrupt one compact digest and require the exact differing field to be reported.

- [ ] **Step 2: Run and observe failure**

```bash
npm run build:portable
node --test scripts/compact-work-authority-postgres.test.mjs
```

- [ ] **Step 3: Implement `compareAllLegacyWorkSubjects`**

Return bounded evidence:

```js
{ ok, checked, mismatches:[{ work_ref, gate, subject_key, differences }] }
```

Comparison never repairs.

- [ ] **Step 4: Register integration test**

Add the exact test command to `scripts/test-integration.mjs`.

- [ ] **Step 5: Run integration**

```bash
npm run test:integration
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/legacy-work-compact-state.js scripts/compact-work-authority-postgres.test.mjs \
  scripts/test-integration.mjs
git commit -m "test: prove legacy work compact equivalence"
```

---

## Task 6: Flip legacy `work.*` to compact authority

**Files:**
- Modify: `lib/work-leases.js`
- Modify: `lib/operator-commands.js`
- Modify: `lib/work-claim-boundary.test.js`
- Modify: `lib/work-progress-boundary.test.js`
- Modify: `lib/work-settle-boundary.test.js`
- Modify: `lib/work-leases.test.js`

- [ ] **Step 1: Poison old-table access in boundary fixtures**

Fake DB bindings must throw if SQL contains any of:

```text
work_leases
work_lease_slots
work_lease_checkpoints
work_lease_heartbeats
```

- [ ] **Step 2: Run boundary tests and observe failure**

```bash
node --input-type=module -e "import { runWorkClaimBoundaryTests } from './lib/work-claim-boundary.test.js'; const r=await runWorkClaimBoundaryTests(); if(!r.ok){console.error(r);process.exit(1)}"
node --input-type=module -e "import { runWorkProgressBoundaryTests } from './lib/work-progress-boundary.test.js'; const r=await runWorkProgressBoundaryTests(); if(!r.ok){console.error(r);process.exit(1)}"
node --input-type=module -e "import { runWorkSettleBoundaryTests } from './lib/work-settle-boundary.test.js'; const r=await runWorkSettleBoundaryTests(); if(!r.ok){console.error(r);process.exit(1)}"
```

- [ ] **Step 3: Replace lease identity and retry derivation**

`lib/operator-commands.js` resolves active lease identity from `execution_state.lease_ref`. Claim retry identity derives from current compact subject state and next epoch, never terminal lease counts.

- [ ] **Step 4: Switch Postgres work service to compact state**

Use operation commands:

```text
legacy_work.acquire
legacy_work.checkpoint
legacy_work.heartbeat
legacy_work.settle
legacy_work.invalidate
legacy_work.expire
```

Acquire scope is the canonical legacy subject. Lease-bound scopes are `lease:<lease_ref>`. Capability material remains only in active `execution_state`.

After the flip, old-table writes are disabled. The temporary mirror is removed.

- [ ] **Step 5: Preserve stale-epoch and continuation semantics**

All lease-bound operations verify current lease ref and epoch. Continuation/no-progress reads only compact fields.

- [ ] **Step 6: Run focused tests**

Run Step 2 plus:

```bash
node --input-type=module -e "import { runWorkLeaseTests } from './lib/work-leases.test.js'; const r=await runWorkLeaseTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/work-leases.js lib/operator-commands.js lib/work-claim-boundary.test.js \
  lib/work-progress-boundary.test.js lib/work-settle-boundary.test.js lib/work-leases.test.js
git commit -m "refactor: make work compatibility compact authoritative"
```

---

## Task 7: Move live-run authority, unresolved effects, and current horizons off history

**Files:**
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/orchestration.test.js`
- Modify: `lib/orchestration-finish-runtime.js`
- Modify: `lib/orchestration-lease-authority.js`
- Modify: `lib/orchestration-recovery.js`
- Modify: `scripts/compact-recovery-postgres.test.mjs`

- [ ] **Step 1: Add old-history poison regressions**

In compact recovery/run-maintenance fixtures, throw if correctness SQL names:

```text
work_leases
work_lease_slots
work_lease_checkpoints
work_lease_heartbeats
orchestration_horizons
orchestration_command_invocations
orchestration_invocation_resolutions
```

Diagnostic receipt history is handled in Plan B, but run terminalization, active authority, unresolved-effect recovery, and current horizon selection must already be clean in Plan A.

- [ ] **Step 2: Replace live-run lease queries**

`createPostgresOrchestrationRunStore.activeLeaseForRun`, maintenance live-lease checks, and `orchestration-finish-runtime` use active `execution_state` rows by `run_id` and expiry. `orchestration-lease-authority.js` treats `subject_kind` plus current epoch as the primary discriminator.

- [ ] **Step 3: Remove journal recovery fallback**

Maintenance/recovery must not use command invocation chronology to resolve `work.claim`, checkpoint, heartbeat, settle, or provider mutation ambiguity. `operation_state` owns unresolved operation recovery. `lib/orchestration-semantic-journal-resolution.js` may remain on disk until Plan C but is no longer imported by correctness code.

- [ ] **Step 4: Replace `orchestration_horizons` current-state persistence**

In `lib/orchestration-runs.js`:

- `checkpointHorizon` computes the existing bounded candidate projection and stores it on `orchestration_runs.current_horizon`, increments `current_horizon_generation`, and stores its SHA-256;
- `resolveHorizon` reads the current run projection, or predecessor run projection when explicitly recovering continuation;
- every returned candidate is re-read from fresh authority and classified against its stored fingerprint;
- no current-action path reads `orchestration_horizons`.

Historical horizon rows remain untouched for Plan B backfill.

- [ ] **Step 5: Run focused recovery/orchestration tests**

```bash
node --input-type=module -e "import { runOrchestrationTests } from './lib/orchestration.test.js'; const r=await runOrchestrationTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
npm run build:portable
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --test scripts/compact-recovery-postgres.test.mjs
```

Expected: PASS without correctness queries to poisoned history tables.

- [ ] **Step 6: Commit**

```bash
git add lib/orchestration-runs.js lib/orchestration.test.js lib/orchestration-finish-runtime.js \
  lib/orchestration-lease-authority.js lib/orchestration-recovery.js \
  scripts/compact-recovery-postgres.test.mjs
git commit -m "refactor: remove history from live orchestration authority"
```

---

## Task 8: Add the physical-absence execution gate

**Files:**
- Create: `scripts/verify-work-lease-history-independence-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Build schema without the four work-lease tables**

Apply compact migrations through 059 and assert all four legacy work tables are absent.

- [ ] **Step 2: Exercise production paths**

The test must run:

1. project-transition acquire -> checkpoint -> heartbeat -> settle -> reacquire;
2. legacy work claim -> checkpoint -> heartbeat -> settle -> reacquire;
3. stale first-epoch settlement after reacquire;
4. orchestration active-lease discovery and finish;
5. current horizon checkpoint/resolve from `orchestration_runs` plus fresh authority.

Install an SQL poison wrapper that fails on any old work-lease table identifier.

- [ ] **Step 3: Run**

```bash
npm run build:portable
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --test scripts/verify-work-lease-history-independence-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Register and run full integration**

Add the test to `scripts/test-integration.mjs`, then:

```bash
npm run test:integration
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-work-lease-history-independence-postgres.test.mjs scripts/test-integration.mjs
git commit -m "test: enforce work lease history independence"
```

---

## Task 9: Regenerate contract evidence and exact-head verification

**Files:**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`

- [ ] **Step 1: Generate candidate evidence**

```bash
mkdir -p /tmp/overcenter-contract-evidence/generated/contracts /tmp/overcenter-contract-evidence/docs/generated
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog /tmp/overcenter-contract-evidence/generated/contracts/catalog.json \
  --docs /tmp/overcenter-contract-evidence/docs/generated/data-contracts.md
```

- [ ] **Step 2: Classify new compact projections**

Classify `execution_state.work_ref`, `execution_state.gate`, `orchestration_runs.current_horizon`, `current_horizon_sha256`, `current_horizon_generation`, and new compact-store methods as internal projections of existing compact contracts, not new public semantic commands.

- [ ] **Step 3: Regenerate committed evidence**

```bash
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md
```

- [ ] **Step 4: Run canonical verification**

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
npm run verify
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add .contract-evidence/classifications.json generated/contracts/catalog.json docs/generated/data-contracts.md
git commit -m "docs: record compact authority completion evidence"
```

## Plan A exit gate

Do not start Plan B until the exact candidate head proves all of the following:

- project-transition execution/replay works without `work_leases`/`work_lease_slots`;
- legacy work execution/replay works without all four work-lease tables;
- stale epochs cannot mutate newer authority;
- live-run terminalization and maintenance derive current leases from `execution_state`;
- unresolved effect recovery uses `operation_state`, not journal chronology;
- current horizon recovery uses bounded `orchestration_runs` state plus fresh authority, not `orchestration_horizons`;
- continuation/no-progress state comes only from compact current state;
- old work-lease tables may still exist in deployed databases but are historical/read-only;
- `npm run verify` and `npm run test:integration` pass on the exact head.
