# Compact Execution State and Telemetry Archive Design

**Date:** 2026-09-01  
**Status:** Approved design  
**Scope:** execution correctness state, recovery state, evidence compaction, telemetry retention, and optional provider-neutral archival

## 1. Decision

Overcenter will stop treating long-lived execution history as a correctness substrate.

The durable kernel will retain only the minimum state that can change a future safety decision:

- `orchestration_runs` for current run state and compact terminal run summaries;
- `execution_state` for current execution authority, fencing epoch, resumable checkpoint, and continuation head;
- `operation_state` for idempotency, mutation certainty, unresolved effects, and compact terminal effect tombstones;
- `proof_state` for exact-revision safety predicates and verification facts.

Historical journals, horizons, heartbeat chronology, superseded checkpoints, settled lease history, scheduler chronology, and similar execution detail become **non-authoritative telemetry** with a bounded TTL.

A deployment may additionally configure an **archive sink**. When archival is configured, telemetry is not purge-eligible until the exact canonical archive bundle has been durably confirmed by the configured sink. Archive availability never participates in execution correctness, settlement, recovery, idempotency, leasing, or verification.

The archive contract is provider-neutral. Google Drive may be used by one deployment because it is convenient; S3-compatible object storage, filesystem storage, or another provider may implement the same port without changing semantic kernel behavior.

The governing rule is:

> Historical state deserves durable operational storage only while it can change a future safety decision. Historical detail that no longer affects safety is telemetry, and telemetry may be archived before TTL deletion.

## 2. Context

Overcenter currently retains substantial append-oriented history across orchestration journals, runs, horizons, leases, checkpoints, heartbeats, scheduler events, mutation receipts, reconciliation receipts, and verification receipts. Some of these records began as observability or evidence but later became convenient inputs to recovery and continuation logic.

That convenience has an architectural cost. A fresh process can need to search historical rows to answer a present-tense question such as:

- who currently owns execution authority;
- what continuation packet is current;
- whether no-progress protection should fire;
- whether an idempotent operation already produced an effect;
- whether an external mutation remains indeterminate;
- whether an exact revision satisfies a required verification predicate.

A correctness path that answers current questions by rummaging through old events is accidental event sourcing. It makes retention policy dangerous, keeps obsolete persistence concepts alive, and forces agents and operators to reconstruct stories that deterministic software can represent directly.

The accepted TypeScript semantic-kernel direction already identifies execution authority, leases, and runs as the next high-value semantic island. Since the 2026-09-01 runtime artifact change, authoritative runtime-bearing TypeScript is compiled into `dist/`; tracked `lib/` files are compatibility mirrors only where still required. This design follows that boundary.

This design also intentionally revises two older assumptions:

1. `execution-evidence-v1` currently defines evidence as a deterministic historical projection over runs, leases, checkpoints, journal invocations, settlements, and recoveries. The new model separates **current proof** from **historical trace**.
2. The recovery-kernel design currently names journals, checkpoints, and domain receipts as part of the canonical recovery substrate. The new model preserves their safety-relevant semantics in compact current state and makes the remaining chronology non-authoritative telemetry.

## 3. Goals

1. Make future safety decisions depend only on fresh external authority plus compact Overcenter state.
2. Eliminate correctness dependencies on historical telemetry.
3. Add an explicit fencing epoch so stale execution authority is rejected even after lease expiry or process resurrection.
4. Replace continuation reconstruction from historical leases with one current continuation head.
5. Replace broad receipt families with one operation state model for idempotency and mutation certainty where semantics are genuinely shared.
6. Preserve exact-revision verification facts without retaining arbitrary observation history.
7. Keep useful debugging chronology for a configurable TTL.
8. Allow users to preserve long-term history outside the operational database using a provider-neutral archive contract.
9. Make archival fail closed for **purge only** when configured.
10. Preserve enough canonical history to backfill the existing Overcenter history before destructive migration.
11. Reduce the number of concepts in the kernel, not merely the number of database rows.

## 4. Non-goals

- No generic event-sourcing framework.
- No second project authority.
- No archive-backed recovery.
- No requirement that an archive provider be online for execution to finish.
- No provider-specific archive semantics in the semantic kernel.
- No blanket JavaScript-to-TypeScript conversion.
- No generic schema framework or workflow DSL.
- No permanent retention of raw prompts, credentials, lease capability material, or arbitrary provider responses.
- No simultaneous implementation requirement for every possible archive provider.
- No destructive production purge before compact-state equivalence and archive backfill are proven.

## 5. Authority model

### 5.1 External authorities

GitHub and other configured external providers remain authoritative for their own current state. Exact external revisions are read fresh whenever a safety decision requires them.

### 5.2 Overcenter correctness authority

Overcenter is authoritative for:

- current run status and bounded terminal run summaries;
- current execution ownership and fencing epoch;
- current continuation state;
- idempotency identities;
- mutation certainty and unresolved effects;
- compact terminal effect identities;
- exact-revision proof facts;
- current repository configuration owned by Overcenter.

### 5.3 Telemetry

Telemetry is diagnostic chronology. It may explain how Overcenter reached a state but must never be required to decide what may safely happen next.

### 5.4 Archive

The archive is a user-owned forensic copy of telemetry and compact terminal evidence. It is not an execution authority and is never read by recovery, `project.advance`, settlement, promotion, mutation retry, or proof evaluation.

The architectural dependency is one-way:

```text
correctness state -----> archive bundle construction
telemetry -------------> archive bundle construction

archive state      -X-> correctness decisions
telemetry          -X-> correctness decisions
```

## 6. Compact durable state

### 6.1 `orchestration_runs`

Reuse the existing run table instead of introducing a parallel `run_state` table.

An active run retains the bounded data needed to execute safely, including target/scope identities, deadline, mode, current subject pointer, and unresolved-operation pointer where applicable.

When a run becomes terminal, it compacts in place to a bounded summary. The terminal form keeps identifiers and hashes needed for correlation and proof but drops recovery detail that has become telemetry.

Representative terminal fields:

```text
run_id
worker
mode
status = finished
started_at
finished_at
disposition
target_sha256
scope_sha256
final_effect_refs
final_evidence_sha256
```

The exact migration may reuse existing columns where they already encode these facts.

### 6.2 `execution_state`

`execution_state` is one mutable row per execution subject. Project transitions are the primary subject type; the shape may also support remaining legacy work identities while migration is incomplete.

Representative fields:

```text
subject_key                         primary key
subject_kind
project_ref                         nullable
transition_id                       nullable

authority_epoch                    bigint not null
lease_ref                           nullable unique
run_id                              nullable

authority_repository               nullable
authority_revision                 nullable
graph_fingerprint                  nullable
transition_revision_fingerprint    nullable
transition_dependency_fingerprint  nullable

expires_at                          nullable
hard_expires_at                     nullable
active_capability_material         nullable

checkpoint                          json nullable
checkpoint_sha256                   nullable
recent_progress_sha256              bounded pair
heartbeat_count                     integer
last_heartbeat_at                   nullable

continuation                        json nullable
continuation_sha256                 nullable
continuation_execution_fingerprint nullable
no_progress_streak                  integer not null default 0

updated_at
```

#### Fencing epoch

Every successful acquisition increments `authority_epoch`. Every effecting operation authorized through execution authority carries or internally binds:

```text
subject_key
authority_epoch
authority_revision
```

A stale process holding an older epoch is rejected before mutation, even if its previous lease token still exists in memory.

The row survives terminal settlement with lease-specific fields cleared so the epoch cannot reset on reacquisition.

#### Checkpoint and heartbeat compaction

Only the latest resumable checkpoint remains correctness state.

Heartbeat chronology is not retained for correctness. The current state keeps only the bounded information required by liveness policy, including the last two progress hashes where current no-progress protection requires that window.

#### Continuation head

Continuation becomes an explicit current fact instead of a derived fact obtained by scanning historical settled/expired leases.

Settlement or recovery atomically updates:

- current continuation packet;
- continuation digest;
- execution fingerprint against which it is valid;
- source lease/run references where useful;
- `no_progress_streak`.

Future acquisition reads this row directly.

### 6.3 `operation_state`

`operation_state` represents one semantically idempotent operation and its mutation certainty.

Representative fields:

```text
operation_id                 primary key
command
subject_key                  nullable
run_id                       nullable

idempotency_key
request_sha256

state
  prepared
  indeterminate
  succeeded
  no_effect
  rejected

lease_epoch                  nullable
authority_revision           nullable

may_have_mutated
effect_kind                  nullable
effect_ref                   nullable
effect_sha256                nullable
result_sha256                nullable

recovery_payload             json nullable
resolution                   json nullable

created_at
resolved_at                  nullable
```

Semantics:

- same idempotency identity plus same canonical request hash replays the proven result;
- same idempotency identity plus a different request hash fails closed;
- `indeterminate` state is never garbage-collected until externally resolved;
- unresolved operations retain the bounded recovery material needed to reconcile safely;
- after success or proven no-effect, the record compacts to a tombstone containing only the identity, request digest, outcome, effect identity, result/evidence digest, and applicable authority fence;
- full request/result payloads and intermediate attempt history become telemetry.

This model is intended to subsume specialized idempotency ledgers where they implement the same semantics, including GitHub changeset, release, promotion, and portfolio reconciliation receipts. Provider-specific mutation implementations remain; only duplicated persistence semantics are removed.

### 6.4 `proof_state`

`proof_state` stores current exact-revision safety predicates.

Representative fields:

```text
proof_key                     primary key
subject_key
predicate_kind

authority_repository
authority_revision

evidence_sha256
evidence_refs                 json

satisfied_at
consumed_at                   nullable
```

Examples include:

- exact SHA passed required verification;
- required checks are satisfied for exact head SHA;
- a candidate revision is promotable;
- release preflight passed for an exact revision.

Proofs do not become provider authority. A proof for revision X cannot satisfy a predicate for revision Y. Superseded proofs may be deleted or marked consumed according to the consuming semantic contract.

### 6.5 Current configuration

Repository disposition, repository identity, branch roles, and current external-work mappings remain mutable current configuration. They are not part of historical telemetry and need not be folded into the four execution-state concepts.

## 7. Telemetry boundary

The following classes become non-authoritative telemetry once all correctness consumers have been cut over:

- command invocation chronology beyond compact operation state;
- historical horizons;
- historical heartbeat events;
- superseded checkpoints;
- settled and expired lease chronology beyond current continuation and compact terminal refs;
- closed scheduled-cycle events;
- intermediate recovery diagnostics;
- historical required-check observations once their revision is obsolete;
- full successful mutation request/result projections after compact tombstones exist;
- other execution timing and diagnostic events that do not affect a future safety decision.

Default retention is TTL-based. The specific default TTL is operational configuration rather than a semantic constant. A reasonable initial deployment default is 30 days.

### Hard invariant

> No correctness path may query telemetry.

This must be enforced in tests and module boundaries, not merely documented as convention.

`project.advance`, recovery, resumption, work acquisition, heartbeat authorization, settlement, GitHub mutation retry, production promotion, and verification must depend only on:

1. fresh authoritative reads;
2. compact correctness state;
3. unresolved operation state;
4. exact-revision proofs.

## 8. Provider-neutral archive

### 8.1 Purpose

Archival preserves user-owned historical detail after it ceases to belong in the operational database.

Archival is optional. When disabled, TTL expiry alone can make telemetry purge-eligible. When enabled, archival confirmation becomes an additional purge precondition.

### 8.2 Canonical archive format

The supported archive representation is a versioned provider-neutral format named `overcenter-archive-v1`.

The format is canonical JSON with a deterministic byte representation and SHA-256 content digest. Compression is a transport/storage choice and does not change semantic bundle identity.

Each normal runtime bundle represents one completed run or one scheduler-only cycle.

Representative top-level shape:

```json
{
  "schema": "overcenter-archive-v1",
  "bundle_id": "...",
  "kind": "run | scheduled_cycle",
  "subject_id": "...",
  "created_at": "...",
  "source_revision": "...",
  "terminal_summary": {},
  "telemetry_records": [],
  "operation_refs": [],
  "proof_refs": [],
  "authority_refs": [],
  "content_sha256": "..."
}
```

`content_sha256` is computed over the canonical bundle representation according to a contract that avoids self-referential hashing, for example a digest over the canonical document with the digest field omitted.

### 8.3 Canonical telemetry record envelope

Each archived telemetry item uses a bounded normalized envelope:

```text
record_type
record_id
occurred_at
run_id                nullable
subject_key           nullable
command               nullable
outcome               nullable
may_have_mutated      nullable
payload               bounded + redacted
payload_sha256
```

The archive format preserves raw record detail only inside bounded, explicitly admitted payload fields. It does not serialize arbitrary database rows wholesale.

### 8.4 Secret exclusion

The archive must never contain:

- lease tokens or capability secrets;
- credentials or API tokens;
- raw prompts unless a future explicit opt-in design establishes a safe separate product;
- secret-bearing environment values;
- arbitrary provider response bodies;
- copied repository source blobs merely because they were observed;
- unrestricted request bodies.

Redaction is centralized and tested. Archive generation reuses the same bounded-evidence principles as current semantic projections rather than maintaining a competing secret list where possible.

### 8.5 Immutable logical bundle

A completed bundle is immutable and content-addressed.

Retrying an export of the same `bundle_id` must reproduce the same `bundle_sha256`. A different digest for the same logical bundle fails closed as a data-integrity error.

The provider adapter may deduplicate storage physically, but provider paths and folder structures are not semantic identifiers.

### 8.6 Archive sink port

The semantic archive contract is independent of provider APIs. A narrow port is sufficient:

```ts
interface ArchiveSink {
  put(bundle: ArchiveBundle): Promise<ArchiveReceipt>;
}
```

A successful `put` means the adapter has durably written the exact bundle and verified or otherwise obtained provider acknowledgement sufficient to bind the provider reference to the bundle digest.

Representative receipt:

```text
sink_id
bundle_id
bundle_sha256
provider_ref
confirmed_at
```

The adapter owns provider-specific layout, authentication, retries that are safe inside one call, multipart behavior, and confirmation mechanics.

Potential adapters include:

- Google Drive;
- S3 or S3-compatible object storage;
- filesystem/object-directory storage;
- future storage providers.

The first operational provider may be Google Drive for deployment convenience. That choice must not alter the port or canonical bundle format. S3-compatible storage remains a first-class expected adapter target.

### 8.7 Archive export outbox

Archive delivery is asynchronous with respect to execution completion and durable with respect to retention.

Add one retention bookkeeping table, conceptually `telemetry_archive_exports`:

```text
bundle_id
bundle_sha256
schema_version
subject_kind
subject_id
sink_id
state                pending | exporting | confirmed | failed
attempt_count
last_error            nullable
provider_ref          nullable
prepared_at
confirmed_at          nullable
updated_at
```

The natural key is `(bundle_id, sink_id)`.

This table is not part of the execution correctness model. Its only authority is whether telemetry is safe to purge under configured retention policy.

The prepared state should retain enough immutable source identity to reproduce and verify the same canonical bytes without copying the whole telemetry payload into a second operational table. A manifest or source-set digest may be used for this purpose. If reconstruction under the pinned archive schema produces a different digest, export fails closed and purge remains blocked.

### 8.8 Purge rule

If no archive sink is configured:

```text
TTL expired
=> purge eligible
```

If a required archive sink is configured:

```text
TTL expired
AND archive export confirmed for exact bundle digest
=> purge eligible
```

Archive failure affects retention only. It must not:

- reopen a completed run;
- block settlement;
- block work acquisition;
- change mutation certainty;
- change proof satisfaction;
- prevent deterministic recovery;
- cause a semantic work item to be marked blocked.

A failed archive export instead creates retention debt and operator-visible degraded health.

### 8.9 Archive health

The health surface should eventually expose a non-blocking retention invariant such as:

```text
retention.archive_backlog
```

It reports pending/failed bundle counts and oldest unconfirmed age. Severity may become `degraded` when policy thresholds are exceeded, but it is not an execution quarantine condition.

## 9. Archive unit and historical backfill

### 9.1 Ongoing operation

The normal archive unit is one immutable bundle per completed run or scheduler-only cycle.

This unit gives deterministic identity, straightforward retries, and a useful forensic boundary while remaining equally representable as a Drive file, S3 object, filesystem object, or another provider artifact.

### 9.2 Existing history

Before old operational history is deleted, existing historical records must be backfilled into canonical archive bundles when archival is configured for the migration.

Legacy records should be correlated into completed run or scheduler-cycle bundles wherever durable identifiers permit.

If genuinely unscoped legacy records cannot be truthfully attached to a run/cycle, the one-time migration may emit deterministic `legacy_unscoped` migration bundles. These bundles exist only to preserve historical material that predates the new correlation discipline; normal runtime code does not emit them.

Backfill completion is a destructive-migration gate for deployments that require archival preservation.

## 10. Execution and archive data flow

```text
                 GitHub / external authority
                          |
                          v
                    fresh evaluation
                          |
             +------------+-------------+
             |                          |
     orchestration_runs          execution_state
                                        |
                              +---------+---------+
                              |                   |
                         authority          continuation
                              |
                              v
                       operation_state
                              |
                              v
                          proof_state

                 EXECUTION CORRECTNESS
                          |
                          | terminal projections
                          v
                 short-lived telemetry
                          |
                          v
                   archive exporter
                          |
                 overcenter-archive-v1
                          |
                    ArchiveSink port
                  /          |          \
              Drive          S3       filesystem
                  \          |          /
                   confirmed receipt
                          |
                          v
                TTL purge becomes eligible
```

## 11. Atomicity requirements

### 11.1 Settlement

A successful settlement must atomically establish the future-safe state before old history is disposable.

Conceptually:

```text
CONFIRM fresh authority
        |
        +-- update continuation head
        +-- record/compact operation state
        +-- clear active lease authority
        +-- finalize run pointer/state as applicable
              ^
          one transaction
```

Telemetry emission may occur within or after this transaction according to reliability needs, but correctness cannot depend on a later telemetry write.

### 11.2 Operation resolution

An indeterminate operation may compact only after authoritative reconciliation proves either the external effect or its absence. Until then, the unresolved state is durable and non-purgeable.

### 11.3 Archive export

Archive export is deliberately not in the settlement transaction. A provider outage must not widen the execution transaction boundary.

## 12. Error semantics

### 12.1 Execution errors

Execution errors follow existing fail-closed mutation and authority rules. They affect execution correctness.

### 12.2 Telemetry errors

Telemetry failures affect diagnostics only. A correctness transition that has durably committed must not be rolled back because a diagnostic event could not be written.

### 12.3 Archive errors

Archive failures affect retention only.

Exporter behavior:

1. prepare or load a deterministic pending bundle identity;
2. reconstruct canonical bytes;
3. verify digest matches the prepared digest;
4. call the configured sink with bounded retry inside the pass;
5. on success, persist provider reference and confirmation;
6. on failure, persist bounded error state and stop for this bundle;
7. later deterministic maintenance retries it.

No reasoning model is required for ordinary retry.

### 12.4 Digest conflicts

The following conditions fail closed for purge:

- same `bundle_id`, different canonical digest;
- provider reports an existing object with incompatible digest;
- reconstructed bytes differ from prepared digest;
- archive schema version required to reconstruct the bundle is unavailable.

These failures do not alter execution truth; they surface as retention-integrity faults requiring operator attention.

## 13. Configuration

Retention and archive configuration should be provider-neutral and should not store provider secrets in semantic state.

Representative configuration:

```text
telemetry.retention.ttl_days = 30
telemetry.archive.enabled = true
telemetry.archive.sink_id = "personal-history"
telemetry.archive.schema = "overcenter-archive-v1"
```

Provider credentials and provider-specific destination settings belong to adapter/runtime configuration.

The initial model requires one configured required sink for purge protection. The storage schema keys exports by sink so future optional fanout does not require redesign, but multi-sink quorum policy is not part of the first implementation.

## 14. Code organization

Authoritative TypeScript follows the existing semantic-kernel and runtime artifact boundary.

Suggested modules, names subject to local conventions discovered during implementation:

```text
src/semantic/
  compact-execution-state.ts
  archive-bundle.ts

src/ports/
  compact-execution-state-store.ts
  archive-sink.ts

src/adapters/postgres/
  compact-execution-state-store.ts
  telemetry-archive-export-store.ts

src/adapters/archive/
  google-drive-archive-sink.ts      # first operational adapter if practical
  filesystem-archive-sink.ts        # useful conformance/test adapter
  s3-archive-sink.ts                # expected provider, not required for first cutover

src/runtime/
  telemetry-archive-exporter.ts
  telemetry-retention.ts
```

Runtime-bearing TypeScript compiles into `dist/` according to the current repository artifact boundary. `lib/` compatibility mirrors are retained only where existing runtime compatibility still requires them and should not become a second hand-maintained implementation.

Avoid proliferating tiny state services. The objective is fewer kernel concepts and fewer persistence paths.

## 15. Migration strategy

The migration is staged so deletion cannot outrun proof.

### Stage 1: Add compact state

- add semantic types and invariants;
- add `execution_state`, `operation_state`, and `proof_state` migrations;
- reshape/reuse `orchestration_runs` where needed;
- add Postgres ports/adapters;
- add authority epoch fencing.

No existing history is deleted.

### Stage 2: Dual write and equivalence

- dual-write compact state alongside existing persistence;
- compare old and compact next-action decisions continuously in tests and controlled runtime paths;
- migrate continuation/no-progress semantics into `execution_state`;
- migrate idempotency/mutation certainty into `operation_state`;
- migrate current verification predicates into `proof_state`.

No correctness read switches until equivalence is demonstrated.

### Stage 3: Cut correctness reads

- recovery/resume read compact state only;
- acquisition/heartbeat/settlement use compact execution state only;
- mutation retry/reconciliation use operation state only;
- promotion/verification use exact-revision proof state;
- correctness modules are forbidden from reading telemetry/history tables.

At this stage the full orchestration test suite must pass with historical tables physically absent from the test schema.

### Stage 4: Add archive and backfill

- add `overcenter-archive-v1` contract;
- add archive sink port and deterministic exporter;
- add archive export outbox;
- add provider conformance tests;
- configure the desired deployment sink, with Google Drive acceptable as the first operational sink;
- backfill existing historical records into canonical bundles;
- verify every required bundle digest at the sink.

### Stage 5: Stop historical writes

- stop writing retired durable history tables for correctness;
- retain only explicit TTL telemetry storage;
- preserve unresolved operations and current compact state indefinitely as required by correctness.

### Stage 6: Purge and drop obsolete structures

A destructive migration may proceed only after:

1. compact-read equivalence is proven;
2. correctness tests pass with history tables absent;
3. no unresolved effect depends on retired storage;
4. configured archive backfill is confirmed for all history targeted for deletion;
5. exact-revision verification passes for the migration head.

Then add forward migrations that compact/migrate required rows and drop obsolete tables. Historical migration files remain in source control.

## 16. Expected table retirement

After migration and verification, the following durable tables should disappear or lose their historical correctness role:

| Current table | Replacement |
| --- | --- |
| `orchestration_command_invocations` | `operation_state` + TTL telemetry |
| `orchestration_invocation_resolutions` | `operation_state.resolution` |
| `orchestration_horizons` | current run state + fresh graph evaluation |
| `work_lease_slots` | `execution_state` |
| historical `work_leases` | `execution_state` + compact operation refs |
| `work_lease_checkpoints` | current checkpoint in `execution_state` |
| `work_lease_heartbeats` | bounded progress fields in `execution_state` + telemetry |
| `github_changeset_receipts` | `operation_state` |
| `github_release_receipts` | `operation_state` |
| `github_production_promotion_receipts` | `operation_state` |
| `portfolio_reconcile_receipts` | `operation_state` |
| `portfolio_verification_receipts` | `proof_state` |
| historical required-check observations | `proof_state` where current, telemetry otherwise |

`scheduled_cycle_events` should be retired only after scheduler correctness is proven independent of its historical rows. Scheduler-only historical detail remains eligible for archive bundles.

## 17. Recovery model after cutover

A fresh recovery decision should conceptually need only:

```text
read current run
      +
read execution_state for active subject
      +
read unresolved operation_state if any
      +
read required proof_state if any
      +
read fresh external authority
      =
safe next action
```

A history query such as:

```sql
ORDER BY created_at DESC LIMIT 20
```

over prior executions to derive current truth is a design failure after cutover.

Fault packets may still include recent telemetry for human diagnosis, but the deterministic recovery decision must remain unchanged if all telemetry rows are deleted.

## 18. Execution evidence after cutover

The existing `execution-evidence-v1` historical transcript model should be superseded rather than silently reinterpreted.

A future `execution-evidence-v2` should answer:

> What can Overcenter prove about this execution now?

Its inputs are:

- compact terminal/current run facts;
- compact operation tombstones and unresolved operations;
- exact-revision proofs;
- current execution authority or terminal authority references;
- bounded fresh external observations when required.

Historical playback, chronology, and detailed forensic trace belong to telemetry/archive products and are explicitly non-authoritative.

## 19. Documentation changes required

Implementation must update or supersede at least:

- `README.md`: durable evidence means minimum sufficient execution truth, not indefinite transcript retention;
- `docs/execution-evidence-v1-design.md`: supersede with `execution-evidence-v2` semantics or mark v1 historical;
- `docs/architecture/recovery-kernel-and-self-healing.md`: replace journal/history reconstruction as canonical recovery substrate;
- `docs/architecture/ontology-and-authority.md`: define compact correctness state, telemetry, archive, and their one-way authority boundary;
- `docs/operator-recovery.md`: remove operator dependence on journal archaeology;
- `docs/implementation/recovery-kernel-plan.md`: replace history-reconstruction milestones with compact-state migration;
- public recovery/continuation documentation: define current continuation head and compact recovery inputs;
- control-plane surface inventory: document retired persistence surfaces and archive/retention surfaces;
- terminology: define `authority_epoch`, `execution_state`, `operation_state`, `proof_state`, telemetry, archive bundle, and archive sink;
- mutation command documentation where bespoke durable receipt ledgers are replaced by operation-state semantics;
- TypeScript semantic-kernel design: add a short follow-up note that the current emitted runtime artifact boundary is `dist/`, superseding the older `lib/` materialization description.

## 20. Verification and acceptance criteria

The implementation is not complete until all of the following are proven.

### Compact correctness

- fresh-process recovery succeeds with historical journal/lease/checkpoint tables empty;
- stale `authority_epoch` cannot authorize mutation;
- acquisition advances the fencing epoch;
- checkpoint overwrite preserves resumability without history;
- bounded progress hashes preserve heartbeat/no-progress protection;
- settlement atomically updates continuation and releases authority;
- continuation restart works from current head only;
- repeated continuation correctly increments no-progress streak;
- unresolved mutation survives restart;
- same idempotency key + same request replays;
- same idempotency key + different request fails closed;
- terminal tombstone replay works after raw receipt deletion;
- superseded proof cannot satisfy a new exact revision;
- graph-revision reconciliation semantics remain intact;
- terminal compaction is impossible before effect-present or no-effect certainty is proven.

### Telemetry boundary

- core orchestration tests pass when historical tables are physically absent;
- correctness modules cannot import or query telemetry/archive modules;
- deleting all telemetry does not change the deterministic next safe action;
- telemetry write failure cannot roll back a committed correctness transition.

### Archive

- every completed run produces exactly one canonical logical archive bundle;
- every scheduler-only completed cycle produces exactly one canonical logical archive bundle;
- canonical bytes and SHA-256 digest are provider-independent;
- same bundle exported twice is idempotent;
- same bundle identity with different digest fails closed for purge;
- configured archive failure blocks purge but not settlement or recovery;
- no configured sink permits normal TTL purge;
- confirmed archive plus expired TTL permits purge;
- unconfirmed archive plus expired TTL does not permit purge;
- archive adapters cannot influence recovery/advance/settlement decisions;
- secrets, capability material, and unrestricted provider payloads are excluded;
- legacy history backfill is complete and digest-confirmed before destructive purge when archival preservation is configured.

### Migration

- old-schema to compact-state migration preserves the same next safe action for representative active, terminal, expired, failed, and indeterminate states;
- destructive migrations refuse to run unless compact-read equivalence and required archive-backfill gates are satisfied;
- repository regression/public-release verification passes;
- exact-revision runtime verification passes on the same migration head.

## 21. Acid test

After migration, for any future semantic execution decision Overcenter should need only:

```text
fresh authoritative state
+ orchestration_runs
+ execution_state
+ unresolved operation_state, if any
+ required proof_state, if any
= safe next action
```

If deleting historical telemetry changes that answer, the compact-state migration is incomplete.

If deleting an external archive changes that answer, the archive boundary has been violated.

## 22. Resulting architecture

Before:

```text
orchestration
 |- runs
 |- horizons
 |- journal
 |- resolutions
 |- leases
 |- slots
 |- checkpoints
 |- heartbeats
 |- continuation history
 |- changeset receipts
 |- release receipts
 |- promotion receipts
 |- reconcile receipts
 `- verification receipts
```

After:

```text
EXECUTION CORRECTNESS
 |- orchestration_runs
 |- execution_state
 |- operation_state
 `- proof_state

RETENTION HOUSEKEEPING
 `- telemetry_archive_exports

NON-AUTHORITATIVE HISTORY
 `- TTL telemetry
       |
       `-> optional provider-neutral archive
```

The intended storage complexity becomes proportional to current projects, current execution subjects, unresolved effects, and current proofs rather than the number of commands agents have ever performed.

The design goal is therefore not merely fewer rows. It is a smaller execution kernel with explicit present-tense truth, bounded diagnostics, and user-controlled long-term history outside the operational database.
