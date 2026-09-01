# orchestration.advance implementation plan

> **Document status: Historical implementation plan.** `orchestration.advance` and the higher-level `project.advance` surface have shipped. This file preserves the implementation path; use [`../agent-session-contract.md`](../agent-session-contract.md), [`../command-reference.md`](../command-reference.md), and current `mcp/` contracts for caller behavior.

## Goal

Expose one production `orchestration.advance` semantic operation that accepts only a targeted `run_id`, rereads authoritative project-graph state, selects and acquires one READY transition deterministically, and advances it as far as Overcenter can prove without caller-authored graph or lifecycle state.

## Invariants

- GitHub remains repository/project-definition authority.
- Overcenter remains run, transition-lease, lifecycle-evidence, settlement, and recovery authority.
- Linear is not required for graph-native transition identity or ownership.
- Agent execution receives only a bounded non-secret `lease_ref`; capability tokens stay inside Overcenter.
- Active project-transition leases are ownership, not partial graph completion observations.
- Only a compatible completed project-transition settlement may project a transition to DONE.
- Occupied READY transitions are filtered mechanically inside the command rather than exposed as claim-probe work.
- No caller-supplied graph, frontier membership, transition state, successor lane, or completion boolean is accepted.

## Tasks

1. Add RED coverage to the registered target-runtime suite for agent handoff, contention, deterministic completion, and failed confirmation.
2. Implement a small `lib/orchestration-advance.js` composition service over the existing run target, project horizon evaluator, project-transition lease service, and operator execution boundary.
3. For an agent transition, acquire exact transition authority and return `AGENT_EXECUTION_REQUIRED` with the transition identity, executor role/skill, authoritative coordinate, and non-secret `lease_ref`. Do not settle or invent EXECUTE success.
4. For deterministic operators, execute the registered canonical command under the acquired lease, settle the transition only after successful execution, reread the graph, and return `TRANSITION_CONFIRMED` only when the refreshed node is DONE.
5. Treat `PROJECT_TRANSITION_ALREADY_LEASED` as candidate occupancy: try the next deterministic READY candidate; if all are occupied, return `WAITING`.
6. Return `PROJECT_COMPLETE`, `OFF_NOMINAL`, or `WAITING` directly from authoritative horizon state when no transition should be acquired.
7. Bind the service into the Postgres target runtime and expose `api/orchestration/advance.js` plus `mcp/orchestration.advance.js`, with an exact input schema containing only `run_id`.
8. Add the command to canonical JS/TypeScript command descriptors, semantic worker transport, and safe journal projections without exposing lease capability material.
9. Reuse the existing lease-reference mutation authority path. Do not add a new project-phase checkpoint protocol in this issue.
10. Run focused verification, the canonical regression suite, exact-revision verification, integration, post-merge verification, production materialization, and a live targeted dogfood call before claiming completion.

## Scope boundary

Agent-phase durable resume beyond the existing transition lease/evidence model is not introduced here. Live graph-definition revision reconciliation remains owned by #221. Successive-transition driving remains owned by #137.