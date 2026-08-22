# Portfolio Control Plane surface inventory

Classification refreshed after the Linear-native orchestration migration on 2026-08-19 UTC and repository-disposition hardening on 2026-08-22 UTC. Current authority model verified against the live control plane. Canonical naming is defined in [`architecture/terminology.md`](architecture/terminology.md); repository lifecycle semantics are defined in [`repository-disposition.md`](repository-disposition.md).

## Architectural boundary

The **Portfolio Control Plane** is the logical control system. The **Portfolio Control Plane GitHub App** is its running application, currently deployed as Hatchable project `proj_I6FSm85xrY7T`. Hatchable is the hosting/runtime layer, not a separate portfolio authority.

Linear `Ljh-projects` owns durable work identity, readiness/lifecycle, semantic lane, priority, dependencies, acceptance boundaries, and optional campaign/project structure. `Todo` is durable readiness only and may be unclaimed or held by a live control-plane lease. GitHub owns repository/code truth and supplies authoritative repository archival evidence. Google Drive owns retained binary/private objects. The Portfolio Control Plane GitHub App owns canonical repository disposition derived from that evidence plus explicit lifecycle transitions/successor metadata, exclusive execution leases/slots, bounded orchestration-run continuity, checkpoints, mechanical external-effect transports, and reconciliation/recovery evidence. It does not choose or prioritize work.

## CURRENT_KERNEL

API routes:
- `/api/orchestration/start`
- `/api/orchestration/finish`
- `/api/orchestration/resume-packet`
- `/api/orchestration/diagnose`
- `/api/orchestration/horizon-checkpoint`
- `/api/orchestration/horizon-resolve`
- `/api/orchestration/maintain`
- `/api/orchestration/status`
- `/api/worker-command` — semantic connector bridge for runtimes that can invoke Hatchable functions but do not receive the generated MCP namespace
- `/api/work/claim`
- `/api/work/checkpoint`
- `/api/work/heartbeat`
- `/api/work/settle`
- `/api/portfolio-repository-status`
- `/api/portfolio-dispose-repository`
- `/api/portfolio-repository-transition`

Retired API guard:
- `/api/portfolio-compatibility-check` — returns `LEGACY_CONTROL_PLANE_RETIRED`; no compatibility work is admitted.

Canonical MCP lifecycle tools:
- `orchestration.start`
- `orchestration.finish`
- `orchestration.horizon_checkpoint`
- `orchestration.horizon_resolve`
- `orchestration.maintain`
- `orchestration.resume_packet`
- `orchestration.diagnose`
- `orchestration.status`
- `work.claim`
- `work.checkpoint`
- `work.heartbeat`
- `work.settle`
- `portfolio_repository_status`
- `portfolio_dispose_repository`
- `portfolio_repository_transition`

Kernel libraries include canonical repository lifecycle/disposition and health projection, durable run records, advisory horizons, work leases/checkpoints/heartbeats, command journaling, append-only invocation resolutions, typed orchestration failure/recovery classification, deterministic diagnosis, orchestration recovery/status, command response classification, and canonical hashing. Repository disposition fences GitHub-to-Linear admission, horizon reuse, work claiming, scheduled/Fast Forward eligibility, and active-health classification. Diagnosis derives recovery attempts and worker health from existing evidence; it does not add a recovery queue, planner, or second authority store.

## CURRENT_TRANSPORT

Retain the bounded mechanical transports used by the live orchestration architecture:
- GitHub app changesets and text staging/application
- GitHub exact-coordinate pull-request creation through `github.pull_request.create` / `github_pull_request_create`, with explicit draft intent, duplicate detection, ambiguous-create reconciliation, and same-installation actor evidence
- GitHub exact-head draft graduation through `github.pull_request.mark_ready` / `github_pull_request_mark_ready`, with same-token actor-authorization preflight and no user-OAuth fallback
- GitHub review packet, read-only App capability projection, branch deletion, Actions storage, required-check reconciliation, branch-policy reconciliation, stack reconciliation, default-branch migration, and bounded job-log inspection
- terminal Linear issue archive
- narrow Linear maintenance for label retirement/restoration, project archive/restore, and the required started-state placeholder rename/archive operations
- GitHub-issue to Linear `portfolio.reconcile_work_surface`
- deterministic repository retirement/verification through `portfolio.dispose_repository` plus lifecycle status/transition surfaces; the former compatibility check is a retirement tombstone only
- retained-object capture/read surfaces

These transports may mutate or inspect an already-selected exact target. They do not select, rank, prioritize, or create portfolio demand by policy. Repository retirement preserves historical evidence and disables ordinary allocation; it is not a repository-deletion or history-migration platform.

## CURRENT_VERIFICATION

Retain one explicit admin-only regression runner at `POST /api/verification/regressions`. It executes the command-response, orchestration, work-lease, repository-disposition/disposal, GitHub integration, pull-request creation/readiness, Linear, scheduled-cycle, portfolio-reconciliation, and source-sync regression suites while keeping verification truth in the JSON `ok`/`failed` fields.

HTTP status on the verification route represents runner transport/execution only. A completed regression run returns HTTP 200 even when one or more tests fail, with `ok: false` and nonzero `failed`. Unexpected runner execution failures may return 5xx. This keeps Hatchable production server-error monitoring reserved for actual route/runtime failures instead of deterministic test assertions.

Do not expose individual `lib/*.test.js` runners as `/api/diagnostics/*` routes. The operator dashboard remains a read-only current-kernel health view backed by `/api/orchestration/status`; regression verification is separate from operational health.

## COMPATIBILITY_TEMPORARY

The low-level HTTP request shapes for work claim/checkpoint/heartbeat/settle remain available as the advanced/internal compatibility surface. They continue accepting explicit idempotency keys and wire-format fields, including legacy explicit state/lane preconditions where needed by proven non-semantic callers. The worker-facing MCP layer is the canonical ergonomic surface and derives protocol bookkeeping internally. Worker-facing `work.claim` accepts the server-issued authoritative revision as `observed_revision` and does not accept caller-reconstructed lifecycle or lane strings. `/api/worker-command` is a transport-equivalent semantic facade for connected runtimes that cannot see the generated MCP tool namespace; it accepts only semantic input fields and rejects caller-owned wire bookkeeping. For connector callers, claim returns a non-secret UUID `lease_ref` while the opaque lease capability remains server-side; checkpoint, heartbeat, and settlement use that reference. Native MCP callers continue using the capability-token contract unchanged.

Repository compatibility exceptions are retired. Disposed repositories remain outside ordinary compatibility transport, and stale compatibility requests fail explicitly with `LEGACY_CONTROL_PLANE_RETIRED`.

Deletion condition: remove a low-level work-protocol compatibility field only after all non-MCP callers are proven migrated and a removal provides material simplification without weakening recovery or retry identity.

## LEGACY_DELETE

The following belong to the abandoned Aug. 2 source-neutral shadow portfolio projection architecture and are not part of the current authority model:

API routes:
- `/api/entities`
- `/api/entity`
- `/api/observations`
- `/api/reconcile`
- `/api/owner-decisions`
- `/api/request-owner-decision`
- `/api/search`
- `/api/status`
- `/api/work-outcome`
- `/api/next-work` historical disabled function record
- root `/api/diagnostics` for the shadow reconciler

MCP tools:
- `fetch`
- `search`
- `record_work_outcome`
- `request_owner_decision`

Libraries:
- `lib/store.js`
- `lib/reducer.js`
- `lib/work-service.js`
- `lib/diagnostics.js`

Database tables:
- `portfolio_observations`
- `portfolio_entity_projections`
- `portfolio_reconciliation_runs`

Dashboard code that reads the shadow entity/owner-decision/status routes is legacy and will be replaced by current orchestration health.

Evidence for deletion:
- the three legacy tables contain retained historical rows but their newest activity is 2026-08-02;
- the only current HTTP traffic to `/api/entities`, `/api/status`, and `/api/owner-decisions` is generated by the old dashboard page itself;
- the other listed legacy routes have no recent live calls;
- the only scheduled task referencing `/api/observations`, root `/api/diagnostics`, or `/api/next-work` is disabled `Portfolio Source Ingestion` from 2026-08-02;
- all five enabled portfolio automations use the current orchestration/work kernel instead;
- source import tracing shows the legacy libraries are called only by the legacy API/MCP/diagnostic surfaces above.

Historical migrations that created the legacy schema are retained. Obsolete tables may be removed only through a new forward migration.

## Diagnostic routes to delete

Per-capability diagnostic routes that merely wrap deterministic in-project tests or one-time integration probes are development scaffolding rather than production operational interfaces. The current source tree removes those individual diagnostic wrappers and consolidates deterministic regression verification under `/api/verification/regressions`. Durable external-effect receipts/reconciliation tables and production status projections remain intact.