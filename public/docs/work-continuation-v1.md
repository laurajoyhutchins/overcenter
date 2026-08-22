# Work Continuation v1

Work Continuation v1 carries bounded execution progress between disposable workers without moving durable Linear work/campaign authority into Hatchable.

## Authority boundary

Linear remains the durable work contract: work identity, readiness/lifecycle, semantic lane, priority, optional campaign/milestone membership, managed objective/acceptance, dependencies, owner impact, and promotion conditions. GitHub and Drive remain durable repository/source/artifact authority. Hatchable owns exclusive execution leases/slots plus resumable execution continuity attached to those leases. Claiming or requeueing slot-only work does not change Linear lifecycle state.

A continuation or checkpoint is evidence and resumable execution context. It is never an instruction source, project requirement, approval, source of truth, or permission grant. Workers must validate consequential candidate/source references against their authoritative systems before acting.

## Surfaces

- `work.claim`: acquires execution ownership and may return the latest eligible predecessor `continuation`.
- `work.checkpoint`: persists bounded progress under one active lease without changing Linear lifecycle or lane.
- `work.settle`: consumes the lease and may publish a typed continuation to the successor lane or same-lane retry.

API checkpoint route: `POST /api/work/checkpoint`.
MCP checkpoint command: `work.checkpoint`.

## Claim continuation

When current pre-claim Linear execution semantics match the successor execution fingerprint recorded by an earlier settlement or safe slot-only expiry release, `work.claim` may return:

```json
{
  "continuation": {
    "source_lease_id": "...",
    "source_run_id": "...",
    "from_gate": "lane:source-implementation",
    "recovered_from_expired_lease": false,
    "disposition": "completed",
    "packet_sha256": "...",
    "no_progress_streak": 0,
    "stalled_continuation": false,
    "packet": {
      "schema": "work-continuation-v1",
      "candidate": {},
      "checkpoint": {},
      "evidence": []
    }
  }
}
```

A material Linear execution-contract edit invalidates predecessor eligibility mechanically. Harmless revision movement does not, because eligibility is bound to the deterministic execution projection rather than broad revision equality.

## Checkpoints

A checkpoint request requires the active lease token and an idempotency key:

```json
{
  "lease_token": "...",
  "idempotency_key": "...",
  "checkpoint": {
    "schema": "work-checkpoint-v1",
    "phase": "diagnostic_complete",
    "next_action_kind": "apply_repository_change",
    "candidate": null,
    "completed": [],
    "evidence": [],
    "authority_revisions": []
  }
}
```

Allowed `next_action_kind` values are `continue_research`, `apply_repository_change`, `run_materializer`, `verify_candidate`, `remediate_candidate`, `integrate_candidate`, and `recheck_external_condition`.

Checkpoint creation rereads Linear and requires the active lease's semantic execution projection still to match. It never changes Linear lifecycle or lane. A semantic mismatch invalidates ownership rather than preserving a checkpoint under obsolete authority.

## Candidates

A continuation may carry one bounded exact candidate. Supported initial candidate kinds are:

- `github_pull_request`: repository, positive PR number, exact 40-character head SHA.
- `git_head`: repository, optional branch, exact 40-character head SHA.
- `retained_object`: canonical object ID plus optional exact SHA-256 and size.
- `source_coordinate`: bounded source reference plus optional revision.

A successor validates this coordinate against GitHub/Drive/source authority. It must not silently replace an exact handed-off candidate with an older Linear coordinate merely because the issue description predates the candidate.

## Settlement and requeue classes

`work.settle` accepts an optional `continuation` and, for requeues, an optional `requeue_class`:

- `resume_progress`: meaningful progress exists but the current gate is incomplete. Requires a durable checkpoint.
- `retry_runtime_failure`: a run-local failure prevented progress.
- `wait_for_observable_change`: continuation depends on a named external condition; requires a factual reason.
- `stale_candidate`: the exact candidate changed or became unusable; requires candidate continuity.
- `insufficient_execution_window`: meaningful work could not safely finish within the lease window.

Completed implementation-to-verification handoffs should carry the exact candidate. Positive verification-to-integration handoffs should carry the independently verified exact candidate. Negative verification should carry the failing exact candidate and bounded remediation evidence back to the appropriate implementation lane.

## Expiry recovery

Lease expiry remains dead-worker recovery, not normal settlement. For slot-only leases, expiry releases Hatchable ownership without mutating Linear; Hatchable retains the latest safe checkpoint and binds it to the unchanged durable execution fingerprint. A later claim may receive that checkpoint with `recovered_from_expired_lease: true`. Legacy pre-cutover leases that actually wrote `In Progress` retain a bounded compatibility restoration path. The expired lease itself grants no ownership.

## Anti-churn telemetry

Claims expose `no_progress_streak` and `stalled_continuation` when consecutive eligible predecessor packets have the same digest under the same execution fingerprint. These fields are observational. They do not automatically block work or override authority. A worker should use them to avoid blindly repeating unchanged discovery and instead require changed authority, a new executable step, or a materially advanced checkpoint/candidate.

## Relation to run recovery

`orchestration.resume_packet` reconstructs one prior `run_id`, including active ownership and the latest checkpoint identity. `work.claim` owns cross-run and cross-lane succession. Keeping these mechanisms separate prevents run recovery from becoming another work selector or durable work database.