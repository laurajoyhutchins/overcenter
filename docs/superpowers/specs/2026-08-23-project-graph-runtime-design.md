# Overcenter Project Graph Runtime Design

## Objective

Add the missing deterministic layer above Overcenter's existing five-stage work lifecycle so Overcenter can derive the currently executable project frontier from authoritative state instead of relying on scheduled prompts or worker-selected routing.

A project is a dynamically refined execution graph. Each node is one verifiable state transition. Edges express prerequisite predicates between nodes. The existing `ENABLE -> ACQUIRE -> EXECUTE -> COMMIT -> CONFIRM` lifecycle remains the execution protocol inside a node; the graph determines which nodes may execute.

## Scope of the first slice

This slice implements a pure, deterministic project-graph kernel. It does not add persistence, a public API, a scheduler, Linear mutation, agent dispatch, or graph amendment storage.

The kernel accepts an in-memory graph description and returns a normalized graph evaluation containing:

- each node's lifecycle resolution;
- whether the node is complete, ready, waiting on prerequisites, or off-nominal;
- exact unmet prerequisite node IDs;
- a deterministic ready frontier;
- whether the whole graph is complete.

A later slice can persist graph state and make the controller tick invoke this kernel.

## Node contract

Each node contains:

- `id`: unique non-empty string;
- `priority`: optional integer, default `0`;
- `requires`: optional array of prerequisite node IDs;
- `lifecycle`: the existing `resolveWorkLifecycle` input (`current_stage`, optional `condition`, and `responsibilities`);
- `executor`: one typed execution descriptor.

Supported executor kinds in this slice are:

- deterministic operator: `{ kind: "operator", command: "..." }`;
- reasoning worker: `{ kind: "agent", role: "...", skill: "..." }`.

An agent executor must name a skill. This keeps skills as operating procedures rather than duplicating their procedures inside graph data.

The graph kernel does not execute the descriptor. It only validates and projects it into the frontier.

## Frontier semantics

A node is `DONE` when the lifecycle resolver reports `complete: true`.

A non-complete node is `OFF_NOMINAL` when its lifecycle condition is not `NOMINAL`.

A nominal, non-complete node is `WAITING` when any required node is not `DONE`.

A nominal, non-complete node with all required nodes `DONE` is `READY` and belongs to the frontier.

The frontier is sorted deterministically by descending integer priority and then ascending node ID. The kernel does not encode richer portfolio value policy. A future controller policy may choose one ready node from this stable frontier.

## Graph validity

The kernel fails closed when:

- node IDs are missing or duplicated;
- a prerequisite references a missing node;
- a node depends on itself;
- prerequisite edges contain a directed cycle;
- lifecycle input is invalid according to the existing lifecycle kernel;
- an executor descriptor is invalid or unknown;
- priority is not an integer.

A prerequisite cycle is invalid because prerequisite edges express facts that must already be satisfied. Lifecycle feedback remains legal inside nodes and does not require a cyclic project graph.

## Relationship to existing Overcenter machinery

`lib/work-lifecycle.js` remains authoritative for productive-stage resolution. The project graph kernel composes it rather than recreating stage logic.

`work.claim`, `work.settle`, GitHub mutation primitives, verification primitives, and skill execution remain lower-level execution mechanisms. This slice does not add replacements for them.

Linear remains outside the graph authority boundary. When later projected, only `READY` nodes requiring human or agent judgment should need a Linear representation; deterministic nodes should be executable directly by Overcenter.

## Testing

Focused regressions must prove:

1. completed prerequisites enable their dependents;
2. incomplete prerequisites block dependents with exact unmet IDs;
3. off-nominal nodes do not enter the ready frontier;
4. multiple ready nodes sort deterministically by priority and ID;
5. lifecycle command/stage resolution is preserved in node evaluation;
6. deterministic and agent executor descriptors validate, and agent descriptors require a skill;
7. missing dependencies, duplicate IDs, self-dependencies, cycles, invalid priorities, and invalid executors fail closed;
8. the full graph reports complete only when every node is done.

The focused suite must be registered in the canonical regression-suite registry.
