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
  "details": {}
}
```

The shared `error_class` vocabulary is `validation`, `precondition`, `conflict`, `not_found`, `permission`, `setup`, `upstream`, and `internal`. Stable domain error codes remain authoritative. Retryability is an explicit semantic property and is not derived from HTTP status.

`details` is the canonical machine-readable evidence location.

## Compatibility fields

This response version is additive. Existing domain success fields remain at their current top-level paths. Existing stable error codes are unchanged.

For Portfolio Control Plane commands, existing flattened error-detail fields are temporarily retained alongside the canonical `details` object when current callers may depend on them. For example, a stale-head error can expose both `details.expected_head` and the legacy top-level `expected_head`.

These flattened fields are compatibility fields. They must not be removed inside `command-response-v1`; removal requires a deliberate future response-version change.

The object commands already used nested `details`, so they do not invent new flattened duplicates.

## Domain semantics

`portfolio.reconcile_work_surface` keeps its two-level result model. `ok: true` means the batch command completed; an item may still have `result: "rejected"` with a domain `reason`.

`github.review_packet` keeps partial-capability behavior. Optional protection or rules evidence may be represented as unavailable inside an otherwise successful packet.