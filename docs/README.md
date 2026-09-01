# Overcenter documentation

Overcenter's public README explains the product. This directory contains the deeper material for people using, operating, or changing it.

## Start here

If you are new to Overcenter, read these in order:

1. [`../README.md`](../README.md) — what Overcenter is and why it exists.
2. [`architecture/ontology-and-authority.md`](architecture/ontology-and-authority.md) — the canonical vocabulary and source-of-truth boundaries.
3. [`agent-session-contract.md`](agent-session-contract.md) — the normal way a reasoning agent should use Overcenter.

That is enough context for ordinary project work. Runs, leases, journals, receipts, and recovery internals can remain drill-down detail until a specialized workflow needs them.

## Use Overcenter

- [`agent-session-contract.md`](agent-session-contract.md) — inspect, amend, advance, perform bounded agent work, and resume safely.
- [`project-graph-authority-contract.md`](project-graph-authority-contract.md) — how repository-owned desired state becomes an authoritative executable graph.
- [`project-horizon-authority-contract.md`](project-horizon-authority-contract.md) — how transition, milestone, project, release, and portfolio targets scope completion without widening lease ownership.

For exact command inputs and outputs, use the current contracts under [`../mcp/`](../mcp/). The MCP implementation is authoritative when prose and executable schemas disagree.

## Understand the architecture

- [`architecture/ontology-and-authority.md`](architecture/ontology-and-authority.md) — projects, transitions, frontiers, horizons, lifecycle phases, runs, leases, evidence, receipts, settlements, projections, and authority coordinates.
- [`architecture/recovery-kernel-and-self-healing.md`](architecture/recovery-kernel-and-self-healing.md) — deterministic diagnosis, health invariants, recovery, and the boundary where judgment must resume.
- [`execution-evidence-v1-design.md`](execution-evidence-v1-design.md) — the execution-evidence data product and its authority model.

## Contracts versus design history

The documentation tree contains several kinds of material:

- **Architecture** explains the current conceptual model and durable invariants.
- **Contracts** define normative runtime boundaries and authority rules.
- **Design** documents capture approved or explored solution designs.
- **Implementation** documents break designs into executable engineering work.

Design and implementation documents are valuable project history, but they are not automatically statements of current runtime behavior. Prefer the public README, architecture docs, normative contracts, and executable command schemas when learning the present system.

## Authority for documentation claims

Overcenter intentionally avoids making prose a shadow source of truth.

- GitHub repository source is authoritative for repository-owned definitions and code.
- Overcenter is authoritative for runs, leases, settlements, receipts, and recovery state.
- The current `mcp/` and runtime implementation define exact command behavior.
- Documentation explains those boundaries and should be updated when behavior changes.

If a document contradicts an exact executable contract, treat that as documentation drift to fix rather than choosing the prose over the software.

## Contributing to docs

Keep public documentation oriented around user and agent intent. Put deterministic bookkeeping behind semantic boundaries rather than teaching callers to reproduce it manually.

When adding a new document, make its status clear: current architecture/contract, active design, implementation plan, or historical material. Link it from this index only when it helps someone navigate the maintained system.