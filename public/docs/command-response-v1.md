# Hatchable command-response-v1

The current control-plane commands use one additive response envelope while retaining each command's domain-native payload at the top level.

## Commands

- `work.claim`
- `work.settle`
- `github.apply_changeset`
- `github.review_packet`
- `portfolio.reconcile_work_surface`
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