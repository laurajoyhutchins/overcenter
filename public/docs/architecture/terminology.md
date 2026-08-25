# Overcenter terminology

This document is the canonical vocabulary for human-facing Overcenter documentation, UI, handoffs, and agent instructions.

Canonical sentence:

> **Overcenter** is the orchestration and execution system for verified project state transitions. It is implemented as a **GitHub App** and currently deployed on **Hatchable**.

## Canonical terms

| Term | Meaning |
|---|---|
| **Overcenter** | The logical orchestration and execution system: work coordination, bounded execution ownership, commands, deterministic recovery, reconciliation, and evidence contracts. |
| **Overcenter GitHub App** | The running GitHub App identity that implements Overcenter and performs its GitHub-facing operations. Use this longer form only when the GitHub application identity matters. |
| **Hatchable project** | A Hatchable project that contains and deploys Overcenter. This is a hosting/container identity, not a project or repository authority. |
| **Hatchable deployment** | One deployed version of Overcenter on Hatchable. |
| **GitHub App installation** | The GitHub-side installation that grants the Overcenter GitHub App repository access and permission scopes. |
| **orchestration state** | Durable coordination state owned by Overcenter, including orchestration runs, leases, checkpoints, receipts, journals, and recovery evidence. |
| **scheduled task** | A scheduler entry that gives Overcenter another opportunity to make progress. It is not itself the execution authority or a persistent worker. |
| **worker** | A reasoning executor selected for work that requires judgment, research, synthesis, design, or novel implementation. |
| **worker session** | One disposable execution of a worker. |
| **orchestration run** | The durable Overcenter run record identified by `run_id`. It can outlive a worker session. |
| **work item** | A durable unit of currently executable work projected through Linear. |
| **lease** | Temporary Overcenter execution authority over one exact work gate. |
| **command** | A semantic Overcenter operation such as `work.claim` or `github.apply_changeset`. |
| **transport** | The mechanism used to invoke a command, such as MCP or HTTP. |
| **endpoint** | A concrete HTTP route. |
| **tool** | An agent-callable surface that exposes a command or operation. |
| **GitHub operation** | The underlying GitHub API read or mutation performed by the GitHub App. |
| **Overcenter source repository** | The authoritative GitHub repository containing Overcenter source for a deployment. |
| **energized** | Operator-facing controls term for a repository whose canonical lifecycle currently permits ordinary execution. Today this means `ACTIVE` or `MAINTENANCE`. It is a derived description, not a separate lifecycle state. |
| **de-energized** | Operator-facing controls term for a repository whose canonical lifecycle inhibits ordinary execution. Today this means `DORMANT`, `ARCHIVED`, or `SUPERSEDED`. It is a derived description, not a separate lifecycle state. |
| **disconnect / breaker** | Controls analogy for the repository lifecycle fence. `CLOSED` corresponds to an energized repository; `OPEN` corresponds to a de-energized repository. Do not rename the canonical lifecycle API around this analogy. |
| **permissive** | A machine-evaluated precondition that must be satisfied before an execution path is eligible, such as repository lifecycle, run scope, lane, or revision fencing. |
| **interlock** | A machine-enforced condition that prevents or invalidates execution when a safety or authority prerequisite is no longer true. |

## Authority vocabulary

Use these distinctions consistently:

- **GitHub repository authority** means repository content, repository identity, exact revisions, pull requests, checks, and other GitHub-owned repository facts.
- **Overcenter execution authority** means bounded execution ownership and the durable evidence needed to perform, reconcile, or settle work safely.
- **Linear projection** means a current view of executable work. It is not repository authority or a parallel execution/evidence store.
- **Hatchable hosting** means the runtime container/deployment surface. Hosting state does not become repository authority.

## Controls analogy

Workers are operator-like reasoning executors, not the control system. They may select, request, research, design, and implement bounded work. Overcenter owns the execution permissives, interlocks, exclusive leases, lifecycle fences, and safe state transitions that determine whether those requested actions may actually proceed.

Use the controls analogy when it improves human comprehension of system state, especially in diagrams and operator surfaces. Keep protocol names literal and stable. For example, say that `DORMANT` is de-energized and that `work.claim` is downstream of the lifecycle permissive; do not replace `DORMANT` with a new machine enum such as `BREAKER_OPEN`.

## Obsolete current-system names

Do not introduce these phrases as current names:

- **Busbar**
- **Hatchable Portfolio Control Plane**
- **Hatchable control plane** when referring to Overcenter
- **Portfolio Control Plane** when referring to the current product/system
- **Portfolio Control Plane GitHub App**
- **Portfolio Control Plane App**
- **Portfolio Orchestration App**

Historical records may quote former names when needed to preserve evidence. Stable API names, database fields, generic portfolio-domain terms, receipt schemas, and migration history are not renamed solely for product-name consistency.

In particular, `portfolio.*` commands and `portfolio_*` tables describe the portfolio domain and remain valid. Do not treat them as obsolete product aliases.

Deployment-specific project IDs, repository coordinates, installation IDs, and actor identities are installation facts. They do not belong in this canonical product vocabulary.
