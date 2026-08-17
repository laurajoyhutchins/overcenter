# Orchestration run recovery

The Portfolio Control Plane correlates compatible Fast Forward and scheduled-worker commands with the existing orchestration `run_id`.

## Surfaces

- Canonical command: `orchestration.resume_packet`
- MCP tool: `orchestration_resume_packet`
- API: `POST /api/orchestration/resume-packet`
- Canonical command: `orchestration.status`
- MCP tool: `orchestration_status`
- API: `POST /api/orchestration/status`

Both commands are read-only with respect to Linear, GitHub, Drive, work leases, and command-specific receipts. A correlated read may append its own bounded journal invocation because the journal is observability metadata.

## Worker procedure

Create one unique run token for the execution session. Use that same token as `run_id` on every compatible canonical Portfolio Control Plane command for the duration of the run. `work.claim` already requires this value as part of its domain request. For other commands it is orchestration metadata and is excluded from their semantic request hash.

If a worker/session disappears, a replacement worker first calls `orchestration.resume_packet` with the prior run token. Follow the returned mechanical continuation classification. Do not infer a new work item from the packet; if it returns `recompute_frontier`, return to the normal authoritative frontier-selection procedure.

A packet may return an existing lease token only when the run still owns a valid unexpired active slot and fresh Linear state still matches that lease's execution gate. Settling leases may include the exact safe replay material already persisted by the work lease settlement protocol. Tokens never enter the orchestration journal.

## Continuations

- `recover_active_lease`: continue the exact currently owned gate.
- `retry_same_request`: replay the identified idempotent semantic request.
- `reconcile_authority`: refresh/reconcile authoritative external state before deciding whether the prior effect landed.
- `recompute_frontier`: no active unresolved ownership remains; use normal portfolio selection.
- `owner_action_required`: durable authority changed in a way the recovery projection cannot safely resolve automatically.
- `terminal_or_quiescent`: the known run evidence is terminal or has no unresolved execution.

## Journal boundary

The run journal records bounded command/target coordinates, request/result hashes, safe projections, timestamps, error classification, retryability, expected-rejection status, and mutation ambiguity. It does not record prompts, model reasoning, chain of thought, conversation text, credentials, lease tokens, source-file contents, patches, binary content, or full copies of authoritative objects.

The journal never grants execution authority. Linear remains durable work truth; GitHub/Drive remain artifact/repository truth; work leases remain temporary exclusive execution ownership; command-specific receipt state machines remain the safety authority for idempotent mutation recovery.