# Legacy Execution History Retirement Design

Status: Approved for implementation planning
Date: 2026-09-02
Base: `dev` after compact execution state and epoch fencing (#443)

## Summary

Overcenter now has a compact correctness kernel built around `orchestration_runs`, `execution_state`, `operation_state`, and `proof_state`. The remaining problem is not absence of compact state. It is that old execution-history tables still participate in live execution, recovery-adjacent maintenance, diagnostics, and retention.

This design retires that substrate in three ordered deployment boundaries:

1. **Compact execution completion.** Make compact state the sole correctness substrate for project-transition execution, legacy `work.*` compatibility, live-run lease checks, and current horizon recovery.
2. **Telemetry, archive, and freeze readiness.** Normalize safe history into bounded TTL telemetry, optionally archive immutable provider-neutral bundles, install database write-freeze guards, and produce deterministic retirement readiness.
3. **Destructive retirement.** Recheck readiness and freeze enforcement, prove the core suite with old tables absent, drop exactly the approved history tables, and delete obsolete runtime/migration scaffolding.

The destructive boundary is deliberately last. Populated deployments cannot drop legacy history until deterministic backfill and configured retention requirements are satisfied. Fresh installations with no legacy rows can pass the same gate without manufacturing archive objects.

## Governing rule

A fresh Overcenter process, given fresh external authority plus compact current state, must be able to decide exactly what may safely happen next without querying historical runs, leases, slots, checkpoints, heartbeats, command journals, horizons, scheduled-cycle chronology, or specialized receipt tables.

Historical data may support diagnostics, analytics, audit, and operator investigation. It may never authorize execution, settlement, retry, recovery, proof satisfaction, mutation reconciliation, live-run terminalization, or selection of the next safe project action.

## Compact correctness boundary

Correctness may use only:

- fresh authoritative provider reads;
- `orchestration_runs` bounded current/terminal state;
- `execution_state` current execution authority;
- `operation_state` idempotency, mutation certainty, and unresolved operation state;
- `proof_state` exact-revision predicates.

The dependency direction is one-way:

```text
fresh authority
      |
      v
+----------------------+
| compact correctness  |
|----------------------|
| orchestration_runs   |
| execution_state      |
| operation_state      |
| proof_state          |
+----------------------+
      |
      | observability only
      v
+----------------------+
| telemetry_events     |
+----------------------+
      |
      v
+----------------------+
| canonical archive    |
+----------------------+
      |
      v
   ArchiveSink
```

Correctness may emit telemetry. Telemetry and archive code may inspect compact state only to label or retain evidence. Correctness may not read telemetry, archive exports, an archive provider, or retirement-control state to decide whether execution is allowed.

## 1. Compact execution completion

### Project-transition authority

For each project transition, `execution_state.subject_key` is the exclusivity slot and current-authority row. Acquisition atomically:

1. locks or creates the canonical subject row;
2. rejects a live existing lease;
3. increments `authority_epoch`;
4. installs the exact repository/revision/graph/transition coordinates and expiry bounds;
5. prepares or replays the acquisition `operation_state` identity;
6. returns the receipt for the exact installed epoch.

No `work_leases` or `work_lease_slots` row is required.

Checkpoint, heartbeat, settlement, invalidation, and expiry recovery fence on current `subject_key + lease_ref + authority_epoch`. A stale process cannot mutate or clear a newer epoch.

### Legacy `work.*` compatibility

The lower-level `api/work/{claim,checkpoint,heartbeat,settle}` surface remains available through the retirement. Its storage implementation moves to compact state so SQL retirement is independent of later API deprecation.

Canonical legacy subject identity is:

`legacy_work:<work_ref>:<gate>`

`execution_state` stores explicit `work_ref` and `gate` coordinates. Migration uses a temporary old-authoritative/compact-dual-write phase, deterministic backfill, and old-vs-compact equivalence checking. Compact state becomes authoritative only after equivalence passes. The dual-write is then removed.

### Live-run lease checks

`orchestration_runs` maintenance and finish logic must not ask `work_leases` or `work_lease_slots` whether a run still owns execution authority. Current live authority is derived from `execution_state` by exact `run_id`, `lease_ref`, `authority_epoch`, and expiry.

Old journal reconciliation is not a fallback for unresolved execution. `operation_state` owns unresolved `prepared` and `indeterminate` effects.

### Current horizon, not horizon history

`orchestration_horizons` cannot remain a correctness dependency because a historical candidate list must not determine the next safe project action.

The bounded current horizon belongs on `orchestration_runs`:

- `current_horizon jsonb`;
- `current_horizon_sha256 text`;
- `current_horizon_generation integer`.

The projection is bounded by the existing maximum horizon size. `checkpointHorizon` replaces the current projection atomically. `resolveHorizon` reads only the current run or predecessor run projection and revalidates every candidate against fresh authority before returning it. Historical horizon rows become retention inputs only.

## 2. Explicit TTL telemetry

All non-authoritative historical observability converges on one table, `telemetry_events`.

Each event contains:

- `event_id`;
- schema version `overcenter-telemetry-v1`;
- `source_kind` and stable `source_id`;
- archive subject kind/id;
- event kind and occurred timestamp;
- bounded canonical payload;
- `payload_sha256`;
- `expires_at`;
- creation timestamp.

`(source_kind, source_id)` is unique. Runtime payloads are limited to 16 KiB of canonical JSON. The default TTL is 30 days and is deployment-configurable.

Telemetry failure is always non-authoritative and cannot change a semantic command result.

## 3. Required-check observation state

`github_required_check_observations` currently contains state that influences whether a missing required check has been observed long enough to be treated as a real delivery failure. That state cannot move to telemetry because it affects a safety decision.

The current exact-head observation lives in `proof_state` instead:

- subject key identifies repository, pull request, and required context;
- predicate kind is the required-check missing-observation predicate;
- authority repository is the repository;
- authority revision is the exact head SHA;
- the one unconsumed proof contains bounded first/last observation timestamps and count in its evidence projection.

Updating an observation consumes the prior exact-head proof and creates the next proof state under a deterministic unique proof key. Clearing an observed context consumes its current proof. Superseded heads cannot satisfy the current head.

Historical observation events may also be emitted to telemetry, but telemetry is never read by required-check correctness.

## 4. Retiring source registry

The retirement backfill has exactly 14 explicit sources. There is no generic catch-all sanitizer.

1. `orchestration_invocation_resolutions`
2. `orchestration_horizons`
3. `work_lease_slots`
4. `work_lease_checkpoints`
5. `work_lease_heartbeats`
6. `work_leases`
7. `github_changeset_receipts`
8. `github_release_receipts`
9. `github_production_promotion_receipts`
10. `portfolio_reconcile_receipts`
11. `portfolio_verification_receipts`
12. `github_required_check_observations`
13. `scheduled_cycle_events`
14. `orchestration_command_invocations`

Every source has a source-specific projection. A sanitizer may explicitly pick safe bounded fields or reject the row with deterministic safe evidence. It may never forward an arbitrary row object.

Telemetry/archive payloads exclude lease/capability tokens, credentials, authorization headers, raw prompts, secret environment values, unrestricted provider bodies, copied source blobs, and unbounded request content.

## 5. Scheduled-cycle diagnostics

`scheduled_cycle_events` is diagnostic chronology, not execution authority. Before it can be retired, `lib/scheduled-cycle-completeness.js` must produce byte-for-byte equivalent normalized classifications from `telemetry_events` while `scheduled_cycle_events` is physically absent.

If that equivalence gate is not green, `scheduled_cycle_events` is excluded from the destructive migration and receives a later independent retirement. The active implementation plan requires the gate to be green before migration 063 is written with all 14 tables.

## 6. Provider-neutral archive

Canonical archive schema is `overcenter-archive-v1`.

A canonical artifact contains provider-independent subject coordinates, source cutoff, source-set digest, ordered safe telemetry records, and SHA-256 over exact canonical bytes. The same source set must produce the same bytes and digest regardless of sink.

Normal bundles are immutable and subject-scoped:

- one logical bundle per completed run;
- one logical bundle per scheduler-only cycle with telemetry;
- no run/cycle bundle freezes while any correlated operation is `prepared` or `indeterminate`, or while `orchestration_runs.unresolved_operation_id` is non-null.

Truly uncorrelated migration history may be assigned only after global freeze as deterministic `legacy_unscoped:<source_kind>:<UTC-month>:<chunk-index>` bundles, at most 1,000 events per chunk in stable source order.

### Archive port

`ArchiveSink.put(CanonicalArchiveArtifact) -> ArchiveReceipt`

`telemetry_archive_exports` is the durable outbox keyed by `(bundle_id, sink_id)`. It stores coordinates, source cutoff, source-set digest, bundle digest, state, attempt metadata, bounded error, provider reference, and confirmation timestamps. It does not store a second full bundle copy.

Retry rebuilds the exact source set. Changed source or bundle digest fails closed with `ARCHIVE_SOURCE_SET_CHANGED`.

Google Drive is the first concrete adapter for the intended deployment, but authentication, folder identity, resumable-session details, and provider response fields never enter the canonical artifact.

## 7. Retention and database-enforced freeze

Retention modes are exactly:

- `ttl_only`
- `archive_required`

The intended Overcenter deployment uses `archive_required`.

Archive configuration changes purge/retirement eligibility only. It never changes execution correctness.

### Retirement control

`legacy_history_retirement_control` durably records:

- canonical control key `legacy_execution_history_v1`;
- retention mode;
- freeze state/timestamp;
- exact per-source counts and aggregate source digest;
- telemetry backfill state/digest;
- archive readiness state/digest;
- destructive readiness state;
- bounded blocking reason;
- timestamps.

### Mechanical write freeze

Migration 062 installs `prevent_frozen_legacy_history_write()` plus one `BEFORE INSERT OR UPDATE OR DELETE` trigger on each of the 14 retiring source tables.

When the control row is not frozen, the trigger permits the write. When `freeze_state='frozen'`, every legacy mutation raises a deterministic `LEGACY_HISTORY_FROZEN` database error. Hidden writers therefore fail loudly during the observation window.

Freeze is permitted only after Plan A has made compact state authoritative and known runtime legacy writers are disabled. The freeze operation records the exact source census. Readiness recomputes that census and fails `LEGACY_HISTORY_CHANGED_AFTER_FREEZE` on any mismatch.

The destructive migration must independently verify that all 14 freeze triggers still exist and are enabled. A readiness bit by itself is insufficient.

## 8. Destructive retirement set

Migration 063 may drop exactly these 14 tables:

- `orchestration_invocation_resolutions`
- `orchestration_horizons`
- `work_lease_slots`
- `work_lease_checkpoints`
- `work_lease_heartbeats`
- `work_leases`
- `github_changeset_receipts`
- `github_release_receipts`
- `github_production_promotion_receipts`
- `portfolio_reconcile_receipts`
- `portfolio_verification_receipts`
- `github_required_check_observations`
- `scheduled_cycle_events`
- `orchestration_command_invocations`

It retains:

- `orchestration_runs`
- `execution_state`
- `operation_state`
- `proof_state`
- `telemetry_events`
- `telemetry_archive_exports`
- `legacy_history_retirement_control`
- current repository/configuration tables.

It may also remove obsolete columns/constraints whose only purpose was to point at retired history, such as `orchestration_runs.latest_horizon_id`, after current-horizon replacement is proven. It may not drop any additional table.

The migration does not use wildcard discovery or unreviewed `CASCADE`. Unexpected dependencies fail closed.

## 9. Migration sequence

As of the 2026-09-02 current `dev` head, migrations 057 and 058 are occupied by compact-kernel follow-ups and `059_*` is free. The planned sequence is:

1. `059_compact_execution_authority_completion.sql`
   - add legacy-work coordinates to `execution_state`;
   - add bounded current-horizon fields to `orchestration_runs`.
2. `060_telemetry_events.sql`
   - create bounded TTL telemetry storage.
3. `061_telemetry_archive_exports.sql`
   - create provider-neutral archive outbox state.
4. `062_legacy_history_retirement_control.sql`
   - create retention/readiness control and the 14 mechanical write-freeze triggers.
5. `063_retire_obsolete_execution_history.sql`
   - fail closed unless empty-history or populated readiness rules pass;
   - verify source census and freeze guards;
   - drop the approved 14-table set;
   - remove temporary freeze triggers/functions and obsolete history pointers.

Immediately before implementation, re-read `migrations/`. If `059` has become occupied, renumber the entire new 059–063 sequence together before the first migration commit. Never create a second overlapping numbering sequence.

## 10. Runtime rollout

### Deployment A1: dual-write and equivalence

- add migration 059;
- make project-transition authority compact-only;
- add temporary compact dual-write for legacy `work.*` while old storage remains authoritative;
- backfill current legacy-work state;
- compare old and compact derivations;
- move live-run lease checks and current horizons onto compact state.

### Deployment A2: compact authority

- require equivalence for every current legacy-work subject;
- make compact state authoritative for legacy work;
- remove legacy dual-write;
- remove legacy lease/journal recovery fallbacks;
- prove project transition and legacy work with all four work-lease tables absent.

### Deployment B: telemetry/archive/freeze readiness

- create telemetry and archive storage;
- redirect command/history observability;
- move required-check current observation state to `proof_state`;
- migrate scheduled-cycle diagnostics to telemetry;
- backfill every safe legacy source;
- export immutable archive bundles when required;
- enable database freeze;
- operate through a full maintenance window with all 14 legacy tables write-protected;
- produce deterministic retirement readiness.

### Deployment C: destructive retirement

- independently recheck readiness, source census, archive confirmation when required, and all 14 freeze guards;
- run populated and empty migration tests;
- apply migration 063;
- delete obsolete legacy persistence, backfill, and semantic-journal-resolution machinery;
- add permanent retired-table poison scanning;
- regenerate contract evidence and public architecture docs;
- run exact-head canonical verification.

## 11. Failure handling

- **Ambiguous legacy backfill:** fail closed; do not flip the affected subject.
- **Dual-write disagreement:** keep old legacy work authoritative until fixed deterministically.
- **Stale epoch:** reject; never consult historical leases to repair.
- **Hidden writer after freeze:** database rejects the write; readiness remains/reverts pending.
- **Archive unavailable:** execution continues; purge/retirement blocks only in `archive_required`.
- **Archive digest mismatch:** fail closed; do not overwrite the existing object and do not purge source telemetry.
- **Unresolved operation:** do not freeze the correlated immutable bundle.
- **Scheduled-cycle classification drift:** exclude `scheduled_cycle_events` from the destructive set until equivalence is restored.

## 12. Required verification

The retirement is incomplete until all of these hold:

- project-transition acquire/checkpoint/heartbeat/settle/replay works without `work_leases` or `work_lease_slots`;
- legacy work claim/checkpoint/heartbeat/settle/reacquire works without all four work-lease tables;
- stale epochs cannot mutate newer authority;
- live-run terminalization checks `execution_state`, not old leases;
- current horizon recovery uses bounded `orchestration_runs` state plus fresh authority, not `orchestration_horizons`;
- indeterminate operations survive restart and remain authoritative;
- exact-revision proof X cannot satisfy revision Y;
- required-check observation safety works from exact-head `proof_state` with the old observation table absent;
- every legacy source row is normalized or blocks with safe deterministic rejection evidence;
- telemetry failure does not alter semantic command results;
- scheduled-cycle classification is equivalent with the old event table absent;
- archive bytes/digests are provider-independent and retry-stable;
- unresolved operations prevent bundle freeze;
- all 14 post-freeze direct INSERT/UPDATE/DELETE attempts are rejected by database guards;
- the frozen source census remains unchanged through the observation window;
- a fresh empty install can retire without fake archive work;
- a populated install cannot retire before configured retention readiness;
- the full core suite passes with all 14 retiring tables physically absent;
- production correctness code contains no retired table identifiers or telemetry/archive authority imports;
- contract evidence and public docs match the final schema.

## Success criterion

The database tells the same story as the product when a fresh Overcenter process can execute, recover, replay, verify exact revisions, and expose lower-level work compatibility using only fresh authority plus compact kernel state while the old execution-history tables do not exist.

Historical detail remains useful, but only as telemetry and archive evidence. It is no longer execution truth.
