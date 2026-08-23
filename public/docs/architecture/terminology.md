# Busbar terminology

This document is the canonical vocabulary for human-facing Busbar documentation, UI, handoffs, and agent instructions.

Canonical sentence:

> **Busbar** is the portfolio orchestration and execution system. It is implemented as a **GitHub App** and currently deployed on **Hatchable**.

## Canonical terms

| Term | Meaning |
|---|---|
| **Busbar** | The logical portfolio orchestration and execution system: work coordination, bounded execution ownership, commands, deterministic recovery, reconciliation, and evidence contracts. |
| **Busbar GitHub App** | The running GitHub App identity that implements Busbar and performs its GitHub-facing operations. Use this longer form only when the GitHub application identity matters. |
| **Hatchable project** | The Hatchable project that contains and deploys Busbar. This is a hosting/container identity, not a separate portfolio authority. |
| **Hatchable deployment** | One deployed version of Busbar on Hatchable. |
| **GitHub App installation** | The GitHub-side installation that grants the Busbar GitHub App repository access and permission scopes. |
| **orchestration state** | Durable coordination state owned by Busbar, including orchestration runs, leases, checkpoints, receipts, journals, and recovery evidence. |
| **scheduled task** | A scheduler entry that gives Busbar another opportunity to make progress. It is not itself the execution authority or a persistent worker. |
| **worker** | A reasoning executor selected for work that requires judgment, research, synthesis, design, or novel implementation. |
| **worker session** | One disposable execution of a worker. |
| **orchestration run** | The durable Busbar run record identified by `run_id`. It can outlive a worker session. |
| **work item** | A durable unit of currently executable work projected through Linear. |
| **lease** | Temporary Busbar execution authority over one exact work gate. |
| **command** | A semantic Busbar operation such as `work.claim` or `github.apply_changeset`. |
| **transport** | The mechanism used to invoke a command, such as MCP or HTTP. |
| **endpoint** | A concrete HTTP route. |
| **tool** | An agent-callable surface that exposes a command or operation. |
| **GitHub operation** | The underlying GitHub API read or mutation performed by the GitHub App. |
| **Busbar source repository** | The authoritative GitHub repository containing Busbar source. |

## Obsolete current-system names

Do not introduce these phrases as current names:

- **Hatchable Portfolio Control Plane**
- **Hatchable control plane** when referring to Busbar
- **Portfolio Control Plane** when referring to the current product/system
- **Portfolio Control Plane GitHub App**
- **Portfolio Control Plane App**
- **Portfolio Orchestration App**

Historical records may quote former names when needed to preserve evidence. Stable API names, database fields, generic portfolio-domain terms, IDs, receipt schemas, and migration history are not renamed solely for product-name consistency.

In particular, `portfolio.*` commands and `portfolio_*` tables describe the portfolio domain and remain valid. Do not treat them as obsolete product aliases.

## Current deployment identity

- Logical system: **Busbar**
- Application identity when explicit: **Busbar GitHub App**
- Hosting: **Hatchable**
- Hatchable project ID: `proj_I6FSm85xrY7T`
- Canonical source repository: `laurajoyhutchins/busbar`

This vocabulary changes product identity, not authority boundaries or protocol semantics.
