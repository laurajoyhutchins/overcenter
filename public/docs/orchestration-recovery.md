# Orchestration run continuity and recovery

The Portfolio Control Plane gives interactive Fast Forward and scheduled execution workers bounded continuity across disposable sessions without becoming work authority.

Linear remains durable work truth. GitHub and Drive remain repository/artifact truth. Hatchable stores only coordination state: run budgets, advisory horizons, leases, checkpoints, heartbeats, settlement receipts, and bounded recovery evidence.

## Surfaces

- `orchestration.start` / `POST /api/orchestration/start`
- `orchestration.horizon_checkpoint` / `POST /api/orchestration/horizon-checkpoint`
- `orchestration.horizon_resolve` / `POST /api/orchestration/horizon-resolve`
- `orchestration.finish` / `POST /api/orchestration/finish`
- `orchestration.maintain` / `POST /api/orchestration/maintain`
- `orchestration.resume_packet` / `POST /api/orchestration/resume-packet`
- `orchestration.status` / `POST /api/orchestration/status`

The corresponding MCP commands use the same canonical names. `resume_packet` and `status` are observational. The other orchestration commands mutate only bounded Hatchable coordination state and do not change Linear, GitHub, Drive, work priority, work executability, or project requirements.

## Run start and budgeting

Create one unique `run_id` for the execution session and reuse it for every compatible command in that run.

Call `orchestration.start` before selecting new work. Supply:

- the worker identity;
- `scheduled` or `interactive` mode;
- a stable `continuation_key` for the same worker/scope across firings;
- a bounded scope containing the project and any hard lane/repository constraints;
- optional narrower run-budget values.

Scheduled workers normally use a 2700-second budget, a 300-second settlement reserve, and a 600-second minimum fresh-gate runway. Registered run budgets fence `work.claim` and `work.heartbeat`. A worker may not acquire a fresh gate when less than the minimum runway remains before the reserve boundary, and a heartbeat may not extend ownership through that boundary.

`orchestration.start` finds the latest compatible predecessor by continuation key plus exact scope fingerprint. This is correlation, not ownership.

## Cross-run planning continuity

The execution agent still chooses its frontier from live Linear/GitHub/Drive authority. When useful, it may persist up to 10 already-selected plausible next gates with `orchestration.horizon_checkpoint`.

For each candidate Hatchable rereads Linear and retains the execution-critical projection and fingerprint. The horizon:

- does not claim work;
- does not reprioritize work;
- does not make work executable;
- is discarded when current authority no longer matches it.

`orchestration.horizon_resolve` revalidates the latest horizon and classifies candidates such as `valid`, `materially_changed`, `no_longer_executable`, or `authority_unavailable`.

A new compatible run may receive its predecessor's revalidated horizon from `orchestration.start`. This is the machine planning handoff across sessions.

## Exact interrupted-execution recovery

When `orchestration.start` identifies a predecessor run, call `orchestration.resume_packet` for that predecessor before selecting new work.

`orchestration.resume_packet` reconstructs exact prior execution mechanics from journal evidence, work leases/slots, checkpoints, and command-specific receipts. Its continuation vocabulary remains deliberately small:

- `recover_active_lease`: continue the exact still-owned gate;
- `retry_same_request`: replay the exact stored idempotent request;
- `reconcile_authority`: refresh authoritative state before deciding whether a prior effect landed;
- `recompute_frontier`: no recoverable exact ownership remains;
- `owner_action_required`: authority changed in a way the recovery layer cannot resolve mechanically;
- `terminal_or_quiescent`: known run evidence is terminal or has no unresolved execution.

A packet may expose a lease token only when the predecessor run still owns a valid unexpired active/settling slot and current Linear execution semantics still match. Lease tokens never enter the orchestration journal.

Cross-run planning continuity is owned by `orchestration.start` plus advisory horizons. Cross-lane exact candidate succession remains `work-continuation-v1` delivered through a later `work.claim`. `resume_packet` does not select a new work item.

## Long-running gates

`work.checkpoint` persists bounded progress while an active lease remains authoritative.

`work.heartbeat` may extend a legitimate long-running gate only when:

- the lease is active and unexpired;
- the slot is still owned by the same lease;
- the same `run_id` is used;
- current Linear execution semantics still match the claim-time projection;
- durable checkpoint progress exists;
- the run budget and three-hour hard lease cap still permit extension.

The lease and slot expiry move together and a heartbeat receipt is retained. Repeated heartbeat attempts without materially advanced checkpoint progress are rejected. An expired lease cannot be revived; expired ownership returns to normal stale-lease recovery.

## Run finish

After all acquired work is truthfully settled or no longer grants execution authority, call `orchestration.finish` with the run disposition, last work/gate, and bounded stop reason.

Finish fails closed with `RUN_HAS_ACTIVE_LEASE` while the run still owns an unexpired claiming, active, or settling lease. A successful finish persists only machine continuation metadata and reports no work-authority mutation.

The user-visible `Portfolio Run Handoff v1` remains a compact human index. It complements this machine handoff and never replaces live authority.

## Deterministic maintenance

`orchestration.maintain` is the bounded self-repair arm of the coordination layer. It may:

- invoke existing expired-slot reconciliation;
- replay an exact stored claiming request with its original idempotency key;
- replay an exact stored settling request with its original idempotency key;
- reconcile an old command-journal row only when a durable receipt conclusively establishes its result;
- reconcile an interrupted `orchestration.start` as succeeded when its exact run record exists, or as not applied when the exact run record is conclusively absent after the stuck threshold.

It must not choose or create work, change priority, invent blockers, make owner decisions, or convert uncertain historical effects into invented certainty. Ambiguous effects without authoritative receipts remain explicitly ambiguous.

## Journal boundary

The run journal records bounded command/target coordinates, request/result hashes, safe projections, timestamps, error classification, retryability, expected-rejection status, and mutation ambiguity. It does not record prompts, model reasoning, chain of thought, conversation text, credentials, lease tokens, source-file contents, patches, binary content, or full copies of authoritative objects.

The journal never grants execution authority. Linear remains durable work truth; GitHub/Drive remain artifact/repository truth; work leases remain temporary exclusive execution ownership; command-specific receipt state machines remain the safety authority for idempotent mutation recovery.