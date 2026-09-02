# Legacy Execution History Retirement Design

Status: Ready for user review
Date: 2026-09-02
Base: `dev` after compact execution state and epoch fencing (#443)

## Summary

Overcenter now has a compact correctness kernel built around `orchestration_runs`, `execution_state`, `operation_state`, and `proof_state`. Recovery can make present-tense decisions without reconstructing command-journal chronology, and project-transition checkpoint, heartbeat, continuation, mutation certainty, and exact-revision proof state already have compact durable homes.

The repository still carries the old persistence substrate, and some current execution paths still participate in it. In particular, project-transition authority still mirrors leases and slots through `work_leases` and `work_lease_slots`; legacy `work.*` HTTP compatibility still uses the old work-lease machinery; command journaling still writes `orchestration_command_invocations`; and several dedicated historical receipt/event tables remain present even though their correctness role has moved elsewhere.

This design retires that machinery in three ordered stages:

1. make compact state the sole correctness substrate for both project-transition and legacy-work execution;
2. normalize retained history into explicit TTL telemetry and, when configured, archive it through a provider-neutral immutable archive path;
3. freeze legacy writes, prove physical independence with the legacy tables absent, then drop the obsolete tables and delete their runtime machinery.

The destructive stage is deliberately last. A populated deployment cannot drop legacy history until deterministic backfill is complete and its configured retention policy is satisfied. A fresh deployment with empty legacy history can pass the same gate without manufacturing archive work for rows that never existed.

## Governing rule

A fresh Overcenter process, given fresh external authority plus compact current state, must be able to decide exactly what may safely happen next without querying historical runs, leases, slots, checkpoints, heartbeats, command journals, horizons, scheduled-cycle chronology, or specialized receipt tables.

Historical data may support diagnostics, analytics, audit, and operator investigation. It may never authorize execution, settlement, retry, recovery, proof satisfaction, or mutation reconciliation.

## Goals

This retirement must achieve all of the following:

- `execution_state` is the sole durable current execution-authority row for project transitions and legacy work.
- `authority_epoch` is the sole durable stale-process fencing mechanism for active execution subjects.
- `operation_state` owns semantically idempotent acquire/checkpoint/heartbeat/settle and provider-mutation outcomes, including indeterminate mutation state.
- `proof_state` owns exact-revision safety predicates.
- `orchestration_runs` retains only bounded current and terminal run state, including the bounded current-failure register.
- `work_leases`, `work_lease_slots`, `work_lease_checkpoints`, and `work_lease_heartbeats` become unnecessary for correctness and can be dropped.
- command-journal and specialized-receipt writes move to explicit non-authoritative telemetry or disappear when redundant.
- safe historical content is normalized into TTL telemetry before legacy tables are dropped.
- when archive is configured, archive confirmation is required before purge or destructive retirement of populated legacy history.
- archive data is provider-neutral and is never queried by the correctness kernel.
- hidden legacy writers are exposed by a deliberate freeze interval before destructive migration.
- the final runtime contains fewer persistence concepts and fewer compatibility paths than the current runtime.

## Non-goals

This design does not:

- change the six primary semantic MCP commands;
- make Linear authoritative for project content or execution truth;
- turn telemetry or an archive provider into a recovery dependency;
- preserve old SQL table shapes through compatibility views;
- retain raw capability tokens, credentials, unrestricted provider responses, raw prompts, or copied source blobs in archives;
- delete the `work.*` HTTP surface in the same migration solely because it is no longer part of the MCP surface;
- introduce a generic event-sourcing system;
- require Google Drive specifically for archive correctness.

The `work.*` HTTP compatibility surface may be removed later after caller evidence proves it is unused. This retirement instead makes that surface compact-state-backed so the old schema can disappear independently of API deprecation.

## Current state after #443

The compact kernel already provides:

- `execution_state` with `subject_kind IN ('project_transition', 'legacy_work')`, monotonically increasing `authority_epoch`, one active `lease_ref`, exact authority coordinates, current checkpoint, bounded recent progress, current continuation, and no-progress streak;
- `operation_state` keyed by the canonical semantic identity `(command, idempotency_scope, idempotency_key)`, including durable `prepared`, `indeterminate`, `succeeded`, `no_effect`, and `rejected` states;
- `proof_state` with immutable exact-revision proof identity;
- `orchestration_runs` compact pointers and bounded current-failure state;
- history-independent orchestration recovery for compact operations and execution state;
- provider mutation tombstones for changesets, releases, production promotion, and portfolio reconciliation.

The remaining structural debt is not that compact state is missing. It is that the old substrate still participates in live execution and retention.

## Architecture overview

```text
                     fresh external authority
                              |
                              v
                    +---------------------+
                    | compact correctness |
                    |---------------------|
                    | orchestration_runs  |
                    | execution_state     |
                    | operation_state     |
                    | proof_state         |
                    +---------------------+
                         |           |
              correctness|           |observability only
                         |           v
                         |   +------------------+
                         |   | telemetry_events |
                         |   +------------------+
                         |            |
                         |            v
                         |   +------------------+
                         |   | archive bundles  |
                         |   +------------------+
                         |            |
                         |            v
                         |       ArchiveSink
                         |
                         X
               no legacy-history reads
```

The dependency arrow is one-way. Correctness may emit telemetry. Telemetry and archive code may inspect compact state to label records. Correctness may not read telemetry or archive state to decide what execution is allowed.

## 1. Compact-only project-transition authority

### One current subject row is the slot

For a project transition, `execution_state.subject_key` becomes both the current-authority row and the exclusivity slot. `work_lease_slots` ceases to have an independent semantic role.

Acquisition is one transaction that:

1. derives the canonical project-transition subject key;
2. locks or creates that `execution_state` row;
3. rejects acquisition if an unexpired `lease_ref` already exists;
4. increments `authority_epoch`;
5. installs the new `lease_ref`, run, exact repository/revision coordinates, graph/transition fingerprints, expiry bounds, and active capability material;
6. creates or replays the acquisition `operation_state` record;
7. returns the receipt for the exact epoch that was durably installed.

No `work_leases` or `work_lease_slots` row is created.

### Acquisition idempotency

Project-transition acquisition becomes an explicit compact operation:

- command: `project_transition.acquire`
- idempotency scope: the canonical transition subject namespace
- idempotency key: the caller's acquisition idempotency key
- request hash: the canonical acquisition request hash

Same key plus same request hash replays the exact compact receipt. Same key plus a different request hash fails with `IDEMPOTENCY_CONFLICT`.

The operation resolution stores only the bounded receipt needed for replay. It does not become a historical lease ledger.

### Current authority reads

A transition lease is reconstructed from the current `execution_state` row plus the matching acquisition tombstone. A lease is valid only when all required coordinates agree:

- subject key;
- lease reference;
- authority epoch;
- run identity;
- exact repository revision;
- transition revision/dependency fingerprints;
- unexpired soft and hard expiry bounds.

Stale epochs remain invalid even if the old process later wakes up with a still-known capability token.

### Heartbeat and checkpoint

Checkpoint and heartbeat already use compact state for progress and operation idempotency. The remaining work is to remove joins and guards against `work_leases` and `work_lease_slots`.

Heartbeat atomically fences on `subject_key + lease_ref + authority_epoch`, updates the expiry/current progress window on `execution_state`, and completes its `operation_state` tombstone. No second lease row or slot expiry is updated.

### Settlement

Settlement becomes an explicit compact operation:

- command: `project_transition.settle`
- idempotency scope: the active lease namespace
- idempotency key: the settlement idempotency key

The settlement transaction fences on the exact lease reference and epoch, records the settlement result, promotes the latest checkpoint into the continuation head when appropriate, and clears active authority from `execution_state`. A stale settlement cannot clear a newer epoch.

A successful settlement replay comes from `operation_state`; it does not require a terminal `work_leases` row.

### Expiry recovery

Expiry recovery reads only the current `execution_state` row. If authority is expired and still owned by the expected epoch, recovery may promote the current checkpoint into continuation and clear the active lease. If the row has already advanced to a newer epoch, the old recovery attempt is stale and has no effect.

## 2. Compact legacy `work.*` compatibility

The lower-level `api/work/{claim,checkpoint,heartbeat,settle}` surface is kept for one compatibility cutover, but its storage implementation moves to compact state. This avoids making SQL compatibility views permanent and avoids coupling schema retirement to proof that every external caller has already disappeared.

### Canonical subject identity

Legacy work uses:

`legacy_work:<work_ref>:<gate>`

as its `execution_state.subject_key`, with `subject_kind='legacy_work'`.

The execution row stores explicit `work_ref` and `gate` coordinates so runtime lookup does not parse an opaque subject key. Bounded acquisition details that are needed only for replay or settlement, such as the prior Linear projection, live in the acquisition operation resolution rather than in a new history table.

### Temporary dual-write migration

Legacy work was not fully dual-written before this retirement. The safe migration therefore introduces a temporary compact dual-write before compact state becomes authoritative.

During the dual-write release:

1. old `work_leases`/slot persistence remains authoritative for the compatibility API;
2. each successful claim, checkpoint, heartbeat, settlement, invalidation, and expiry-recovery transition also writes the equivalent compact current state or operation tombstone in the same transaction where practical;
3. preexisting active and terminal subjects are backfilled idempotently into compact state;
4. subsequent legacy mutations keep the backfilled subjects synchronized;
5. an equivalence checker compares old and compact current-state derivations before authority flips.

The dual-write exists only as migration scaffolding. It is removed when compact reads become authoritative. No compatibility view or permanent second ledger remains.

### Active/current backfill

For every legacy-work subject, the backfill computes exactly one current compact projection from existing legacy state:

- active current lease and slot ownership, if one exists;
- current run and expiry bounds;
- current capability material needed to validate the active lease;
- latest durable checkpoint and its digest;
- the final two heartbeat progress digests ordered by durable heartbeat time and stable row identity, sufficient to preserve the bounded no-progress window;
- current continuation head from the latest eligible settled or safely expired lease under the existing continuation rules;
- continuation execution fingerprint and bounded no-progress streak.

The backfill is allowed to read historical legacy tables because it is migration code. Runtime correctness is not.

Backfill fails closed if legacy history is ambiguous, for example two simultaneously authoritative slots for the same canonical subject or conflicting terminal continuations that the existing continuation rules cannot order deterministically.

### Equivalence and authority flip

Before switching reads, comparison mode derives current authority and continuation from both the old store and compact projection for the same subject. The cutover requires equality for:

- lease identity and current ownership;
- authority revision;
- expiry bounds;
- checkpoint digest;
- bounded recent-progress window;
- continuation digest;
- no-progress streak;
- next safe action.

Once equivalence passes, compact state becomes authoritative for `work.*`. The legacy dual-write is then removed, making the old tables historical/read-only inputs for retention backfill only.

After cutover, tests physically remove the legacy lease tables and exercise the same HTTP compatibility behavior through compact state.

### Later API deletion

Once caller evidence proves `work.*` is unused outside Overcenter internals, its HTTP endpoints and boundary modules may be deleted in a separate bounded change. That later deletion must not be a prerequisite for database retirement.

## 3. Explicit TTL telemetry

Historical observability moves into one normalized, non-authoritative table rather than many specialized history tables.

### `telemetry_events`

A telemetry event contains:

- `event_id`;
- `schema_version`;
- `source_kind`;
- `source_id`;
- `archive_subject_kind`;
- `archive_subject_id`;
- `event_kind`;
- `occurred_at`;
- bounded canonical `payload`;
- `payload_sha256`;
- `expires_at`;
- `created_at`.

`(source_kind, source_id)` is unique so legacy backfill and retry are idempotent.

The default TTL is 30 days and is configurable by deployment policy.

### New telemetry writes

`executeCorrelatedCommand` stops writing `orchestration_command_invocations`. It may emit a bounded `telemetry_events` record after execution, but telemetry failure remains non-authoritative and cannot change the command result.

Dedicated receipt/event writers that no longer own correctness are similarly redirected or removed. No new feature should introduce another history-specific table unless the data is genuinely current authority rather than telemetry.

### Legacy backfill sanitization

Every retiring source table has an explicit sanitizer. The sanitizer preserves safe historical facts and rejects or removes secret-bearing material.

Archive/telemetry payloads must exclude at minimum:

- lease and capability tokens;
- credentials and authorization headers;
- raw secret environment values;
- raw prompts;
- unrestricted provider response bodies;
- copied source blobs;
- arbitrary request payloads that have not been bounded by a safe projection.

A legacy row that cannot be safely normalized is not silently skipped. Backfill records a deterministic rejection reason and retirement remains blocked until the sanitizer or retention decision is corrected.

## 4. Provider-neutral archive

### Canonical artifact

The archive format is `overcenter-archive-v1`.

An archive artifact is deterministic canonical JSON with SHA-256 over the exact canonical bytes. It contains schema metadata, archive subject coordinates, source cutoff, source-set digest, and the ordered safe telemetry records included in the bundle.

Provider metadata is not part of the canonical artifact, so the same source set produces the same bundle digest for Google Drive, S3-compatible storage, or any future sink.

### Bundle identity

Normal runtime bundles are immutable and subject-scoped:

- one logical bundle per completed run;
- one logical bundle per scheduler-only cycle where cycle telemetry still exists;
- no bundle is frozen while a correlated `operation_state` remains `prepared` or `indeterminate`.

Legacy rows that genuinely lack run/cycle correlation are grouped deterministically as:

`legacy_unscoped:<source_kind>:<UTC-month>:<chunk-index>`

with at most 1,000 events per chunk and stable ordering by `(source_kind, source_id)`. Legacy tables are globally write-frozen before these chunks are assigned, so retry reproduces the same membership and digest.

### `ArchiveSink`

The semantic port is intentionally small:

`ArchiveSink.put(CanonicalArchiveArtifact) -> ArchiveReceipt`

A receipt contains the sink identifier, provider object reference, canonical bundle digest, and confirmation metadata. Sink-specific fields do not leak into the canonical artifact.

### `telemetry_archive_exports`

The durable export outbox contains:

- `bundle_id + sink_id` primary key;
- schema version;
- subject kind/id;
- source cutoff;
- source-set SHA-256;
- bundle SHA-256;
- state `pending | exporting | confirmed | failed`;
- attempts;
- bounded last error;
- provider reference;
- created/updated/confirmed timestamps.

The outbox stores digests and coordinates, not a second full copy of the bundle. Source telemetry remains available until export is confirmed.

On retry, the exporter rebuilds the exact source set and must reproduce both source-set and bundle digests. A mismatch fails with `ARCHIVE_SOURCE_SET_CHANGED` and blocks purge.

### Google Drive adapter

Google Drive is the first concrete archive adapter for the intended deployment, but not part of the semantic archive contract.

The adapter receives injected authentication and folder configuration. It uses private app properties to make upload idempotent:

- `overcenter_bundle_id`;
- `overcenter_sha256`;
- `overcenter_schema`.

Before upload it searches the configured folder by bundle ID. Same bundle ID plus same digest reuses the confirmed object. Same bundle ID plus a different digest fails with `ARCHIVE_DIGEST_CONFLICT`.

The adapter may use resumable upload, but resumable-session details remain provider-local.

## 5. Retention and retirement readiness

### Retention modes

A deployment has one explicit retention mode:

- `ttl_only`: telemetry is retained for the configured TTL and may then be purged without external archival;
- `archive_required`: eligible telemetry must be confirmed in the configured archive sink before purge.

The intended Overcenter deployment uses `archive_required` so the safe historical copy survives database retirement.

Archive configuration never changes execution correctness. It changes only whether retention maintenance may purge telemetry or approve destructive legacy retirement.

### Freeze-before-drop

The retirement sequence includes a deliberate global history freeze after compact state has become authoritative and all legacy writers have been removed.

A small retirement-control record and database guard prevent writes to the retiring legacy tables once freeze is enabled. Freeze is not used to make the legacy-work authority flip safe; the temporary dual-write and equivalence gate do that earlier.

Any hidden old writer that fires during the freeze verification interval receives a hard database failure. This is intentional evidence that the runtime is not yet ready to drop the table.

The freeze guard is itself temporary and is removed with the legacy tables.

### Retirement receipt

For populated legacy history, destructive migration requires a durable readiness receipt containing:

- retirement schema/version;
- freeze timestamp;
- per-source legacy row counts;
- stable source-set digest computed after freeze as SHA-256 over ordered `(source_kind, source_id, payload_sha256)` tuples;
- normalized telemetry event count and digest;
- retention mode;
- archive confirmation digest when `archive_required`;
- ready timestamp.

The readiness service rechecks the frozen source counts immediately before declaring readiness. Because legacy tables are write-frozen, the source set cannot legitimately change after the receipt is created.

### Fresh-install rule

A fresh database whose retiring legacy tables are empty does not need fake backfill or archive bundles. The destructive migration may proceed when every retiring source table is empty.

A populated database must present a valid readiness receipt. In `archive_required` mode the receipt is invalid until every required legacy bundle is confirmed.

## 6. Destructive retirement set

After all gates pass, the retirement migration removes the obsolete execution-history substrate:

- `orchestration_invocation_resolutions`;
- `orchestration_horizons`;
- `work_lease_slots`;
- `work_lease_checkpoints`;
- `work_lease_heartbeats`;
- `work_leases`;
- `github_changeset_receipts`;
- `github_release_receipts`;
- `github_production_promotion_receipts`;
- `portfolio_reconcile_receipts`;
- `portfolio_verification_receipts`;
- `github_required_check_observations`;
- `orchestration_command_invocations`.

`scheduled_cycle_events` is retired in the same migration only if scheduler diagnostics have first been migrated to `telemetry_events` and the existing scheduled-cycle completeness classifier produces identical results with the old table physically absent. Otherwise that table remains temporarily diagnostic-only and gets its own later retirement.

The compact tables remain:

- `orchestration_runs`;
- `execution_state`;
- `operation_state`;
- `proof_state`;
- `telemetry_events`;
- `telemetry_archive_exports`;
- the small retention/retirement control records needed by maintenance.

After successful destructive migration, legacy backfill/freeze code is deleted as dead migration scaffolding.

## 7. Migration sequence

Migration numbers must be rechecked against `dev` immediately before implementation. As of this design, `056_orchestration_run_compaction.sql` is the latest compact-state migration and the following numbers are available.

Proposed sequence:

1. `057_execution_state_legacy_work_coordinates.sql`
   - add nullable `work_ref text` and `gate text` columns;
   - require both coordinates when `subject_kind='legacy_work'` has active authority;
   - add the lookup index required by compact legacy-work compatibility.

2. `058_telemetry_events.sql`
   - create explicit TTL telemetry storage and indexes.

3. `059_telemetry_archive_exports.sql`
   - create archive outbox and confirmation state.

4. `060_legacy_history_retirement_control.sql`
   - create retention policy/readiness state and temporary write-freeze guards.

5. `061_retire_obsolete_execution_history.sql`
   - fail closed unless legacy tables are empty or the readiness receipt proves the populated source set was frozen, normalized, and retained according to policy;
   - drop the approved retirement set;
   - remove temporary freeze triggers/functions.

If any of these numbers become occupied before implementation, the implementation plan must renumber the entire new sequence before the first migration is committed. It must never collide or silently reorder migration history.

## 8. Runtime sequencing

The deployment order is as important as the schema order.

### Phase A1: introduce compact legacy-work dual-write

- replace project-transition lease/slot reads and writes with `execution_state` and `operation_state`;
- add compact dual-write to legacy `work.*` mutations while old work-lease storage remains authoritative;
- backfill preexisting active/current legacy-work state and continuation heads;
- run continuous old-vs-compact equivalence checks.

### Phase A2: flip execution authority

- require equivalence for every current legacy-work subject;
- make compact state authoritative for `work.*` reads, writes, replay, and recovery;
- remove legacy dual-write;
- remove recovery's legacy lease fallback;
- leave old tables present as historical/read-only inputs for retention backfill.

### Phase B: start explicit telemetry/archive

- create normalized telemetry recorder;
- redirect command-journal and non-authoritative dedicated receipt/event writes;
- implement archive contracts/outbox/exporter;
- configure Google Drive adapter for the intended deployment;
- verify archive failure never changes execution results.

### Phase C: global freeze and history backfill

- prove static code no longer writes retiring tables;
- enable database write freeze for the retirement set;
- operate the normal test/runtime surface with freeze enabled;
- normalize all safe legacy rows into telemetry;
- create immutable archive bundles;
- confirm archive exports when policy requires them;
- create retirement readiness receipt.

### Phase D: physical-absence verification

In an integration database, drop the retiring tables before running the core suite. The suite must still cover project transition, legacy `work.*` compatibility, provider mutation replay, exact-revision proof lookup, orchestration recovery, and current-failure behavior.

### Phase E: destructive migration and deletion

- apply the retirement migration;
- delete legacy stores, SQL strings, sanitizers/backfill machinery that no longer has a source table, and obsolete tests;
- regenerate contract evidence;
- update public architecture documentation;
- run all canonical exact-head gates.

## 9. Implementation decomposition

This architecture should be implemented as at least three separately reviewable plans and deployment boundaries rather than one giant change.

### Plan A: compact execution completion

Owns project-transition slot removal, temporary legacy-work dual-write/backfill, equivalence checks, compact legacy-work authority, and removal of recovery's legacy fallback. It must end with legacy work tables still present but unnecessary for correctness.

### Plan B: telemetry, archive, and freeze readiness

Owns normalized telemetry, safe history sanitizers, `ArchiveSink`, archive outbox/exporter, Google Drive adapter, retention modes, global write-freeze controls, legacy history backfill, and retirement readiness receipts. It must not include the destructive drop migration.

### Plan C: destructive retirement

Begins only after Plans A and B have been deployed and observed. Owns physical-absence verification, migration 061, removal of old runtime/backfill scaffolding, contract-evidence regeneration, and final documentation cleanup.

## 10. Static dependency boundary

CI must enforce that correctness code cannot import telemetry/archive modules or name retired history tables.

At minimum, runtime correctness roots under `src/`, `lib/`, `api/`, and `mcp/` are checked for forbidden legacy table identifiers after final retirement. Before the drop, the only allowed references are the explicitly scoped migration/backfill/retention modules.

After migration 061 lands, even those exceptions disappear from runtime code.

The static test complements, but does not replace, the physical-table-absence PostgreSQL tests.

## 11. Failure handling

### Ambiguous legacy backfill

Fail closed and do not flip compact authority for the affected subject. Report the exact subject/source rows that cannot be reduced to one current compact state.

### Dual-write disagreement

Keep the old legacy-work store authoritative and block the authority flip. Do not repair disagreement by selecting whichever side looks newer without deterministic evidence.

### Hidden writer after freeze

The database rejects the write. Retirement readiness is revoked or remains pending until the caller is removed or migrated.

### Archive sink unavailable

Execution continues normally. Export remains failed/pending. In `archive_required` mode, purge and destructive retirement remain blocked.

### Archive digest mismatch

Fail with `ARCHIVE_SOURCE_SET_CHANGED` or `ARCHIVE_DIGEST_CONFLICT`. Do not overwrite the existing archive object and do not purge source telemetry.

### Unresolved operation

Do not freeze an immutable run/cycle archive bundle while any correlated operation is `prepared` or `indeterminate`.

### Stale execution epoch

Reject the mutation or settlement. Never repair stale epoch conflicts by consulting historical lease rows.

## 12. Required verification

The implementation is not complete until all of these are proven.

### Compact project-transition authority

- acquire succeeds with `work_leases` and `work_lease_slots` absent;
- concurrent acquire cannot produce two current authorities;
- reacquisition increments `authority_epoch`;
- stale epoch heartbeat/settlement cannot mutate the newer authority;
- acquire and settle idempotency replay from `operation_state` after the active lease is gone;
- checkpoint, heartbeat, continuation, and no-progress semantics remain unchanged.

### Compact legacy work

- temporary dual-write keeps new legacy mutations equivalent during migration;
- deterministic active-state backfill matches old current authority;
- deterministic continuation backfill matches the next safe action previously derived from history;
- authority is not flipped for a subject with an equivalence mismatch;
- `work.claim`, checkpoint, heartbeat, settle, expiry recovery, and replay work with all four legacy work-lease tables physically absent;
- API response semantics remain compatible for the cutover release;
- stale legacy-work epoch cannot clear a newer lease.

### Recovery and correctness independence

- fresh-process orchestration recovery works after all retiring history tables are physically dropped;
- no correctness module imports telemetry or archive code;
- no correctness SQL names a retired history table;
- an indeterminate operation survives restart and remains recovery-authoritative;
- exact-revision proof X cannot satisfy revision Y.

### Telemetry and archive

- every legacy source row is either normalized or fails backfill with an explicit safe reason;
- backfill is idempotent;
- repeated export produces the same source-set and bundle digests;
- archive digest is provider-independent;
- same bundle ID plus different digest fails closed;
- secret-bearing fields are absent from telemetry and archive fixtures;
- archive failure blocks purge only;
- unresolved operations prevent bundle freezing;
- `ttl_only` permits TTL purge without a sink only when that retention mode is durably configured;
- `archive_required` blocks purge and legacy retirement until confirmation exists.

### Retirement gate

- fresh empty installs can apply the destructive migration without fake archive work;
- populated installs cannot apply it before global freeze/backfill/retention readiness;
- a write attempt after freeze fails;
- source counts are stable between readiness receipt and destructive migration;
- the full core suite passes with the retirement-set tables physically absent;
- contract evidence is regenerated and the unclassified-debt ratchet remains green.

### Scheduler conditional gate

If `scheduled_cycle_events` is included in the destructive migration, scheduled-cycle completeness classifications must be byte-for-byte equivalent when driven from `telemetry_events` with `scheduled_cycle_events` physically absent.

## 13. Rollout and rollback

Before destructive migration, rollback is ordinary code rollback because legacy tables still exist. During Plan A dual-write, the old legacy-work store remains authoritative until equivalence is proven and the authority flip occurs.

After compact authority flips, rollback must preserve the compact rows written during the cutover. The old tables are no longer assumed complete, so rollback may restore code only if that code can continue from compact state rather than treating legacy history as newly authoritative.

After destructive migration, rollback must not depend on recreating historical tables. The compact schema is the forward authority. Historical diagnostics are recovered from retained telemetry/archive, not restored into correctness tables.

For this reason the destructive migration is intentionally a one-way boundary and must not be included in the same deploy that first introduces compact legacy-work writers or the archive sink.

The operational rollout should therefore include distinct observed deployments:

1. a dual-write/backfill deployment where legacy work remains authoritative and equivalence is measured;
2. a compact-authoritative deployment where old writers are removed, telemetry/archive operates, and legacy tables are globally frozen but still present;
3. only then, a destructive-retirement deployment.

## 14. Success criteria

The retirement is successful when a fresh Overcenter process can perform normal project execution, lower-level work compatibility, deterministic recovery, mutation replay, and exact-revision verification using only fresh external authority plus the compact kernel tables, while the old history tables do not exist.

At that point the database schema tells the same story as the product:

Reasoning agents make judgments. Compact deterministic software owns execution truth. Historical detail is telemetry, not authority.
