# Telemetry Retention and Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace long-lived historical execution tables with explicit 30-day TTL telemetry, optionally archive canonical immutable history through a provider-neutral sink before purge, and make Google Drive a concrete first sink without making Drive part of Overcenter semantics.

**Architecture:** Normalize new diagnostic chronology into one non-authoritative `telemetry_events` buffer. Freeze one immutable `overcenter-archive-v1` bundle only after a run/cycle is terminal and has no unresolved operation that could append semantically relevant history. Track delivery in `telemetry_archive_exports` and export through `ArchiveSink`. With no sink, TTL expiry permits purge; with a configured sink, the exact bundle digest must be confirmed first. Backfill legacy history through the same canonicalizer, confirm every configured archive, then retire obsolete history tables with a forward migration.

**Tech Stack:** Node.js 22, TypeScript 5.9.2, PostgreSQL, canonical JSON + SHA-256, native `fetch`, Google Drive API v3 for the first provider adapter, existing deterministic maintenance/runtime patterns.

**Spec:** `docs/superpowers/specs/2026-09-01-compact-execution-state-and-telemetry-archive-design.md`

**Depends on:**
- `docs/superpowers/plans/2026-09-01-compact-execution-state.md`
- `docs/superpowers/plans/2026-09-01-legacy-work-compact-cutover.md`

## Global Constraints

- Archive and telemetry are non-authoritative. Recovery, `project.advance`, acquisition, heartbeat authorization, settlement, mutation retry, promotion, and proof evaluation may not import or query them.
- Initial telemetry TTL is 30 days and is configurable at runtime.
- No configured archive sink: TTL expiry alone can permit purge.
- Configured archive sink: TTL expiry plus confirmed exact bundle digest is required for purge.
- Archive/export failure changes retention state only, never run/execution/operation/proof correctness state.
- Normal runtime bundle kinds are exactly `run` and `scheduled_cycle`; `legacy_unscoped` is migration-only.
- A run bundle is not prepared while `orchestration_runs.unresolved_operation_id` is non-null or any operation for the run remains `prepared/indeterminate`.
- A cycle bundle is not prepared while any correlated run has unresolved operation state.
- `content_sha256` is computed over canonical JSON with the digest field omitted.
- Same `bundle_id` must always reproduce the same source-set digest and bundle digest. Any mismatch is corruption and blocks purge.
- Never archive capability/lease tokens, credentials, secret environment values, raw prompts, arbitrary provider bodies, unrestricted request bodies, or copied source blobs.
- Google Drive auth is injected. The adapter does not own OAuth/user identity or put Google-specific fields into the semantic archive contract.
- Production retirement requires compact-read equivalence, history-independence, no unresolved dependency, confirmed archive backfill for targeted rows, and exact-revision verification on the retirement head.

---

### Task 1: Define canonical telemetry/archive semantics

**Files:**
- Create: `src/semantic/telemetry-archive.ts`
- Create: `type-tests/telemetry-archive.test.ts`
- Create: `scripts/verify-telemetry-archive-contract.test.mjs`
- Modify: `tsconfig.semantic.runtime.json`
- Create generated mirror: `lib/telemetry-archive.js`
- Modify: `.github/workflows/semantic-kernel-types.yml`

**Interfaces:**
- Produces: `TelemetryRecordV1`, `ArchiveBundleV1`, `CanonicalArchiveArtifact`, `buildArchiveBundle()`, `buildLegacyUnscopedArchiveBundle()`.

- [ ] **Step 1: Write the failing type/runtime tests**

```ts
const record: TelemetryRecordV1 = {
  record_type:'command_invocation', record_id:'invocation:1',
  occurred_at:'2026-09-01T18:00:00.000Z', run_id:'run-1', subject_key:null,
  command:'github.apply_changeset', outcome:'succeeded', may_have_mutated:true,
  payload:{ effect_ref:'abc123' }, payload_sha256:'a'.repeat(64),
};
```

Runtime tests must prove insertion order does not change canonical bytes/digest and normal runtime builder rejects `legacy_unscoped`.

- [ ] **Step 2: Verify failure**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
node --test scripts/verify-telemetry-archive-contract.test.mjs
```

- [ ] **Step 3: Implement deterministic sort/digest**

Sort telemetry by `(occurred_at, record_type, record_id)` and reference arrays lexicographically. Compute digest over:

```ts
export function archiveBundleDigestInput(bundle: ArchiveBundleV1) {
  const { content_sha256: _ignored, ...input } = bundle;
  return input;
}
```

Then SHA-256 `canonicalJson(input)`.

- [ ] **Step 4: Centralize archive redaction**

Reject forbidden keys including `lease_token`, `token_hash`, `authorization`, `password`, `access_token`, `refresh_token`, and `raw_prompt`. Reuse current bounded-evidence projections where available; never serialize arbitrary DB rows.

- [ ] **Step 5: Generate/run/commit**

```bash
rm -rf dist/lib && npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
cp dist/lib/telemetry-archive.js lib/telemetry-archive.js
diff -u lib/telemetry-archive.js dist/lib/telemetry-archive.js
node --test scripts/verify-telemetry-archive-contract.test.mjs
git add src/semantic/telemetry-archive.ts type-tests/telemetry-archive.test.ts scripts/verify-telemetry-archive-contract.test.mjs tsconfig.semantic.runtime.json lib/telemetry-archive.js .github/workflows/semantic-kernel-types.yml
git commit -m "feat: define canonical telemetry archive format"
```

---

### Task 2: Add explicit TTL telemetry and archive outbox schema

**Files:**
- Create: `migrations/057_telemetry_events.sql`
- Create: `migrations/058_telemetry_archive_exports.sql`
- Create: `scripts/verify-telemetry-retention-migrations.test.mjs`

**Interfaces:**
- Produces: non-authoritative TTL buffer plus immutable archive-delivery bookkeeping.

- [ ] **Step 1: Write failing migration assertions**

```js
assert.match(await read('057_telemetry_events.sql'), /expires_at\s+TIMESTAMPTZ\s+NOT NULL/i);
assert.match(await read('058_telemetry_archive_exports.sql'), /PRIMARY KEY\s*\(bundle_id,\s*sink_id\)/i);
```

- [ ] **Step 2: Create `telemetry_events`**

```sql
CREATE TABLE telemetry_events (
  event_id UUID PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  archive_subject_kind TEXT NOT NULL CHECK (archive_subject_kind IN ('run','scheduled_cycle','legacy_unscoped')),
  archive_subject_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  run_id TEXT,
  subject_key TEXT,
  command TEXT,
  outcome TEXT,
  may_have_mutated BOOLEAN,
  payload JSONB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id),
  UNIQUE (record_type, record_id)
);
CREATE INDEX telemetry_events_bundle_idx
  ON telemetry_events (archive_subject_kind, archive_subject_id, occurred_at, record_id);
CREATE INDEX telemetry_events_expiry_idx
  ON telemetry_events (expires_at, archive_subject_kind, archive_subject_id);
```

Normal runtime recorders reject `archive_subject_kind='legacy_unscoped'`; only backfill code may use it.

- [ ] **Step 3: Create `telemetry_archive_exports`**

```sql
CREATE TABLE telemetry_archive_exports (
  bundle_id TEXT NOT NULL,
  sink_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version='overcenter-archive-v1'),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('run','scheduled_cycle','legacy_unscoped')),
  subject_id TEXT NOT NULL,
  source_cutoff_at TIMESTAMPTZ NOT NULL,
  source_set_sha256 TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','exporting','confirmed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error JSONB,
  provider_ref TEXT,
  prepared_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bundle_id, sink_id)
);
```

- [ ] **Step 4: Run and commit**

```bash
node --test scripts/verify-telemetry-retention-migrations.test.mjs
git add migrations/057_telemetry_events.sql migrations/058_telemetry_archive_exports.sql scripts/verify-telemetry-retention-migrations.test.mjs
git commit -m "feat: add ttl telemetry and archive outbox schema"
```

---

### Task 3: Add TTL telemetry recorder and enforce the kernel boundary

**Files:**
- Create: `src/ports/telemetry-store.ts`
- Create: `src/adapters/postgres/telemetry-store.ts`
- Create: `src/runtime/telemetry-recorder.ts`
- Modify: `src/adapters/postgres/node-postgres-runtime.ts`
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/scheduled-cycle-completeness.js`
- Create: `scripts/verify-telemetry-recorder.test.mjs`
- Create: `scripts/verify-telemetry-kernel-boundary.test.mjs`

**Interfaces:**
- Produces: `recordTelemetry()` with default 30-day expiry and diagnostic-only readers.

- [ ] **Step 1: Write recorder/idempotency tests**

Same `(source_kind,source_id)` + same payload digest replays. Different digest throws `TELEMETRY_SOURCE_CONFLICT`. Default expiry equals occurrence time + 30 days.

- [ ] **Step 2: Write the forbidden-import test**

Fail if correctness modules import `telemetry-store`, `telemetry-recorder`, `telemetry-retention`, `archive-sink`, or provider archive adapters.

- [ ] **Step 3: Implement retention calculation**

```ts
export function telemetryExpiresAt(occurredAt: string, ttlDays = 30): string {
  if (!Number.isInteger(ttlDays) || ttlDays < 1) throw new TypeError('ttlDays must be a positive integer');
  return new Date(Date.parse(occurredAt) + ttlDays * 86_400_000).toISOString();
}
```

- [ ] **Step 4: Dual-write command/scheduler chronology**

Write existing safe journal/scheduled-cycle projections into normalized telemetry while old tables still receive compatibility writes. Prove scheduled-cycle classifications match old rows before any old writer is removed.

- [ ] **Step 5: Run and commit**

```bash
rm -rf dist/portable && npx --yes --package typescript@5.9.2 tsc -p tsconfig.portable-runtime.json
node --test scripts/verify-telemetry-recorder.test.mjs scripts/verify-telemetry-kernel-boundary.test.mjs
git add src/ports/telemetry-store.ts src/adapters/postgres/telemetry-store.ts src/runtime/telemetry-recorder.ts src/adapters/postgres/node-postgres-runtime.ts lib/orchestration-journal.js lib/scheduled-cycle-completeness.js scripts/verify-telemetry-recorder.test.mjs scripts/verify-telemetry-kernel-boundary.test.mjs
git commit -m "feat: record explicit ttl telemetry"
```

---

### Task 4: Add archive sink/export-store ports and immutable bundle preparation

**Files:**
- Create: `src/ports/archive-sink.ts`
- Create: `src/ports/archive-export-store.ts`
- Create: `src/adapters/postgres/archive-export-store.ts`
- Create: `src/runtime/telemetry-archive-builder.ts`
- Create: `src/runtime/telemetry-archive-exporter.ts`
- Modify: `src/adapters/postgres/node-postgres-runtime.ts`
- Create: `scripts/archive-sink-conformance.test.mjs`
- Create: `scripts/archive-export-store-postgres.test.mjs`
- Create: `scripts/verify-telemetry-archive-builder.test.mjs`
- Create: `scripts/verify-telemetry-archive-exporter.test.mjs`

**Interfaces:**
- Produces: `ArchiveSink.put()`, durable outbox transitions, deterministic builder/exporter.

- [ ] **Step 1: Define the port in a failing type test**

```ts
export interface ArchiveSink {
  readonly sinkId:string;
  put(artifact: CanonicalArchiveArtifact): Promise<ArchiveReceipt>;
}
```

`CanonicalArchiveArtifact` includes semantic bundle, canonical UTF-8 bytes, and digest so providers cannot choose serialization.

- [ ] **Step 2: Test outbox immutability**

Allowed states: `pending -> exporting -> confirmed|failed`, `failed -> exporting -> confirmed|failed`. Confirmed is immutable. Reprepare same `(bundle_id,sink_id)` with changed source-set or bundle digest throws `ARCHIVE_BUNDLE_CONFLICT`.

- [ ] **Step 3: Test the unresolved-operation freeze fence**

A terminal run with `unresolved_operation_id` or any `prepared/indeterminate` operation is not eligible for bundle preparation. After authoritative resolution clears the pointer/state, preparation succeeds once. The same rule applies to any correlated run in a scheduled cycle.

- [ ] **Step 4: Test deterministic source set**

Compute `source_set_sha256` over sorted `(record_type,record_id,payload_sha256)`. Reordering does not change it. Adding/changing any record with `occurred_at <= source_cutoff_at` after preparation makes retry fail `ARCHIVE_SOURCE_SET_CHANGED`.

- [ ] **Step 5: Implement asynchronous export**

One maintenance attempt performs at most one provider `put()` per selected bundle. Require returned `bundle_id` and digest equality before `confirmed`. Provider failure records bounded `last_error`, increments attempts, sets `failed`, and returns retention debt rather than an execution error.

- [ ] **Step 6: Run and commit**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
rm -rf dist/portable && npx --yes --package typescript@5.9.2 tsc -p tsconfig.portable-runtime.json
node --test scripts/archive-sink-conformance.test.mjs scripts/archive-export-store-postgres.test.mjs scripts/verify-telemetry-archive-builder.test.mjs scripts/verify-telemetry-archive-exporter.test.mjs
git add src/ports/archive-sink.ts src/ports/archive-export-store.ts src/adapters/postgres/archive-export-store.ts src/runtime/telemetry-archive-builder.ts src/runtime/telemetry-archive-exporter.ts src/adapters/postgres/node-postgres-runtime.ts scripts/archive-sink-conformance.test.mjs scripts/archive-export-store-postgres.test.mjs scripts/verify-telemetry-archive-builder.test.mjs scripts/verify-telemetry-archive-exporter.test.mjs
git commit -m "feat: prepare and export immutable archive bundles"
```

---

### Task 5: Implement Google Drive as the first concrete archive sink

**Files:**
- Create: `src/adapters/archive/google-drive.ts`
- Create: `type-tests/google-drive-archive-sink.test.ts`
- Create: `scripts/google-drive-archive-sink.test.mjs`

**Interfaces:**
- Consumes: `ArchiveSink`, injected `getAccessToken()`, configured `folderId`, injected/native `fetch`.
- Produces: `createGoogleDriveArchiveSink()`.

- [ ] **Step 1: Write fake-HTTP idempotency tests**

Before upload, search Drive by configured parent and private `appProperties.overcenter_bundle_id`. Same digest returns existing file ID without upload. Same bundle ID with a different `overcenter_sha256` throws `ARCHIVE_DIGEST_CONFLICT`.

- [ ] **Step 2: Implement Drive v3 search**

Use `files.list` query:

```text
'<folderId>' in parents and trashed = false
and appProperties has { key='overcenter_bundle_id' and value='<bundleId>' }
```

Request `files(id,name,appProperties)` only.

- [ ] **Step 3: Implement resumable upload**

Initiate:

```text
POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,appProperties
```

Metadata contains `name`, `parents:[folderId]`, `mimeType:'application/json'`, and private app properties `overcenter_bundle_id`, `overcenter_sha256`, `overcenter_schema`. Read `Location`, then `PUT` the exact canonical bytes there. Confirm returned file ID/digest metadata before returning `ArchiveReceipt`.

- [ ] **Step 4: Keep authentication/provider layout out of the semantic contract**

```ts
createGoogleDriveArchiveSink({
  sinkId,
  folderId,
  getAccessToken,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
})
```

No account/folder/token field may appear in `ArchiveBundleV1`.

- [ ] **Step 5: Run and commit**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
node --test scripts/google-drive-archive-sink.test.mjs scripts/archive-sink-conformance.test.mjs
git add src/adapters/archive/google-drive.ts type-tests/google-drive-archive-sink.test.ts scripts/google-drive-archive-sink.test.mjs
git commit -m "feat: add google drive archive sink"
```

---

### Task 6: Implement fail-closed-for-purge retention maintenance

**Files:**
- Create: `src/runtime/telemetry-retention.ts`
- Create: `src/runtime/telemetry-maintenance.ts`
- Modify: `lib/orchestration-maintenance-subjects.js`
- Create: `scripts/verify-telemetry-retention.test.mjs`
- Create: `scripts/verify-archive-failure-does-not-block-execution.test.mjs`

**Interfaces:**
- Produces: deterministic purge eligibility and bounded maintenance.

- [ ] **Step 1: Encode the retention truth table**

```text
TTL not expired                            -> keep
TTL expired + no sink                      -> purge eligible
TTL expired + sink + exact export confirmed-> purge eligible
TTL expired + sink + pending/failed export -> keep
```

Rows whose subject has not yet become archive-finalizable because of unresolved operations are always kept when a sink is configured.

- [ ] **Step 2: Prove archive failure cannot block execution**

Make the sink fail on every call. Finish/settle a run. Assert compact correctness state is terminal and unchanged; only maintenance reports archive/retention debt.

- [ ] **Step 3: Delete in bounded batches**

Select/delete at most 500 eligible telemetry rows per maintenance pass. With a sink configured, require a confirmed outbox row for that exact archive subject/digest and ensure the telemetry event occurred on/before the archived cutoff.

- [ ] **Step 4: Integrate with deterministic maintenance**

Existing maintenance may invoke archive retries/purge and return warnings/counters. Do not create an agent reasoning loop for archive retries and do not make health/recovery success depend on provider availability.

- [ ] **Step 5: Run and commit**

```bash
node --test scripts/verify-telemetry-retention.test.mjs scripts/verify-archive-failure-does-not-block-execution.test.mjs
git add src/runtime/telemetry-retention.ts src/runtime/telemetry-maintenance.ts lib/orchestration-maintenance-subjects.js scripts/verify-telemetry-retention.test.mjs scripts/verify-archive-failure-does-not-block-execution.test.mjs
git commit -m "feat: enforce archive aware telemetry retention"
```

---

### Task 7: Backfill all existing safe history into canonical telemetry/archive bundles

**Files:**
- Create: `src/runtime/telemetry-history-backfill.ts`
- Create: `scripts/backfill-telemetry-history.mjs`
- Create: `scripts/verify-telemetry-history-backfill.test.mjs`
- Create: `scripts/verify-archive-backfill-completeness.test.mjs`

**Interfaces:**
- Consumes: legacy historical tables as migration input.
- Produces: deterministic safe telemetry, run/cycle bundles, migration-only unscoped bundles, and completeness evidence.

- [ ] **Step 1: Write mapping fixtures for every retirement target**

Cover `orchestration_command_invocations`, invocation resolutions, horizons, work leases/slots/checkpoints/heartbeats, changeset/release/promotion/reconcile/verification receipts, required-check observations, and scheduled-cycle events. Every source row gets deterministic `source_kind/source_id`, bounded redacted payload, and archive subject.

- [ ] **Step 2: Prove redaction before apply mode**

Fixtures containing token-like fields must not emit those fields. Rows that cannot be normalized safely are explicitly rejected, never dumped wholesale.

- [ ] **Step 3: Implement dry-run by default**

```bash
node scripts/backfill-telemetry-history.mjs
```

Print source counts, normalized counts, rejected/ambiguous counts, archive subject counts, source-set hashes, and bundle hashes. Only `--apply` writes.

- [ ] **Step 4: Handle uncorrelatable legacy rows explicitly**

Group genuinely uncorrelatable old records into deterministic `legacy_unscoped` migration bundles. No normal runtime API can emit that kind.

- [ ] **Step 5: Verify completeness and configured archive confirmation**

Every source row targeted for retirement must map to exactly one safe archival record or an explicit safe exclusion. If a sink is configured, every covering bundle must be `confirmed` with matching digest before the retirement gate can pass.

- [ ] **Step 6: Run and commit**

```bash
node --test scripts/verify-telemetry-history-backfill.test.mjs scripts/verify-archive-backfill-completeness.test.mjs
git add src/runtime/telemetry-history-backfill.ts scripts/backfill-telemetry-history.mjs scripts/verify-telemetry-history-backfill.test.mjs scripts/verify-archive-backfill-completeness.test.mjs
git commit -m "feat: backfill canonical telemetry history"
```

---

### Task 8: Retire specialized history writers/tables

**Files:**
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/orchestration-semantic-journal-resolution.js`
- Modify: `lib/scheduled-cycle-completeness.js`
- Modify mutation/verification modules still dual-writing specialized receipts
- Create: `scripts/verify-history-retirement-readiness.test.mjs`
- Create: `scripts/verify-scheduler-history-independence.test.mjs`
- Create: `migrations/059_retire_obsolete_execution_history.sql`

**Interfaces:**
- Produces: compact correctness + one TTL telemetry store + archive outbox, with old history tables removed.

- [ ] **Step 1: Encode the five retirement gates**

Readiness test proves: compact-read equivalence, correctness with history absent, no unresolved effect dependency, configured archive backfill confirmation for every targeted row, and exact-revision verification on the migration head.

- [ ] **Step 2: Prove scheduler diagnostics from normalized telemetry**

Run existing cycle classification fixtures with `scheduled_cycle_events` physically absent and the equivalent normalized events in `telemetry_events`. Require identical `idle/completed/verified/failed_closed/missing/ambiguous` classifications.

- [ ] **Step 3: Stop specialized history writes**

After dual-write equivalence, new runtime writes compact correctness state plus normalized telemetry only. Delete old journal-resolution/receipt persistence paths that no longer have a current consumer.

- [ ] **Step 4: Add forward retirement migration**

```sql
DROP TABLE orchestration_invocation_resolutions;
DROP TABLE orchestration_horizons;
DROP TABLE work_lease_slots;
DROP TABLE work_lease_checkpoints;
DROP TABLE work_lease_heartbeats;
DROP TABLE work_leases;
DROP TABLE github_changeset_receipts;
DROP TABLE github_release_receipts;
DROP TABLE github_production_promotion_receipts;
DROP TABLE portfolio_reconcile_receipts;
DROP TABLE portfolio_verification_receipts;
DROP TABLE github_required_check_observations;
DROP TABLE scheduled_cycle_events;
DROP TABLE orchestration_command_invocations;
```

Retain `orchestration_runs`, `execution_state`, `operation_state`, `proof_state`, `telemetry_events`, and `telemetry_archive_exports`.

- [ ] **Step 5: Run with retired tables absent and commit**

```bash
node --test scripts/verify-history-retirement-readiness.test.mjs scripts/verify-scheduler-history-independence.test.mjs scripts/verify-compact-state-history-independence.test.mjs scripts/verify-legacy-work-history-independence.test.mjs scripts/verify-telemetry-retention.test.mjs
git add lib/orchestration-journal.js lib/orchestration-semantic-journal-resolution.js lib/scheduled-cycle-completeness.js scripts/verify-history-retirement-readiness.test.mjs scripts/verify-scheduler-history-independence.test.mjs migrations/059_retire_obsolete_execution_history.sql
git commit -m "refactor: retire durable execution history tables"
```

---

### Task 9: Document configuration and prove exact-head rollout

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/ontology-and-authority.md`
- Modify: `docs/architecture/recovery-kernel-and-self-healing.md`
- Modify: `docs/operator-recovery.md`
- Modify: `public/docs/control-plane-surface-inventory.md`
- Modify: `public/docs/architecture/terminology.md`
- Create: `public/docs/telemetry-retention-and-archive.md`
- Create: `scripts/verify-archive-provider-neutrality.test.mjs`

**Interfaces:**
- Produces: operator-facing retention/archive contract plus production rollout evidence.

- [ ] **Step 1: Document the exact model**

```text
correctness: compact state only
telemetry: 30-day default TTL, configurable
archive disabled: TTL expiry can purge
archive enabled: TTL expiry + confirmed exact bundle digest can purge
unresolved operation: do not freeze the run/cycle bundle yet
archive outage: retention warning only, never execution failure
```

Document Google Drive as one adapter requiring configured folder ID and injected access-token provider. State that S3-compatible storage is expected to implement the same `ArchiveSink` without changing bundle schema.

- [ ] **Step 2: Add provider-neutrality static tests**

Fail if semantic archive contracts, compact correctness modules, or archive port types contain Google/Drive/S3/bucket/folder/provider URL fields. Provider names are allowed only in adapters/runtime configuration/docs.

- [ ] **Step 3: Run all targeted gates**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
rm -rf dist/lib && npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
node --test scripts/verify-telemetry-archive-contract.test.mjs scripts/verify-telemetry-recorder.test.mjs scripts/verify-telemetry-kernel-boundary.test.mjs scripts/archive-sink-conformance.test.mjs scripts/archive-export-store-postgres.test.mjs scripts/verify-telemetry-archive-builder.test.mjs scripts/verify-telemetry-archive-exporter.test.mjs scripts/google-drive-archive-sink.test.mjs scripts/verify-telemetry-retention.test.mjs scripts/verify-archive-failure-does-not-block-execution.test.mjs scripts/verify-telemetry-history-backfill.test.mjs scripts/verify-archive-backfill-completeness.test.mjs scripts/verify-history-retirement-readiness.test.mjs scripts/verify-scheduler-history-independence.test.mjs scripts/verify-archive-provider-neutrality.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Run canonical regression and exact-revision Hatchable verification**

```bash
node scripts/verify-regression-suite-registry.mjs
```

Run every registered required check and the existing dist-aware exact-revision verifier against the same candidate SHA.

- [ ] **Step 5: Exercise the real configured sink before production purge**

Export one non-sensitive verification bundle, confirm provider reference/digest, replay the same bundle to prove idempotency, and prove a different digest for the same bundle ID fails closed. For Google Drive, verify the file is in the configured folder and `appProperties.overcenter_sha256` equals the canonical digest.

- [ ] **Step 6: Commit docs and record rollout evidence**

```bash
git add README.md docs public/docs scripts/verify-archive-provider-neutrality.test.mjs
git commit -m "docs: document telemetry retention and archival"
```

Record candidate SHA, archive backfill counts, confirmed bundle count, unresolved/not-yet-finalizable bundle count, outstanding retention debt, provider conformance result, retired-table absence result, canonical regression result, and exact-revision Hatchable result. Only then may migration `059` be promoted.
