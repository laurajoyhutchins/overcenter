# Hatchable command-response-v1

The current control-plane commands use one additive response envelope while retaining each command's domain-native payload at the top level.

## Commands

- `work.claim`
- `work.checkpoint`
- `work.heartbeat`
- `work.settle`
- `github.apply_changeset`
- `github.delete_branch`
- `github.required_checks.ensure`
- `github.branch_policy.reconcile`
- `github.stack.reconcile`
- `github.default_branch.migrate`
- `github.review_packet`
- `github.capabilities`
- `github.pull_request.create`
- `github.pull_request.mark_ready`
- `portfolio.reconcile_work_surface`
- `linear.archive`
- `orchestration.start`
- `orchestration.horizon_checkpoint`
- `orchestration.horizon_resolve`
- `orchestration.finish`
- `orchestration.maintain`
- `orchestration.resume_packet`
- `orchestration.diagnose`
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
  "failure_state": "<typed orchestration recovery class>",
  "automatic_recovery_allowed": false,
  "recovery_operation": null,
  "escalation_required": true,
  "escalation_reason": "<machine-readable boundary or null>",
  "details": {}
}
```

The shared `error_class` vocabulary is `validation`, `precondition`, `conflict`, `not_found`, `permission`, `setup`, `upstream`, and `internal`. Stable domain error codes remain authoritative. Retryability is an explicit semantic property and is not derived from HTTP status.

`failure_state` is the orchestration recovery class layered on top of the detailed domain error. The stable recovery vocabulary includes `CLAIM_STATE_INVALID`, `ACTIVE_LEASE_REMAINS`, `HEARTBEAT_BUDGET_EXHAUSTED`, `STALE_LEASE`, `TRANSPORT_UNAVAILABLE`, `WORKER_DISABLED`, `RECOVERY_FAILED`, and `UNKNOWN`, plus narrower safety-preserving classes such as authority conflict or indeterminate external effect. `recovery_operation` is a bounded command prescription, not a plan. A worker executes it only when `automatic_recovery_allowed: true`; otherwise it obeys the machine-readable escalation boundary. A response with `may_have_mutated: true` never becomes a blind retry merely because a transport is ordinarily retryable.

`rejection: true` means Hatchable established enough authoritative state to determine that a guarded action was not permitted by its safety, concurrency, identity, idempotency, or precondition contract. `rejection: false` covers malformed requests, unavailable authority, permission/setup failures, upstream/internal failures, indeterminate outcomes, and ordinary observational failures. Rejection and retryability are independent: an idempotency-in-progress rejection may be safely retryable, while stale authority normally requires refresh-and-redecide.

The shared classifier owns this distinction. A small command-specific override layer handles stable codes whose meaning differs by command, such as mutation `HEAD_MISMATCH` versus an observational review-packet guard, or `OBJECT_ID_CONFLICT` during capture versus verification.

`details` is the canonical machine-readable evidence location.

## Compatibility fields

This response version is additive. Existing domain success fields remain at their current top-level paths. Existing stable error codes are unchanged.

For Busbar commands, existing flattened error-detail fields are temporarily retained alongside the canonical `details` object when current callers may depend on them. For example, a stale-head error can expose both `details.expected_head` and the legacy top-level `expected_head`.

These flattened fields are compatibility fields. They must not be removed inside `command-response-v1`; removal requires a deliberate future response-version change.

The object commands already used nested `details`, so they do not invent new flattened duplicates.

## Domain semantics

`portfolio.reconcile_work_surface` keeps its two-level result model. `ok: true` means the batch command completed; an item may still have `result: "rejected"` or dry-run `result: "would_reject"` with a domain `reason`. Item reconciliation rejection is not a command-level failure and therefore does not use the command-level `rejection` field.

`github.review_packet` keeps partial-capability behavior. Optional evidence may be represented as unavailable inside an otherwise successful packet. When the observation itself cannot be established, its command failure normally carries `rejection: false`; guarded mutation semantics are not inferred merely from a stable error name shared with another command.

## Work lease settlement semantics

Worker-facing `work.claim` is revision-only. The worker passes the exact server-observed `authoritative_revision` back as `observed_revision`; the control plane rereads Linear and derives lifecycle and execution lane itself. Semantic MCP and `/api/worker-command` callers do not construct `observed_state` or `observed_lane`, so semantically equivalent rendering cannot make a freshly observed eligible item unclaimable. Low-level compatibility surfaces may retain explicit state/lane fields for non-semantic callers until those callers are removed.

`work.claim` persists both the broad authoritative Linear revision it observed and a deterministic execution-critical projection/fingerprint used to authorize later settlement. The execution projection is intentionally narrower than the full Linear issue representation. It covers durable work/project identity, archive status, lifecycle state, execution lane, priority, managed repository/source/authority and acceptance/promotion fields, and dependency identities.

Comments, appended execution evidence, unrelated labels, relation titles, timestamps, generic description prose outside managed fields, and broad revision counters do not by themselves invalidate settlement. `work.settle` rereads authority, derives the same canonical execution projection, and compares that projection rather than requiring generic Linear revision equality.

A successful settlement can therefore report different `claim_authoritative_revision` and `pre_settlement_authoritative_revision` values together with `authoritative_revision_changed_before_settlement: true` and `execution_precondition_verified: true`. This means the broad record moved but the execution contract remained unchanged; it does not mean Hatchable ignored the revision.

When execution-critical authority changes, settlement fails closed with `WORK_STATE_CHANGED`, `rejection: true`, `retryable: false`, and structured mismatch evidence such as `changed_fields`, `claim`, and `current`. A conclusive semantic rejection terminates that lease's ownership rather than leaving a misleading active lease waiting for expiry.

Settlement uses an explicit `settling` state for an upstream or otherwise indeterminate transition attempt. In that case Hatchable does not release ownership as though the command were rejected. The caller must replay the identical semantic settlement with the same idempotency key so Hatchable can reconcile whether the Linear transition already occurred without creating a second lifecycle transition. Lease expiry remains crash/dead-worker recovery, not the normal cleanup path for a live settlement attempt.

Historical lease rows may retain terminal evidence after authority ends. Actual current ownership requires a valid unexpired active slot; an expired lease grants no execution authority.

`work.checkpoint` adds resumable execution progress without changing Linear lifecycle or lane. A checkpoint is accepted only while the lease still owns an unexpired slot and the semantic execution projection remains valid. `work.settle` may promote a checkpoint and exact candidate into `work-continuation-v1`; a later `work.claim` returns that predecessor packet only when the settlement's successor execution fingerprint still matches current Linear execution semantics. See `work-continuation-v1.md` for the full boundary and requeue taxonomy.

`work.heartbeat` is the bounded lease-extension verb. It is accepted only for the exact unexpired active lease and slot, with the same `run_id`, an unchanged semantic execution projection, and durable checkpoint progress. It atomically advances the lease/slot expiry and records a heartbeat receipt, but never past the lease hard cap or a registered run's settlement-reserve boundary. An expired lease cannot be revived. Repeated extension attempts without materially advanced checkpoint progress are rejected rather than turning heartbeat into indefinite reservation.

## Run correlation and recovery

Each execution session is represented by one durable, non-authoritative orchestration run. `orchestration.start` records the worker/scope, establishes a bounded run deadline with settlement reserve and minimum fresh-gate runway, and may identify the latest compatible predecessor by stable continuation key plus exact scope fingerprint only when that predecessor is finished or its registered deadline has passed. A still-live compatible run is never transferred implicitly. Production `work.claim` requires a registered active run and is fenced by the run's budget plus declared project/lane/repository scope; `orchestration.horizon_checkpoint` is fenced by the same scope. `work.heartbeat` remains fenced by the registered budget and exact lease ownership. None of these make a Linear item executable.

The execution agent may persist up to 10 already-selected plausible next gates with `orchestration.horizon_checkpoint`. Hatchable rereads Linear and retains the execution-critical projection/fingerprint for each candidate. `orchestration.horizon_resolve` later classifies those entries against current authority. Horizons are advisory only: they never claim work, change priority, or become durable work truth. Cross-run planning continuity comes from `orchestration.start` plus a revalidated predecessor horizon; exact interrupted ownership recovery still uses `orchestration.resume_packet`.

`orchestration.finish` is settlement-aware. If the run owns a live claiming/active/settling lease, the caller supplies truthful `active_lease_settlement` semantics and the control plane settles that exact owned lease through the canonical `work.settle` path before terminalizing the run. It never guesses `completed`, `requeue`, or `blocked`, and a failed settlement leaves the run active. If a live lease exists and settlement semantics are omitted, finish fails closed with typed `ACTIVE_LEASE_REMAINS` and prescribes the settlement-aware finish retry. Start and finish replays are idempotent only for the exact normalized request semantics. `orchestration.maintain` is a bounded deterministic repair surface for expired slots, stored claim/settlement/checkpoint/heartbeat replay evidence, and interrupted starts whose durable request hash and receipt conclusively match. Recovery is recorded append-only in `orchestration_invocation_resolutions`; historical invocation outcomes are not rewritten merely to clear operator health. Maintenance never selects, creates, prioritizes, or semantically edits portfolio work.

Compatible Busbar commands may be correlated with one orchestration `run_id`. The control plane records one bounded `orchestration_command_invocations` row per correlated invocation with command identity, safe target coordinates, request/result digests, bounded request/result projections, outcome classification, and timing.

The journal is an evidence/correlation index. It is not work authority and it never stores chain of thought, prompts, arbitrary conversation content, credentials, API tokens, lease tokens, full patches, complete source files, retained binaries, or redundant full Linear/GitHub objects. Existing command-specific durability remains authoritative for mutation safety.

Journal outcomes are `running`, `succeeded`, `rejected`, `failed`, and `indeterminate`. `rejected` is reserved for conclusive expected rejections from the shared command envelope. `indeterminate` means a durable mutation may have occurred or the command has an explicit indeterminate error code and requires command-specific reconciliation/retry behavior.

`orchestration.resume_packet` is read-only. Given a `run_id`, it combines journal evidence with existing work leases/slots and command-specific receipts. The resume call itself is not inserted into the target run journal before reconstruction, preventing the recovery observation from shadowing the prior unresolved invocation. Its continuation vocabulary is deliberately small: `recover_active_lease`, `retry_same_request`, `reconcile_authority`, `recompute_frontier`, `owner_action_required`, and `terminal_or_quiescent`. It never selects the next Linear issue. A valid unexpired lease token may be returned only for the exact run's still-authoritative active/settling lease; the token is never copied into the journal.

`orchestration.diagnose` is the narrower deterministic recovery classifier. Given `run_id` and optional `work_ref`, it rereads run, lease/slot/checkpoint, journal, and current Linear evidence and returns current run/work state, active/latest lease, derived worker health, last success, last typed failure, bounded recovery-failure count, exact recovery operation, and escalation boundary. The diagnosis call is not journaled into the run it is classifying, and it cannot plan or select work. A transient command transport outage projects `worker_state: "degraded"` with bounded retry; a persistent invalid configuration projects disabled/error and requires operator action; three repeated automatic-recovery failures become `RECOVERY_FAILED`.

Historical deadline-expired runs with no observable session-layer termination reason are classified `UNOBSERVABLE_SESSION_TERMINATION` with `investigation_required: false`. This preserves the incident evidence without inventing a cause or keeping speculative cessation archaeology in the active engineering queue.

`orchestration.status` is a read-only operator projection over expired active slots, stuck claiming/settling leases, stuck/indeterminate journal rows, GitHub changeset receipts, portfolio reconciliation receipts, and recent command outcomes/errors/rejections. It is bounded health evidence, not durable state.

`portfolio.reconcile_work_surface` now retains per-item durable-effect progress when an idempotency key is present. It marks an effect boundary before dispatch, confirms it after durable success, preserves an `indeterminate` receipt when a post-dispatch outcome is ambiguous, skips already completed batch items on exact replay, and rereads GitHub/Linear authority for uncertain items. A material authority change during recovery fails closed rather than discarding the recovery marker.

`linear.archive` is canonicalized into this envelope while the existing `/api/linear-archive` route and `archive_linear_issue` MCP tool remain compatibility surfaces. A lost response after archival is explicitly indeterminate; exact retry rereads Linear and treats an already archived issue as idempotent success.