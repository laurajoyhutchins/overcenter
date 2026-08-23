# Linear Execution Projection Design

## Intent

Linear is a bounded execution projection over authoritative work. Repository/GitHub own implementation demand and history. The Portfolio Control Plane owns work identity, leases, lifecycle transitions, exact-head continuation, receipts, orchestration state, and deterministic settlement. Linear exposes only work a worker or human can act on now, plus concise authority links and true blockers.

## Admission predicate

A candidate is eligible for ordinary Linear execution only when all are true:

1. it names one bounded outcome;
2. it names one concrete next action;
3. the declared actor can perform that action now;
4. the action is not deterministic bookkeeping;
5. the candidate has one canonical executable identity;
6. completion changes authoritative state or produces required evidence;
7. the repository permits ordinary work;
8. the authoritative source remains open/current;
9. the bounded frontier has capacity.

The machine disposition is one of:

- `KEEP_EXECUTABLE`
- `BLOCKED_EXTERNAL`
- `WAITING_HUMAN`
- `DERIVED_STATE`
- `HISTORICAL_REFERENCE`
- `SUPERSEDED`
- `DUPLICATE`
- `DISPOSED_REPOSITORY`
- `NO_EXECUTABLE_ACTION`

Only the first three are non-terminal work-surface states. `KEEP_EXECUTABLE` projects as `Todo`. External or human waits project as `Backlog` with a concise promotion condition. Other dispositions are excluded or truthfully terminalized.

## Minimal packet

The reconciler accepts a small execution contract rather than lifecycle prose:

```yaml
source:
  kind: github_issue
  repo: owner/repo
  issue_number: 123
  unit_key: optional-roadmap-unit
projection:
  title: bounded outcome title
  lane: lane:repo-implementation
  priority: 2
  outcome: one bounded executable result
  next_action: concrete action
  actor: worker
  changes_authority_or_produces_evidence: true
  disposition: KEEP_EXECUTABLE
  dependencies: []
  promotion_condition: null
```

Linear description materialization is deliberately small: repository, authority reference, outcome, next action, and promotion condition when blocked. Exact heads, PR topology, leases, run IDs, command receipts, historical narratives, and verification evidence remain at their real authorities.

The current executable gate is sized as one agent handoff. `work.claim` fails closed before lease creation when a `Todo` execution-lane issue lacks either `Outcome` or `Next action`. If the current gate still requires decomposition before a worker can act, it is not handoff-ready and must be bounded before it becomes executable. The durable issue may later be rewritten to the next lane after settlement; the invariant applies to the current gate, not to the issue's entire lifetime.

## Durable identity and phase collapse

The existing `portfolio_work_identity` mapping remains the durable Linear identity. `source.unit_key` distinguishes bounded units backed by one roadmap issue. Optional `canonical_key` can collapse multiple source observations onto one executable identity.

Implementation, verification, and integration are phases of that identity. Existing `work.claim` / `work.settle` transitions move the same Linear issue through lane changes while exact-head continuation stays in the control plane. Reconciliation never creates a new issue directly in verification or integration.

## Eviction

An existing projected issue leaves ordinary selection when its source closes, its repository is disposed, its disposition becomes terminal/non-executable, a deterministic predicate settles, or stale authority data attempts to resurrect an already-terminal identity. Source closure maps to Done. Superseded/disposed/no-action maps to Canceled unless a stronger authoritative completion fact exists. Duplicates map to Duplicate.

Active leases block mutation except deterministic settlement after the relevant lease is absent.

## Deterministic verification

Machine-checkable gates are evaluated in software and produce durable verification receipts. The scheduled-cycle integration reconciler is the existing periodic hook for scheduled-cycle predicates; it does not create a second work queue. `LJH-117` is the first regression case: three healthy complete post-wiring cycles satisfy its remaining gate and terminalize the work without a reasoning-agent verification ticket.

## Historical incidents

Incident/postmortem records keep their documents, relations, and IDs but do not remain ordinary executable work merely because their history matters. `LJH-116` is preserved as historical state while executable corrective actions remain separate durable identities.

## Bounded roadmap frontier

Large campaigns remain authoritative in GitHub/repository data. Linear projects may declare a small frontier bound. `U.S. Jurisdiction Coverage` is bounded to three active projected units. Reconciliation counts the actual non-terminal issues in that Linear project, refuses excess admission, and admits the next unit after capacity opens.

## Idempotency and resurrection safety

Repeated reconciliation must not duplicate a source/unit identity, recreate terminal work, exceed a configured frontier, project work from disposed repositories, or manufacture phase tickets. Terminal Linear state plus the durable source mapping is the resurrection barrier.