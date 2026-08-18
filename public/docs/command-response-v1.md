# Hatchable command-response-v1

The current control-plane commands use one additive response envelope while retaining each command's domain-native payload at the top level.

## Commands

- `work.claim`
- `work.settle`
- `github.apply_changeset`
- `github.delete_branch`
- `github.required_checks.ensure`
- `github.branch_policy.reconcile`
- `github.stack.reconcile`
- `github.default_branch.migrate`
- `github.review_packet`
- `portfolio.reconcile_work_surface`
- `linear.archive`
- `orchestration.resume_packet`
- `orchestration.status`
- `object.capture`
- `object.get_verified`

## Success

Every successful command response includes:

```json
{
  "ok": true,
  "command": "<canonical command name>",
  "schema_version": "command-response-v1",
  "observed_at": "<ISO-8601 timestamp>"
}
```

Domain fields remain at their existing top-level paths. The envelope does not introduce a generic `data`, `resource`, `subject`, `mutation`, or `outcome` wrapper.

When a compatible command is invoked with orchestration metadata `run_id`, the same value is returned as an additive top-level field on both success and failure. This does not change `command-response-v1`. For commands where `run_id` is not already domain input, the wrapper removes it before command-specific normalization and semantic hashing so run correlation cannot create a false idempotency conflict. `work.claim` retains its existing domain use of `run_id`; `orchestration.resume_packet` uses `run_id` as the run being reconstructed.

Idempotent mutation commands retain `idempotent_replay`. Read-only commands do not add a synthetic replay field. Domain timestamps such as lease expiry, settlement, and GitHub packet snapshot timestamps remain independent of `observed_at`.

## Failure

Command-level failures use:

```json
{
  "ok": false,
  "command": "<canonical command name>",
  "schema_version": "command-response-v1",
  "observed_at": "<ISO-8601 timestamp>",
  "error": "<STABLE_MACHINE_CODE>",
  "message": "<human-readable explanation>",
  "error_class": "<class>",
  "retryable": false,
  "rejection": false,
  "details": {}
}
```

The shared `error_class` vocabulary is `validation`, `precondition`, `conflict`, `not_found`, `permission`, `setup`, `upstream`, and `internal`. Stable domain error codes remain authoritative. Retryability is an explicit semantic property and is not derived from HTTP status.

`rejection: true` means Hatchable established enough authoritative state to determine that a guarded action was not permitted by its safety, concurrency, identity, idempotency, or precondition contract. `rejection: false` covers malformed requests, unavailable authority, permission/setup failures, upstream/internal failures, indeterminate outcomes, and ordinary observational failures. Rejection and retryability are independent: an idempotency-in-progress rejection may be safely retryable, while stale authority normally requires refresh-and-redecide.

The shared classifier owns this distinction. A small command-specific override layer handles stable codes whose meaning differs by command, such as mutation `HEAD_MISMATCH` versus an observational review-packet guard, or `OBJECT_ID_CONFLICT` during capture versus verification.

`details` is the canonical machine-readable evidence location.

## Compatibility fields

This response version is additive. Existing domain success fields remain at their current top-level paths. Existing stable error codes are unchanged.

For Portfolio Control Plane commands, existing flattened error-detail fields are temporarily retained alongside the canonical `details` object when current callers may depend on them. For example, a stale-head error can expose both `details.expected_head` and the legacy top-level `expected_head`.

These flattened fields are compatibility fields. They must not be removed inside `command-response-v1`; removal requires a deliberate future response-version change.

The object commands already used nested `details`, so they do not invent new flattened duplicates.

## Domain semantics

`portfolio.reconcile_work_surface` keeps its two-level result model. `ok: true` means the batch command completed; an item may still have `result: "rejected"` or dry-run `result: "would_reject"` with a domain `reason`. Item reconciliation rejection is not a command-level failure and therefore does not use the command-level `rejection` field.

`github.review_packet` keeps partial-capability behavior. Optional evidence may be represented as unavailable inside an otherwise successful packet. When the observation itself cannot be established, its command failure normally carries `rejection: false`; guarded mutation semantics are not inferred merely from a stable error name shared with another command.

## Work lease settlement semantics

`work.claim` persists both the broad authoritative Linear revision it observed and a deterministic execution-critical projection/fingerprint used to authorize later settlement. The execution projection is intentionally narrower than the full Linear issue representation. It covers durable work/project identity, archive status, lifecycle state, execution lane, priority, managed repository/source/authority and acceptance/promotion fields, and dependency identities.

Comments, appended execution evidence, unrelated labels, relation titles, timestamps, generic description prose outside managed fields, and broad revision counters do not by themselves invalidate settlement. `work.settle` rereads authority, derives the same canonical execution projection, and compares that projection rather than requiring generic Linear revision equality.

A successful settlement can therefore report different `claim_authoritative_revision` and `pre_settlement_authoritative_revision` values together with `authoritative_revision_changed_before_settlement: true` and `execution_precondition_verified: true`. This means the broad record moved but the execution contract remained unchanged; it does not mean Hatchable ignored the revision.

When execution-critical authority changes, settlement fails closed with `WORK_STATE_CHANGED`, `rejection: true`, `retryable: false`, and structured mismatch evidence such as `changed_fields`, `claim`, and `current`. A conclusive semantic rejection terminates that lease's ownership rather than leaving a misleading active lease waiting for expiry.

Settlement uses an explicit `settling` state for an upstream or otherwise indeterminate transition attempt. In that case Hatchable does not release ownership as though the command were rejected. The caller must replay the identical semantic settlement with the same idempotency key so Hatchable can reconcile whether the Linear transition already occurred without creating a second lifecycle transition. Lease expiry remains crash/dead-worker recovery, not the normal cleanup path for a live settlement attempt.

Historical lease rows may retain terminal evidence after authority ends. Actual current ownership requires a valid unexpired active slot; an expired lease grants no execution authority.

## Run correlation and recovery

Compatible Portfolio Control Plane commands may be correlated with one orchestration `run_id`. The control plane records one bounded `orchestration_command_invocations` row per correlated invocation with command identity, safe target coordinates, request/result digests, bounded request/result projections, outcome classification, and timing.

The journal is an evidence/correlation index. It is not work authority and it never stores chain of thought, prompts, arbitrary conversation content, credentials, API tokens, lease tokens, full patches, complete source files, retained binaries, or redundant full Linear/GitHub objects. Existing command-specific durability remains authoritative for mutation safety.

Journal outcomes are `running`, `succeeded`, `rejected`, `failed`, and `indeterminate`. `rejected` is reserved for conclusive expected rejections from the shared command envelope. `indeterminate` means a durable mutation may have occurred or the command has an explicit indeterminate error code and requires command-specific reconciliation/retry behavior.

`orchestration.resume_packet` is read-only. Given a `run_id`, it combines journal evidence with existing work leases/slots and command-specific receipts. The resume call itself is not inserted into the target run journal before reconstruction, preventing the recovery observation from shadowing the prior unresolved invocation. Its continuation vocabulary is deliberately small: `recover_active_lease`, `retry_same_request`, `reconcile_authority`, `recompute_frontier`, `owner_action_required`, and `terminal_or_quiescent`. It never selects the next Linear issue. A valid unexpired lease token may be returned only for the exact run's still-authoritative active/settling lease; the token is never copied into the journal.

`orchestration.status` is a read-only operator projection over expired active slots, stuck claiming/settling leases, stuck/indeterminate journal rows, GitHub changeset receipts, portfolio reconciliation receipts, and recent command outcomes/errors/rejections. It is bounded health evidence, not durable state.

`portfolio.reconcile_work_surface` now retains per-item durable-effect progress when an idempotency key is present. It marks an effect boundary before dispatch, confirms it after durable success, preserves an `indeterminate` receipt when a post-dispatch outcome is ambiguous, skips already completed batch items on exact replay, and rereads GitHub/Linear authority for uncertain items. A material authority change during recovery fails closed rather than discarding the recovery marker.

`linear.archive` is canonicalized into this envelope while the existing `/api/linear-archive` route and `archive_linear_issue` MCP tool remain compatibility surfaces. A lost response after archival is explicitly indeterminate; exact retry rereads Linear and treats an already archived issue as idempotent success.