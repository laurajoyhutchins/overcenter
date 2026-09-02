# Telemetry and Archive Retirement Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize every safe retiring-history row into explicit bounded TTL telemetry, move the remaining current safety fact in `github_required_check_observations` to exact-head `proof_state`, archive immutable provider-neutral bundles when configured, mechanically freeze all retiring tables, and produce deterministic destructive-retirement readiness without dropping legacy tables.

**Architecture:** `telemetry_events` is observability only. `proof_state` retains current required-check observation safety. `telemetry_archive_exports` is a provider-neutral archive outbox. `legacy_history_retirement_control` records retention and retirement state. PostgreSQL triggers enforce the global history freeze. Execution correctness never reads telemetry, archive exports, an archive provider, or retirement-control state.

**Tech Stack:** Node.js 22, TypeScript 5.9, PostgreSQL 16, `pg`, Node test runner, canonical JSON/SHA-256 helpers, Google Drive v3 through injected `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-02-legacy-execution-history-retirement-design.md`

## Global constraints

- Plan A must be green on the exact candidate head before Plan B becomes deployable.
- Plan B owns:
  - `060_telemetry_events.sql`
  - `061_telemetry_archive_exports.sql`
  - `062_legacy_history_retirement_control.sql`
- `059` belongs to Plan A and `063` to Plan C. Re-read the migration tail before the first Plan B commit; if Plan A renumbered the sequence, use that same sequence.
- This plan must not drop, truncate, rename, or replace a retiring source table.
- Telemetry failure must not change a semantic command result.
- Archive failure may block telemetry purge and destructive readiness only.
- Default telemetry TTL is 30 days.
- Canonical runtime telemetry payload limit is exactly 16,384 bytes of canonical JSON.
- Retention modes are exactly `ttl_only` and `archive_required`.
- The intended Overcenter deployment uses `archive_required`.
- Canonical archive schema is exactly `overcenter-archive-v1`.
- A run/cycle bundle cannot freeze while a correlated operation is `prepared` or `indeterminate`, or while `orchestration_runs.unresolved_operation_id` is non-null.
- `legacy_unscoped` is migration-only and only after the global database freeze.
- Sanitizers never forward arbitrary row objects.
- Raw capability/lease tokens, credentials, authorization headers, raw prompts, secret environment values, unrestricted provider response bodies, copied source blobs, and unbounded arbitrary requests never enter telemetry/archive payloads.
- A sanitizer rejection blocks readiness and identifies the first rejected `source_kind/source_id` with safe bounded evidence.
- Follow TDD and commit after each bounded task.
- Planning files under `docs/superpowers/**` stay off public implementation PRs.

## Exact retiring source registry

| `source_kind` | Source table | Correctness destination | Historical destination |
|---|---|---|---|
| `orchestration_invocation_resolution` | `orchestration_invocation_resolutions` | `operation_state` / no journal fallback after Plan A | telemetry |
| `orchestration_horizon` | `orchestration_horizons` | bounded `orchestration_runs.current_horizon` + fresh authority | telemetry |
| `work_lease_slot` | `work_lease_slots` | `execution_state` | telemetry |
| `work_lease_checkpoint` | `work_lease_checkpoints` | `execution_state` + `operation_state` | telemetry |
| `work_lease_heartbeat` | `work_lease_heartbeats` | bounded `execution_state` progress | telemetry |
| `work_lease` | `work_leases` | `execution_state` + `operation_state` | telemetry |
| `github_changeset_receipt` | `github_changeset_receipts` | compact provider `operation_state` | telemetry |
| `github_release_receipt` | `github_release_receipts` | compact provider `operation_state` | telemetry |
| `github_production_promotion_receipt` | `github_production_promotion_receipts` | compact operation/proof state | telemetry |
| `portfolio_reconcile_receipt` | `portfolio_reconcile_receipts` | compact provider `operation_state` | telemetry |
| `portfolio_verification_receipt` | `portfolio_verification_receipts` | `proof_state` | telemetry |
| `github_required_check_observation` | `github_required_check_observations` | exact-head `proof_state` | telemetry |
| `scheduled_cycle_event` | `scheduled_cycle_events` | none, diagnostic only | telemetry |
| `orchestration_command_invocation` | `orchestration_command_invocations` | `operation_state` for unresolved effects | telemetry |

The provider compact stores already present after #443 are correctness implementations, not legacy receipt writers. Plan B verifies they contain no writes to the dedicated receipt tables; it does not reimplement them.

## File map

**Telemetry contracts/storage**
- Create: `src/semantic/telemetry-retention.ts`
- Create: `src/ports/telemetry-store.ts`
- Create: `src/adapters/postgres/telemetry-store.ts`
- Create: `migrations/060_telemetry_events.sql`
- Create: `scripts/telemetry-store-postgres.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

**One-way boundary**
- Create: `scripts/verify-telemetry-kernel-boundary.mjs`
- Create: `scripts/verify-telemetry-kernel-boundary.test.mjs`

**Runtime command/receipt observability**
- Create: `lib/telemetry-events.js`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/orchestration.test.js`

**Required-check exact-head current state**
- Create: `lib/github-required-check-observation-proof.js`
- Create: `lib/github-required-check-observation.test.js`
- Modify: `lib/github-required-check-observation.js`
- Create: `scripts/github-required-check-observation-proof-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Legacy source sanitization/backfill**
- Create: `lib/legacy-history-sanitizers.js`
- Create: `lib/legacy-history-sanitizers.test.js`
- Create: `lib/legacy-history-backfill.js`
- Create: `lib/legacy-history-backfill.test.js`
- Create: `scripts/legacy-history-backfill-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Scheduled-cycle diagnostics**
- Modify: `lib/scheduled-cycle-completeness.js`
- Modify: `lib/scheduled-cycle-completeness.test.js`
- Create: `scripts/scheduled-cycle-telemetry-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Archive**
- Create: `src/semantic/archive-artifact.ts`
- Create: `src/ports/archive-sink.ts`
- Create: `src/ports/archive-export-store.ts`
- Create: `src/adapters/postgres/archive-export-store.ts`
- Create: `src/adapters/archive/google-drive.ts`
- Create: `migrations/061_telemetry_archive_exports.sql`
- Create: `lib/telemetry-archive-runtime.js`
- Create: `scripts/archive-artifact.test.mjs`
- Create: `scripts/archive-export-postgres.test.mjs`
- Create: `scripts/google-drive-archive-sink.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

**Retention/freeze/readiness**
- Create: `lib/telemetry-retention-maintenance.js`
- Create: `lib/legacy-history-retirement.js`
- Create: `migrations/062_legacy_history_retirement_control.sql`
- Create: `scripts/telemetry-retention-postgres.test.mjs`
- Create: `scripts/legacy-history-retirement-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Evidence**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`

---

## Task 1: Add explicit bounded TTL telemetry storage

**Files:**
- Create: `src/semantic/telemetry-retention.ts`
- Create: `src/ports/telemetry-store.ts`
- Create: `src/adapters/postgres/telemetry-store.ts`
- Create: `migrations/060_telemetry_events.sql`
- Create: `scripts/telemetry-store-postgres.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

- [ ] **Step 1: Write failing Postgres contract tests**

Require:

```text
PRIMARY KEY(event_id)
UNIQUE(source_kind, source_id)
payload_sha256 not null
expires_at not null
archive subject/time indexes
expiry index
```

Exact replay of the same `(source_kind,source_id,payload_sha256)` returns the existing event. Same source identity with a different digest fails `TELEMETRY_SOURCE_CONFLICT`.

- [ ] **Step 2: Define exact semantic constants**

```ts
export const TELEMETRY_SCHEMA_VERSION = 'overcenter-telemetry-v1';
export const DEFAULT_TELEMETRY_TTL_DAYS = 30;
export const MAX_TELEMETRY_PAYLOAD_BYTES = 16_384;
export type RetentionMode = 'ttl_only' | 'archive_required';
```

`TelemetryEvent.archive_subject_kind` is `run | scheduled_cycle | legacy_unscoped`. Normal runtime constructors reject `legacy_unscoped`; migration code gets an explicit backfill-only constructor.

- [ ] **Step 3: Implement migration/store**

Canonicalize payload, compute SHA-256, and reject canonical payload byte length greater than 16,384 before SQL. Test exactly 16,384 accepted and 16,385 rejected.

- [ ] **Step 4: Run**

```bash
npm run build:portable
node --test scripts/telemetry-store-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/semantic/telemetry-retention.ts src/ports/telemetry-store.ts \
  src/adapters/postgres/telemetry-store.ts migrations/060_telemetry_events.sql \
  scripts/telemetry-store-postgres.test.mjs tsconfig.portable-runtime.json
git commit -m "feat: add bounded ttl telemetry storage"
```

---

## Task 2: Enforce the one-way kernel boundary

**Files:**
- Create: `scripts/verify-telemetry-kernel-boundary.mjs`
- Create: `scripts/verify-telemetry-kernel-boundary.test.mjs`

- [ ] **Step 1: Write failing architecture-scanner tests**

Correctness roots include:

```text
lib/project-transition-lease-store.js
lib/project-transition-leases.js
lib/work-leases.js
lib/operator-commands.js
lib/orchestration-runs.js
lib/orchestration-finish-runtime.js
lib/orchestration-recovery.js
lib/compact-provider-operation-store.js
lib/compact-github-changeset-receipt-store.js
lib/compact-github-release-receipt-store.js
lib/compact-github-production-promotion-receipt-store.js
lib/compact-portfolio-reconcile-receipt-store.js
lib/compact-proof-state-store.js
lib/github-required-check-observation-proof.js
src/semantic/
src/ports/compact-execution-state-store.ts
src/adapters/postgres/compact-execution-state-store.ts
```

The scanner fails if these roots import/read modules matching:

```text
telemetry-events
telemetry-retention
telemetry-store
archive-artifact
archive-sink
archive-export
telemetry-archive
legacy-history-retirement
```

Composition code may inject a best-effort telemetry recorder into a boundary, but correctness modules themselves do not import telemetry/archive modules.

- [ ] **Step 2: Implement scanning**

Scan static imports, literal `import()`, and literal `require()` in the declared roots. Tests/docs/generated/migration-only modules are excluded explicitly.

- [ ] **Step 3: Run**

```bash
node --test scripts/verify-telemetry-kernel-boundary.test.mjs
node scripts/verify-telemetry-kernel-boundary.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-telemetry-kernel-boundary.mjs scripts/verify-telemetry-kernel-boundary.test.mjs
git commit -m "test: forbid telemetry authority imports"
```

---

## Task 3: Replace command-journal history with telemetry

**Files:**
- Create: `lib/telemetry-events.js`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/orchestration-runs.js`
- Modify: `lib/orchestration.test.js`

- [ ] **Step 1: Add failing `executeCorrelatedCommand` telemetry tests**

In `lib/orchestration.test.js`, extend the existing correlated-command tests. Require one bounded event using existing `safeRequestProjection`/`safeResultProjection`. Make the telemetry recorder throw and assert the semantic command body, `may_have_mutated`, retryability, and mutation certainty are unchanged.

Run:

```bash
node --input-type=module -e "import { runOrchestrationTests } from './lib/orchestration.test.js'; const r=await runOrchestrationTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

Expected initially: FAIL because telemetry recorder injection does not exist.

- [ ] **Step 2: Add best-effort recorder boundary**

`lib/telemetry-events.js` exposes a composition helper that implements the telemetry-store write and swallows/logs storage failure. `lib/orchestration-journal.js` accepts an injected `recordTelemetry` callback. It no longer creates new `orchestration_command_invocations` rows in normal runtime.

Each new runtime invocation gets a generated invocation UUID used as `source_id`; retries are separate observability events unless the caller supplies the same explicit invocation correlation identity.

- [ ] **Step 3: Move run-receipt journal diagnostics to telemetry**

In `lib/orchestration-runs.js`, `receipt()` reads command history by `archive_subject_kind='run'` and `archive_subject_id=run_id` from a diagnostic telemetry reader injected into the run store. It must not use telemetry for run completion, active authority, or recovery decisions.

The old command invocation/resolution tables remain untouched for backfill and freeze.

- [ ] **Step 4: Run focused tests**

Run Step 1 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/telemetry-events.js lib/orchestration-journal.js lib/orchestration-runs.js lib/orchestration.test.js
git commit -m "refactor: route command history into telemetry"
```

---

## Task 4: Move required-check current observation state to exact-head proof state

**Files:**
- Create: `lib/github-required-check-observation-proof.js`
- Create: `lib/github-required-check-observation.test.js`
- Modify: `lib/github-required-check-observation.js`
- Create: `scripts/github-required-check-observation-proof-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Write pure compatibility tests**

Preserve the current `observeMissing` / `clearObserved` store contract used by `stabilizeRequiredCheckEvaluation`. Tests require:

- first observation count 1;
- repeated exact-head observation increments count and preserves first timestamp;
- a new head SHA starts a separate exact-revision state;
- clearing a context consumes its current proof;
- head X can never satisfy head Y.

- [ ] **Step 2: Define proof identity**

Use:

```text
subject_key = required_check:<repo>:pr:<pull_request>:<required_context>
predicate_kind = github_required_check_missing_observation
authority_repository = <repo>
authority_revision = <head_sha>
```

The current unconsumed proof evidence contains bounded:

```text
required_context
first_missing_at
last_missing_at
observation_count
```

Each increment transaction locks the current unconsumed exact-head proof, consumes it, and inserts a new proof with a deterministic proof key containing subject/head/count/evidence digest. Do not mutate a proof identity in place.

- [ ] **Step 3: Replace old-table Postgres store**

`lib/github-required-check-observation.js` keeps the stabilization algorithm but delegates Postgres persistence to `lib/github-required-check-observation-proof.js`. No correctness SQL names `github_required_check_observations`.

Telemetry emission is optional callback injection after a successful proof transition; the proof module never imports telemetry.

- [ ] **Step 4: Prove physical absence**

`scripts/github-required-check-observation-proof-postgres.test.mjs` builds `proof_state` without `github_required_check_observations`, exercises the observation maturity threshold, exact-head change, and clear behavior, and asserts the old table is absent.

- [ ] **Step 5: Run**

```bash
node --input-type=module -e "import { runGithubRequiredCheckObservationTests } from './lib/github-required-check-observation.test.js'; const r=await runGithubRequiredCheckObservationTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
node --test scripts/github-required-check-observation-proof-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Register/commit**

Add the Postgres test to `scripts/test-integration.mjs`, then:

```bash
git add lib/github-required-check-observation-proof.js lib/github-required-check-observation.js \
  lib/github-required-check-observation.test.js \
  scripts/github-required-check-observation-proof-postgres.test.mjs scripts/test-integration.mjs
git commit -m "refactor: move required check observations to proof state"
```

---

## Task 5: Build the explicit 14-source sanitizer registry

**Files:**
- Create: `lib/legacy-history-sanitizers.js`
- Create: `lib/legacy-history-sanitizers.test.js`

- [ ] **Step 1: Write one fixture per exact source kind**

The test asserts the registry contains exactly 14 sorted source kinds from this plan. `work_lease` fixtures include `lease_token`, `token_hash`, and capability-like values and prove none survive. Command/provider fixtures include `authorization`, `body`, `prompt`, `private_key`, `secret`, and copied content fields.

- [ ] **Step 2: Implement source-specific projections**

Every sanitizer returns exactly:

```js
{ ok:true, event_kind, occurred_at, archive_subject_kind, archive_subject_id, payload }
```

or:

```js
{ ok:false, rejection_code, source_kind, source_id, safe_details }
```

No `SELECT *` result or raw row object is forwarded.

- [ ] **Step 3: Add recursive secret defense**

Run a second bounded key/value guard after source-specific projection. A guard failure is deterministic and blocks readiness.

- [ ] **Step 4: Run**

```bash
node --input-type=module -e "import { runLegacyHistorySanitizerTests } from './lib/legacy-history-sanitizers.test.js'; const r=await runLegacyHistorySanitizerTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/legacy-history-sanitizers.js lib/legacy-history-sanitizers.test.js
git commit -m "feat: define safe legacy history sanitizers"
```

---

## Task 6: Backfill every retiring source idempotently

**Files:**
- Create: `lib/legacy-history-backfill.js`
- Create: `lib/legacy-history-backfill.test.js`
- Create: `scripts/legacy-history-backfill-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Seed all 14 sources**

Postgres test creates at least one safe row from each retiring table. Require one telemetry event per source row, stable `(source_kind,source_id)`, stable payload digest, and zero duplicates on rerun.

- [ ] **Step 2: Implement explicit enumeration SQL**

Each source adapter lists columns explicitly and orders by its stable source identity. Never use `SELECT *` in sanitizer-facing code.

Correlation preference is exactly:

1. exact run;
2. exact scheduled cycle;
3. pending uncorrelated until post-freeze `legacy_unscoped` assignment.

Never infer run/cycle identity from timestamps alone.

- [ ] **Step 3: Handle rejection deterministically**

Backfill returns at most 25 safe rejection summaries and identifies the first rejected source. `legacy_history_retirement_control` later stores the first blocking `source_kind/source_id/code`. Rejected rows are not marked represented.

- [ ] **Step 4: Run/register**

```bash
node --test scripts/legacy-history-backfill-postgres.test.mjs
```

Add it to `scripts/test-integration.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/legacy-history-backfill.js lib/legacy-history-backfill.test.js \
  scripts/legacy-history-backfill-postgres.test.mjs scripts/test-integration.mjs
git commit -m "feat: backfill legacy history into telemetry"
```

---

## Task 7: Move scheduled-cycle chronology to telemetry

**Files:**
- Modify: `lib/scheduled-cycle-completeness.js`
- Modify: `lib/scheduled-cycle-completeness.test.js`
- Create: `scripts/scheduled-cycle-telemetry-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Capture exact classifier fixtures**

In `lib/scheduled-cycle-completeness.test.js`, retain fixtures for expected/accepted/started/acknowledged/claimed/idle/completed/verified/failed_closed/missing/ambiguous/reordered/duplicated outcomes and canonicalize returned records.

- [ ] **Step 2: Add Postgres physical-absence test**

`scripts/scheduled-cycle-telemetry-postgres.test.mjs` omits `scheduled_cycle_events`, seeds equivalent `source_kind='scheduled_cycle_event'` telemetry, and calls the production status/reconcile diagnostic path.

- [ ] **Step 3: Replace the Postgres chronology store**

`lib/scheduled-cycle-completeness.js` reads/writes diagnostic scheduled-cycle events through injected telemetry storage. Its run evidence still reads bounded current/terminal `orchestration_runs`. It does not turn cycle chronology into execution authority.

- [ ] **Step 4: Assert classification equality**

For every fixture, canonical old expected classification equals the telemetry-backed result byte-for-byte after normalization.

- [ ] **Step 5: Run/register**

```bash
node --input-type=module -e "import { runScheduledCycleCompletenessTests } from './lib/scheduled-cycle-completeness.test.js'; const r=await runScheduledCycleCompletenessTests(); console.log(JSON.stringify(r,null,2)); if(!r.ok) process.exit(1);"
node --test scripts/scheduled-cycle-telemetry-postgres.test.mjs
```

Add the Postgres test to `scripts/test-integration.mjs`.

- [ ] **Step 6: Commit**

```bash
git add lib/scheduled-cycle-completeness.js lib/scheduled-cycle-completeness.test.js \
  scripts/scheduled-cycle-telemetry-postgres.test.mjs scripts/test-integration.mjs
git commit -m "refactor: source cycle diagnostics from telemetry"
```

---

## Task 8: Add provider-neutral archive artifact/outbox and unresolved-operation fence

**Files:**
- Create: `src/semantic/archive-artifact.ts`
- Create: `src/ports/archive-sink.ts`
- Create: `src/ports/archive-export-store.ts`
- Create: `src/adapters/postgres/archive-export-store.ts`
- Create: `migrations/061_telemetry_archive_exports.sql`
- Create: `lib/telemetry-archive-runtime.js`
- Create: `scripts/archive-artifact.test.mjs`
- Create: `scripts/archive-export-postgres.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

- [ ] **Step 1: Write deterministic artifact tests**

Same ordered telemetry records produce identical canonical bytes/source-set digest/bundle digest regardless of sink configuration.

- [ ] **Step 2: Define exact port**

```ts
export interface CanonicalArchiveArtifact {
  readonly schema: 'overcenter-archive-v1';
  readonly bundle_id: string;
  readonly subject_kind: 'run' | 'scheduled_cycle' | 'legacy_unscoped';
  readonly subject_id: string;
  readonly source_cutoff: string;
  readonly source_set_sha256: string;
  readonly bundle_sha256: string;
  readonly canonical_bytes: Uint8Array;
}

export interface ArchiveSink {
  put(artifact: CanonicalArchiveArtifact): Promise<ArchiveReceipt>;
}
```

- [ ] **Step 3: Create outbox**

`telemetry_archive_exports` primary key is `(bundle_id,sink_id)` with subject coordinates, cutoff/digests, `pending|exporting|confirmed|failed`, attempts, bounded error, provider ref, and timestamps. No second payload copy.

- [ ] **Step 4: Fence bundle preparation**

Before preparing a run/cycle export, reject `ARCHIVE_SUBJECT_NOT_FINAL` if:

```text
orchestration_runs.unresolved_operation_id IS NOT NULL
or correlated operation_state.state = prepared
or correlated operation_state.state = indeterminate
```

Cycle bundles check all correlated runs. After blockers resolve, one bundle freezes. Retry rebuilds the exact cutoff source set and must reproduce both digests; otherwise `ARCHIVE_SOURCE_SET_CHANGED`.

- [ ] **Step 5: Run**

```bash
npm run build:portable
node --test scripts/archive-artifact.test.mjs
node --test scripts/archive-export-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/semantic/archive-artifact.ts src/ports/archive-sink.ts src/ports/archive-export-store.ts \
  src/adapters/postgres/archive-export-store.ts migrations/061_telemetry_archive_exports.sql \
  lib/telemetry-archive-runtime.js scripts/archive-artifact.test.mjs \
  scripts/archive-export-postgres.test.mjs tsconfig.portable-runtime.json
git commit -m "feat: add provider neutral telemetry archive"
```

---

## Task 9: Implement Google Drive archive sink

**Files:**
- Create: `src/adapters/archive/google-drive.ts`
- Create: `scripts/google-drive-archive-sink.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

- [ ] **Step 1: Write injected-fetch tests**

Cover new upload, exact same-bundle replay, digest conflict, and auth/upload failure.

- [ ] **Step 2: Implement adapter**

Constructor accepts exactly:

```ts
{ sinkId, folderId, getAccessToken, fetch }
```

Search the configured folder using private app properties:

```text
overcenter_bundle_id
overcenter_sha256
overcenter_schema
```

Same bundle ID/digest reuses the file. Different digest fails `ARCHIVE_DIGEST_CONFLICT`. Use resumable upload for canonical bytes. Provider details stay in adapter/receipt.

- [ ] **Step 3: Run/commit**

```bash
npm run build:portable
node --test scripts/google-drive-archive-sink.test.mjs
git add src/adapters/archive/google-drive.ts scripts/google-drive-archive-sink.test.mjs tsconfig.portable-runtime.json
git commit -m "feat: add google drive archive sink"
```

---

## Task 10: Add retention maintenance and database-enforced global freeze

**Files:**
- Create: `lib/telemetry-retention-maintenance.js`
- Create: `lib/legacy-history-retirement.js`
- Create: `migrations/062_legacy_history_retirement_control.sql`
- Create: `scripts/telemetry-retention-postgres.test.mjs`
- Create: `scripts/legacy-history-retirement-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Write retention-mode tests**

Require:

```text
ttl_only + expired -> purge eligible
archive_required + expired + confirmed -> purge eligible
archive_required + pending/failed/missing export -> not purge eligible
archive failure -> execution unaffected
```

- [ ] **Step 2: Create retirement-control schema**

The singleton row records:

```text
control_key
retention_mode
freeze_state
frozen_at
expected_source_counts jsonb
expected_source_sha256
telemetry_backfill_state
telemetry_source_sha256
archive_readiness_state
archive_confirmation_sha256
destructive_readiness_state
blocked_reason
blocked_source_kind
blocked_source_id
created_at
updated_at
```

Canonical control key is `legacy_execution_history_v1`.

- [ ] **Step 3: Install mechanical database guards in migration 062**

Create function:

```sql
prevent_frozen_legacy_history_write() RETURNS trigger
```

When the control row is `freeze_state='frozen'`, raise SQLSTATE `P0001` with message `LEGACY_HISTORY_FROZEN` and table name in safe detail. Otherwise return `OLD` for DELETE and `NEW` for INSERT/UPDATE.

Install exactly one enabled `BEFORE INSERT OR UPDATE OR DELETE` trigger on each of the 14 source tables. Trigger names are exactly:

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

- [ ] **Step 4: Implement deterministic source census and freeze**

For every source table compute `row_count` plus SHA-256 over stable ordered source identities. Freeze transaction:

1. verifies Plan A compact-authority marker/preconditions;
2. verifies no unresolved sanitizer rejection;
3. computes/stores sorted census and aggregate digest;
4. sets `freeze_state='frozen'` and `frozen_at`.

After commit, direct writes are blocked by triggers.

- [ ] **Step 5: Prove every guard**

`scripts/legacy-history-retirement-postgres.test.mjs` iterates all 14 tables. For each table after freeze, attempt one direct INSERT, UPDATE, and DELETE using a valid fixture row/identity and assert `P0001 / LEGACY_HISTORY_FROZEN`. Recompute the census and assert exact digest equality.

- [ ] **Step 6: Assign `legacy_unscoped` only after freeze**

Use:

```text
legacy_unscoped:<source_kind>:<UTC-month>:<chunk-index>
```

Maximum 1,000 events/chunk, stable `(source_kind,source_id)` order. Replay reproduces exact membership/digest.

- [ ] **Step 7: Compute destructive readiness**

Ready only when:

1. all 14 freeze triggers exist and are enabled;
2. frozen census still matches;
3. every source row is represented in telemetry;
4. there are zero sanitizer rejections;
5. all required immutable bundles are final;
6. `archive_required` has every expected export confirmed;
7. `ttl_only` needs no external sink;
8. no eligible run/cycle remains blocked by unresolved operations.

Do not drop anything.

- [ ] **Step 8: Run/register**

```bash
node --test scripts/telemetry-retention-postgres.test.mjs
node --test scripts/legacy-history-retirement-postgres.test.mjs
npm run test:integration
```

Expected: PASS. Register both Postgres tests in `scripts/test-integration.mjs`.

- [ ] **Step 9: Commit**

```bash
git add lib/telemetry-retention-maintenance.js lib/legacy-history-retirement.js \
  migrations/062_legacy_history_retirement_control.sql scripts/telemetry-retention-postgres.test.mjs \
  scripts/legacy-history-retirement-postgres.test.mjs scripts/test-integration.mjs
git commit -m "feat: freeze and gate legacy history retirement"
```

---

## Task 11: Contract evidence and exact-head verification

**Files:**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`

- [ ] **Step 1: Generate/classify new contracts**

`telemetry_events`, `telemetry_archive_exports`, and `legacy_history_retirement_control` are durable internal retention/observability contracts, never authority. Archive sink/store interfaces are internal boundary contracts. Required-check proof-state usage is a projection of the existing proof-state contract.

- [ ] **Step 2: Regenerate evidence**

```bash
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md
```

- [ ] **Step 3: Run exact-head verification**

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
node scripts/verify-telemetry-kernel-boundary.mjs
npm run verify
```

Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add .contract-evidence/classifications.json generated/contracts/catalog.json docs/generated/data-contracts.md
git commit -m "docs: record telemetry archive contract evidence"
```

## Plan B exit gate

Do not start Plan C until the exact implementation head proves:

- all 14 source kinds have explicit sanitizer/source identity;
- full backfill is idempotent and secret-redaction tests pass;
- command telemetry failure is non-authoritative;
- required-check maturity/current state works from exact-head `proof_state` with the old observation table absent;
- scheduled-cycle classifications are byte-for-byte equivalent with `scheduled_cycle_events` absent;
- archive bytes/digests are provider-independent and deterministic;
- unresolved operations prevent run/cycle bundle freeze;
- Google Drive replay/digest-conflict behavior is correct;
- `ttl_only` and `archive_required` rules pass;
- the global source census is frozen;
- all 14 freeze triggers exist, are enabled, and reject INSERT/UPDATE/DELETE;
- the source census remains unchanged through the observation/maintenance window;
- `legacy_unscoped` assignment is stable if needed;
- `legacy_history_retirement_control.destructive_readiness_state='ready'`;
- no retiring table has been dropped or truncated;
- `npm run verify` and `npm run test:integration` pass on the exact head.
