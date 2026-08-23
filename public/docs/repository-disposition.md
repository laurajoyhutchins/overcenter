# Repository disposition

Repository lifecycle is canonical machine state in Busbar. It exists to answer whether a repository may generate ordinary executable portfolio work without asking an agent to rediscover repository history.

## States

The lifecycle is deliberately small:

- `ACTIVE` — ordinary discovery, projection, Fast Forward, scheduled execution, and active health are eligible.
- `MAINTENANCE` — ordinary work remains eligible, but the repository is understood to be maintenance-oriented rather than active product development.
- `DORMANT` — intentionally parked. Ordinary work, Fast Forward, scheduled execution, and active health are disabled until an explicit lifecycle transition.
- `ARCHIVED` — historical state. Ordinary executable work is prohibited.
- `SUPERSEDED` — historical state whose responsibility moved to a recorded successor. Ordinary executable work in the old repository is prohibited.

Repository disposition has no compatibility exception. Disposed repositories remain historical state; stale callers requesting compatibility work receive `LEGACY_CONTROL_PLANE_RETIRED`.

## Controls model

For operator-facing explanations, Busbar projects repository lifecycle as a simple control circuit. This is a derived view of the canonical lifecycle state, not another authority or another state machine.

- `ACTIVE` and `MAINTENANCE` are **ENERGIZED**. The repository disconnect is **CLOSED**, so ordinary-work permissives may be true.
- `DORMANT`, `ARCHIVED`, and `SUPERSEDED` are **DE_ENERGIZED**. The repository disconnect is **OPEN**, so ordinary work, issue discovery, Linear projection, Fast Forward, and scheduled-worker targeting are inhibited.
- A work item existing in GitHub or Linear is analogous to equipment being present. Presence does not energize it.
- `work.claim` is downstream of the repository disconnect. A lease can establish exclusive execution ownership only after repository and run-scope permissives are satisfied.
- Checkpoint, heartbeat, and settlement revalidate the lifecycle interlock. Opening the repository disconnect while a lease exists invalidates that lease before another execution effect.

The controls projection is intentionally one-way:

```text
canonical repository disposition
            |
            v
   derived controls view
 power + disconnect + permissives
```

Changing descriptive controls language cannot make a repository executable. Only the canonical repository lifecycle transition can change execution eligibility.

A deliberate temporary shutdown follows the same safe sequence as de-energized equipment work:

```text
ACTIVE / MAINTENANCE
        |
        v
explicit transition to DORMANT
        |
        v
de-energized: execution paths inhibited
        |
        v
perform bounded relocation / restructuring work
        |
        v
verify authority, wiring, and execution interlocks
        |
        v
explicit transition to ACTIVE or MAINTENANCE
        |
        v
re-energized
```

Busbar uses this analogy to make the system legible to operators. Canonical API enums, command names, error codes, and persistence fields retain their existing protocol vocabulary.

## GitHub evidence and sticky retirement

GitHub repository state remains authoritative evidence. Observing `archived: true` forces a repository out of active lifecycle and into `ARCHIVED` unless it is already in another disposed state such as `SUPERSEDED`.

A later GitHub unarchive does not silently reactivate a repository. Once disposed, restoration to `ACTIVE`, `MAINTENANCE`, or `DORMANT` requires the explicit lifecycle-transition operation. This prevents one external field change from reintroducing historical work into execution.

Open GitHub issues are historical evidence, not lifecycle authority. An open issue in an `ARCHIVED` or `SUPERSEDED` repository does not become active backlog merely because it remains open.

## Execution invariants

`ARCHIVED` and `SUPERSEDED` repositories must not generate ordinary executable portfolio work. `DORMANT` is also non-executable until explicitly transitioned.

The lifecycle fence is applied in multiple places so stale external state cannot bypass retirement:

- GitHub issue to Linear reconciliation rejects lifecycle-ineligible repositories before creating or updating executable Linear projections.
- advisory orchestration horizons reject lifecycle-ineligible candidates and revalidate stored horizons before reuse, covering Fast Forward and scheduled workers.
- `work.claim` rejects stale executable Linear work for lifecycle-ineligible repositories, while `work.checkpoint`, `work.heartbeat`, and `work.settle` revalidate canonical lifecycle after claim. If a repository becomes `DORMANT`, `ARCHIVED`, or `SUPERSEDED`, the active lease is invalidated and its slot released before any new execution effect. Idempotent readback of an effect already proven to have landed remains available only to reconcile that historical effect.
- health projection classifies disposed repositories as `disposed_as_intended` and dormant repositories as `dormant_as_intended`, excluding both from active-project health scoring.

These are software preconditions. Worker prompts must not reproduce a second lifecycle decision procedure.

## Successors

A `SUPERSEDED` repository may record `successor_repository` when the architecture establishes a real transfer of responsibility. The successor coordinate answers where the responsibility moved. It does not create synchronization, mirroring, dependency, or maintenance obligations between old and new repositories.

Current explicit successor:

- `laurajoyhutchins/building-code-dashboard` → `laurajoyhutchins/building-code-map`

No successor is invented when there is no supported architectural relationship.

Historical compatibility exceptions are retired. `laurajoyhutchins/agent-team-context-bridge` remains archived historical evidence and is not eligible for compatibility work.

## Operations

Admin HTTP surfaces:

- `GET|POST /api/portfolio-repository-status` — observe lifecycle plus a retirement verification packet.
- `POST /api/portfolio-dispose-repository` — deterministic repository retirement.
- `POST /api/portfolio-repository-transition` — explicit lifecycle transition, including deliberate reactivation.
- `POST /api/portfolio-compatibility-check` — retired compatibility tombstone; returns `LEGACY_CONTROL_PLANE_RETIRED`.

Equivalent live MCP surfaces are `portfolio_repository_status`, `portfolio_dispose_repository`, and `portfolio_repository_transition`. There is no compatibility MCP operation.

`portfolio.dispose_repository` is intentionally narrow. It observes GitHub archival state, commits canonical disposition, disables ordinary eligibility through that state, retires exact stale Linear execution projections by canceling when necessary and archiving rather than deleting, invalidates active work leases, records a supplied successor when applicable, and returns a fresh verification packet. Lifecycle state is written before cleanup so new ordinary work cannot enter while retirement is reconciling existing state.

The operation does not delete GitHub repositories, close historical GitHub issues, erase discussions, or copy a retired repository elsewhere.

## Verification packet

A retired repository packet reports the machine facts agents previously reconstructed by hand, including:

- repository and disposition
- successor or none
- GitHub archived observation
- ordinary-work eligibility
- Linear projection eligibility and active/historical Linear coordinates
- scheduled-worker and Fast Forward eligibility
- issue-discovery eligibility
- active lease evidence
- active-health classification

For a normal archived repository the intended end state is equivalent to:

```text
GitHub repository: archived
portfolio disposition: ARCHIVED
ordinary work: prohibited
Linear projection: disabled
scheduled workers: none
Fast Forward: ineligible
active health: excluded
history: preserved
```

## Preservation boundary

Retirement is allocation control, not historical erasure. Preserve Git history, GitHub issues and discussions, release history, provenance, useful experiments, and explicit compatibility coordinates.

Do not use `junk-drawer` as a repository graveyard. An archived GitHub repository already preserves its repository history. Move or copy only an independently useful artifact when there is a real live destination for it; do not create repository-within-repository archival copies.
