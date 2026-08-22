# Linear-Native Orchestration Design

## Objective

Simplify Portfolio Control Plane by making Linear the durable planning/executable-work graph without using Linear lifecycle state as runtime ownership.

## Authority

- Linear owns durable work identity, readiness (`Todo`/`Backlog`/terminal), campaign/project membership, milestones, priority, dependencies, and semantic lane.
- Hatchable owns run identity, leases, exclusivity, heartbeats, checkpoints, continuation, settlement receipts, recovery, and command history.
- GitHub owns repository/code/PR/review/integration truth.
- Source systems and Drive own retained evidence/source objects.

## Core changes

1. `work.claim` must no longer mutate a `Todo` Linear issue to `In Progress`. The Hatchable lease slot is the sole ownership authority.
2. Settlement mutates Linear only when durable work state actually changes: block, successor lane, completion, cancellation/duplicate when explicitly supported.
3. Preserve compatibility for legacy leases whose claim receipt proves they used the old `In Progress` protocol until no live legacy lease exists.
4. Generalize orchestration scope from one required project name to one team plus optional project IDs/names, lanes, and repositories. Empty project scope means any eligible project in the team.
5. Generalize GitHub→Linear work-surface reconciliation so admitted work can target an explicit campaign project rather than the single `Portfolio Orchestration` project.
6. Retire obsolete routing taxonomy after runtime cutover. Keep only semantic execution lanes: `lane:repo-implementation`, `lane:source-implementation`, `lane:verification`, `lane:integration`.
7. Retire `LJH-83` and remove `In Progress` semantics only after runtime and active work no longer depend on them. Implementation note: Linear requires at least one started-category state per team; after the final-state archive was rejected without mutation, the state was renamed `Started (unused)` and explicitly documented as non-authoritative.

## Safety

- Claim remains fenced by authoritative Linear execution projection/fingerprint and the Hatchable slot uniqueness boundary.
- Material Linear edits after claim continue to invalidate settlement; comment-only/evidence-only revisions remain tolerated under existing execution-fingerprint rules.
- Legacy lease settlement/recovery remains supported during the compatibility window.
- No webhook subsystem is added unless it later deletes a polling/reconciliation burden.
- No generic Linear GraphQL escape hatch is exposed to workers.

## Migration order

1. Add tests for non-mutating claims and legacy settlement compatibility.
2. Change lease implementation and recovery semantics.
3. Generalize run scope to team + optional projects.
4. Generalize work-surface reconciliation project targeting.
5. Deploy and verify live canaries.
6. Migrate Linear campaign structure and retire legacy routing/status surfaces only after runtime verification.