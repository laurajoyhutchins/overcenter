# Telemetry Retention and Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace long-lived historical execution tables with explicit 30-day TTL telemetry, optionally archive canonical immutable history to a provider-neutral sink before purge, and make Google Drive a concrete first sink without making Drive part of Overcenter semantics.

**Architecture:** Normalize new diagnostic chronology into one non-authoritative `telemetry_events` buffer. Prepare one immutable `overcenter-archive-v1` bundle per completed run or scheduler-only cycle, record delivery state in `telemetry_archive_exports`, and export through an `ArchiveSink` port. With no sink configured, TTL expiry is sufficient for purge; with a sink configured, the exact bundle digest must be confirmed first. Backfill old history through the same canonicalizer, verify every configured archive, then drop obsolete history tables through a forward migration.

**Tech Stack:** Node.js 22, TypeScript 5.9.2, PostgreSQL, SHA-256 canonical JSON, native `fetch`, Google Drive API v3 for the first provider adapter, existing Overcenter deterministic maintenance/runtime patterns.

**Spec:** `docs/superpowers/specs/2026-09-01-compact-execution-state-and-telemetry-archive-design.md`

**Depends on:**
- `docs/superpowers/plans/2026-09-01-compact-execution-state.md`
- `docs/superpowers/plans/2026-09-01-legacy-work-compact-cutover.md`

## Global Constraints

- Archive and telemetry are non-authoritative. Recovery, `project.advance`, acquisition, heartbeat authorization, settlement, mutation retry, promotion, and proof evaluation may not import or query them.
- Initial telemetry TTL is 30 days, configurable at runtime; TTL is operational configuration, not a semantic constant in archived data.
- When no archive sink is configured, expired telemetry may purge normally.
- When an archive sink is configured, telemetry for a bundle may purge only after that sink confirms the exact `bundle_sha256`.
- Archive/export failure never changes execution/run/lease/operation/proof state. It creates retention debt only.
- Normal runtime bundles are exactly `run` or `scheduled_cycle`; `legacy_unscoped` is migration-only.
- Archive bytes are canonical JSON. `content_sha256` is computed over the canonical document with `content_sha256` omitted.
- A retry for the same `bundle_id` must reproduce the same source-set digest and bundle digest. A mismatch fails closed as archive corruption.
- Never archive lease/capability tokens, credentials, secret environment values, raw prompts, arbitrary provider response bodies, unrestricted request bodies, or copied repository source blobs.
- Google Drive is an adapter. The semantic archive contract must remain equally implementable by S3-compatible object storage, filesystem storage, or another sink.
- Google Drive authentication is injected through an access-token provider. The archive adapter does not own user identity or OAuth credential lifecycle.
- Production table retirement requires compact-read equivalence, physical history-independence, no unresolved effect dependency, configured archive backfill confirmation, and exact-revision verification on the retirement head.

---

### Task 1: Define canonical telemetry and archive contracts

**Files:**
- Create: `src/semantic/telemetry-archive.ts`
- Create: `type-tests/telemetry-archive.test.ts`
- Create: `scripts/verify-telemetry-archive-contract.test.mjs`
- Modify: `tsconfig.semantic.runtime.json`
- Create generated compatibility mirror: `lib/telemetry-archive.js`
- Modify: `.github/workflows/semantic-kernel-types.yml`

**Interfaces:**
- Consumes: canonical JSON and SHA-256 helpers.
- Produces: `TelemetryRecordV1`, `ArchiveBundleV1`, `CanonicalArchiveArtifact`, `canonicalTelemetryRecord()`, `buildArchiveBundle()`, `archiveBundleDigestInput()`.

- [ ] **Step 1: Write failing contract tests**

```ts
import type { ArchiveBundleV1, TelemetryRecordV1 } from '../src/semantic/telemetry-archive.js';

const record: TelemetryRecordV1 = {
  record_type:'command_invocation',
  record_id:'invocation:1',
  occurred_at:'2026-09-01T18:00:00.000Z',
  run_id:'run-1',
  subject_key:null,
  command:'github.apply_changeset',
  outcome:'succeeded',
  may_have_mutated:true,
  payload:{ effect_ref:'abc123' },
  payload_sha256:'a'.repeat(64),
};

const bundle: ArchiveBundleV1 = {
  schema:'overcenter-archive-v1',
  bundle_id:'run:run-1',
  kind:'run',
  subject_id:'run-1',
  created_at:'2026-09-01T18:10:00.000Z',
  source_revision:'b'.repeat(40),
  terminal_summary:{ disposition:'completed' },
  telemetry_records:[record],
  operation_refs:[],
  proof_refs:[],
  authority_refs:[],
  content_sha256:'c'.repeat(64),
};
void bundle;
```

- [ ] **Step 2: Verify failure**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
```

Expected: FAIL because the archive contract does not exist.

- [ ] **Step 3: Implement canonical ordering and self-excluding digest**

`buildArchiveBundle()` must sort telemetry by `(occurred_at, record_type, record_id)`, operation/proof/authority refs lexicographically, and produce the same canonical bytes regardless of insertion order.

```ts
export function archiveBundleDigestInput(bundle: ArchiveBundleV1): Omit<ArchiveBundleV1,'content_sha256'> {
  const { content_sha256: _ignored, ...digestInput } = bundle;
  return digestInput;
}
```

Digest only `canonicalJson(archiveBundleDigestInput(bundle))`.

- [ ] **Step 4: Centralize redaction**

The canonicalizer must reject forbidden key names such as `lease_token`, `token_hash`, `authorization`, `password`, `access_token`, `refresh_token`, and `raw_prompt` before serialization. Where current bounded-evidence utilities already normalize safe projections, reuse them instead of maintaining duplicate payload logic.

- [ ] **Step 5: Test normal vs migration bundle kinds**

Normal runtime builder accepts only `run | scheduled_cycle`. A separate `buildLegacyUnscopedArchiveBundle()` is the only API allowed to emit `legacy_unscoped`.

- [ ] **Step 6: Generate/run/commit**

```bash
rm -rf dist/lib
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.runtime.json
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
- Consumes: canonical telemetry/archive fields from Task 1.
- Produces: one non-authoritative telemetry buffer and one retention outbox.

- [ ] **Step 1: Write failing migration tests**

```js
const events = await read('057_telemetry_events.sql');
assert.match(events, /expires_at\s+TIMESTAMPTZ\s+NOT NULL/i);
assert.match(events, /UNIQUE\s*\(source_kind,\s*source_id\)/i);
const exportsSql = await read('058_telemetry_archive_exports.sql');
assert.match(exportsSql, /PRIMARY KEY\s*\(bundle_id,\s*sink_id\)/i);
assert.match(exportsSql, /source_set_sha256\s+TEXT\s+NOT NULL/i);
```

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/verify-telemetry-retention-migrations.test.mjs
```

- [ ] **Step 3: Create `telemetry_events`**

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
CREATE INDEX telemetry_events_expiry_idx ON telemetry_events (expires_at, archive_subject_kind, archive_subject_id);
CREATE INDEX telemetry_events_bundle_idx ON telemetry_events (archive_subject_kind, archive_subject_id, occurred_at, record_id);
```

`legacy_unscoped` inserts are permitted only through the migration backfill adapter, never the normal runtime recorder.

- [ ] **Step 4: Create `telemetry_archive_exports`**

```sql
CREATE TABLE telemetry_archive_exports (
  bundle_id TEXT NOT NULL,
  sink_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version = 'overcenter-archive-v1'),
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

- [ ] **Step 5: Run and commit**

```bash
node --test scripts/verify-telemetry-retention-migrations.test.mjs
git add migrations/057_telemetry_events.sql migrations/058_telemetry_archive_exports.sql scripts/verify-telemetry-retention-migrations.test.mjs
git commit -m "feat: add ttl telemetry and archive outbox schema"
```

---

### Task 3: Add telemetry recorder and forbid kernel imports

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
- Consumes: safe bounded event projections already produced by runtime modules.
- Produces: `recordTelemetry(record, { ttlDays:30 })` and telemetry reads for diagnostics/archive only.

- [ ] **Step 1: Write failing recorder tests**

Assert duplicate `(source_kind,source_id)` is idempotent only when `payload_sha256` matches; a different digest raises `TELEMETRY_SOURCE_CONFLICT`. Assert default expiry equals `occurred_at + 30 days` when the runtime policy does not override it.

- [ ] **Step 2: Write the import-boundary test**

Scan correctness modules (`project-transition-leases`, `work-leases`, recovery, mutation modules, production promotion, proof evaluation) and fail if they import `telemetry-recorder`, `telemetry-store`, `telemetry-retention`, or any archive adapter.

- [ ] **Step 3: Verify failures**

```bash
node --test scripts/verify-telemetry-recorder.test.mjs scripts/verify-telemetry-kernel-boundary.test.mjs
```

- [ ] **Step 4: Implement the recorder**

```ts
export interface TelemetryRetentionPolicy { readonly ttlDays: number; }

export function telemetryExpiresAt(occurredAt: string, policy: TelemetryRetentionPolicy): string {
  const ms = Date.parse(occurredAt) + policy.ttlDays * 86_400_000;
  return new Date(ms).toISOString();
}
```

Reject `ttlDays < 1` or non-integers. The default composition passes `30`.

- [ ] **Step 5: Dual-write current chronology into `telemetry_events`**

Start with command journal events and scheduled-cycle events. Preserve current public diagnostics by teaching scheduled-cycle completeness to read normalized telemetry once dual-write equivalence is proven. Do not remove old writes yet.

- [ ] **Step 6: Run and commit**

```bash
rm -rf dist/portable && npx --yes --package typescript@5.9.2 tsc -p tsconfig.portable-runtime.json
node --test scripts/verify-telemetry-recorder.test.mjs scripts/verify-telemetry-kernel-boundary.test.mjs
git add src/ports/telemetry-store.ts src/adapters/postgres/telemetry-store.ts src/runtime/telemetry-recorder.ts src/adapters/postgres/node-postgres-runtime.ts lib/orchestration-journal.js lib/scheduled-cycle-completeness.js scripts/verify-telemetry-recorder.test.mjs scripts/verify-telemetry-kernel-boundary.test.mjs
git commit -m "feat: record explicit ttl telemetry"
```

---

### Task 4: Define archive sink and durable export-store ports

**Files:**
- Create: `src/ports/archive-sink.ts`
- Create: `src/ports/archive-export-store.ts`
- Create: `src/adapters/postgres/archive-export-store.ts`
- Modify: `src/adapters/postgres/node-postgres-runtime.ts`
- Create: `type-tests/archive-sink.test.ts`
- Create: `scripts/archive-sink-conformance.test.mjs`
- Create: `scripts/archive-export-store-postgres.test.mjs`

**Interfaces:**
- Consumes: `CanonicalArchiveArtifact` from Task 1 and outbox table from Task 2.
- Produces: provider-neutral `ArchiveSink` and exact-digest export bookkeeping.

- [ ] **Step 1: Write the failing port contract**

```ts
export interface ArchiveReceipt {
  readonly sink_id:string;
  readonly bundle_id:string;
  readonly bundle_sha256:string;
  readonly provider_ref:string;
  readonly confirmed_at:string;
}

export interface ArchiveSink {
  readonly sinkId:string;
  put(artifact: CanonicalArchiveArtifact): Promise<ArchiveReceipt>;
}
```

`CanonicalArchiveArtifact` contains the semantic bundle, canonical UTF-8 bytes, and digest so adapters cannot reserialize it differently.

- [ ] **Step 2: Verify type failure**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
```

- [ ] **Step 3: Implement export-store state transitions**

Allowed transitions are:

```text
pending -> exporting -> confirmed
pending -> exporting -> failed
failed  -> exporting -> confirmed
failed  -> exporting -> failed
```

A confirmed export is immutable. Re-preparing the same `(bundle_id,sink_id)` with a different `source_set_sha256` or `bundle_sha256` throws `ARCHIVE_BUNDLE_CONFLICT`.

- [ ] **Step 4: Add sink conformance tests**

Any sink implementation must prove: exact digest returned, same artifact replay succeeds, same bundle ID/different digest fails, and provider errors do not mutate the artifact.

- [ ] **Step 5: Run and commit**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
rm -rf dist/portable && npx --yes --package typescript@5.9.2 tsc -p tsconfig.portable-runtime.json
node --test scripts/archive-sink-conformance.test.mjs scripts/archive-export-store-postgres.test.mjs
git add src/ports/archive-sink.ts src/ports/archive-export-store.ts src/adapters/postgres/archive-export-store.ts src/adapters/postgres/node-postgres-runtime.ts type-tests/archive-sink.test.ts scripts/archive-sink-conformance.test.mjs scripts/archive-export-store-postgres.test.mjs
git commit -m "feat: add provider neutral archive sink port"
```

---

### Task 5: Build immutable bundles and asynchronous exporter

**Files:**
- Create: `src/runtime/telemetry-archive-builder.ts`
- Create: `src/runtime/telemetry-archive-exporter.ts`
- Create: `scripts/verify-telemetry-archive-builder.test.mjs`
- Create: `scripts/verify-telemetry-archive-exporter.test.mjs`

**Interfaces:**
- Consumes: terminal compact state, telemetry rows, archive sink, export store.
- Produces: `prepareArchiveBundle(subject, sinkId)` and `exportArchiveBundle(bundleId, sink)`.

- [ ] **Step 1: Write deterministic builder tests**

For the same terminal run and telemetry set in different DB order, assert identical `source_set_sha256`, canonical bytes, and `bundle_sha256`.

The source-set digest is computed over sorted pairs:

```text
(record_type, record_id, payload_sha256)
```

- [ ] **Step 2: Write the changed-source corruption test**

Prepare an export, then change/add a telemetry event with `occurred_at <= source_cutoff_at`. Rebuild must throw `ARCHIVE_SOURCE_SET_CHANGED`; it may not silently update the stored digest.

- [ ] **Step 3: Verify failures**

```bash
node --test scripts/verify-telemetry-archive-builder.test.mjs scripts/verify-telemetry-archive-exporter.test.mjs
```

- [ ] **Step 4: Implement preparation**

A runtime `run` bundle is prepared only after the run is terminal. A `scheduled_cycle` bundle is prepared only after the cycle completeness surface declares the cycle terminal. Store `source_cutoff_at`, source-set digest, and bundle digest in `telemetry_archive_exports`; do not store a second full bundle payload.

- [ ] **Step 5: Implement bounded exporter attempts**

Each maintenance invocation performs at most one provider `put()` per selected bundle. On success, require receipt `bundle_id` and digest equality before `confirmed`. On failure, store bounded machine-readable `last_error`, increment attempts, set `failed`, and return a retention warning rather than throwing into execution state.

- [ ] **Step 6: Run and commit**

```bash
node --test scripts/verify-telemetry-archive-builder.test.mjs scripts/verify-telemetry-archive-exporter.test.mjs
git add src/runtime/telemetry-archive-builder.ts src/runtime/telemetry-archive-exporter.ts scripts/verify-telemetry-archive-builder.test.mjs scripts/verify-telemetry-archive-exporter.test.mjs
git commit -m "feat: prepare and export immutable archive bundles"
```

---

### Task 6: Implement the Google Drive archive adapter

**Files:**
- Create: `src/adapters/archive/google-drive.ts`
- Create: `type-tests/google-drive-archive-sink.test.ts`
- Create: `scripts/google-drive-archive-sink.test.mjs`

**Interfaces:**
- Consumes: `ArchiveSink`, injected `getAccessToken(): Promise<string>`, `folderId`, and `fetch` implementation.
- Produces: `createGoogleDriveArchiveSink()` implementing the same provider-neutral receipt contract.

- [ ] **Step 1: Write idempotency tests with a fake HTTP server/fetch**

First `put()` should search for the bundle by private `appProperties`. If a matching file exists with the same digest, no upload occurs and the existing file ID is returned. If the same bundle ID exists with a different digest, throw `ARCHIVE_DIGEST_CONFLICT`.

- [ ] **Step 2: Verify failure**

```bash
node --test scripts/google-drive-archive-sink.test.mjs
```

- [ ] **Step 3: Implement Drive search**

Use Drive v3 `files.list` with a query containing:

```text
'<folderId>' in parents
and trashed = false
and appProperties has { key='overcenter_bundle_id' and value='<bundleId>' }
```

Request only `files(id,name,appProperties)` and compare `appProperties.overcenter_sha256` with the artifact digest.

- [ ] **Step 4: Implement resumable upload**

Use an injected bearer token. Initiate:

```text
POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,appProperties
```

Metadata:

```json
{
  "name": "overcenter-<bundle-id>-<digest-prefix>.json",
  "parents": ["<configured-folder-id>"],
  "mimeType": "application/json",
  "appProperties": {
    "overcenter_bundle_id": "<bundle-id>",
    "overcenter_sha256": "<full-digest>",
    "overcenter_schema": "overcenter-archive-v1"
  }
}
```

Read the returned `Location` header and `PUT` the exact canonical bytes to that session URI. Confirm the returned file ID and digest metadata before returning the archive receipt.

- [ ] **Step 5: Keep auth outside the adapter contract**

The constructor shape is:

```ts
createGoogleDriveArchiveSink({
  sinkId,
  folderId,
  getAccessToken,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
})
```

Do not hard-code account IDs, folder IDs, tokens, client secrets, or a Google-specific field into `ArchiveBundleV1`.

- [ ] **Step 6: Run conformance and commit**

```bash
npx --yes --package typescript@5.9.2 tsc -p tsconfig.semantic.json
node --test scripts/google-drive-archive-sink.test.mjs scripts/archive-sink-conformance.test.mjs
git add src/adapters/archive/google-drive.ts type-tests/google-drive-archive-sink.test.ts scripts/google-drive-archive-sink.test.mjs
git commit -m "feat: add google drive archive sink"
```

---

### Task 7: Implement fail-closed-for-purge retention maintenance

**Files:**
- Create: `src/runtime/telemetry-retention.ts`
- Create: `src/runtime/telemetry-maintenance.ts`
- Modify: `lib/orchestration-maintenance-subjects.js`
- Create: `scripts/verify-telemetry-retention.test.mjs`
- Create: `scripts/verify-archive-failure-does-not-block-execution.test.mjs`

**Interfaces:**
- Consumes: TTL telemetry store plus optional configured archive sink/export store.
- Produces: deterministic purge eligibility and bounded maintenance pass.

- [ ] **Step 1: Write the four retention truth-table tests**

```text
TTL not expired                           -> keep
TTL expired + no archive sink             -> purge eligible
TTL expired + sink + export confirmed     -> purge eligible
TTL expired + sink + pending/failed export-> keep
```

Confirmation is valid only if the outbox digest equals the currently prepared canonical bundle digest.

- [ ] **Step 2: Write the execution-isolation test**

Make the archive sink throw on every call. Finish/settle a run and assert its compact run/operation/execution state is unchanged and terminal. Maintenance reports `archive_pending`/retention debt separately.

- [ ] **Step 3: Verify failures**

```bash
node --test scripts/verify-telemetry-retention.test.mjs scripts/verify-archive-failure-does-not-block-execution.test.mjs
```

- [ ] **Step 4: Implement bounded purge batches**

Select at most 500 eligible telemetry rows per maintenance pass. When a sink is configured, join through confirmed `telemetry_archive_exports` for the row's archive subject before delete. Never delete telemetry for a subject whose prepared bundle is absent, failed, pending, or digest-conflicted.

- [ ] **Step 5: Add maintenance without a new agent workflow**

Existing deterministic maintenance may call the retention pass and report counts/warnings, but recovery/health success does not depend on archive provider availability. Do not introduce an agent reasoning step for retries.

- [ ] **Step 6: Run and commit**

```bash
node --test scripts/verify-telemetry-retention.test.mjs scripts/verify-archive-failure-does-not-block-execution.test.mjs
git add src/runtime/telemetry-retention.ts src/runtime/telemetry-maintenance.ts lib/orchestration-maintenance-subjects.js scripts/verify-telemetry-retention.test.mjs scripts/verify-archive-failure-does-not-block-execution.test.mjs
git commit -m "feat: enforce archive aware telemetry retention"
```

---

### Task 8: Backfill the entire existing safe history into canonical telemetry and archive bundles

**Files:**
- Create: `src/runtime/telemetry-history-backfill.ts`
- Create: `scripts/backfill-telemetry-history.mjs`
- Create: `scripts/verify-telemetry-history-backfill.test.mjs`
- Create: `scripts/verify-archive-backfill-completeness.test.mjs`

**Interfaces:**
- Consumes: legacy history tables as migration input plus compact terminal facts.
- Produces: canonical telemetry rows, run/cycle bundles, migration-only `legacy_unscoped` bundles, and completeness evidence.

- [ ] **Step 1: Write one mapping fixture per legacy table family**

Cover at minimum:

```text
orchestration_command_invocations
orchestration_invocation_resolutions
orchestration_horizons
work_leases
work_lease_checkpoints
work_lease_heartbeats
github_changeset_receipts
github_release_receipts
github_production_promotion_receipts
portfolio_reconcile_receipts
portfolio_verification_receipts
github_required_check_observations
scheduled_cycle_events
```

Each fixture gets a deterministic `source_kind/source_id`, canonical record ID, bounded/redacted payload, and archive subject.

- [ ] **Step 2: Verify redaction before any apply mode**

Feed rows containing token-like fields and assert archive/telemetry output excludes them. The backfill refuses a record it cannot normalize safely rather than serializing the raw row.

- [ ] **Step 3: Implement dry-run by default**

```bash
node scripts/backfill-telemetry-history.mjs
```

prints source counts, normalized counts, rejected/ambiguous counts, subject counts, source-set hashes, and bundle digests. Only `--apply` writes normalized telemetry/outbox rows.

- [ ] **Step 4: Handle uncorrelatable history explicitly**

Rows that truthfully cannot map to a run or scheduled cycle go into deterministic migration-only `legacy_unscoped` groups. Normal runtime code has no API to create those bundles.

- [ ] **Step 5: Add archive-completeness verification**

For every history row targeted for retirement, prove exactly one safe normalized archival record exists or an explicit documented exclusion explains why no historical payload is retainable. When a sink is configured, require every bundle covering those rows to be `confirmed` with matching digest.

- [ ] **Step 6: Run and commit**

```bash
node --test scripts/verify-telemetry-history-backfill.test.mjs scripts/verify-archive-backfill-completeness.test.mjs
git add src/runtime/telemetry-history-backfill.ts scripts/backfill-telemetry-history.mjs scripts/verify-telemetry-history-backfill.test.mjs scripts/verify-archive-backfill-completeness.test.mjs
git commit -m "feat: backfill canonical telemetry history"
```

---

### Task 9: Retire dedicated history writers and tables

**Files:**
- Modify: `lib/orchestration-journal.js`
- Modify: `lib/orchestration-semantic-journal-resolution.js`
- Modify: `lib/scheduled-cycle-completeness.js`
- Modify mutation/verification modules that still dual-write specialized receipts
- Create: `scripts/verify-history-retirement-readiness.test.mjs`
- Create: `scripts/verify-scheduler-history-independence.test.mjs`
- Create: `migrations/059_retire_obsolete_execution_history.sql`

**Interfaces:**
- Consumes: compact correctness cutover, normalized telemetry dual-write, confirmed archive backfill.
- Produces: one TTL telemetry store instead of many durable history tables.

- [ ] **Step 1: Write the retirement readiness gate**

It must prove all five spec conditions:

```text
compact-read equivalence passed
correctness passes with history absent
no unresolved effect depends on retired storage
configured archive backfill confirmed for every targeted row
exact-revision verification passed for this migration head
```

- [ ] **Step 2: Prove scheduler completeness from normalized telemetry**

Teach `scheduled-cycle-completeness` to read the equivalent normalized scheduled-cycle events from `telemetry_events`. Run the same classification fixtures with `scheduled_cycle_events` physically absent and assert identical `idle/completed/verified/failed_closed/missing/ambiguous` results.

- [ ] **Step 3: Stop dedicated history writers**

Once equivalence passes, journal/scheduler/mutation/verification code writes only compact correctness state plus normalized TTL telemetry. Delete dual-write code for specialized receipt/history tables.

- [ ] **Step 4: Add the forward drop migration**

`059_retire_obsolete_execution_history.sql` drops only after the readiness gate is green:

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

Do not drop `operation_state`, `proof_state`, `execution_state`, `orchestration_runs`, `telemetry_events`, or `telemetry_archive_exports`.

- [ ] **Step 5: Run the repository with retired tables physically absent**

```bash
node --test scripts/verify-history-retirement-readiness.test.mjs scripts/verify-scheduler-history-independence.test.mjs scripts/verify-compact-state-history-independence.test.mjs scripts/verify-legacy-work-history-independence.test.mjs scripts/verify-telemetry-retention.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/orchestration-journal.js lib/orchestration-semantic-journal-resolution.js lib/scheduled-cycle-completeness.js scripts/verify-history-retirement-readiness.test.mjs scripts/verify-scheduler-history-independence.test.mjs migrations/059_retire_obsolete_execution_history.sql
git commit -m "refactor: retire durable execution history tables"
```

---

### Task 10: Document configuration, verify provider neutrality, and prove exact-head rollout

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
- Consumes: complete retention/archive implementation.
- Produces: documented 30-day default, archive-enabled purge rule, provider-neutral configuration, and exact-head deployment evidence.

- [ ] **Step 1: Document the operator model**

State clearly:

```text
execution correctness: compact state only
telemetry: 30-day default TTL, configurable
archive disabled: TTL expiry permits purge
archive enabled: TTL expiry + confirmed exact bundle digest permits purge
archive outage: retention warning only, never execution failure
```

Document Google Drive as an available adapter requiring configured folder ID and injected OAuth/access-token provider. Describe S3-compatible storage as an expected future adapter against the same `ArchiveSink` contract, not as a schema change.

- [ ] **Step 2: Add provider-neutrality static tests**

Fail if `src/semantic/telemetry-archive.ts`, compact correctness modules, or archive port types contain `google`, `drive`, `s3`, bucket, folder ID, or provider-specific URL fields. Provider names are allowed only under adapters/runtime configuration/docs.

- [ ] **Step 3: Run all archive/retention gates**

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

Run all registered required checks and the existing dist-aware exact-revision Hatchable verifier against the same candidate SHA.

- [ ] **Step 5: Exercise a real configured archive sink before production purge**

For the selected deployment sink, export a non-sensitive verification bundle, confirm the provider reference and digest, re-export the same bundle to prove idempotency, and verify a deliberately different digest for the same bundle ID fails closed. For Google Drive, verify the file exists in the configured folder and its `appProperties.overcenter_sha256` equals the canonical bundle digest.

- [ ] **Step 6: Commit docs and record rollout evidence**

```bash
git add README.md docs public/docs scripts/verify-archive-provider-neutrality.test.mjs
git commit -m "docs: document telemetry retention and archival"
```

Record candidate SHA, archive backfill counts, confirmed bundle count, outstanding retention debt, provider conformance result, retired-table absence result, canonical regression result, and exact-revision Hatchable result. Only then may the destructive migration be promoted.
