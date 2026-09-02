# Destructive Execution History Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physically remove the obsolete execution-history substrate only after compact correctness, safe telemetry backfill, configured archive readiness, and a database-enforced freeze prove the old tables are unnecessary and stable.

**Architecture:** Destructive retirement is a one-way cleanup boundary, not a shortcut. A runtime preflight independently verifies the frozen census, required archive confirmations, unresolved-operation state, and all 14 enabled database freeze triggers. Migration `063_retire_obsolete_execution_history.sql` repeats the database-checkable parts before dropping exactly the approved tables. The final runtime then deletes legacy journal/lease/backfill machinery and permanently poisons retired table identifiers in production code.

**Tech Stack:** Node.js 22, PostgreSQL 16, existing TypeScript/JavaScript runtime, Node test runner, contract-evidence generator.

**Spec:** `docs/superpowers/specs/2026-09-02-legacy-execution-history-retirement-design.md`

## Hard preconditions

Plan C must not begin until the exact candidate head satisfies both earlier exit gates:

1. Plan A proves compact project-transition, legacy work, live-run authority, unresolved effects, and current horizons without correctness reads from legacy history.
2. Plan B proves complete safe telemetry normalization, exact-head required-check proof state, immutable archive behavior, scheduled-cycle telemetry equivalence, all 14 database write guards, a stable frozen census, and `destructive_readiness_state='ready'` for populated history.

Additional constraints:

- Plan C owns only migration `063_retire_obsolete_execution_history.sql` in the 059–063 sequence.
- If the sequence was renumbered before Plan A implementation, use that exact renumbered destructive migration number.
- No compatibility SQL views or replacement tables may preserve retired schema names.
- Archive data is never queried by execution/recovery.
- Populated retirement fails closed if readiness is absent, stale, contradicted by the current frozen census, missing an enabled freeze trigger, or incomplete under `archive_required`.
- A fresh deployment with zero rows in all retiring tables may retire without fake archive objects.
- No unreviewed `CASCADE`.
- The final runtime contains fewer persistence concepts and less migration scaffolding than before retirement.
- Follow TDD and make bounded commits.
- Planning files under `docs/superpowers/**` stay off public implementation PRs.

## Exact 14-table drop set

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

Retain at minimum:

```text
orchestration_runs
execution_state
operation_state
proof_state
telemetry_events
telemetry_archive_exports
legacy_history_retirement_control
```

Migration 063 may also remove `orchestration_runs.latest_horizon_id` after Plan A proves `current_horizon` replacement. It may not drop any additional table.

## Exact freeze trigger set

Migration 063 expects these enabled user triggers from migration 062:

```text
lh_freeze_orchestration_invocation_resolutions
lh_freeze_orchestration_horizons
lh_freeze_work_lease_slots
lh_freeze_work_lease_checkpoints
lh_freeze_work_lease_heartbeats
lh_freeze_work_leases
lh_freeze_github_changeset_receipts
lh_freeze_github_release_receipts
lh_freeze_github_production_promotion_receipts
lh_freeze_portfolio_reconcile_receipts
lh_freeze_portfolio_verification_receipts
lh_freeze_github_required_check_observations
lh_freeze_scheduled_cycle_events
lh_freeze_orchestration_command_invocations
```

The trigger function is exactly `prevent_frozen_legacy_history_write()`.

## File map

**Readiness/preflight**
- Modify: `lib/legacy-history-retirement.js`
- Create: `scripts/verify-legacy-history-retirement-ready.mjs`
- Create: `scripts/verify-legacy-history-retirement-ready.test.mjs`

**Freeze-window proof**
- Modify: `scripts/legacy-history-retirement-postgres.test.mjs`
- Create: `scripts/legacy-history-freeze-window-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Destructive migration**
- Create: `migrations/063_retire_obsolete_execution_history.sql`
- Create: `scripts/retire-obsolete-execution-history-postgres.test.mjs`
- Create: `scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Final runtime cleanup**
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/orchestration.test.js`
- Modify: `lib/work-leases.js`
- Modify: `lib/work-leases.test.js`
- Modify: `lib/github-required-check-observation.js`
- Modify: `lib/github-required-check-observation.test.js`
- Modify: `lib/scheduled-cycle-completeness.js`
- Modify: `lib/scheduled-cycle-completeness.test.js`
- Delete: `lib/orchestration-semantic-journal-resolution.js`
- Delete: `lib/orchestration-semantic-journal-resolution.test.js`
- Delete: `lib/legacy-history-sanitizers.js`
- Delete: `lib/legacy-history-sanitizers.test.js`
- Delete: `lib/legacy-history-backfill.js`
- Delete: `lib/legacy-history-backfill.test.js`
- Delete: `lib/legacy-history-retirement.js`
- Delete: `scripts/legacy-history-backfill-postgres.test.mjs`
- Delete: `scripts/legacy-history-retirement-postgres.test.mjs`
- Delete: `scripts/verify-legacy-history-retirement-ready.mjs`
- Delete: `scripts/verify-legacy-history-retirement-ready.test.mjs`

**Permanent enforcement**
- Create: `scripts/verify-retired-history-tables-absent.mjs`
- Create: `scripts/verify-retired-history-tables-absent.test.mjs`
- Modify: `package.json`

**Evidence/docs**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`
- Modify: `README.md`
- Modify: `docs/architecture/recovery-kernel-and-self-healing.md`
- Modify: `docs/execution-evidence-v1-design.md`
- Modify: `public/docs/orchestration-recovery.md`

---

## Task 1: Make destructive readiness independently executable

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
  trigger_count,
  checked_at
}>
```

- [ ] **Step 1: Write independent failure cases**

Cover:

```text
control row missing for populated history
freeze_state != frozen
current source census != frozen expected census
telemetry_backfill_state != complete
archive_required and archive_readiness_state != confirmed
destructive_readiness_state != ready
unresolved sanitizer blocker present
unresolved prepared/indeterminate operation blocks an expected bundle
one expected freeze trigger missing
one expected freeze trigger disabled
freeze trigger function missing
```

Also cover successful `ttl_only`, successful `archive_required`, and successful zero-history fresh deployment.

- [ ] **Step 2: Run and observe failure**

```bash
node --test scripts/verify-legacy-history-retirement-ready.test.mjs
```

Expected: FAIL before verifier implementation.

- [ ] **Step 3: Implement one authoritative preflight**

For populated history:

1. read the singleton control row;
2. recompute the current source census using `legacy_history_source_census()` from migration 062;
3. compare the full JSON census and aggregate SHA with the frozen record;
4. query `pg_trigger`/`pg_proc` and require all 14 exact triggers with `tgenabled='O'` plus `prevent_frozen_legacy_history_write()`;
5. require no unresolved migration blocker;
6. for `archive_required`, require every expected export `confirmed` with the stored digest;
7. require `destructive_readiness_state='ready'`.

The preflight never calls an external archive provider.

For fresh zero-history, require every source table row count to be zero and all 14 freeze guards present/enabled. No archive bundle is required.

- [ ] **Step 4: Implement CLI**

`scripts/verify-legacy-history-retirement-ready.mjs` uses the repository Postgres environment and prints bounded JSON only. Failures emit safe code/details and exit nonzero.

- [ ] **Step 5: Run/commit**

```bash
node --test scripts/verify-legacy-history-retirement-ready.test.mjs
git add lib/legacy-history-retirement.js scripts/verify-legacy-history-retirement-ready.mjs \
  scripts/verify-legacy-history-retirement-ready.test.mjs
git commit -m "feat: enforce destructive history retirement readiness"
```

---

## Task 2: Prove the database freeze across a maintenance window

**Files:**
- Modify: `scripts/legacy-history-retirement-postgres.test.mjs`
- Create: `scripts/legacy-history-freeze-window-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Reassert all 42 direct mutation failures**

After freeze, for each of 14 tables attempt one valid INSERT, UPDATE, and DELETE. Every attempt must fail SQLSTATE `P0001` with `LEGACY_HISTORY_FROZEN`. This is intentionally redundant with Plan B because Plan C treats freeze evidence as a deployment precondition, not historical trust.

- [ ] **Step 2: Capture the frozen census**

Read the full per-source census plus aggregate SHA before the maintenance window.

- [ ] **Step 3: Exercise representative normal runtime**

With freeze enabled, run compact project-transition acquire/settle, compact legacy work claim/checkpoint/heartbeat/settle, one compact provider-operation replay, exact-head required-check observation proof update, and scheduled-cycle telemetry diagnostics. These operations must succeed without touching frozen tables.

- [ ] **Step 4: Recompute census**

Require full JSON equality and identical aggregate SHA after the runtime cycle.

- [ ] **Step 5: Run/register**

```bash
node --test scripts/legacy-history-retirement-postgres.test.mjs
node --test scripts/legacy-history-freeze-window-postgres.test.mjs
```

Add `scripts/legacy-history-freeze-window-postgres.test.mjs` to `scripts/test-integration.mjs`.

- [ ] **Step 6: Commit**

```bash
git add scripts/legacy-history-retirement-postgres.test.mjs \
  scripts/legacy-history-freeze-window-postgres.test.mjs scripts/test-integration.mjs
git commit -m "test: prove database enforced legacy history freeze"
```

---

## Task 3: Write migration 063 as a guarded exact drop

**Files:**
- Create: `migrations/063_retire_obsolete_execution_history.sql`
- Create: `scripts/retire-obsolete-execution-history-postgres.test.mjs`

- [ ] **Step 1: Write migration tests first**

Cases:

1. populated source, no readiness row -> migration fails, all 14 tables remain;
2. ready row, source census changed -> fails, all tables remain;
3. ready row, one trigger missing -> fails;
4. ready row, one trigger disabled -> fails;
5. `archive_required`, archive not confirmed -> fails;
6. valid populated frozen/readied fixture -> succeeds;
7. all 14 source tables empty with guards installed -> succeeds without fake archive work.

- [ ] **Step 2: Run and observe failure**

```bash
node --test scripts/retire-obsolete-execution-history-postgres.test.mjs
```

Expected: FAIL because migration 063 does not exist.

- [ ] **Step 3: Implement transactional SQL preflight**

Migration begins one transaction and obtains a transaction-level advisory lock dedicated to legacy history retirement.

For populated history it verifies:

```text
control_key = legacy_execution_history_v1
freeze_state = frozen
telemetry_backfill_state = complete
destructive_readiness_state = ready
current source-census JSON = expected_source_counts
```

When `retention_mode='archive_required'`, also require `archive_readiness_state='confirmed'`.

Query `pg_trigger` and require the exact 14 trigger names, each enabled for origin execution, and query `pg_proc` for `prevent_frozen_legacy_history_write`.

For zero-history fresh deployment, allow the drop without archive/readiness rows only when all 14 tables have zero rows and the exact freeze guards are still installed/enabled.

- [ ] **Step 4: Drop exactly the approved objects**

Use explicit `DROP TABLE` statements for the 14 names. Do not use wildcard discovery. Do not use `CASCADE` unless an explicitly named constraint owned by the approved set is first reviewed and dropped separately.

After tables are gone, drop exactly the two temporary migration helpers created by migration 062:

```sql
ALTER TABLE orchestration_runs DROP COLUMN IF EXISTS latest_horizon_id;
DROP FUNCTION IF EXISTS prevent_frozen_legacy_history_write();
DROP FUNCTION IF EXISTS legacy_history_source_census();
```

Migration 062 creates no additional census helper. Do not discover/drop functions by pattern.

- [ ] **Step 5: Verify retained tables**

Test `to_regclass(...) IS NOT NULL` for all compact/telemetry/control tables and null for all 14 retired tables.

- [ ] **Step 6: Run/commit**

```bash
node --test scripts/retire-obsolete-execution-history-postgres.test.mjs
git add migrations/063_retire_obsolete_execution_history.sql \
  scripts/retire-obsolete-execution-history-postgres.test.mjs
git commit -m "feat: retire obsolete execution history tables"
```

---

## Task 4: Prove the populated upgrade and post-drop correctness path

**Files:**
- Create: `scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Build a realistic frozen populated fixture**

Apply historical migrations that create all retiring tables, compact migrations through 059, and Plan B migrations 060–062. Seed representative terminal legacy history, matching telemetry events, confirmed archive exports, and a frozen census/readiness row exactly as Plan B would leave them.

This final test does not call the soon-to-be-deleted backfill module. It validates the contract between a completed Plan B deployment and migration 063.

- [ ] **Step 2: Apply migration 063**

Assert all 14 tables and the old `latest_horizon_id` pointer are absent while compact/telemetry/control state remains.

- [ ] **Step 3: Exercise post-drop correctness**

On the same database run:

```text
project-transition acquire/checkpoint/heartbeat/settle/reacquire
legacy work claim/checkpoint/heartbeat/settle/reacquire
stale epoch rejection
operation_state indeterminate recovery lookup
exact-revision proof lookup
required-check observation proof update
run current-horizon checkpoint/resolve
scheduled-cycle telemetry classification
```

Any SQL reference to a dropped table must fail the test.

- [ ] **Step 4: Register/run**

Add to `scripts/test-integration.mjs`, then:

```bash
npm run test:integration
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/retire-obsolete-execution-history-upgrade-postgres.test.mjs scripts/test-integration.mjs
git commit -m "test: prove populated execution history retirement"
```

---

## Task 5: Delete obsolete runtime and one-way migration scaffolding

**Files to modify:**
- `lib/orchestration-journal.js`
- `lib/orchestration-runs.js`
- `lib/orchestration.test.js`
- `lib/work-leases.js`
- `lib/work-leases.test.js`
- `lib/github-required-check-observation.js`
- `lib/github-required-check-observation.test.js`
- `lib/scheduled-cycle-completeness.js`
- `lib/scheduled-cycle-completeness.test.js`
- `scripts/test-integration.mjs`

**Files to delete:**
- `lib/orchestration-semantic-journal-resolution.js`
- `lib/orchestration-semantic-journal-resolution.test.js`
- `lib/legacy-history-sanitizers.js`
- `lib/legacy-history-sanitizers.test.js`
- `lib/legacy-history-backfill.js`
- `lib/legacy-history-backfill.test.js`
- `lib/legacy-history-retirement.js`
- `scripts/legacy-history-backfill-postgres.test.mjs`
- `scripts/legacy-history-retirement-postgres.test.mjs`
- `scripts/verify-legacy-history-retirement-ready.mjs`
- `scripts/verify-legacy-history-retirement-ready.test.mjs`

- [ ] **Step 1: Remove dead journal persistence**

`lib/orchestration-journal.js` retains canonical request/result projection and telemetry emission only. Remove SQL/factories for `orchestration_command_invocations` and invocation resolutions.

Delete `lib/orchestration-semantic-journal-resolution.js` and its test because unresolved correctness now belongs to `operation_state`.

- [ ] **Step 2: Remove dead run/history persistence**

From `lib/orchestration-runs.js`, remove old `leasesForRun`, invocation history queries, old horizon insert/read/generation SQL, and any `latest_horizon_id` update/read. Run receipts use telemetry diagnostics plus compact current/terminal state only.

- [ ] **Step 3: Remove old lease storage/migration bridge**

`lib/work-leases.js` keeps the compact-backed lower-level work API. Delete old work-lease SQL store, dual-write bridge mode, historical continuation scans, and backfill-only hooks. Update `lib/work-leases.test.js` to test only compact behavior.

- [ ] **Step 4: Remove old observation/cycle SQL**

`lib/github-required-check-observation.js` retains proof-backed semantics only. `lib/scheduled-cycle-completeness.js` retains telemetry-backed diagnostics only. Delete all old table SQL from both and update focused tests.

- [ ] **Step 5: Delete one-way backfill/freeze runtime**

After migration 063 has been proven and is the deployment boundary, delete the exact legacy sanitizer/backfill/readiness files listed above. `lib/telemetry-retention-maintenance.js`, telemetry/archive modules, and `legacy_history_retirement_control` remain for retention policy/history.

- [ ] **Step 6: Remove deleted tests from integration registry**

Delete only the Plan B migration-scaffolding test registrations. Keep final migration/post-drop tests.

- [ ] **Step 7: Run**

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A lib scripts
git commit -m "refactor: delete retired execution history machinery"
```

---

## Task 6: Add a permanent retired-history poison gate

**Files:**
- Create: `scripts/verify-retired-history-tables-absent.mjs`
- Create: `scripts/verify-retired-history-tables-absent.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write scanner tests**

A production fixture containing any exact retired table identifier must fail. A fixture containing `latest_horizon_id` must also fail.

- [ ] **Step 2: Implement production-root scanner**

Scan exactly:

```text
api/
lib/
mcp/
src/
```

for the 14 retired identifiers plus `latest_horizon_id`. Error output includes path, line, and identifier.

Historical migrations and destructive-migration tests are outside these production roots and therefore need no broad allowlist. Do not weaken the production scan for compatibility shims.

- [ ] **Step 3: Wire canonical verification**

Add package script:

```json
"verify:retired-history": "node scripts/verify-retired-history-tables-absent.mjs"
```

and include it in the repository's existing `verify` chain without replacing existing checks.

- [ ] **Step 4: Run**

```bash
node --test scripts/verify-retired-history-tables-absent.test.mjs
npm run verify:retired-history
npm run verify
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-retired-history-tables-absent.mjs \
  scripts/verify-retired-history-tables-absent.test.mjs package.json
git commit -m "test: poison retired execution history references"
```

---

## Task 7: Regenerate contract evidence and public architecture docs

**Files:**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`
- Modify: `README.md`
- Modify: `docs/architecture/recovery-kernel-and-self-healing.md`
- Modify: `docs/execution-evidence-v1-design.md`
- Modify: `public/docs/orchestration-recovery.md`

- [ ] **Step 1: Regenerate contract evidence**

```bash
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md
```

The catalog must show no live durable contracts for the 14 retired tables. Compact/telemetry/control contracts remain classified.

- [ ] **Step 2: Update architecture docs**

Document the final steady-state boundary:

```text
fresh authority
+ orchestration_runs
+ execution_state
+ operation_state
+ proof_state
= execution correctness

telemetry_events + archive = observability/retention only
```

Remove instructions that teach operators/agents to reason from old leases, invocation chronology, old horizons, specialized receipts, or scheduled-cycle tables.

- [ ] **Step 3: Run final exact-head verification**

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
npm run verify:retired-history
npm run verify
```

Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add .contract-evidence/classifications.json generated/contracts/catalog.json \
  docs/generated/data-contracts.md README.md \
  docs/architecture/recovery-kernel-and-self-healing.md \
  docs/execution-evidence-v1-design.md public/docs/orchestration-recovery.md
git commit -m "docs: record compact execution history retirement"
```

## Plan C exit gate

Retirement is complete only when the exact final head proves:

- migration 063 rejects missing/stale readiness, changed census, missing/disabled freeze guards, and incomplete required archive;
- zero-history fresh installation succeeds without fake archive work;
- populated upgrade succeeds from a valid Plan B frozen state;
- all 14 tables are physically absent;
- `orchestration_runs.latest_horizon_id` is absent;
- compact project transition, legacy work, run horizons, operation recovery, required-check proof state, exact-revision proof state, and scheduled-cycle telemetry diagnostics work after the drop;
- production roots contain no retired table identifiers;
- one-way legacy sanitizer/backfill/readiness runtime has been deleted;
- telemetry/archive remain non-authoritative;
- contract evidence/public docs match the final schema;
- `npm run verify` and `npm run test:integration` pass on the exact head.
