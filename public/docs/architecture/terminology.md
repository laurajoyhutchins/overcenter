# Portfolio Control Plane terminology

This document is the canonical vocabulary for human-facing Portfolio Control Plane documentation, UI, handoffs, and agent instructions.

Canonical sentence:

> The **Portfolio Control Plane** is implemented as a **GitHub App**, currently deployed on **Hatchable**.

## Canonical terms

| Term | Meaning |
|---|---|
| **Portfolio Control Plane** | The logical orchestration and control system: work coordination, bounded execution ownership, commands, recovery, reconciliation, and evidence contracts. |
| **Portfolio Control Plane GitHub App** | The running GitHub App that implements the Portfolio Control Plane and performs its GitHub-facing operations. |
| **Hatchable project** | The Hatchable project that contains and deploys the Portfolio Control Plane GitHub App. This is a hosting/container identity, not the logical control plane. |
| **Hatchable deployment** | One deployed version of the Portfolio Control Plane GitHub App on Hatchable. |
| **GitHub App installation** | The GitHub-side installation that grants the Portfolio Control Plane GitHub App repository access and permission scopes. |
| **control-plane state** | Durable coordination state owned by the application, including orchestration runs, leases, checkpoints, receipts, journals, and recovery evidence. |
| **scheduled task** | A ChatGPT scheduler entry that triggers work. It is not a worker session or orchestration run. |
| **worker** | A named execution role such as Repository Implementation or Exact-Head Verification. |
| **worker session** | One disposable ChatGPT execution of a worker. A scheduled task firing or interactive Fast Forward invocation may start one. |
| **orchestration run** | The durable control-plane run record identified by `run_id`. It can outlive the worker session that created it. |
| **work item** | A durable unit of portfolio work represented in Linear. |
| **lease** | Temporary control-plane execution authority over one exact work gate. |
| **command** | A semantic Portfolio Control Plane operation such as `work.claim` or `github.apply_changeset`. |
| **transport** | The mechanism used to invoke a command, such as MCP or HTTP. |
| **endpoint** | A concrete HTTP route. |
| **tool** | An agent-callable surface that exposes a command or operation. |
| **GitHub operation** | The underlying GitHub API read or mutation performed by the GitHub App. |
| **Portfolio Control Plane source repository** | The GitHub repository containing the mirrored source representation of the deployed GitHub App. Hatchable remains deployment authority unless explicitly changed. |

## Deprecated aliases

Do not introduce these phrases in current human-facing text:

- **Hatchable Portfolio Control Plane**: conflates hosting provider with the logical system and GitHub App identity.
- **Hatchable control plane** when referring to the Portfolio Control Plane: use **Portfolio Control Plane** or **Portfolio Control Plane GitHub App** as appropriate.
- **Portfolio Control Plane App** when the GitHub identity is intended: use **Portfolio Control Plane GitHub App**.
- **task**, **session**, **worker**, and **run** as interchangeable execution nouns: choose the exact canonical term.

Historical records may quote former names when needed to preserve evidence. Stable API names, database fields, IDs, receipt schemas, and migration history are not renamed solely for terminology consistency.

## Current deployment identity

- Logical system: **Portfolio Control Plane**
- Application: **Portfolio Control Plane GitHub App**
- Hosting: **Hatchable**
- Hatchable project ID: `proj_I6FSm85xrY7T`

This vocabulary changes human interpretation, not authority boundaries or protocol semantics.