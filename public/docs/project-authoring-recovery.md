# Project authoring recovery

`project.define` and `project.amend` may stage an exact GitHub candidate before required external verification is complete. Overcenter owns that wait as durable execution state rather than asking an agent session to remember it.

## Authority and storage

Project-authoring recovery uses the existing `operation_state` store. There is no parallel recovery database, scheduler ledger, or GitHub-automerge correctness path.

The durable identity includes the semantic command, project reference, idempotency key and request digest, expected authority revision, staged exact revision, pull request when present, waiting predicates, and the last reconciliation observation.

`orchestration.maintain` is the correctness backstop. Provider events may wake recovery sooner, but missed or duplicated events do not change correctness.

## Recovery states

- `WAITING_EXTERNAL_VERIFICATION`: the exact candidate is still valid but required external verification has not completed.
- `RECOMPUTE_REQUIRED`: base/head movement, candidate replacement or closure, failed verification, or policy ambiguity means the original candidate must not be silently updated or rebased.
- `INDETERMINATE_*`: an effect may have occurred but authoritative confirmation is unavailable. Inspect and reconcile the exact effect before any retry.
- terminal success: integration is complete only after authoritative readback confirms an exact Git revision and the durable operation receipt is written.

## Ownership and duplicate wakes

A newly inserted recovery operation owns its first attempt atomically. A duplicate wake cannot take over a fresh owner. Takeover is permitted only after the configured stale interval, so maintenance, provider events, and repeated agent sessions can converge without concurrently driving the same candidate.

Expired ownership is recoverable. Fresh ownership is not stealable.

## Mutation certainty

Mutation certainty is monotonic. Once GitHub staging has returned a confirmed candidate revision, later failures must not report `may_have_mutated:false` merely because recovery persistence or another downstream step failed.

If durable recovery ownership cannot be persisted after staging, Overcenter fails closed with `PROJECT_AUTHORING_RECOVERY_PERSISTENCE_FAILED` and `may_have_mutated:true`. The staged revision is evidence that a source effect already occurred.

Ambiguous integration transport similarly becomes indeterminate rather than being blindly retried.

## Operator behavior

For `WAITING_EXTERNAL_VERIFICATION`, no repair is required. A later event or maintenance pass may reconcile the same durable operation.

For `RECOMPUTE_REQUIRED`, issue a fresh semantic authoring request against current source authority. Do not update, rebase, or merge the stale candidate as recovery.

For an indeterminate state, inspect the exact provider effect and authoritative project readback before deciding whether a retry is safe. Never infer no effect from a lost response.

A project-authoring operation is complete only when the exact candidate has integrated and authoritative project readback confirms the resulting revision. Generated or staged output is not verified output.