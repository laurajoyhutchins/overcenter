# Authoritative state disposition

Overcenter's Hatchable-to-GCP migration is a semantic cutover, not a physical database transplant.

The migration rule is:

> Preserve execution truth. Change representation only when the change is deterministic, exhaustive, and independently verifiable.

This document is the repository-owned disposition doctrine for the current Hatchable PostgreSQL state surface. It defines what must survive in the hot GCP authority store, what may be compiled into a canonical representation, what belongs only in a sealed historical archive, and what carries no migration obligation.

The current application-state census is the 22-table Hatchable schema observed at migration planning time. `__hatchable_migrations` is source schema-history metadata and `overcenter_authority_freeze` is cutover-control state; both are handled separately from the 22 application-state tables.

The executable `migration-state-contract-v2` cutover contract is authoritative when this doctrine and migration code differ. It defines a fresh runtime epoch: GitHub plus an empty canonical Cloud SQL target must recover current project truth. Consequently the current census uses `TRANSFORM` only for bounded GitHub recovery-seed inputs and `DISCARD` for source-epoch runtime/projection state. `PRESERVE` and `ARCHIVE` remain valid disposition categories for future state classes, but no current application table is assigned either category. A complete immutable source backup may retain bytes without making those bytes a semantic `ARCHIVE` input.

## Four dispositions

Every source table, field class, and exceptional row class MUST receive exactly one disposition in the migration semantic manifest.

### PRESERVE

The semantic shape and truth remain part of current operational authority in GCP. Physical encoding may change only where the encoding is provably equivalent and the manifest binds source and target identities.

### TRANSFORM

Authoritative or irreducible truth survives, but legacy storage shape does not. Transformation MUST be deterministic, versioned, replayable from the frozen source snapshot, and verified by semantic identity or digest. Raw legacy rows may additionally appear in the sealed archive, but current execution MUST use only the canonical transformed representation.

### ARCHIVE

The state is historical evidence worth retaining for audit, diagnosis, or provenance, but it is not current execution authority. Archived state MUST be content-addressed and read-only. The execution kernel MUST NOT query the archive to decide current leases, readiness, mutation authority, settlement, or proof.

### DISCARD

The state contains no current authority and no irreducible evidence required by the target runtime. It is derived, ephemeral, runtime-epoch-specific, synthetic, or provider-implementation state that is safe to recompute or abandon. DISCARD creates no requirement to import the state into the target or historical evidence product. A complete immutable source backup may still contain discarded bytes.

No state may disappear merely because it is inconvenient. Unclassified source state fails the migration.

## Deterministic reason codes

The semantic manifest uses stable reason codes rather than free-form prose as the primary accounting key.

| Reason code | Meaning |
| --- | --- |
| `CURRENT_KERNEL_TRUTH` | Current provider-neutral authority remains operational state. |
| `REPOSITORY_POLICY_TRUTH` | Repository lifecycle or branch-role policy is Overcenter-owned durable truth. |
| `CANONICAL_EFFECT_EVIDENCE` | Legacy provider-effect or idempotency records are compiled into canonical durable effect evidence. |
| `CANONICAL_PROOF_EVIDENCE` | Legacy verification evidence is compiled into canonical proof state. |
| `CANONICAL_RECOVERY_EVIDENCE` | Historical mutation/recovery facts are retained in the canonical recovery/evidence model. |
| `GITHUB_RECOVERY_SEED` | The source row contributes only bounded inputs needed to reconstruct current project truth from GitHub in an empty canonical target. |
| `GITHUB_RECOVERABLE_EFFECT` | The consequential effect is authoritatively recoverable from exact GitHub state; the source receipt does not cross the runtime epoch. |
| `GITHUB_RECOVERABLE_PROOF` | The proof can be freshly reconstructed from exact GitHub authority and current verification, so source proof rows do not migrate. |
| `RUNTIME_EPOCH_RESET` | The semantic capability exists in GCP, but source-era live authority is not transferable and must be freshly issued. |
| `PROVIDER_NEUTRALIZATION` | Durable meaning survives after provider-specific identity or projection fields are removed from the core model. |
| `LEGACY_HISTORY_ONLY` | Historical evidence is retained only in the sealed archive. |
| `LEGACY_PROJECTION_ONLY` | Historical state belongs to an optional/retired projection and is not core authority. |
| `DERIVED_STATE` | State is recomputed from authoritative facts after cutover. |
| `EPHEMERAL_COORDINATION` | State is meaningful only inside the source runtime epoch. |
| `NONTRANSFERABLE_CAPABILITY` | Capability-bearing material is never migrated as authority. |
| `SYNTHETIC_OR_INVALID_EVIDENCE` | Known synthetic, orphaned, or invalid evidence must not become target authority. |
| `PROVIDER_IMPLEMENTATION_STATE` | Hosting/platform implementation state is not an Overcenter semantic fact. |
| `PROVIDER_PROJECTION_STATE` | Provider/projection bookkeeping is not current provider-neutral authority and is rebuilt from authoritative sources when needed. |
| `CUTOVER_CONTROL_STATE` | State exists only to fence and prove the one-time source freeze; it is not target runtime authority. |

A manifest entry may name a primary reason plus field- or row-level overrides. An override may only move state to an equally or more conservative disposition. For example, a TRANSFORM table may contain fields that are DISCARD.

## Current 22-table classification

This is the required baseline classification. The migration manifest expands it to field and exceptional-row classes before any cutover.

| Source table | Primary disposition | Reason | Required treatment |
| --- | --- | --- | --- |
| `execution_state` | DISCARD | `RUNTIME_EPOCH_RESET` | Source-era execution authority is non-transferable. Recreate execution state only inside the new GCP runtime epoch from current GitHub/canonical authority. |
| `github_changeset_receipts` | DISCARD | `GITHUB_RECOVERABLE_EFFECT` | Exact GitHub state is the recovery authority for the effect; source-era receipt rows are not imported into the new runtime epoch. |
| `github_production_promotion_receipts` | DISCARD | `GITHUB_RECOVERABLE_EFFECT` | Recover promotion outcome from exact GitHub authority; do not transplant source receipt/idempotency state across epochs. |
| `github_release_receipts` | DISCARD | `GITHUB_RECOVERABLE_EFFECT` | Recover release outcome from exact GitHub authority; the source receipt is not target execution authority. |
| `github_required_check_observations` | DISCARD | `DERIVED_STATE` | Re-observe required checks against exact current GitHub authority after cutover. Historical observations do not authorize new effects. |
| `operation_state` | DISCARD | `RUNTIME_EPOCH_RESET` | Final freeze requires zero unresolved non-GitHub effects; source operation authority then ends and fresh target operation state starts empty. |
| `orchestration_command_invocations` | DISCARD | `RUNTIME_EPOCH_RESET` | Invocation bookkeeping is source-runtime execution state. Current work is reconstructed after cutover rather than replaying source invocation authority. |
| `orchestration_horizons` | DISCARD | `DERIVED_STATE` | Recompute frontier/horizon projections from current graph and evidence. |
| `orchestration_invocation_resolutions` | DISCARD | `RUNTIME_EPOCH_RESET` | Resolution bookkeeping belongs to the source orchestration epoch; target recovery re-derives current truth from GitHub and canonical state. |
| `orchestration_runs` | DISCARD | `RUNTIME_EPOCH_RESET` | No source run identity crosses hosting epochs. GCP starts a fresh run epoch after quiescence and recovery verification. |
| `orchestration_skill_activations` | DISCARD | `RUNTIME_EPOCH_RESET` | Skill activation is source-runtime execution bookkeeping and has no target authority or irreducible recovery obligation. |
| `portfolio_reconcile_receipts` | DISCARD | `LEGACY_PROJECTION_ONLY` | Legacy projection reconciliation history is not current authority and is omitted from the canonical target. |
| `portfolio_repository_branch_roles` | TRANSFORM | `GITHUB_RECOVERY_SEED` | Convert current branch-role policy into the bounded GitHub recovery seed used to reconstruct canonical target truth. |
| `portfolio_repository_disposition` | TRANSFORM | `GITHUB_RECOVERY_SEED` | Convert repository lifecycle/disposition facts into the bounded GitHub recovery seed; do not transplant the legacy table shape. |
| `portfolio_verification_receipts` | DISCARD | `GITHUB_RECOVERABLE_PROOF` | Re-run verification against exact GitHub authority in the target epoch rather than importing source proof receipts. |
| `portfolio_work_identity` | DISCARD | `PROVIDER_PROJECTION_STATE` | Legacy provider/projection work identity is rebuilt from current canonical project and GitHub state when needed. |
| `proof_state` | DISCARD | `GITHUB_RECOVERABLE_PROOF` | Source proof rows do not cross the epoch. Fresh target proof state is produced from exact GitHub authority and current verification. |
| `scheduled_cycle_events` | DISCARD | `RUNTIME_EPOCH_RESET` | Legacy scheduler events are source-epoch runtime state and have no target authority. |
| `work_lease_checkpoints` | DISCARD | `RUNTIME_EPOCH_RESET` | Source checkpoints cannot grant or reconstruct target authority; the new runtime starts from current GitHub/canonical truth. |
| `work_lease_heartbeats` | DISCARD | `RUNTIME_EPOCH_RESET` | Heartbeats are source-runtime liveness state and are abandoned with the old runtime epoch. |
| `work_lease_slots` | DISCARD | `RUNTIME_EPOCH_RESET` | Source slot authority must be quiescent at freeze and is recreated only by fresh GCP execution authority. |
| `work_leases` | TRANSFORM | `GITHUB_RECOVERY_SEED` | Extract only the bounded recovery seed needed to reconstruct current project truth; no source lease, token, run, or expiry authority survives the cutover. |

## Mandatory field and row overrides

Table-level classification is intentionally insufficient for mixed-purpose rows. At minimum the manifest MUST encode these overrides:

- `execution_state.active_capability_material` is `DISCARD / NONTRANSFERABLE_CAPABILITY`.
- Source-era `execution_state` lease/run expiry, heartbeat, and continuation authority is not transferable. Durable evidence referenced by those records is accounted for separately.
- `work_leases.lease_token` and `work_leases.token_hash` are `DISCARD / NONTRANSFERABLE_CAPABILITY`.
- Source-era active lease/slot authority is `DISCARD / RUNTIME_EPOCH_RESET` after quiescence proves it can no longer authorize mutation.
- Heartbeat counters and liveness timestamps are `DISCARD / EPHEMERAL_COORDINATION` unless a separately identified historical evidence requirement explicitly archives them.
- `orchestration_runs.current_failure_*` fields are derived current-observation/cache state unless a specific unresolved mutation fact requires canonical recovery evidence.
- `orchestration_horizons` and required-check observation rows are derived observations and are recomputed from current authorities.
- Receipt `request_json` bodies are not automatically hot authority. Preserve canonical request identity, bounded safe projection where required, idempotency identity, mutation certainty, effect coordinates, and result evidence. Raw request representation belongs only in the archive when retention is justified.
- Attempt tokens are source-operation coordination and do not survive merely because a terminal receipt stores them.
- Linear identifiers and legacy lifecycle/lane fields are projection/compatibility data, not graph authority. Preserve only provider-neutral semantic identity required by the current runtime; archive historical projection relationships where useful.
- Known synthetic, test-fixture, orphaned, or invalid historical evidence is never promoted into canonical target truth. It is either `ARCHIVE / SYNTHETIC_OR_INVALID_EVIDENCE` for forensics or `DISCARD / SYNTHETIC_OR_INVALID_EVIDENCE` when it has no irreducible value.
- `__hatchable_migrations` is `DISCARD / PROVIDER_IMPLEMENTATION_STATE`. Cloud SQL starts from one squashed canonical baseline rather than replaying the Hatchable migration chain.
- `overcenter_authority_freeze` is `DISCARD / CUTOVER_CONTROL_STATE`. It proves and fences the one-time source freeze but never becomes target runtime authority.
- Source sequence values are preserved only when required to interpret retained archive ordering or canonical identities. A sequence does not become target authority merely because the source used it.

## Target conceptual schema

The target is deliberately smaller than the source schema surface.

```text
GitHub authority
      |
      v
+-----------------------------+
| current Overcenter kernel   |
|                             |
| execution_state             |
| operation_state             |
| proof_state                 |
| canonical effect/evidence   |
| repository policy           |
+-------------+---------------+
              |
              +---- optional projections/configuration
              |
              +---- sealed historical archive
                         ^
                         |
                 read-only, never authority
```

`execution_state`, `operation_state`, and `proof_state` name the current kernel concepts, not a requirement to reproduce every source column unchanged. The squashed GCP schema should encode current semantics directly. Compatibility-only storage is admitted only when the current runtime still requires it and has an explicit deletion criterion.

The historical archive is not a shadow database. It cannot answer "who owns this lease?", "is this transition ready?", "did this effect settle?", or any other current execution-authority question.

## `migration-semantic-manifest-v2`

The migration verifier accounts for semantic truth rather than demanding source/target table equality. The executable v2 invariant is `github-plus-empty-canonical-cloud-sql-recovers-current-project-truth`: source runtime state is not transplanted merely because it exists.

At minimum the manifest records:

- source snapshot identity and exact capture/freeze coordinates;
- source schema/census version and the complete set of discovered tables, fields, sequences, and migration metadata;
- one disposition and reason code for every source state class;
- source row counts and deterministic content digests for preserved, transformed, and archived inputs;
- target semantic identities/digests for any PRESERVE outputs and the bounded GitHub recovery seed produced by TRANSFORM inputs;
- archive object identity, count, digest, and source provenance for any ARCHIVE state;
- explicit recomputation/abandonment proof for DISCARD state;
- exceptional row classifications, including synthetic/invalid evidence;
- quiescence evidence for runs, leases, slots, operations, and indeterminate effects;
- recovery/evidence-integrity verification results;
- exact target runtime/source revision and target database schema identity;
- writer-cutover evidence showing exactly one authoritative writer.

The accounting invariant is:

```text
source semantic truth
  = preserved target truth
  + transformed target truth
  + explicitly archived truth
  + explicitly discarded non-authoritative state
```

This is an accounting identity, not permission to discard evidence. If the verifier cannot prove which term contains a source fact, migration fails closed.

## Raw status is not effective authority

Migration tooling MUST distinguish stored lifecycle labels from currently effective authority.

A row labeled `active` may already be expired or otherwise unable to authorize a current effect. Conversely, a nominally terminal record may still carry unresolved mutation uncertainty. The quiescence gate therefore evaluates authority semantics, not only status strings.

The rehearsal and final manifest report both raw state counts and effective-authority counts. Stale source coordination is reconciled or explicitly classified so it cannot resurrect in GCP.

## Non-destructive rehearsal

Before any freeze, the migration MUST be rehearsed end to end while Hatchable remains authoritative and writable:

1. capture a deterministic source snapshot or export suitable for rehearsal;
2. classify every discovered source state class;
3. build the squashed target schema in a disposable/staging target;
4. derive the bounded TRANSFORM recovery seed and reconstruct an empty canonical target from GitHub plus that seed; the current census has no PRESERVE table;
5. if a future state class is ARCHIVE, produce and verify its sealed archive; the current census has no ARCHIVE application table;
6. prove DISCARD state has no current authority or irreducible evidence obligation;
7. generate `migration-semantic-manifest-v2` and fail on any unclassified or unmatched fact;
8. run recovery and evidence-integrity checks against the target;
9. exercise provider-neutral read semantics and safe non-consequential runtime probes against the rehearsal target;
10. destroy/recreate the rehearsal target and prove deterministic replay.

A rehearsal never disables Hatchable writers and never makes the staging target authoritative.

## Final quiescence gate

The final source snapshot is forbidden until fresh checks prove all of the following:

- no effective active Overcenter run can authorize new work;
- zero effective live leases;
- zero occupied live lease slots;
- zero unresolved potentially mutating operations;
- zero unresolved indeterminate external effects;
- stale runtime coordination is reconciled or classified so it cannot be reactivated;
- the complete writer inventory is known and can be disabled as one cutover action;
- the final semantic export/archive/import procedure has already passed rehearsal without source mutation.

Expired-but-still-labeled-active rows are not live authority, but they also cannot be copied into the target as live authority. The final manifest must make that distinction explicit.

## Cutover safety

The authoritative cutover is one-way until an explicit separately designed rollback protocol exists.

1. Quiesce source execution and prove the final quiescence gate.
2. Disable Hatchable mutation entrypoints and record the freeze boundary.
3. Take the final frozen snapshot.
4. Re-run the exact rehearsed semantic transform and archive procedure.
5. Verify semantic-manifest accounting, archive integrity, recovery invariants, and exact target runtime revision.
6. Enable GCP as the sole writer exactly once.
7. Prove fresh `project.inspect` and at least one safe canonical semantic operation against Cloud SQL.
8. Keep Hatchable mutation-frozen after successful cutover.

There is no dual-writer interval. If any authoritative fact is unclassified, any potentially mutating effect is unresolved, any required target proof fails, or writer exclusivity cannot be established, the cutover does not proceed.

## Non-goals

This doctrine does not require the migration to preserve:

- Hatchable deployment-version identity as an Overcenter semantic identity;
- mutable source workspaces or source-sync implementation state;
- legacy five-lane/scheduled-cycle choreography;
- Linear projection state as core authority;
- source-era lease/run/capability authority;
- derived horizons, caches, or provider observations;
- historical schema-migration mechanics.

It does require preserving the invariants those implementations once supported when those invariants remain part of current Overcenter semantics: exact authority fencing, idempotency, monotonic mutation certainty, independently checkable evidence, recovery, and authoritative postcondition readback.
