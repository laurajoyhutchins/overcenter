# Destructive Execution History Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physically remove the obsolete execution-history schema and runtime machinery only after compact correctness, telemetry backfill, archive/retention readiness and a write-freeze observation window prove the old substrate is unnecessary and safely retained according to policy.

**Architecture:** Destructive retirement is a gated cleanup, not a migration shortcut. A preflight verifier requires Plan A’s compact-authority independence and Plan B’s frozen source census plus retention readiness. Migration `063_retire_obsolete_execution_history.sql` then drops exactly the approved 14 historical tables. Production modules that wrote/read those tables are deleted or reduced to compact/telemetry implementations. Static and physical-absence tests prevent old table names from creeping back into runtime correctness.

**Tech Stack:** Node.js 22, PostgreSQL 16, existing TypeScript/JavaScript runtime, Node test runner, contract-evidence generator.

**Spec:** `docs/superpowers/specs/2026-09-02-legacy-execution-history-retirement-design.md`

## Hard Preconditions

Plan C must not begin until the exact candidate head satisfies both prior exit gates:

1. Plan A, `2026-09-02-compact-execution-authority-retirement.md`, proves project-transition and legacy `work.*` correctness with all four work-lease tables absent.
2. Plan B, `2026-09-02-telemetry-archive-retirement-readiness.md`, proves complete safe telemetry normalization, immutable archive behavior, global legacy-history freeze and `destructive_readiness_state='ready'`.

Additional constraints:

- Plan C owns only `063_retire_obsolete_execution_history.sql`.
- If migration numbering moved before implementation started, use the renumbered sequence chosen before Plan A’s first migration commit. Never introduce a second numbering sequence mid-series.
- No compatibility SQL views or shadow tables may preserve the retired schema names.
- Archive data may never be queried by execution or recovery before, during, or after retirement.
- A populated deployment must fail closed if retirement readiness is absent, stale, contradicted by a changed source census, or incomplete under `archive_required`.
- A fresh deployment with zero legacy rows may satisfy readiness without manufacturing archive objects for nonexistent history.
- Destructive migration must drop exactly the approved tables, no more.
- The final runtime must contain fewer persistence concepts and less compatibility machinery than before the retirement.
- Follow TDD and make bounded commits.
- Planning files under `docs/superpowers/**` must not be included in public implementation PRs.

---

## Approved Drop Set

Migration `063_retire_obsolete_execution_history.sql` may drop exactly these 14 tables:

```text
orchestration_invocation_resolutions
orchestration_horizons
work_lease_slots
work_lease_checkpoints
work_lease_heartbeats
work_leases
github_changeset_receipts
github_release_receipts
github_production_promotion_receipts
portfolio_reconcile_receipts
portfolio_verification_receipts
github_required_check_observations
scheduled_cycle_events
orchestration_command_invocations
```

It must retain at minimum:

```text
orchestration_runs
execution_state
operation_state
proof_state
telemetry_events
telemetry_archive_exports
legacy_history_retirement_control
```

plus current repository/configuration tables.

---

## File Map

**Readiness/preflight**
- Modify: `lib/legacy-history-retirement.js`
- Create: `scripts/verify-legacy-history-retirement-ready.mjs`
- Create: `scripts/verify-legacy-history-retirement-ready.test.mjs`

**Destructive migration**
- Create: `migrations/063_retire_obsolete_execution_history.sql`
- Create: `scripts/retire-obsolete-execution-history-postgres.test.mjs`
- Create: `scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Runtime deletion/cleanup**
- Modify/delete modules that still name or write retired tables after Plans A/B.
- Modify: `lib/orchestration-journal.js` if any old command-journal SQL remains.
- Modify: scheduled-cycle diagnostic/runtime modules so only `telemetry_events` remains for historical diagnostics.
- Modify provider receipt/verification modules so compact `operation_state`/`proof_state` remain correctness authority and telemetry remains observability.
- Remove obsolete legacy lease store/recovery helpers from `lib/work-leases.js`, `lib/orchestration-finish-runtime.js`, `lib/orchestration-recovery.js`, and related modules after confirming no callers.

**Static enforcement**
- Create: `scripts/verify-retired-history-tables-absent.mjs`
- Create: `scripts/verify-retired-history-tables-absent.test.mjs`

**Evidence**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`

---

### Task 1: Make destructive readiness an executable precondition

**Files:**
- Modify: `lib/legacy-history-retirement.js`
- Create: `scripts/verify-legacy-history-retirement-ready.mjs`
- Create: `scripts/verify-legacy-history-retirement-ready.test.mjs`

**Interface:**

```js
assertLegacyHistoryRetirementReady(dbBinding, options?) -> Promise<{
  control_key,
  retention_mode,
  frozen_at,
  source_sha256,
  checked_at
}>
```

- [ ] **Step 1: Write failing readiness cases**

Cover all failures independently:

```text
control row missing
freeze_state != frozen
source census changed after freeze
telemetry_backfill_state != complete
archive_required and archive_readiness_state != confirmed
destructive_readiness_state != ready
unresolved sanitizer rejection exists
unresolved operation blocks a frozen archive subject
```

Also cover `ttl_only` and zero-history fresh-deployment success.

- [ ] **Step 2: Run and observe failure**

```bash
node --test scripts/verify-legacy-history-retirement-ready.test.mjs
```

Expected: FAIL because verifier does not exist.

- [ ] **Step 3: Implement one authoritative preflight function**

The function must recompute the source census from the still-present legacy tables and compare it to `legacy_history_retirement_control.expected_source_counts` and `expected_source_sha256`. Do not trust the stored `destructive_readiness_state` alone.

For `archive_required`, independently query `telemetry_archive_exports` and require every expected immutable bundle to be `confirmed` with matching bundle digest.

The function must never query an external archive provider. Database confirmation is sufficient for migration preflight.

- [ ] **Step 4: Implement CLI verifier**

`scripts/verify-legacy-history-retirement-ready.mjs` connects with the repository’s standard Postgres environment and prints bounded JSON:

```json
{
  "ok": true,
  "control_key": "legacy_execution_history_v1",
  "retention_mode": "archive_required",
  "frozen_at": "...",
  "source_sha256": "..."
}
```

On failure print only safe code/details and exit nonzero.

- [ ] **Step 5: Run tests**

```bash
node --test scripts/verify-legacy-history-retirement-ready.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/legacy-history-retirement.js \
  scripts/verify-legacy-history-retirement-ready.mjs \
  scripts/verify-legacy-history-retirement-ready.test.mjs
git commit -m "feat: enforce destructive history retirement readiness"
```

---

### Task 2: Prove the legacy writer freeze over a full maintenance window

**Files:**
- Modify: `scripts/legacy-history-retirement-postgres.test.mjs`
- Modify: `lib/legacy-history-retirement.js`

- [ ] **Step 1: Add a write-after-freeze rejection regression**

After `freeze_state='frozen'`, call every legacy-history code path still reachable in the test harness. Runtime behavior must either write telemetry/compact state only or fail before touching a frozen table.

- [ ] **Step 2: Add source-census stability assertion**

Capture census digest at freeze, execute a representative full maintenance cycle including project advance, work compatibility, provider mutation tombstone resolution and scheduled-cycle diagnostics, then recompute census. Assert exact digest equality.

- [ ] **Step 3: Run**

```bash
node --test scripts/legacy-history-retirement-postgres.test.mjs
```

Expected: PASS and no frozen source table changes.

- [ ] **Step 4: Commit**

```bash
git add lib/legacy-history-retirement.js scripts/legacy-history-retirement-postgres.test.mjs
git commit -m "test: prove legacy history writer freeze"
```

---

### Task 3: Write the destructive migration as a guarded exact drop

**Files:**
- Create: `migrations/063_retire_obsolete_execution_history.sql`
- Create: `scripts/retire-obsolete-execution-history-postgres.test.mjs`

- [ ] **Step 1: Write the failing migration test before the migration**

Prepare a schema containing migrations through `062` plus representative legacy tables/data.

Case A: no readiness row. Applying `063` must fail and leave all 14 tables present.

Case B: readiness row says ready but source census changed. Applying `063` must fail and leave all 14 tables present.

Case C: valid frozen/readied zero-history fixture. Applying `063` succeeds and all 14 tables become absent while retained compact/telemetry tables remain.

- [ ] **Step 2: Run and observe failure**

```bash
node --test scripts/retire-obsolete-execution-history-postgres.test.mjs
```

Expected: FAIL because migration 063 does not exist.

- [ ] **Step 3: Create migration 063**

The migration must run in one transaction and begin with SQL guards against the retirement-control state. It must verify:

```text
control_key = legacy_execution_history_v1
freeze_state = frozen
telemetry_backfill_state = complete
destructive_readiness_state = ready
```

For `archive_required`, require `archive_readiness_state='confirmed'`.

Use explicit `DROP TABLE` statements for the 14 names. Do not use wildcard schema discovery and do not use `CASCADE` unless a pre-existing dependency is itself an explicitly approved retired object. Prefer dropping known constraints first so unexpected dependencies fail closed rather than deleting an unreviewed object graph.

- [ ] **Step 4: Verify retained tables**

The test must assert `to_regclass(...) IS NOT NULL` for all retained kernel/telemetry/control tables after migration.

- [ ] **Step 5: Run**

```bash
node --test scripts/retire-obsolete-execution-history-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/063_retire_obsolete_execution_history.sql \
  scripts/retire-obsolete-execution-history-postgres.test.mjs
git commit -m "feat: retire obsolete execution history tables"
```

---

### Task 4: Prove the populated upgrade path before deleting runtime code

**Files:**
- Create: `scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Build a realistic pre-retirement fixture**

Apply the historical migrations that create the 14 source tables, then compact migrations 053–059 and telemetry/readiness migrations 060–062. Seed:

```text
active/terminal historical leases
checkpoint/heartbeat history
command invocations/resolutions
horizons
scheduled cycle events
provider receipt/verification history
required-check observations
```

Ensure no active current authority is represented only by old tables.

- [ ] **Step 2: Run Plan B backfill/freeze/archive flow in-process**

Use the real backfill/readiness modules. For `archive_required`, inject a deterministic fake `ArchiveSink` that confirms canonical artifacts.

- [ ] **Step 3: Apply migration 063**

Assert all 14 tables are absent.

- [ ] **Step 4: Exercise post-drop correctness**

With the same database, run compact project-transition acquire/settle, legacy work compatibility, operation recovery and exact-revision proof lookup. Any SQL reference to a dropped table must surface as test failure.

- [ ] **Step 5: Register integration test**

Append to `scripts/test-integration.mjs`:

```js
run(['--experimental-loader=./scripts/hatchable-node-test-loader.mjs', '--test', 'scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs']);
```

- [ ] **Step 6: Run**

```bash
npm run test:integration
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs scripts/test-integration.mjs
git commit -m "test: prove populated execution history retirement"
```

---

### Task 5: Delete obsolete runtime readers and writers

**Files:**
- Modify/delete exact legacy-history modules identified by static search after Plans A/B.
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/work-leases.js`
- Modify: `lib/orchestration-finish-runtime.js`
- Modify: `lib/orchestration-recovery.js`
- Modify provider receipt/verification modules.
- Modify scheduled-cycle diagnostic/runtime modules.
- Modify corresponding tests.

- [ ] **Step 1: Generate a retired-table reference inventory**

Run:

```bash
rg -n "orchestration_invocation_resolutions|orchestration_horizons|work_lease_slots|work_lease_checkpoints|work_lease_heartbeats|work_leases|github_changeset_receipts|github_release_receipts|github_production_promotion_receipts|portfolio_reconcile_receipts|portfolio_verification_receipts|github_required_check_observations|scheduled_cycle_events|orchestration_command_invocations" \
  api lib mcp src scripts .github
```

Classify every hit as one of:

```text
production runtime to delete/replace
destructive migration
migration/history test
retirement/backfill-only test fixture
```

There must be no unclassified hit before commit.

- [ ] **Step 2: Delete runtime SQL against retired tables**

Remove old stores, replay helpers, slot scanners, journal writers and specialized receipt persistence that are no longer called. Prefer deleting entire obsolete functions/modules over retaining dead compatibility shims.

Do not delete semantic `work.*` compatibility endpoints solely because the old persistence disappeared. Their compact implementation stays until separate caller evidence approves API deletion.

- [ ] **Step 3: Remove dead imports and constructor options**

Delete dependency injection parameters that existed only to support old lease/history stores. Update focused tests to construct the simpler runtime.

- [ ] **Step 4: Keep diagnostic history on telemetry only**

Scheduled-cycle/operator diagnostics may query `telemetry_events`. They must not recreate tables or add compatibility views.

- [ ] **Step 5: Run focused tests**

Run all directly affected module tests plus:

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A api lib mcp src scripts
git commit -m "refactor: delete retired execution history machinery"
```

---

### Task 6: Add a permanent retired-table poison gate

**Files:**
- Create: `scripts/verify-retired-history-tables-absent.mjs`
- Create: `scripts/verify-retired-history-tables-absent.test.mjs`

- [ ] **Step 1: Write failing static scanner tests**

A fixture production module containing `SELECT * FROM work_leases` must fail. References in `migrations/063_retire_obsolete_execution_history.sql`, historical migrations and explicitly named migration/backfill tests must be allowed.

- [ ] **Step 2: Implement scanner**

Scan production roots:

```text
api/
lib/
mcp/
src/
```

and fail on exact retired table identifiers. Do not merely scan SQL tagged templates because string concatenation can hide a query.

The error must list `path`, `line`, and retired identifier.

- [ ] **Step 3: Run**

```bash
node --test scripts/verify-retired-history-tables-absent.test.mjs
node scripts/verify-retired-history-tables-absent.mjs
```

Expected: PASS after Task 5.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-retired-history-tables-absent.mjs scripts/verify-retired-history-tables-absent.test.mjs
git commit -m "test: forbid retired history tables in runtime"
```

---

### Task 7: Prove scheduled-cycle diagnostics with the source table physically gone

**Files:**
- Modify: scheduled-cycle completeness/diagnostic regression from Plan B.
- Modify: `scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs` if needed.

- [ ] **Step 1: Add physical-absence assertion**

After migration 063:

```js
assert.equal((await client.query("SELECT to_regclass('scheduled_cycle_events') AS value")).rows[0].value, null);
```

- [ ] **Step 2: Run the diagnostic against retained telemetry**

Use the same representative cycle fixtures from Plan B. Assert canonical classification equality after the old table is gone.

- [ ] **Step 3: Run focused test**

Expected: PASS without any compatibility table/view.

- [ ] **Step 4: Commit**

```bash
git add <scheduled-cycle-diagnostic-test-files> scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs
git commit -m "test: prove cycle diagnostics after history drop"
```

---

### Task 8: Prove fresh-install migration behavior

**Files:**
- Modify/create: migration verification test covering full current sequence.

- [ ] **Step 1: Build a fresh schema from all current migrations**

Run the repository’s migration sequence exactly as deployment does. For migrations 060–063, initialize retirement control in the supported fresh-install/zero-history path so migration 063 can safely retire tables created by earlier historical migrations.

- [ ] **Step 2: Assert final schema**

The 14 retired tables are absent. Compact kernel/telemetry/control tables are present. No compatibility views use retired names.

- [ ] **Step 3: Exercise a minimal runtime smoke test**

Start a run, acquire/settle compact execution, write best-effort telemetry and read a proof. No legacy table query may occur.

- [ ] **Step 4: Run migration verification suite**

```bash
npm run test:integration
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add <fresh-migration-test-files>
git commit -m "test: verify fresh schema after history retirement"
```

---

### Task 9: Remove retired contracts from generated evidence

**Files:**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`

- [ ] **Step 1: Generate candidate evidence after migration 063**

```bash
mkdir -p /tmp/overcenter-contract-evidence/generated/contracts /tmp/overcenter-contract-evidence/docs/generated
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog /tmp/overcenter-contract-evidence/generated/contracts/catalog.json \
  --docs /tmp/overcenter-contract-evidence/docs/generated/data-contracts.md
```

- [ ] **Step 2: Remove obsolete classification entries**

Delete durable-internal classifications for retired tables only after the discoverer no longer reports them in the final schema. Keep classifications for `execution_state`, `operation_state`, `proof_state`, `orchestration_runs`, `telemetry_events`, `telemetry_archive_exports`, and retirement control.

- [ ] **Step 3: Regenerate committed evidence**

```bash
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md
```

- [ ] **Step 4: Run contract-evidence tests and ratchet locally**

```bash
node --test scripts/contract-evidence/*.test.mjs scripts/contract-evidence/overcenter/*.test.mjs
```

Expected: PASS and no retired table remains a current contract.

- [ ] **Step 5: Commit**

```bash
git add .contract-evidence/classifications.json generated/contracts/catalog.json docs/generated/data-contracts.md
git commit -m "docs: retire obsolete persistence contracts"
```

---

### Task 10: Run the brutal physical-drop and exact-head verification gate

**Files:**
- No new feature files. Fix only defects revealed by verification.

- [ ] **Step 1: Run static architecture gates**

```bash
node scripts/verify-telemetry-kernel-boundary.mjs
node scripts/verify-retired-history-tables-absent.mjs
```

Expected: PASS.

- [ ] **Step 2: Run focused destructive migration tests**

```bash
node --test scripts/retire-obsolete-execution-history-postgres.test.mjs
node --experimental-loader=./scripts/hatchable-node-test-loader.mjs --test scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run the full repository verification**

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
npm run verify
```

Expected: all commands exit 0.

- [ ] **Step 4: Perform final source scan**

```bash
rg -n "orchestration_invocation_resolutions|orchestration_horizons|work_lease_slots|work_lease_checkpoints|work_lease_heartbeats|work_leases|github_changeset_receipts|github_release_receipts|github_production_promotion_receipts|portfolio_reconcile_receipts|portfolio_verification_receipts|github_required_check_observations|scheduled_cycle_events|orchestration_command_invocations" \
  api lib mcp src
```

Expected: no output.

- [ ] **Step 5: Verify public-release hygiene**

Ensure the implementation branch does not contain planning journals under `docs/superpowers/**`, then run:

```bash
npm run verify
```

Expected: PASS.

- [ ] **Step 6: Commit verification-only fixes if any**

If verification required code changes, commit each bounded correction with a descriptive message. If no changes are needed, do not create an empty commit.

---

## Plan C Exit Gate

The retirement is complete only when all of the following are true on the exact candidate head:

- preflight independently proves frozen source census and retention/archive readiness;
- migration 063 fails closed without valid readiness;
- migration 063 drops exactly the approved 14 tables;
- all retained compact/telemetry/control tables remain;
- populated-upgrade and zero-history fresh-install paths both pass;
- project-transition, legacy `work.*`, operation recovery and exact-revision proofs work after physical drop;
- scheduled-cycle diagnostics work from telemetry with `scheduled_cycle_events` physically absent;
- production runtime contains no retired table identifier;
- no compatibility SQL view/table reintroduces a retired name;
- archive/telemetry remain outside correctness imports;
- generated contract evidence no longer treats retired tables as current contracts;
- `npm test`, `npm run typecheck`, `npm run build`, `npm run test:integration`, and `npm run verify` all pass on the exact head.

At that point the old execution-history substrate is not merely deprecated. It is absent, unreferenced, and mechanically proven unnecessary for correctness.
