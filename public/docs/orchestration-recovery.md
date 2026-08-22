# Orchestration run continuity and recovery

The Portfolio Control Plane gives interactive Fast Forward and scheduled workers bounded continuity across disposable worker sessions without becoming work authority. Canonical naming is defined in [`architecture/terminology.md`](architecture/terminology.md).

A **scheduled task** is the ChatGPT scheduler entry. A **worker** is the execution role. A **worker session** is one disposable ChatGPT execution. An **orchestration run** is the durable control-plane record identified by `run_id`; it can outlive the worker session that created it. These terms are not interchangeable.

Linear remains durable work truth. GitHub and Drive remain repository/artifact truth. The Portfolio Control Plane GitHub App, currently deployed on Hatchable, stores only coordination state: run budgets, advisory horizons, leases, checkpoints, heartbeats, settlement receipts, and bounded recovery evidence.

## Surfaces

- `orchestration.start` / `POST /api/orchestration/start`
- `orchestration.horizon_checkpoint` / `POST /api/orchestration/horizon-checkpoint`
- `orchestration.horizon_resolve` / `POST /api/orchestration/horizon-resolve`
- `orchestration.finish` / `POST /api/orchestration/finish`
- `orchestration.maintain` / `POST /api/orchestration/maintain`
- `orchestration.resume_packet` / `POST /api/orchestration/resume-packet`
- `orchestration.diagnose` / `POST /api/orchestration/diagnose`
- `orchestration.status` / `POST /api/orchestration/status`

The corresponding MCP commands use the same canonical names. `resume_packet`, `diagnose`, and `status` are observational. The other orchestration commands mutate only bounded Hatchable coordination state and do not change Linear, GitHub, Drive, work priority, work executability, or project requirements.

## Run start and budgeting

Create one unique `run_id` for the orchestration run and reuse it for every compatible command in that run. The worker session is the disposable executor; `run_id` identifies the durable control-plane record.

Call `orchestration.start` before selecting new work. Supply:

- the worker identity;
- `scheduled` or `interactive` mode;
- a stable `continuation_key` for the same worker/scope across firings;
- a bounded scope containing the project and any hard lane/repository constraints;
- optional narrower run-budget values;
- when the worker can observe them exactly, immutable `contract_provenance` coordinates for the project instructions, Fast Forward skill, and execution-ownership skill. Missing provenance is recorded as unknown/not supplied rather than guessed. The control plane also stamps its own worker-transport revision.

Scheduled workers normally use a 2700-second budget, a 300-second settlement reserve, and a 600-second minimum fresh-gate runway. Production `work.claim` requires a registered active run and is fenced by the run budget plus declared project/lane/repository scope. `orchestration.horizon_checkpoint` is fenced by the same scope. A worker may not acquire a fresh gate when less than the minimum runway remains before the reserve boundary, and a heartbeat may not extend ownership through that boundary.

`orchestration.start` considers only compatible predecessors that are already finished or whose registered deadline has passed. A still-live compatible run is not transferred to a new run. Explicit recovery of a known live session uses that exact prior `run_id` through `orchestration.resume_packet`. Continuation keys provide cross-run context, not authority.

## Cross-run planning continuity

The execution agent still chooses its frontier from live Linear/GitHub/Drive authority. When useful, it may persist up to 10 already-selected plausible next gates with `orchestration.horizon_checkpoint`.

For each candidate Hatchable rereads Linear and retains the execution-critical projection and fingerprint. The horizon:

- does not claim work;
- does not reprioritize work;
- does not make work executable;
- is discarded when current authority no longer matches it.

`orchestration.horizon_resolve` revalidates the latest horizon and classifies candidates such as `valid`, `materially_changed`, `no_longer_executable`, or `authority_unavailable`.

A new compatible run may receive a finished or deadline-expired predecessor's revalidated horizon from `orchestration.start`. This is the machine planning handoff across sessions and never transfers a still-live worker's lease authority.

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

## Typed diagnosis and recovery

`orchestration.diagnose` is the deterministic answer to "why did this worker stop?" for known control-plane failure classes. It reads the durable run, current Linear work state, lease/slot/checkpoint state, and bounded journal evidence, then returns the last successful command, last typed failure, derived worker health, whether automatic recovery is allowed, the exact recovery operation, and whether reasoning/operator escalation is required. It is not inserted into the run journal it is inspecting and cannot choose work or invent a recovery plan.

Known recovery states include `CLAIM_STATE_INVALID`, `ACTIVE_LEASE_REMAINS`, `HEARTBEAT_BUDGET_EXHAUSTED`, `STALE_LEASE`, `TRANSPORT_UNAVAILABLE`, `WORKER_DISABLED`, `RECOVERY_FAILED`, and `UNKNOWN`. Transient transport absence projects `degraded` and a bounded retry operation rather than disabling the worker. Persistent invalid configuration remains an operator error. Repeated automatic recovery is bounded; after three failed attempts the diagnosis becomes `RECOVERY_FAILED` and escalates rather than looping.

Worker-facing recovery semantics are therefore one rule: execute the canonical command; when the response contains a known recoverable `failure_state`, execute its `recovery_operation`; escalate only when the machine response says escalation is required. Workers do not reconstruct lifecycle/lane strings, lease cleanup sequences, or historical recovery narratives.

## Long-running gates

`work.checkpoint` persists bounded progress while an active lease remains authoritative.

`work.heartbeat` may extend a legitimate long-running gate only when:

- the lease is active and unexpired;
- the slot is still owned by the same lease;
- the same `run_id` is used;
- current Linear execution semantics still match the claim-time projection;
- durable checkpoint progress exists;
- the run budget and three-hour hard lease cap still permit extension.

The lease and slot expiry move together and a heartbeat receipt is retained. Repeated heartbeat attempts without materially advanced checkpoint progress are rejected. When the run budget or hard lease horizon prevents extension, the heartbeat checkpoint is already durable and the response is typed `HEARTBEAT_BUDGET_EXHAUSTED` with the exact `work.settle` recovery operation needed to requeue `resume_progress`. The worker executes that prescription rather than attempting another extension or reconstructing cleanup. An expired lease cannot be revived; diagnosis classifies expired/orphaned ownership as `STALE_LEASE` and prescribes the canonical reconciliation path.

## Run finish

Call `orchestration.finish` with the run disposition, last work/gate, and bounded stop reason. If the run still owns a live lease, include truthful `active_lease_settlement` semantics in that same terminal command.

Finish uses the canonical lease settlement state machine before terminalizing the run. It targets the exact lease owned by the run, preserves settlement idempotency and ownership fences, and never guesses `completed`, `requeue`, or `blocked`. If a live lease exists but settlement semantics are omitted, finish fails closed with typed `ACTIVE_LEASE_REMAINS` and prescribes the settlement-aware finish retry. If settlement itself fails, the run remains active and the underlying failure is not hidden. That same lease-liveness definition is reused by abandoned-run reconciliation.

If a worker session disappears without calling `orchestration.finish`, the run deadline remains the lifecycle fence. Once the deadline has elapsed and no live lease remains, deterministic maintenance terminalizes the run as `finished` with disposition `abandoned` and stop classification `UNOBSERVABLE_SESSION_TERMINATION`. This says exactly what the available evidence supports: no session-layer termination reason is observable. It does not infer client cancellation, context/runtime exhaustion, safety interruption, model behavior, or infrastructure failure, and it does not generate a continuing investigation queue unless new session-layer telemetry becomes available.

The user-visible `Portfolio Run Handoff v1` remains a compact human index. It complements this machine handoff and never replaces live authority.

## Deterministic maintenance

`orchestration.maintain` is the bounded self-repair arm of the coordination layer. It may:

- invoke existing expired-slot reconciliation;
- replay an exact stored claiming request with its original idempotency key;
- replay an exact stored settling request with its original idempotency key;
- reconcile an old command-journal row only when the durable receipt's semantic request hash exactly matches the journal invocation;
- reconcile an interrupted `orchestration.start` from an exact request-bound run record, or mark it definitively not applied when the exact run record is conclusively absent after the stuck threshold;
- terminalize an overdue `active` orchestration run as `abandoned` only after atomically revalidating that no unexpired claiming, active, or settling lease remains;
- record every such journal reconciliation append-only in `orchestration_invocation_resolutions` rather than rewriting the historical invocation outcome.

Run terminalization and lease insertion serialize on the same `orchestration_runs` row lock. A concurrent claim therefore either establishes its lease before reconciliation revalidates ownership, or observes the terminal run and fails closed; maintenance cannot finish a run underneath a valid newly acquired lease.

`orchestration.status` exposes `overdue_active_runs` with bounded run coordinates. Any overdue active run is unhealthy until its lifecycle is reconciled; after maintenance clears the condition, health returns to normal when no other unhealthy condition remains.

It must not choose or create work, change priority, invent blockers, make owner decisions, or convert uncertain historical effects into invented certainty. Abandoned-run terminalization is orchestration metadata cleanup, so maintenance continues to report `semantic_work_mutations = 0` and `work_selection_performed = false`. Ambiguous effects without authoritative receipts remain explicitly ambiguous.

A scheduler-only control-plane sweep runs hourly as the durable eventual-quiescence safety net. Dispatcher and interactive maintenance calls may still run opportunistically, but correctness no longer depends on either conversational workers or the Dispatcher remembering to invoke maintenance. The hourly cadence does not redefine lease expiry or infer worker death; it only applies the existing deterministic recovery rules after their authoritative boundaries have been crossed.

## Journal boundary

The run journal records bounded command/target coordinates, request/result hashes, safe projections, timestamps, error classification, retryability, expected-rejection status, and mutation ambiguity. After a correlated command completes durably, the run also records its monotonic last durable activity timestamp/type/sequence for diagnostics. This is evidence of the last observed command completion, never a worker-death timestamp. Run rows may additionally retain declared immutable worker-contract provenance coordinates. The journal does not record prompts, model reasoning, chain of thought, conversation text, credentials, lease tokens, source-file contents, patches, binary content, or full copies of authoritative objects.

The journal never grants execution authority. Linear remains durable work truth; GitHub/Drive remain artifact/repository truth; work leases remain temporary exclusive execution ownership; command-specific receipt state machines remain the safety authority for idempotent mutation recovery.