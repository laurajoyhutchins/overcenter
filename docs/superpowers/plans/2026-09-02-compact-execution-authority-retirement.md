# Compact Execution Authority Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `execution_state`, `operation_state`, `proof_state`, and `orchestration_runs` the sole correctness substrate for project-transition and legacy `work.*` execution while leaving all legacy history tables physically present but unnecessary.

**Architecture:** Project-transition authority stops mirroring through `work_leases` and `work_lease_slots`; the existing project-transition service API is preserved while its Postgres store reconstructs active and replay state from compact tables. Legacy work receives a temporary old-authoritative/compact-dual-write phase, deterministic backfill and equivalence checker, then flips to a compact-state-backed compatibility service. The plan ends by proving the normal execution surface works in a database where the four work-lease tables do not exist.

**Tech Stack:** Node.js 22, TypeScript 5.9, PostgreSQL 16, `pg`, Node test runner, existing Overcenter semantic/runtime modules.

**Spec:** `docs/superpowers/specs/2026-09-02-legacy-execution-history-retirement-design.md`

## Global Constraints

- Fresh external authority plus compact current state must be sufficient to decide exactly what may safely happen next.
- Historical data may never authorize execution, settlement, retry, recovery, proof satisfaction, or mutation reconciliation.
- `execution_state` is the sole durable current execution-authority row for project transitions and legacy work.
- Every acquisition increments `authority_epoch`; stale epochs can never mutate or settle a newer acquisition.
- Canonical operation identity remains exactly `(command, idempotency_scope, idempotency_key)`.
- `prepared` and `indeterminate` operations remain durable and are never compacted away as terminal history.
- The lower-level `api/work/{claim,checkpoint,heartbeat,settle}` compatibility surface remains available in this plan.
- No SQL compatibility views are introduced for retired lease tables.
- Plan A owns migration `059_execution_state_legacy_work_coordinates.sql` on the current `dev` migration tail. `057` and `058` are already occupied. Before committing the first migration, re-read `migrations/`; if `059` is occupied, renumber the entire retirement sequence `059–063` together before writing any migration.
- Do not add telemetry, archive, freeze, or destructive-drop behavior in this plan.
- Production code from this plan must not depend on `telemetry_events`, `telemetry_archive_exports`, archive providers, or retirement receipts.
- Follow TDD: add one failing regression, observe the expected failure, make the smallest implementation change, rerun the focused regression, then commit.
- Do not merge tracked `docs/superpowers/**` planning files into the public release branch; implementation work should travel in implementation PRs separate from this planning branch.

---

## File Map

**Schema and compact contracts**
- Modify: `src/semantic/compact-execution-state.ts` — add explicit legacy-work coordinates and validation.
- Modify: `src/ports/compact-execution-state-store.ts` — accept and expose legacy-work coordinates and lookup operations needed by compatibility code.
- Modify: `src/adapters/postgres/compact-execution-state-store.ts` — persist/read the new coordinates and provide compact lookup by lease reference and legacy subject.
- Create: `migrations/059_execution_state_legacy_work_coordinates.sql` — add `work_ref`/`gate` columns, invariants, and indexes.
- Modify: `scripts/verify-compact-state-migrations-postgres.test.mjs` — schema constraints for legacy current authority.
- Modify: `scripts/compact-execution-state-postgres.test.mjs` — compact store lookup/fencing coverage.

**Project-transition cutover**
- Modify: `lib/project-transition-lease-store.js` — remove all correctness reads/writes to `work_leases` and `work_lease_slots`; reconstruct active/replay state from compact tables.
- Modify: `lib/project-transition-leases.js` — preserve service semantics while relying only on compact store projections.
- Modify: `scripts/project-transition-compact-authority-postgres.test.mjs` — stop creating old lease tables and prove acquire/checkpoint/heartbeat/settle/replay/stale-epoch behavior without them.

**Legacy-work migration bridge**
- Create: `lib/legacy-work-compact-state.js` — canonical subject identity, bounded compact projection, deterministic backfill and equivalence comparison.
- Create: `lib/legacy-work-compact-state.test.js` — pure regression coverage for subject identity, projection equivalence and ambiguity failures.
- Modify: `lib/work-leases.js` — add temporary dual-write hooks, then compact-backed runtime methods behind the existing service API.
- Modify: `lib/work-leases.test.js` — preserve existing semantics and add epoch/replay cases.
- Modify: `lib/operator-commands.js` — resolve `lease_ref` and claim-attempt identity from compact state after authority flip.
- Modify: `lib/work-claim-boundary.test.js` — retry identity no longer depends on historical lease counts after cutover.
- Modify: `lib/work-progress-boundary.test.js` — checkpoint/heartbeat canonicalization from compact lease identity.
- Modify: `lib/work-settle-boundary.test.js` — settlement canonicalization from compact lease identity.

**Orchestration composition and recovery**
- Modify: `lib/orchestration-finish-runtime.js` — read current lease candidates from compact state and dispatch by `subject_kind` without querying `work_leases`.
- Modify: `lib/orchestration-lease-authority.js` — classify compact current authority directly; retain historical project-transition classification only as diagnostic output where still required.
- Modify: `lib/orchestration-recovery.js` — delete the legacy lease/slot correctness fallback after compact equivalence is proven.
- Modify: `scripts/compact-recovery-postgres.test.mjs` — verify recovery with old work-lease tables absent.
- Create: `scripts/compact-work-authority-postgres.test.mjs` — end-to-end Postgres proof for legacy `work.*` on compact state.
- Create: `scripts/verify-work-lease-history-independence-postgres.test.mjs` — physical-absence gate.
- Modify: `scripts/test-integration.mjs` — register the two new Postgres tests.

**Evidence**
- Modify: `.contract-evidence/classifications.json` — classify `work_ref`/`gate` and any new compact-store interfaces as projections of existing compact contracts.
- Regenerate: `generated/contracts/catalog.json`.
- Regenerate: `docs/generated/data-contracts.md`.

---

### Task 1: Add explicit legacy-work coordinates to compact state

**Files:**
- Modify: `src/semantic/compact-execution-state.ts`
- Modify: `src/ports/compact-execution-state-store.ts`
- Modify: `src/adapters/postgres/compact-execution-state-store.ts`
- Create: `migrations/059_execution_state_legacy_work_coordinates.sql`
- Modify: `scripts/verify-compact-state-migrations-postgres.test.mjs`
- Modify: `scripts/compact-execution-state-postgres.test.mjs`

**Interfaces:**
- Consumes: existing `ExecutionState`, `AcquireExecutionInput`, `CompactExecutionStateStore`.
- Produces:
  - `ExecutionState.work_ref: string | null`
  - `ExecutionState.gate: string | null`
  - `AcquireExecutionInput.work_ref?: string | null`
  - `AcquireExecutionInput.gate?: string | null`
  - `CompactExecutionStateStore.getExecutionByLeaseRef(leaseRef: string): Promise<ExecutionState | null>`
  - `CompactExecutionStateStore.getLegacyExecution(workRef: string, gate: string): Promise<ExecutionState | null>`

- [ ] **Step 1: Write the failing migration regression**

Add a legacy-work case to `scripts/verify-compact-state-migrations-postgres.test.mjs` that applies migration `059_execution_state_legacy_work_coordinates.sql`, inserts a valid legacy row, and rejects partial coordinates:

```js
await client.query(await sql('059_execution_state_legacy_work_coordinates.sql'));

await client.query(
  `INSERT INTO execution_state (
     subject_key, subject_kind, work_ref, gate, authority_epoch, lease_ref, run_id,
     authority_repository, authority_revision, expires_at, hard_expires_at
   ) VALUES ($1, 'legacy_work', 'LJH-500', 'lane:verification', 1, $2, $3,
     'laurajoyhutchins/overcenter', $4, now()+interval '10 minutes', now()+interval '20 minutes')`,
  ['legacy_work:LJH-500:lane:verification', '00000000-0000-4000-8000-000000000500', runId, 'a'.repeat(40)],
);

await assert.rejects(
  client.query(
    `INSERT INTO execution_state (
       subject_key, subject_kind, work_ref, authority_epoch, lease_ref, run_id,
       authority_repository, authority_revision, expires_at, hard_expires_at
     ) VALUES ('legacy_work:bad', 'legacy_work', 'LJH-BAD', 1, $1, $2,
       'laurajoyhutchins/overcenter', $3, now()+interval '10 minutes', now()+interval '20 minutes')`,
    ['00000000-0000-4000-8000-000000000501', runId, 'b'.repeat(40)],
  ),
  error => error?.code === '23514',
);
```

- [ ] **Step 2: Run the focused migration test and verify failure**

Run:

```bash
npm run build:portable
node --test scripts/verify-compact-state-migrations-postgres.test.mjs
```

Expected: FAIL because migration `059_execution_state_legacy_work_coordinates.sql` does not exist or because `work_ref`/`gate` are unknown columns.

- [ ] **Step 3: Create migration 059**

Create `migrations/059_execution_state_legacy_work_coordinates.sql` with exactly these responsibilities:

```sql
ALTER TABLE execution_state
  ADD COLUMN IF NOT EXISTS work_ref text,
  ADD COLUMN IF NOT EXISTS gate text;

ALTER TABLE execution_state
  DROP CONSTRAINT IF EXISTS execution_state_legacy_coordinates_check;

ALTER TABLE execution_state
  ADD CONSTRAINT execution_state_legacy_coordinates_check CHECK (
    subject_kind <> 'legacy_work'
    OR lease_ref IS NULL
    OR (work_ref IS NOT NULL AND btrim(work_ref) <> '' AND gate IS NOT NULL AND btrim(gate) <> '')
  );

CREATE INDEX IF NOT EXISTS execution_state_legacy_subject_idx
  ON execution_state (work_ref, gate)
  WHERE subject_kind = 'legacy_work';

CREATE INDEX IF NOT EXISTS execution_state_active_run_idx
  ON execution_state (run_id)
  WHERE lease_ref IS NOT NULL;
```

Do not add a unique `(work_ref, gate)` constraint: canonical uniqueness is already `subject_key`, and the backfill must be able to detect malformed historical duplicates rather than having migration DDL arbitrarily choose one.

- [ ] **Step 4: Extend TypeScript contracts and row mapping**

In `src/semantic/compact-execution-state.ts`, add:

```ts
readonly work_ref: string | null;
readonly gate: string | null;
```

and in `assertExecutionState` require both fields whenever `subject_kind === 'legacy_work' && lease_ref !== null`.

In `src/ports/compact-execution-state-store.ts`, add to `AcquireExecutionInput`:

```ts
readonly work_ref?: string | null;
readonly gate?: string | null;
```

and add store methods:

```ts
getExecutionByLeaseRef(leaseRef: string): Promise<ExecutionState | null>;
getLegacyExecution(workRef: string, gate: string): Promise<ExecutionState | null>;
```

In `src/adapters/postgres/compact-execution-state-store.ts`:

```ts
work_ref:nullableText(row.work_ref),
gate:nullableText(row.gate),
```

persist `$work_ref/$gate` during acquisition, clear them only when they are not part of persistent subject identity, and implement the two exact lookups:

```sql
SELECT * FROM execution_state WHERE lease_ref = $1 LIMIT 1;
```

```sql
SELECT * FROM execution_state
 WHERE subject_kind='legacy_work' AND work_ref=$1 AND gate=$2
 LIMIT 1;
```

For legacy subjects, keep `work_ref` and `gate` after settlement because they are stable subject coordinates; clear only active lease/run/authority/progress material.

- [ ] **Step 5: Add compact-store regression coverage**

In `scripts/compact-execution-state-postgres.test.mjs`, acquire a legacy subject with `work_ref`/`gate`, assert both lookup methods return the same `authority_epoch`, settle it, then reacquire and assert the epoch increments while the subject coordinates remain unchanged.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:portable
node --test scripts/verify-compact-state-migrations-postgres.test.mjs
node --test scripts/compact-execution-state-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add migrations/059_execution_state_legacy_work_coordinates.sql \
  src/semantic/compact-execution-state.ts \
  src/ports/compact-execution-state-store.ts \
  src/adapters/postgres/compact-execution-state-store.ts \
  scripts/verify-compact-state-migrations-postgres.test.mjs \
  scripts/compact-execution-state-postgres.test.mjs
git commit -m "feat: add compact legacy work coordinates"
```

---

### Task 2: Make project-transition lease authority compact-only

**Files:**
- Modify: `lib/project-transition-lease-store.js`
- Modify: `lib/project-transition-leases.js`
- Modify: `scripts/project-transition-compact-authority-postgres.test.mjs`

**Interfaces:**
- Consumes: `execution_state`, `operation_state`, current `createProjectTransitionLeaseService` store interface.
- Produces: the same project-transition service methods (`acquire`, `require`, `checkpoint`, `heartbeat`, `settle`, `reconcileExpired`) with no `work_leases`/`work_lease_slots` dependency.
- Operation identities:
  - acquire: `command='project_transition.acquire'`, `idempotency_scope=<slot_key>`, caller acquisition key.
  - settle: `command='project_transition.settle'`, `idempotency_scope='lease:<lease_id>'`, caller settlement key.

- [ ] **Step 1: Rewrite the integration fixture to omit old lease tables**

In `scripts/project-transition-compact-authority-postgres.test.mjs`, delete the fixture DDL that creates `work_leases` and `work_lease_slots`. Apply only:

```js
for (const name of [
  '025_orchestration_runs.sql',
  '053_execution_state.sql',
  '054_operation_state.sql',
  '055_proof_state.sql',
  '056_orchestration_run_compaction.sql',
  '057_operation_state_updated_at.sql',
  '058_orchestration_run_current_failure.sql',
  '059_execution_state_legacy_work_coordinates.sql',
]) await client.query(await migration(name));
```

Keep the existing acquire/settle/stale-epoch/progress assertions and add:

```js
const absent = await client.query(`SELECT
  to_regclass('work_leases') AS leases,
  to_regclass('work_lease_slots') AS slots`);
assert.equal(absent.rows[0].leases, null);
assert.equal(absent.rows[0].slots, null);
```

- [ ] **Step 2: Run the project-transition integration test and verify failure**

Run:

```bash
node --test scripts/project-transition-compact-authority-postgres.test.mjs
```

Expected: FAIL on the first SQL reference to `work_leases` or `work_lease_slots`.

- [ ] **Step 3: Replace project-transition persistence with compact projections**

In `lib/project-transition-lease-store.js`, preserve exported factory names but replace old-table operations as follows:

```js
const ACQUIRE_COMMAND = 'project_transition.acquire';
const SETTLE_COMMAND = 'project_transition.settle';

function acquireScope(slotKey) {
  return required(slotKey, 'slotKey');
}

function settleScope(leaseId) {
  return `lease:${required(leaseId, 'leaseId')}`;
}
```

`getSlot(slotKey)` must query `execution_state` by `subject_key=slotKey` and return a slot-shaped projection only when `lease_ref IS NOT NULL`.

`getActiveLeasesForTransition(projectRef, transitionId, observedAt)` must query active `execution_state` rows with matching project/transition coordinates and `expires_at > observedAt`.

`getLease(leaseId)` must first query active `execution_state.lease_ref`; if absent, query the acquisition operation tombstone with `effect_kind='execution_lease' AND effect_ref=$1` and reconstruct the bounded stored receipt from `resolution`.

`getLeaseByAcquireIdempotency(key)` must query:

```sql
SELECT * FROM operation_state
 WHERE command='project_transition.acquire'
   AND idempotency_key=$1
 LIMIT 1;
```

and reject ambiguity if more than one scope is ever returned for one caller key.

- [ ] **Step 4: Implement atomic compact acquisition**

`acquireLeaseAtomically(row)` must use one transaction that:

1. creates/locks the `execution_state` subject row;
2. checks for exact idempotent acquire replay in `operation_state`;
3. rejects a different request hash with `PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT`;
4. rejects a live current lease with `PROJECT_TRANSITION_ALREADY_CLAIMED`;
5. increments `authority_epoch` and installs the new lease;
6. writes a terminal acquire operation with `effect_kind='execution_lease'`, `effect_ref=<lease_id>`, and bounded `resolution.lease` containing only fields needed for replay.

The transaction must never write `work_leases` or `work_lease_slots`.

- [ ] **Step 5: Implement compact heartbeat/checkpoint/settlement replay**

Keep checkpoint and heartbeat operation identities already used by the store, but fence all writes by current `subject_key + lease_ref + authority_epoch`.

`settleLeaseAtomically(input)` must prepare/replay `project_transition.settle`, verify the current epoch, promote the current checkpoint into continuation exactly as the existing logic does, clear active authority, and resolve the settlement operation. Store the public settlement replay fields under `resolution.settlement`.

A stale epoch must throw `PROJECT_TRANSITION_LEASE_STALE` and leave the current execution row untouched.

- [ ] **Step 6: Simplify project-transition service checks**

In `lib/project-transition-leases.js`, keep current authority/readback semantics but ensure `currentLease()` does not require independent evidence from an old slot table. `store.getSlot()` is now a projection of `execution_state`, so the service may retain the method call without introducing a second authority source.

- [ ] **Step 7: Run the focused integration test**

Run:

```bash
node --test scripts/project-transition-compact-authority-postgres.test.mjs
```

Expected: PASS with `work_leases` and `work_lease_slots` absent.

- [ ] **Step 8: Commit**

```bash
git add lib/project-transition-lease-store.js \
  lib/project-transition-leases.js \
  scripts/project-transition-compact-authority-postgres.test.mjs
git commit -m "refactor: make project transition authority compact only"
```

---

### Task 3: Define deterministic legacy-work compact projection and equivalence

**Files:**
- Create: `lib/legacy-work-compact-state.js`
- Create: `lib/legacy-work-compact-state.test.js`

**Interfaces:**
- Produces:

```js
legacyWorkSubjectKey(workRef, gate) -> string
legacyWorkExecutionFingerprint({ work_ref, gate, authority_revision, execution_projection }) -> Promise<string>
projectLegacyWorkCurrentState({ lease, slot, checkpoint, heartbeats, continuation }) -> object
compareLegacyWorkCurrentState(oldProjection, compactExecution) -> { ok:boolean, differences:string[] }
createPostgresLegacyWorkBackfillService({ db }) -> { backfillSubject, compareSubject, backfillAll }
```

- [ ] **Step 1: Write pure failing tests for identity and comparison**

Create `lib/legacy-work-compact-state.test.js` with cases asserting:

```js
check(legacyWorkSubjectKey('LJH-500', 'lane:verification') === 'legacy_work:LJH-500:lane:verification', 'subject key drifted');
```

and that comparison checks exactly these fields:

```js
[
  'lease_ref',
  'authority_revision',
  'expires_at',
  'hard_expires_at',
  'checkpoint_sha256',
  'recent_progress_sha256',
  'continuation_sha256',
  'no_progress_streak',
]
```

Add an ambiguity case where two simultaneously live legacy slots for one canonical subject cause `LEGACY_WORK_BACKFILL_AMBIGUOUS` rather than choosing one.

- [ ] **Step 2: Run the pure test and verify failure**

Run:

```bash
node --input-type=module -e "import { runLegacyWorkCompactStateTests } from './lib/legacy-work-compact-state.test.js'; const r=await runLegacyWorkCompactStateTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement canonical subject and projection helpers**

Create `lib/legacy-work-compact-state.js`. Normalize `work_ref` and `gate` as bounded non-empty text and return exactly:

```js
export function legacyWorkSubjectKey(workRef, gate) {
  return `legacy_work:${required(workRef, 'work_ref', 128)}:${required(gate, 'gate', 128)}`;
}
```

The compact execution fingerprint must hash canonical JSON containing only current semantic execution identity, never token material or timestamps.

`compareLegacyWorkCurrentState` must canonicalize timestamps with `new Date(value).toISOString()`, compare the bounded two-hash progress window in durable order, and return sorted field names in `differences`.

- [ ] **Step 4: Implement deterministic Postgres backfill**

`backfillSubject(workRef, gate)` may read legacy tables because it is migration code. It must:

1. load all potentially current leases and the slot for the canonical subject;
2. fail if more than one lease can claim current authority;
3. choose the latest eligible checkpoint by `(created_at DESC, idempotency_key DESC)`;
4. choose the final two heartbeats by `(created_at ASC, idempotency_key ASC)` then take the last two progress digests;
5. reuse the existing continuation eligibility rules from `work-leases.js` rather than inventing a new disposition policy;
6. compute the current no-progress streak deterministically;
7. upsert one `execution_state` row without modifying an already-newer `authority_epoch`.

For an active lease, persist active capability material only in `execution_state.active_capability_material`; do not put it in `operation_state.resolution`.

- [ ] **Step 5: Run the pure tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/legacy-work-compact-state.js lib/legacy-work-compact-state.test.js
git commit -m "feat: add deterministic legacy work compact projection"
```

---

### Task 4: Add temporary dual-write to legacy work mutations

**Files:**
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`
- Modify: `lib/legacy-work-compact-state.js`

**Interfaces:**
- Consumes: `legacyWorkSubjectKey`, compact projection helpers.
- Produces: old-authoritative behavior plus compact mirror for claim, checkpoint, heartbeat, settlement, invalidation and expiry recovery.

- [ ] **Step 1: Add a failing dual-write regression**

Extend `lib/work-leases.test.js` with a Postgres-independent fake store capability that records compact mirror calls. For a successful claim, checkpoint, heartbeat and settle, assert exactly one corresponding compact call with the same lease id and canonical subject key.

Add a failure case where the old authoritative mutation fails before commit and assert no compact success is recorded.

- [ ] **Step 2: Run the work-lease test and verify failure**

Run:

```bash
node --input-type=module -e "import { runWorkLeaseTests } from './lib/work-leases.test.js'; const r=await runWorkLeaseTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

Expected: FAIL because compact mirror hooks are not invoked.

- [ ] **Step 3: Add explicit migration-mode bridge injection**

Extend `createWorkLeaseService` options with:

```js
compactMirror = null
```

where the bridge shape is:

```js
{
  claimCommitted(input),
  checkpointCommitted(input),
  heartbeatCommitted(input),
  settlementCommitted(input),
  invalidationCommitted(input),
  expiryCommitted(input),
}
```

Default `null` preserves the pure in-memory tests. `createPostgresWorkLeaseService` must create the Postgres bridge by default during the dual-write phase.

- [ ] **Step 4: Mirror only committed old-authority results**

Invoke the bridge after each old-authoritative store mutation returns a committed row. Each bridge method must be idempotent by the same semantic operation key and must reject contradictory compact state instead of silently rewriting it.

When the Postgres store supports transactions, fold compact updates into the same `dbBinding.transaction(...)` unit used by the old mutation. If an existing method already emits one SQL transaction array, append the compact statements to that array rather than opening a nested transaction.

- [ ] **Step 5: Add a backfill entrypoint**

Expose from `lib/legacy-work-compact-state.js`:

```js
export async function backfillAllLegacyWorkSubjects(dbBinding) { ... }
```

It must enumerate distinct `(work_ref, gate)` from legacy lease history in stable lexical order and call `backfillSubject` exactly once per subject.

- [ ] **Step 6: Run the work-lease tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/work-leases.js lib/work-leases.test.js lib/legacy-work-compact-state.js
git commit -m "feat: dual write legacy work into compact state"
```

---

### Task 5: Prove legacy old-vs-compact equivalence before authority flip

**Files:**
- Create: `scripts/compact-work-authority-postgres.test.mjs`
- Modify: `lib/legacy-work-compact-state.js`
- Modify: `scripts/test-integration.mjs`

**Interfaces:**
- Produces:

```js
compareAllLegacyWorkSubjects(dbBinding) -> Promise<{ ok:boolean, checked:number, mismatches:readonly object[] }>
```

- [ ] **Step 1: Write the failing Postgres equivalence test**

Create `scripts/compact-work-authority-postgres.test.mjs`. Prepare a schema with migrations through `059`, then create the four legacy work tables using their historical migration DDL. Seed three subjects:

1. active with checkpoint + two heartbeats;
2. settled with continuation;
3. expired and safely reconciled.

Run the backfill, then assert:

```js
const comparison = await compareAllLegacyWorkSubjects(binding);
assert.equal(comparison.ok, true);
assert.equal(comparison.checked, 3);
assert.deepEqual(comparison.mismatches, []);
```

Then corrupt one compact checkpoint digest and assert `ok === false` with `differences:['checkpoint_sha256']`.

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
npm run build:portable
node --test scripts/compact-work-authority-postgres.test.mjs
```

Expected: FAIL because `compareAllLegacyWorkSubjects` does not exist.

- [ ] **Step 3: Implement comparison across all subjects**

Enumerate legacy subjects in stable `(work_ref, gate)` order, derive the old projection and current compact row, and compare using Task 3’s exact comparison function. Return bounded mismatch evidence:

```js
{
  work_ref,
  gate,
  subject_key,
  differences,
}
```

Never auto-repair a mismatch in the comparison function.

- [ ] **Step 4: Register the integration regression**

Append to `scripts/test-integration.mjs`:

```js
run(['--test', 'scripts/compact-work-authority-postgres.test.mjs']);
```

- [ ] **Step 5: Run focused integration**

Run:

```bash
npm run test:integration
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/legacy-work-compact-state.js scripts/compact-work-authority-postgres.test.mjs scripts/test-integration.mjs
git commit -m "test: prove legacy work compact equivalence"
```

---

### Task 6: Flip `work.*` identity, progress and settlement to compact state

**Files:**
- Modify: `lib/work-leases.js`
- Modify: `lib/operator-commands.js`
- Modify: `lib/work-claim-boundary.test.js`
- Modify: `lib/work-progress-boundary.test.js`
- Modify: `lib/work-settle-boundary.test.js`
- Modify: `lib/work-leases.test.js`

**Interfaces:**
- Consumes: compact legacy subject/state from Tasks 1–5.
- Produces: existing public `work.claim`, `work.checkpoint`, `work.heartbeat`, `work.settle` semantic behavior with no correctness query of historical lease rows.

- [ ] **Step 1: Change boundary fixtures to expose compact current state only**

Update the three boundary tests so their fake DB recognizes queries against `execution_state` and `operation_state`, and throws if SQL contains any of:

```js
['work_leases', 'work_lease_slots', 'work_lease_checkpoints', 'work_lease_heartbeats']
```

For lease-ref canonicalization, return one compact row containing `lease_ref`, `run_id`, `work_ref`, `gate`, and active expiry.

- [ ] **Step 2: Run boundary tests and verify failure**

Run:

```bash
node --input-type=module -e "import { runWorkClaimBoundaryTests } from './lib/work-claim-boundary.test.js'; const r=await runWorkClaimBoundaryTests(); if(!r.ok){console.error(r);process.exit(1)}"
node --input-type=module -e "import { runWorkProgressBoundaryTests } from './lib/work-progress-boundary.test.js'; const r=await runWorkProgressBoundaryTests(); if(!r.ok){console.error(r);process.exit(1)}"
node --input-type=module -e "import { runWorkSettleBoundaryTests } from './lib/work-settle-boundary.test.js'; const r=await runWorkSettleBoundaryTests(); if(!r.ok){console.error(r);process.exit(1)}"
```

Expected: FAIL on old-table SQL.

- [ ] **Step 3: Replace lease-ref identity lookup**

In `lib/operator-commands.js`, replace `leaseIdentityByRef` with a compact lookup:

```sql
SELECT lease_ref AS lease_id, run_id, work_ref, gate, expires_at
  FROM execution_state
 WHERE lease_ref=$1
 LIMIT 1;
```

The method must fail `LEASE_INVALID` when no active compact row exists.

Remove claim-attempt counting over historical leases. Derive claim retry identity from current compact subject state:

- if the subject currently has an active acquire operation for the same run/request semantics, replay that key;
- otherwise derive a new deterministic semantic key from `{ run_id, work_ref, gate, next_authority_epoch }` where `next_authority_epoch = current.authority_epoch + 1`.

Do not count terminal history.

- [ ] **Step 4: Switch legacy work service persistence to compact authority**

In `lib/work-leases.js`, preserve `createWorkLeaseService` behavior but make its Postgres store implementation use compact current rows and operation tombstones for claim/checkpoint/heartbeat/settle. Old-table writes become disabled after the flip.

Use operation commands:

```text
legacy_work.acquire
legacy_work.checkpoint
legacy_work.heartbeat
legacy_work.settle
legacy_work.invalidate
legacy_work.expire
```

Scopes:

```text
acquire: legacy_work:<work_ref>:<gate>
lease-bound operations: lease:<lease_ref>
```

Successful acquire resolution must contain only bounded replay fields; capability material remains only in `execution_state.active_capability_material`.

- [ ] **Step 5: Preserve stale-epoch fencing and continuation behavior**

Checkpoint, heartbeat, settle, invalidation and expiry recovery must require the current `lease_ref` and `authority_epoch`. Reacquisition increments the epoch. A stale operation from an earlier epoch must return the existing stale/expired public error class and make no compact mutation.

Continuation/no-progress behavior must read only the current `execution_state` continuation and bounded progress window.

- [ ] **Step 6: Run focused boundary and work-lease tests**

Run the three commands from Step 2 plus:

```bash
node --input-type=module -e "import { runWorkLeaseTests } from './lib/work-leases.test.js'; const r=await runWorkLeaseTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/work-leases.js lib/operator-commands.js \
  lib/work-claim-boundary.test.js lib/work-progress-boundary.test.js \
  lib/work-settle-boundary.test.js lib/work-leases.test.js
git commit -m "refactor: make work compatibility compact authoritative"
```

---

### Task 7: Remove orchestration’s legacy lease authority fallback

**Files:**
- Modify: `lib/orchestration-finish-runtime.js`
- Modify: `lib/orchestration-lease-authority.js`
- Modify: `lib/orchestration-recovery.js`
- Modify: `scripts/compact-recovery-postgres.test.mjs`

**Interfaces:**
- Consumes: compact `execution_state` current authority.
- Produces: run finish, active-lease discovery and recovery without querying work-lease history.

- [ ] **Step 1: Add old-table poison assertions to recovery test**

In `scripts/compact-recovery-postgres.test.mjs`, ensure the test schema never creates the four old work-lease tables. Add an assertion before exercising recovery:

```js
const absent = await client.query(`SELECT
  to_regclass('work_leases') AS leases,
  to_regclass('work_lease_slots') AS slots,
  to_regclass('work_lease_checkpoints') AS checkpoints,
  to_regclass('work_lease_heartbeats') AS heartbeats`);
assert.deepEqual(absent.rows[0], { leases:null, slots:null, checkpoints:null, heartbeats:null });
```

- [ ] **Step 2: Run recovery test and verify failure**

Run:

```bash
npm run build:portable
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --test scripts/compact-recovery-postgres.test.mjs
```

Expected: FAIL on a remaining old-table lookup.

- [ ] **Step 3: Replace active lease candidate reads**

In `lib/orchestration-finish-runtime.js`, replace `readLeaseByRef` and `readActiveLeaseCandidates` SQL with `execution_state` projections. Candidate SQL must return one row per current active subject for the run:

```sql
SELECT lease_ref AS lease_id, work_ref, gate, run_id,
       subject_kind, authority_epoch, expires_at
  FROM execution_state
 WHERE run_id=$1 AND lease_ref IS NOT NULL AND expires_at > $2
 ORDER BY updated_at DESC, subject_key ASC;
```

For `project_transition`, include enough fields or an explicit subject marker for `durableLeaseSubject` without needing a historical claim receipt.

- [ ] **Step 4: Make subject classification explicit**

In `lib/orchestration-lease-authority.js`, accept `lease.subject_kind` as the primary subject discriminator for compact current rows. Keep `gate/claim_receipt` inference only for historical diagnostic projections that are not used for correctness.

Legacy current authority is not automatically “current” merely because the subject is legacy. It is current only when its compact row still owns the supplied lease reference/epoch and is unexpired.

- [ ] **Step 5: Delete recovery fallback to old lease/slot history**

In `lib/orchestration-recovery.js`, remove queries/scans that reconstruct current execution from `work_leases`, slots, checkpoints or heartbeats. The only correctness inputs may be:

```text
orchestration_runs
execution_state
operation_state
proof_state
fresh authoritative provider reads
```

If compact authority is missing or ambiguous, fail closed instead of consulting history.

- [ ] **Step 6: Run recovery test**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/orchestration-finish-runtime.js lib/orchestration-lease-authority.js \
  lib/orchestration-recovery.js scripts/compact-recovery-postgres.test.mjs
git commit -m "refactor: remove legacy lease recovery authority"
```

---

### Task 8: Add the physical-absence execution gate

**Files:**
- Create: `scripts/verify-work-lease-history-independence-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Interfaces:**
- Produces: canonical regression proving the four work-lease tables are unnecessary for project-transition and legacy compatibility correctness.

- [ ] **Step 1: Write the physical-absence integration test**

Create `scripts/verify-work-lease-history-independence-postgres.test.mjs`. Build a fresh schema through migration `059` and explicitly assert the four old tables are absent. Seed a run, then exercise:

1. project-transition acquire → checkpoint → heartbeat → settle → reacquire;
2. legacy `work.claim` → checkpoint → heartbeat → settle → reacquire through the production Postgres service/runtime boundary;
3. stale first-epoch settlement after reacquire is rejected;
4. orchestration active-lease discovery and finish do not query absent tables.

The test must install a database wrapper that throws immediately when SQL text includes any retired work-lease table name. This catches accidental compatibility queries even if a fixture later recreates one.

- [ ] **Step 2: Run the new test and verify current state**

Run:

```bash
npm run build:portable
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --test scripts/verify-work-lease-history-independence-postgres.test.mjs
```

Expected after Tasks 1–7: PASS. If it fails, fix the exposed correctness dependency before continuing; do not weaken the poison wrapper.

- [ ] **Step 3: Register the test in integration suite**

Append:

```js
run(['--experimental-loader=./scripts/hatchable-node-test-loader.mjs', '--test', 'scripts/verify-work-lease-history-independence-postgres.test.mjs']);
```

to `scripts/test-integration.mjs`.

- [ ] **Step 4: Run full integration**

Run:

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

### Task 9: Regenerate contract evidence and run exact repository verification

**Files:**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`

**Interfaces:**
- Produces: contract-evidence inventory matching migration 059 and compact-store interface changes.

- [ ] **Step 1: Run contract evidence generation to expose new candidates**

Run:

```bash
mkdir -p /tmp/overcenter-contract-evidence/generated/contracts /tmp/overcenter-contract-evidence/docs/generated
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog /tmp/overcenter-contract-evidence/generated/contracts/catalog.json \
  --docs /tmp/overcenter-contract-evidence/docs/generated/data-contracts.md
```

Expected: generated candidates include `execution_state.work_ref`, `execution_state.gate`, and any new exported compact-store methods.

- [ ] **Step 2: Classify new internal projections**

In `.contract-evidence/classifications.json`, classify the new database columns as projections:

```json
"postgres:public.execution_state#work_ref": {
  "significance": "projection",
  "projection_of": "compact.execution-state"
},
"postgres:public.execution_state#gate": {
  "significance": "projection",
  "projection_of": "compact.execution-state"
}
```

Classify new TypeScript store interface members as projections of `compact.execution-state.store`; do not mark them as new public semantic command contracts.

- [ ] **Step 3: Regenerate committed evidence**

Run the same generator with committed destinations:

```bash
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md
```

- [ ] **Step 4: Run canonical verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
npm run verify
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit evidence**

```bash
git add .contract-evidence/classifications.json generated/contracts/catalog.json docs/generated/data-contracts.md
git commit -m "docs: record compact authority contract evidence"
```

---

## Plan A Exit Gate

Do not start Plan B until all of the following are true on the exact implementation head:

- project-transition acquire/checkpoint/heartbeat/settle/replay pass with `work_leases` and `work_lease_slots` absent;
- legacy `work.*` acquire/checkpoint/heartbeat/settle/replay pass with all four work-lease tables absent;
- stale authority epochs cannot mutate or settle newer authority;
- continuation and no-progress state come only from `execution_state`;
- `operator-commands.js`, orchestration finish, and recovery contain no correctness SQL against the four work-lease tables;
- the old tables may still exist in deployed databases, but they are historical/read-only inputs only;
- `npm run verify` and `npm run test:integration` pass on the exact head.
