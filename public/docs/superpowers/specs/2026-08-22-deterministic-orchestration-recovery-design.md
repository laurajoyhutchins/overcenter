# Deterministic Orchestration Recovery Design

Date: 2026-08-22
Status: approved by user request

## Goal

Move recurring Portfolio Control Plane orchestration failures out of agent reasoning and into typed machine states with deterministic recovery operations.

The governing rule is: once a failure class is understood, workers execute a machine-prescribed recovery operation rather than reconstructing state, remembering cleanup choreography, or reopening historical diagnosis.

## Architectural fit

This design extends the existing Portfolio Control Plane kernel. It does not create a planner, queue, worker, or second control plane.

Existing authorities remain unchanged:

- Linear owns durable work identity, readiness, lifecycle, lane, dependencies, and acceptance semantics.
- GitHub owns repository truth.
- Work leases and slots own temporary exclusive execution authority.
- Orchestration runs own bounded run continuity.
- Command-specific receipts and idempotency keys remain mutation-safety authority.
- The orchestration journal remains bounded evidence and correlation, not authority.

`command-response-v1` remains the shared response envelope. The new recovery classification is additive.

## Typed orchestration failure states

The control plane exposes the following stable recovery classes:

- `CLAIM_STATE_INVALID`: a claim was based on stale or non-canonical observed work state. Automatic recovery refreshes authority and retries with the server-issued revision coordinate.
- `ACTIVE_LEASE_REMAINS`: terminal run flow encountered a still-owned lease. Normal terminal flow should avoid this through settlement-aware finish; otherwise the response identifies the settlement-aware retry shape.
- `HEARTBEAT_BUDGET_EXHAUSTED`: the lease or run budget cannot be extended. Progress is checkpointed before the failure and recovery settles/requeues that checkpointed progress.
- `STALE_LEASE`: a lease or slot is expired, orphaned, or no longer grants current ownership. Recovery uses the canonical expiry/reconciliation path.
- `TRANSPORT_UNAVAILABLE`: a required non-ambiguous command transport is temporarily unavailable. Recovery is bounded retry; the worker is degraded, not permanently disabled.
- `WORKER_DISABLED`: persistent invalid setup/configuration or explicit disabled state. Automatic recovery is not allowed.
- `RECOVERY_FAILED`: the same automatic recovery class has failed repeatedly beyond the bounded recovery budget. Escalation is required.
- `UNKNOWN`: the failure cannot be mapped safely. Escalation is required.

The classifier may additionally expose more specific non-recoverable classes such as authority conflict or indeterminate external effect when doing so preserves an existing safety boundary.

Detailed domain `error` / `error_code` values remain authoritative for the underlying condition. `failure_state` answers the narrower question: what orchestration recovery class does this belong to?

## Additive command response contract

Known failures add these fields to `command-response-v1`:

- `failure_state`
- `automatic_recovery_allowed`
- `recovery_operation`
- `escalation_required`
- `escalation_reason`

`recovery_operation` is a bounded command prescription, not a plan. It names the canonical command and either provides exact safe input or identifies the semantic field that the caller must truthfully supply.

A failure with `may_have_mutated: true` never becomes a blind retry merely because the transport is retryable.

## Diagnosis command

Add `orchestration.diagnose` as a read-only state-inspection and recovery-classification command.

Input:

- `run_id` required
- `work_ref` optional when a specific work item should be diagnosed

Output includes:

- current run state and terminal disposition
- current authoritative work state/lane/revision when a work item is known
- active lease if one exists
- latest lease when relevant to stale recovery
- derived worker health (`enabled`, `degraded`, or `disabled/error`)
- last successful command
- last typed failure
- consecutive automatic-recovery failure count
- whether automatic recovery is allowed
- exact recovery operation
- whether reasoning/operator escalation is required and why
- historical cessation classification when applicable

Diagnosis derives repeated recovery attempts from the existing orchestration journal. No recovery queue or new durable state table is introduced.

The worker-health field is a projection of observed control-plane evidence. The current control plane does not own an operator scheduling toggle, so this change must not invent a fake durable worker-enable flag.

## Recovery policy

The deterministic recovery table is:

1. Fresh claim observation drift or legacy representation mismatch -> reread Linear and retry `work.claim` using only the exact authoritative revision.
2. Heartbeat budget exhaustion -> checkpoint is already durable; settle/requeue the lease with `requeue_class=resume_progress` and stop extending the lease.
3. Finish with active lease -> terminal flow accepts explicit lease-settlement semantics and settles before finishing in the same control-plane command. If no truthful disposition was supplied, fail closed and return the required settlement-aware retry shape.
4. Expired/orphaned lease -> canonical stale-lease reconciliation releases or restores authority according to the existing lease protocol, then recompute current execution state.
5. Temporary transport absence before any ambiguous mutation -> bounded retry and degraded worker state. A later cycle rechecks the dependency automatically.
6. Persistent setup/configuration failure -> disabled/error projection and operator escalation; do not spin.
7. Same recoverable failure repeatedly survives the recovery budget -> `RECOVERY_FAILED` and escalation.
8. Unknown, invariant-breaking, conflicting-authority, potentially destructive, or unsafe mutation -> escalation without invented recovery.

## Claim contract

Worker-facing `work.claim` becomes revision-only.

A worker receives an exact `authoritative_revision` from the same control plane observation/horizon path and passes it back as `observed_revision`. The semantic worker and MCP surfaces no longer accept caller-built `observed_state` or `observed_lane` strings.

The lower-level internal/HTTP lease compatibility surface may continue to support the old explicit state/lane fields until all non-semantic callers are proven migrated. This preserves compatibility without forcing semantic reconstruction on agents.

A freshly observed eligible work item therefore cannot fail because a caller rendered `Todo / lane:source-implementation` differently.

## Settlement-aware terminal flow

`orchestration.finish` gains an optional `active_lease_settlement` object with explicit settlement semantics. When a run still owns a live lease, the finish command may safely settle that exact lease through the existing `settleByRef` path, recheck lease liveness, and only then persist the run terminal state.

The control plane never guesses `completed`, `requeue`, or `blocked`. If the caller omits required truthful semantics while a live lease exists, finish remains fail-closed.

This makes lease cleanup structurally part of terminal flow while preserving exclusive ownership, idempotency, and settlement evidence.

## Transient dependency behavior

Transport absence and other temporary dependencies are not permanent worker-disable events.

The protocol reports a degraded/retryable machine state and a bounded retry operation. Scheduled sessions are instructed to return cleanly and recheck on the next firing rather than turning themselves off.

Persistent invalid configuration and explicit operator disablement remain distinct concepts. The current control plane does not own the external scheduler's operator toggle, so this design does not counterfeit one.

## Historical session cessation

Runs terminalized by maintenance after their deadline, when no live lease remains and no session-layer finish reason exists, are classified as `UNOBSERVABLE_SESSION_TERMINATION`.

This classification records that the session stopped without an observable termination cause. It does not infer client cancellation, context exhaustion, runtime exhaustion, model behavior, safety interruption, or infrastructure failure.

Existing incident evidence is preserved. No further engineering work should be generated to infer an unknowable cause unless new session-layer telemetry becomes available.

## Escalation boundary

Reasoning/operator escalation is machine-readable and occurs only for:

- `UNKNOWN`
- invariant violation
- bounded automatic recovery repeatedly failing
- conflicting authorities
- potential data loss
- unsafe or ambiguous mutation
- persistent invalid configuration requiring operator action
- a genuinely new failure class

Known recoverable orchestration failures remain software work, not reasoning work.

## Non-goals

- No new planner.
- No new work queue.
- No new worker or meta-orchestrator.
- No new authority source.
- No revival of the historical Agent Execution Control Plane.
- No blind retry after a potentially mutating indeterminate external effect.
- No speculative reconstruction of historical ChatGPT session termination causes.