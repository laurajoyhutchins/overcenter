# Telemetry and Archive Retirement Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize all safe legacy history into explicit non-authoritative TTL telemetry, optionally archive immutable provider-neutral bundles, and produce a deterministic retirement-readiness record without dropping any legacy table.

**Architecture:** One bounded `telemetry_events` table replaces the many dedicated historical ledgers as the observability substrate. A provider-neutral archive builder freezes immutable run/cycle bundles only after all correlated operations are resolved, then an `ArchiveSink` exports canonical bytes through an idempotent outbox. A singleton retirement-control record tracks backfill, freeze and retention readiness. Correctness code may emit telemetry but may never read telemetry/archive state to authorize, recover, settle or reconcile work.

**Tech Stack:** Node.js 22, TypeScript 5.9, PostgreSQL 16, `pg`, Node test runner, canonical JSON/SHA-256 helpers, Google Drive v3 via injected `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-02-legacy-execution-history-retirement-design.md`

## Global Constraints

- Plan A, `2026-09-02-compact-execution-authority-retirement.md`, must be green on the exact implementation head before this plan becomes deployable.
- Plan B owns migrations:
  - `060_telemetry_events.sql`
  - `061_telemetry_archive_exports.sql`
  - `062_legacy_history_retirement_control.sql`
- `059` belongs to Plan A and `063` belongs to Plan C. If `dev` consumes any number before implementation begins, renumber the entire `059–063` retirement sequence together before the first migration commit.
- This plan must not drop, truncate, rename, or replace any legacy source table.
- Correctness may emit telemetry. Correctness may not read `telemetry_events`, `telemetry_archive_exports`, archive providers, or `legacy_history_retirement_control` to decide what execution is allowed.
- Telemetry failure must not change a semantic command result.
- Archive failure may block telemetry purge and destructive retirement readiness only. It must never block execution.
- Default telemetry TTL is 30 days and deployment-configurable.
- Retention modes are exactly `ttl_only` and `archive_required`.
- The intended Overcenter deployment uses `archive_required`.
- Canonical archive format is exactly `overcenter-archive-v1`.
- Archive bytes and digest are provider-neutral.
- A run/cycle archive must not freeze while any correlated operation is `prepared` or `indeterminate`, or while `orchestration_runs.unresolved_operation_id` is non-null.
- `legacy_unscoped` bundles are migration-only and may be assigned only after a global legacy-history freeze.
- Raw capability/lease tokens, credentials, authorization headers, raw prompts, secret environment values, unrestricted provider response bodies, copied source blobs, and unbounded arbitrary requests must never enter telemetry/archive payloads.
- A legacy row that cannot be safely normalized is rejected with deterministic evidence and blocks retirement readiness. It is never silently skipped.
- Follow TDD and commit after each bounded task.
- Planning files under `docs/superpowers/**` stay on the planning branch and must not ride an implementation PR into the public release branch.

---

## Retiring Source Registry

The backfill/sanitizer registry must name all retiring sources explicitly. There is no generic `misc_history` sanitizer.

| `source_kind` | Legacy source | Safe destination |
|---|---|---|
| `orchestration_invocation_resolution` | `orchestration_invocation_resolutions` | telemetry event with bounded resolution coordinates |
| `orchestration_horizon` | `orchestration_horizons` | telemetry event with bounded candidate refs/counts |
| `work_lease_slot` | `work_lease_slots` | telemetry only; current authority already lives in `execution_state` |
| `work_lease_checkpoint` | `work_lease_checkpoints` | telemetry with bounded checkpoint projection/digest |
| `work_lease_heartbeat` | `work_lease_heartbeats` | telemetry with bounded progress/expiry projection |
| `work_lease` | `work_leases` | telemetry with secret-bearing capability fields removed |
| `github_changeset_receipt` | `github_changeset_receipts` | operation tombstone for correctness, telemetry for safe history |
| `github_release_receipt` | `github_release_receipts` | operation tombstone for correctness, telemetry for safe history |
| `github_production_promotion_receipt` | `github_production_promotion_receipts` | operation/proof state for correctness, telemetry for safe history |
| `portfolio_reconcile_receipt` | `portfolio_reconcile_receipts` | operation tombstone for correctness, telemetry for safe history |
| `portfolio_verification_receipt` | `portfolio_verification_receipts` | proof state for correctness, telemetry for safe history |
| `github_required_check_observation` | `github_required_check_observations` | proof state for current exact revision, telemetry for safe history |
| `scheduled_cycle_event` | `scheduled_cycle_events` | telemetry event preserving diagnostic classification inputs |
| `orchestration_command_invocation` | `orchestration_command_invocations` | runtime telemetry event using existing bounded request/result projections |

---

## File Map

**Telemetry contracts and storage**
- Create: `src/semantic/telemetry-retention.ts`
- Create: `src/ports/telemetry-store.ts`
- Create: `src/adapters/postgres/telemetry-store.ts`
- Create: `migrations/060_telemetry_events.sql`
- Create: `scripts/telemetry-store-postgres.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

**Archive contracts and storage**
- Create: `src/semantic/archive-artifact.ts`
- Create: `src/ports/archive-sink.ts`
- Create: `src/ports/archive-export-store.ts`
- Create: `src/adapters/postgres/archive-export-store.ts`
- Create: `src/adapters/archive/google-drive.ts`
- Create: `migrations/061_telemetry_archive_exports.sql`
- Create: `scripts/archive-artifact.test.mjs`
- Create: `scripts/archive-export-postgres.test.mjs`
- Create: `scripts/google-drive-archive-sink.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

**Runtime observability and source sanitizers**
- Create: `lib/telemetry-events.js`
- Create: `lib/legacy-history-sanitizers.js`
- Create: `lib/legacy-history-sanitizers.test.js`
- Create: `lib/legacy-history-backfill.js`
- Create: `lib/legacy-history-backfill.test.js`
- Modify: `lib/orchestration-journal.js`
- Modify relevant specialized receipt/observation writers so correctness goes to compact state and history goes to telemetry only.

**Scheduled-cycle diagnostics**
- Modify the existing scheduled-cycle completeness/diagnostic module that reads `scheduled_cycle_events`.
- Add or modify its regression test so classification is identical when `scheduled_cycle_events` is absent and equivalent telemetry is present.

**Retention/readiness**
- Create: `lib/telemetry-archive-runtime.js`
- Create: `lib/legacy-history-retirement.js`
- Create: `migrations/062_legacy_history_retirement_control.sql`
- Create: `scripts/legacy-history-retirement-postgres.test.mjs`
- Create: `scripts/verify-telemetry-kernel-boundary.mjs`
- Create: `scripts/verify-telemetry-kernel-boundary.test.mjs`
- Modify: `scripts/test-integration.mjs`

**Evidence**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`

---

### Task 1: Add explicit TTL telemetry contracts and storage

**Files:**
- Create: `src/semantic/telemetry-retention.ts`
- Create: `src/ports/telemetry-store.ts`
- Create: `src/adapters/postgres/telemetry-store.ts`
- Create: `migrations/060_telemetry_events.sql`
- Create: `scripts/telemetry-store-postgres.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

- [ ] **Step 1: Write a failing Postgres contract test**

The test must require:

```text
UNIQUE(source_kind, source_id)
payload_sha256 present
expires_at present
payload JSON bounded by application validation
```

and prove exact replay returns the existing event while same `(source_kind,source_id)` with a different digest fails `TELEMETRY_SOURCE_CONFLICT`.

- [ ] **Step 2: Run and observe failure**

```bash
npm run build:portable
node --test scripts/telemetry-store-postgres.test.mjs
```

Expected: FAIL because migration/store do not exist.

- [ ] **Step 3: Implement semantic contract**

`src/semantic/telemetry-retention.ts` must define:

```ts
export const TELEMETRY_SCHEMA_VERSION = 'overcenter-telemetry-v1';
export const DEFAULT_TELEMETRY_TTL_DAYS = 30;
export type RetentionMode = 'ttl_only' | 'archive_required';

export interface TelemetryEvent {
  readonly event_id: string;
  readonly schema_version: typeof TELEMETRY_SCHEMA_VERSION;
  readonly source_kind: string;
  readonly source_id: string;
  readonly archive_subject_kind: 'run' | 'scheduled_cycle' | 'legacy_unscoped';
  readonly archive_subject_id: string;
  readonly event_kind: string;
  readonly occurred_at: string;
  readonly payload: unknown;
  readonly payload_sha256: string;
  readonly expires_at: string;
  readonly created_at: string;
}
```

Normal runtime constructors must reject `archive_subject_kind='legacy_unscoped'`. Migration/backfill code receives a separate explicit escape hatch after global freeze.

- [ ] **Step 4: Create migration 060**

Create `telemetry_events` with primary key `event_id`, unique `(source_kind,source_id)`, subject/time indexes, and expiry index. Do not add foreign keys to legacy tables.

- [ ] **Step 5: Implement store and bounded write validation**

`TelemetryStore.put(event)` must canonicalize/hash payload and reject payloads over the chosen bounded byte limit before SQL. Use a constant in the semantic module and test the exact limit.

- [ ] **Step 6: Run focused test**

```bash
npm run build:portable
node --test scripts/telemetry-store-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/semantic/telemetry-retention.ts src/ports/telemetry-store.ts \
  src/adapters/postgres/telemetry-store.ts migrations/060_telemetry_events.sql \
  scripts/telemetry-store-postgres.test.mjs tsconfig.portable-runtime.json
git commit -m "feat: add explicit ttl telemetry storage"
```

---

### Task 2: Enforce the one-way kernel boundary

**Files:**
- Create: `scripts/verify-telemetry-kernel-boundary.mjs`
- Create: `scripts/verify-telemetry-kernel-boundary.test.mjs`

- [ ] **Step 1: Write the failing static-architecture test**

Declare correctness roots explicitly, including compact execution/recovery/project-transition/work authority/provider mutation/proof modules. The test must fail when a fixture imports any path matching:

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

- [ ] **Step 2: Implement deterministic import scanning**

Scan static `import`, dynamic `import()`, and `require()` strings in production correctness roots. Do not scan tests, docs, generated output, or migration/backfill-only modules.

- [ ] **Step 3: Run**

```bash
node --test scripts/verify-telemetry-kernel-boundary.test.mjs
node scripts/verify-telemetry-kernel-boundary.mjs
```

Expected: PASS on current production tree.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-telemetry-kernel-boundary.mjs scripts/verify-telemetry-kernel-boundary.test.mjs
git commit -m "test: forbid telemetry authority imports"
```

---

### Task 3: Route command-journal observability into telemetry

**Files:**
- Create: `lib/telemetry-events.js`
- Modify: `lib/orchestration-journal.js`
- Modify existing orchestration-journal regression tests.

- [ ] **Step 1: Add a failing regression around `executeCorrelatedCommand`**

Assert that a successful command records one bounded telemetry event built from existing safe request/result projection helpers. Then make telemetry storage throw and assert the original semantic command response is unchanged.

- [ ] **Step 2: Run focused journal tests and observe failure**

Use the repository's existing orchestration-journal test entrypoint. Expected: FAIL because telemetry is not emitted.

- [ ] **Step 3: Add the runtime telemetry recorder**

`lib/telemetry-events.js` exposes a small best-effort recorder. `orchestration-journal.js` stops treating `orchestration_command_invocations` as the runtime history sink and emits `source_kind='orchestration_command_invocation'` with a stable source id and existing bounded projections.

The current-failure register in `orchestration_runs` remains correctness state. Telemetry does not replace it.

- [ ] **Step 4: Prove telemetry failure is non-authoritative**

Run the focused journal tests with injected telemetry failure. Expected: command result/effect certainty unchanged; only logger/diagnostic evidence records the telemetry failure.

- [ ] **Step 5: Commit**

```bash
git add lib/telemetry-events.js lib/orchestration-journal.js <journal-test-files>
git commit -m "refactor: route command history into telemetry"
```

---

### Task 4: Build explicit sanitizer registry for all retiring sources

**Files:**
- Create: `lib/legacy-history-sanitizers.js`
- Create: `lib/legacy-history-sanitizers.test.js`

- [ ] **Step 1: Write one sanitizer test per source kind**

The test table must contain all 14 `source_kind` values from the registry at the top of this plan. Fail the test if the registry count or exact sorted names differ.

For `work_lease`, include fixtures containing `lease_token`, `token_hash`, and capability-like strings and assert none appear in canonical output.

For command/provider rows, include raw `authorization`, `body`, `prompt`, `private_key`, `secret`, and copied content fields and assert they are rejected/removed according to the source-specific policy.

- [ ] **Step 2: Implement source-specific sanitizers**

Each sanitizer returns exactly one of:

```js
{ ok:true, event_kind, occurred_at, archive_subject_kind, archive_subject_id, payload }
```

or

```js
{ ok:false, rejection_code, safe_details }
```

No sanitizer may forward an arbitrary row object. Every payload field must be explicitly picked/normalized.

- [ ] **Step 3: Add recursive secret-pattern defense**

After source-specific projection, run a second bounded key/value guard so a newly added token/credential-like field cannot slip through unnoticed. A guard rejection is deterministic and blocks retirement readiness.

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

### Task 5: Backfill every legacy source idempotently

**Files:**
- Create: `lib/legacy-history-backfill.js`
- Create: `lib/legacy-history-backfill.test.js`
- Create or extend: `scripts/legacy-history-backfill-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Write failing backfill tests**

Seed at least one row from every retiring source table. Assert:

- one telemetry event per source row;
- rerun creates zero additional events;
- `(source_kind,source_id)` is stable;
- safe payload digest is stable;
- sanitizer rejection is persisted/returned as bounded evidence and makes `ok:false`;
- no capability/token fixture survives in telemetry JSON.

- [ ] **Step 2: Implement stable source enumeration**

Each source adapter owns an explicit SQL query and stable source id. Do not use `SELECT *` in sanitizer-facing code. Enumerate in stable source-id order.

- [ ] **Step 3: Implement correlation rules**

Prefer, in order:

1. exact run correlation;
2. exact scheduled-cycle correlation;
3. leave uncorrelated rows pending for post-freeze `legacy_unscoped` assignment.

Do not invent a run/cycle id from timestamps.

- [ ] **Step 4: Run integration**

```bash
node --test scripts/legacy-history-backfill-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Register and commit**

```bash
git add lib/legacy-history-backfill.js lib/legacy-history-backfill.test.js \
  scripts/legacy-history-backfill-postgres.test.mjs scripts/test-integration.mjs
git commit -m "feat: backfill legacy history into telemetry"
```

---

### Task 6: Move scheduled-cycle completeness diagnostics to telemetry

**Files:**
- Modify: existing scheduled-cycle completeness/diagnostic module.
- Modify/create: its focused regression test.

- [ ] **Step 1: Capture old-table classifications as fixtures**

For representative complete, incomplete, failed-closed and ambiguous cycles, record the exact classification fields currently derived from `scheduled_cycle_events`.

- [ ] **Step 2: Add equivalent telemetry fixtures with old table absent**

The test schema must omit/drop `scheduled_cycle_events` and insert equivalent `source_kind='scheduled_cycle_event'` telemetry.

- [ ] **Step 3: Replace diagnostic reads**

Change the diagnostic module to query telemetry only for historical cycle chronology. This is diagnostic logic, not execution correctness.

- [ ] **Step 4: Assert byte-for-byte normalized classification equality**

Canonicalize the old captured expected result and new telemetry result and assert equality.

- [ ] **Step 5: Commit**

```bash
git add <scheduled-cycle-diagnostic-files>
git commit -m "refactor: source cycle diagnostics from telemetry"
```

---

### Task 7: Add provider-neutral archive artifact and export outbox

**Files:**
- Create: `src/semantic/archive-artifact.ts`
- Create: `src/ports/archive-sink.ts`
- Create: `src/ports/archive-export-store.ts`
- Create: `src/adapters/postgres/archive-export-store.ts`
- Create: `migrations/061_telemetry_archive_exports.sql`
- Create: `scripts/archive-artifact.test.mjs`
- Create: `scripts/archive-export-postgres.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

- [ ] **Step 1: Write deterministic artifact tests**

Given the same ordered telemetry records, two builders must produce identical canonical bytes and SHA-256 regardless of sink configuration.

- [ ] **Step 2: Define archive interfaces**

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

export interface ArchiveReceipt {
  readonly sink_id: string;
  readonly provider_ref: string;
  readonly bundle_sha256: string;
  readonly confirmed_at: string;
}

export interface ArchiveSink {
  put(artifact: CanonicalArchiveArtifact): Promise<ArchiveReceipt>;
}
```

- [ ] **Step 3: Create migration 061**

`telemetry_archive_exports` has `(bundle_id,sink_id)` primary key, subject coordinates, source cutoff/digests, `pending|exporting|confirmed|failed`, attempts, bounded last error, provider ref and timestamps. It stores no canonical payload copy.

- [ ] **Step 4: Implement exact-source-set retry**

Prepared export persists source cutoff + source-set digest + bundle digest. Retry rebuilds the exact telemetry set. If either digest changes, throw `ARCHIVE_SOURCE_SET_CHANGED` and leave export unconfirmed.

- [ ] **Step 5: Run tests**

```bash
npm run build:portable
node --test scripts/archive-artifact.test.mjs
node --test scripts/archive-export-postgres.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/semantic/archive-artifact.ts src/ports/archive-sink.ts \
  src/ports/archive-export-store.ts src/adapters/postgres/archive-export-store.ts \
  migrations/061_telemetry_archive_exports.sql scripts/archive-artifact.test.mjs \
  scripts/archive-export-postgres.test.mjs tsconfig.portable-runtime.json
git commit -m "feat: add provider neutral telemetry archive"
```

---

### Task 8: Fence immutable bundle creation on unresolved operations

**Files:**
- Create: `lib/telemetry-archive-runtime.js`
- Create/modify: `scripts/archive-export-postgres.test.mjs`

- [ ] **Step 1: Add failing run-freeze tests**

Seed a terminal run and telemetry, then each blocker separately:

```text
orchestration_runs.unresolved_operation_id != null
operation_state.state='prepared'
operation_state.state='indeterminate'
```

Assert no export row is prepared and return `ARCHIVE_SUBJECT_NOT_FINAL`.

- [ ] **Step 2: Add scheduled-cycle correlation test**

A cycle with a correlated run containing unresolved operations must also remain unfrozen.

- [ ] **Step 3: Implement bundle readiness query**

Only after all blockers are absent may the runtime select `occurred_at <= source_cutoff`, stable-order events by `(occurred_at,source_kind,source_id)`, calculate source-set digest, and prepare the export row.

- [ ] **Step 4: Test terminal resolution transition**

Resolve the operation, clear the run pointer, retry, and assert exactly one bundle freezes.

- [ ] **Step 5: Commit**

```bash
git add lib/telemetry-archive-runtime.js scripts/archive-export-postgres.test.mjs
git commit -m "feat: fence archive freezing on unresolved effects"
```

---

### Task 9: Implement the Google Drive archive sink

**Files:**
- Create: `src/adapters/archive/google-drive.ts`
- Create: `scripts/google-drive-archive-sink.test.mjs`
- Modify: `tsconfig.portable-runtime.json`

- [ ] **Step 1: Write fake-fetch tests**

Cover:

1. no existing bundle -> resumable upload -> confirmed receipt;
2. same bundle id + same digest -> reuse existing file without uploading;
3. same bundle id + different digest -> `ARCHIVE_DIGEST_CONFLICT`;
4. authentication/upload error -> sink failure only.

- [ ] **Step 2: Implement injected adapter**

Constructor accepts only:

```ts
{
  sinkId,
  folderId,
  getAccessToken,
  fetch,
}
```

Search the configured folder using private app properties:

```text
overcenter_bundle_id
overcenter_sha256
overcenter_schema
```

Use resumable upload for canonical bytes. Provider-specific response fields stay inside the adapter/receipt.

- [ ] **Step 3: Run**

```bash
npm run build:portable
node --test scripts/google-drive-archive-sink.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/archive/google-drive.ts scripts/google-drive-archive-sink.test.mjs tsconfig.portable-runtime.json
git commit -m "feat: add google drive archive sink"
```

---

### Task 10: Add retention maintenance and retirement control

**Files:**
- Create: `lib/legacy-history-retirement.js`
- Create: `migrations/062_legacy_history_retirement_control.sql`
- Create: `scripts/legacy-history-retirement-postgres.test.mjs`
- Modify: `scripts/test-integration.mjs`

- [ ] **Step 1: Write failing retention-mode tests**

Cover:

```text
ttl_only + expired telemetry -> purge eligible
archive_required + expired + confirmed export -> purge eligible
archive_required + expired + pending/failed/no export -> not purge eligible
archive failure -> execution unaffected
```

- [ ] **Step 2: Create singleton retirement-control schema**

`legacy_history_retirement_control` must record at minimum:

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
destructive_readiness_state
blocked_reason
created_at
updated_at
```

Use one canonical control key such as `legacy_execution_history_v1`.

- [ ] **Step 3: Implement deterministic source census**

Before freeze, compute for every retiring table:

```text
row_count
stable source-id digest
```

Store the sorted map and a canonical aggregate SHA-256 in retirement control.

- [ ] **Step 4: Implement global freeze**

Freeze is permitted only after Plan A authority flip and all runtime legacy writers are disabled. On freeze, record the source census and `frozen_at`. Subsequent readiness checks must fail `LEGACY_HISTORY_CHANGED_AFTER_FREEZE` if any source count/digest changes.

- [ ] **Step 5: Assign migration-only `legacy_unscoped` bundles after freeze**

Group genuinely uncorrelated telemetry as:

```text
legacy_unscoped:<source_kind>:<UTC-month>:<chunk-index>
```

with maximum 1,000 events per chunk and stable `(source_kind,source_id)` order. Repeated assignment must reproduce bundle membership exactly.

- [ ] **Step 6: Implement destructive-readiness computation**

Readiness is true only when:

1. freeze census still matches;
2. all safe source rows are represented in telemetry or have deterministic sanitizer rejection evidence;
3. there are zero unresolved sanitizer rejections;
4. retention mode requirements are satisfied;
5. if `archive_required`, every immutable bundle is confirmed;
6. no run/cycle eligible for retirement is blocked by unresolved operations.

Do not drop anything. Store only the readiness result.

- [ ] **Step 7: Run**

```bash
node --test scripts/legacy-history-retirement-postgres.test.mjs
npm run test:integration
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/legacy-history-retirement.js migrations/062_legacy_history_retirement_control.sql \
  scripts/legacy-history-retirement-postgres.test.mjs scripts/test-integration.mjs
git commit -m "feat: gate legacy history retirement readiness"
```

---

### Task 11: Contract evidence and exact-head verification

**Files:**
- Modify: `.contract-evidence/classifications.json`
- Regenerate: `generated/contracts/catalog.json`
- Regenerate: `docs/generated/data-contracts.md`

- [ ] **Step 1: Generate candidate contract evidence**

```bash
mkdir -p /tmp/overcenter-contract-evidence/generated/contracts /tmp/overcenter-contract-evidence/docs/generated
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog /tmp/overcenter-contract-evidence/generated/contracts/catalog.json \
  --docs /tmp/overcenter-contract-evidence/docs/generated/data-contracts.md
```

- [ ] **Step 2: Classify new contracts**

Mark `telemetry_events`, `telemetry_archive_exports`, and `legacy_history_retirement_control` as durable internal/retention contracts, never authority. Mark archive sink/store interfaces as boundary-internal adapter contracts. Do not create new public semantic command contracts.

- [ ] **Step 3: Regenerate committed evidence**

```bash
node scripts/contract-evidence/cli.mjs generate \
  --repo-root . \
  --config scripts/contract-evidence/overcenter/config.mjs \
  --catalog generated/contracts/catalog.json \
  --docs docs/generated/data-contracts.md
```

- [ ] **Step 4: Run full verification**

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
node scripts/verify-telemetry-kernel-boundary.mjs
npm run verify
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add .contract-evidence/classifications.json generated/contracts/catalog.json docs/generated/data-contracts.md
git commit -m "docs: record telemetry archive contract evidence"
```

---

## Plan B Exit Gate

Do not start destructive Plan C until all of the following are true on the exact implementation head:

- all 14 retiring source kinds have explicit sanitizers and deterministic source identities;
- full backfill is idempotent and secret redaction tests pass;
- command/runtime telemetry failure is proven non-authoritative;
- scheduled-cycle diagnostics produce equivalent classifications from telemetry with the old event table absent;
- archive artifact bytes/digests are provider-neutral and deterministic;
- unresolved operations prevent run/cycle bundle freezing;
- Google Drive same-bundle replay is idempotent and digest conflict fails closed;
- `ttl_only` and `archive_required` retention rules pass;
- a global source census has been frozen and remains unchanged across the agreed observation/maintenance window;
- `legacy_unscoped` assignments are complete and stable if needed;
- `legacy_history_retirement_control.destructive_readiness_state` is ready;
- no legacy source table has been dropped or truncated;
- static kernel-boundary verification passes;
- `npm run verify` and `npm run test:integration` pass on the exact head.
