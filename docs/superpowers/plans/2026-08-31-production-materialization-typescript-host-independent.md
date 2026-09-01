# TypeScript production materialization implementation plan

**Goal:** Make production source materialization a TypeScript-first, host-independent semantic operation while preserving GitHub source authority, exact-revision fencing, deterministic receipts/evidence, monotonic mutation certainty, and the existing Hatchable production path.

**Architecture:** Author the materialization operation and host port contract under `src/semantic/`. Keep provider mechanics under `src/runtime/` and routed MCP/API shells in JavaScript. Reuse the existing production materialization behavior as the compatibility oracle, but move decision-making about desired source, staging/deployment state transitions, and postcondition requirements into the typed kernel. The Hatchable adapter supplies observations and effects only.

## TDD sequence

1. Add compile-only tests for `production.materialize({repo})`, the host-neutral materialization ports, no-op behavior, verified success, and mutation-indeterminate failures after the first runtime write.
2. Confirm RED because the semantic operation and runtime adapter do not exist.
3. Implement the minimal typed semantic operation and runtime adapter interfaces.
4. Add `production.materialize` to the canonical command registry and primary semantic discovery, using the existing generated-runtime mechanism for runtime-bearing command metadata.
5. Bind the existing Hatchable production materialization machinery behind the new host port without importing Hatchable into `src/semantic/`.
6. Verify strict TypeScript, generated-JS drift checks, repository regressions, portable Node/Postgres checks, and exact-revision V8 verification on the same head.
7. Merge only when all required checks pass. Settle the graph transition only with exact merged evidence; do not claim live source projection unless immutable deployment evidence proves it.

## Required invariants

- Caller input is repository identity only.
- GitHub production head is derived, never caller-selected.
- No-op performs no runtime mutation.
- Once any runtime write/stage/deploy effect begins, later uncertainty is mutation-indeterminate (`may_have_mutated: true`).
- Success requires immutable deployment verification, not mutable workspace readback.
- Semantic kernel has no Hatchable imports or Hatchable credential knowledge.
- Existing JS compatibility paths remain generated/thin where runtime constraints require them; no second hand-maintained semantic implementation.
