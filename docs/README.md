# Overcenter documentation

Overcenter's public README explains the product. This directory contains the deeper material for people using, operating, or changing it.

## Start here

If you are new to Overcenter, read these in order:

1. [`../README.md`](../README.md) — what Overcenter is and why it exists.
2. [`architecture/ontology-and-authority.md`](architecture/ontology-and-authority.md) — the canonical vocabulary and source-of-truth boundaries.
3. [`agent-session-contract.md`](agent-session-contract.md) — the normal way a reasoning agent should use Overcenter.
4. [`command-reference.md`](command-reference.md) — the compact primary, advanced, operator, and compatibility command map.

That is enough context for ordinary project work. Runs, leases, journals, receipts, and recovery internals can remain drill-down detail until a specialized workflow needs them.

## Use Overcenter

- [`agent-session-contract.md`](agent-session-contract.md) — inspect, amend, advance, perform bounded agent work, and resume safely.
- [`command-reference.md`](command-reference.md) — which semantic surface to use and what each public command is for.
- [`project-graph-authority-contract.md`](project-graph-authority-contract.md) — how repository-owned desired state becomes an authoritative executable graph.
- [`project-horizon-authority-contract.md`](project-horizon-authority-contract.md) — how transition, milestone, project, release, and portfolio targets scope completion without widening lease ownership.

For exact command inputs and outputs, use the current contracts under [`../mcp/`](../mcp/). The MCP implementation is authoritative when prose and executable schemas disagree.

## Operate and recover

- [`operator-recovery.md`](operator-recovery.md) — the **current** operator path for diagnosis, continuation reconstruction, bounded maintenance, mutation certainty, and authoritative readback.
- [`architecture/recovery-kernel-and-self-healing.md`](architecture/recovery-kernel-and-self-healing.md) — the **approved future-state design** for higher-level health, recovery, fault packets, quarantine, and scheduled healing.
- [`implementation/recovery-kernel-plan.md`](implementation/recovery-kernel-plan.md) — the **active implementation plan** for closing the gap between the current operator path and that architecture.

When operating an incident, use the current operator guide and executable contracts. Do not infer that a command is available merely because it appears in an approved design document.

## Understand the architecture

- [`architecture/ontology-and-authority.md`](architecture/ontology-and-authority.md) — projects, transitions, frontiers, horizons, lifecycle phases, runs, leases, evidence, receipts, settlements, projections, and authority coordinates.
- [`architecture/recovery-kernel-and-self-healing.md`](architecture/recovery-kernel-and-self-healing.md) — approved recovery-kernel architecture and the intended direction for deterministic diagnosis and self-healing.
- [`execution-evidence-v1-design.md`](execution-evidence-v1-design.md) — the execution-evidence data product and its authority model.
- [`design/2026-09-02-legacy-execution-history-retirement.md`](design/2026-09-02-legacy-execution-history-retirement.md) — accepted design for making compact state the sole correctness substrate and retiring legacy execution history safely.

## Document status

The documentation tree contains several kinds of material. The label matters:

| Status | Meaning |
| --- | --- |
| **Current architecture / contract** | Maintained conceptual or normative description of the current system. |
| **Accepted design decision** | A direction that remains relevant, but exact behavior belongs to current source and executable contracts. |
| **Active implementation plan** | Unfinished implementation work; file maps and details may drift as code changes. |
| **Completed / historical implementation record** | Preserved evidence of how shipped work was built; not current caller documentation. |

Current notable records:

- [`design/2026-08-28-typescript-semantic-kernel.md`](design/2026-08-28-typescript-semantic-kernel.md) — **Accepted design decision**.
- [`design/2026-09-02-legacy-execution-history-retirement.md`](design/2026-09-02-legacy-execution-history-retirement.md) — **Accepted design decision** for legacy execution-history retirement.
- [`architecture/recovery-kernel-and-self-healing.md`](architecture/recovery-kernel-and-self-healing.md) — **Accepted future-state architecture**; use the operator recovery guide for the shipped path.
- [`implementation/typescript-semantic-kernel-plan.md`](implementation/typescript-semantic-kernel-plan.md) — **Completed implementation record** for the initial proof slice.
- [`implementation/orchestration-advance.md`](implementation/orchestration-advance.md) — **Historical implementation plan**; the operation has shipped and the current agent contract is documented elsewhere.
- [`implementation/recovery-kernel-plan.md`](implementation/recovery-kernel-plan.md) — **Active implementation plan**.
- [`implementation/compact-execution-authority-retirement.md`](implementation/compact-execution-authority-retirement.md) — **Active implementation plan**, phase A of legacy execution-history retirement.
- [`implementation/telemetry-archive-retirement-readiness.md`](implementation/telemetry-archive-retirement-readiness.md) — **Active implementation plan**, phase B for telemetry, archive, freeze, and retirement readiness.
- [`implementation/destructive-execution-history-retirement.md`](implementation/destructive-execution-history-retirement.md) — **Active implementation plan**, phase C for the guarded destructive retirement.
- [`implementation/retirement-plan-census-contract.md`](implementation/retirement-plan-census-contract.md) — supporting implementation contract for the retirement source census.

Design and implementation documents are valuable project history, but they are not automatically statements of current runtime behavior. Prefer the public README, current architecture docs, normative contracts, command reference, current operator guide, and executable schemas when learning the present system.

## Authority for documentation claims

Overcenter intentionally avoids making prose a shadow source of truth.

- GitHub repository source is authoritative for repository-owned definitions and code.
- Overcenter is authoritative for runs, leases, settlements, receipts, and recovery state.
- The current `mcp/` and runtime implementation define exact command behavior.
- Documentation explains those boundaries and should be updated when behavior changes.

If a document contradicts an exact executable contract, treat that as documentation drift to fix rather than choosing the prose over the software.

## Contributing

Read [`../CONTRIBUTING.md`](../CONTRIBUTING.md) before changing the repository. Keep public documentation oriented around user and agent intent. Put deterministic bookkeeping behind semantic boundaries rather than teaching callers to reproduce it manually.

When adding a new document, give it one of the statuses above and link it from this index only when it helps someone navigate the maintained system.