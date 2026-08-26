# Project Horizon Authority Contract

## Purpose

Overcenter scales execution by widening the target horizon, not by widening exclusive execution ownership.

A **project horizon** is an authority-bound target state evaluated over the authoritative project graph. It answers:

- which verified transitions are in scope for the current goal;
- which in-scope transitions are READY now;
- whether the target state is complete;
- which in-scope transitions are WAITING or OFF_NOMINAL.

A horizon does not grant ownership. `work.claim` continues to lease one exact executable work gate at a time.

## Horizon kinds

`project-horizon-v1` supports these target kinds:

- `transition` — one transition plus its prerequisite closure;
- `milestone` — an authoritative named target composed from one or more target transitions;
- `project` — all transitions in one authoritative project graph;
- `release` — a named release target composed from verified transitions;
- `portfolio` — a named higher-order target composed from verified transitions.

The execution semantics are intentionally the same at every altitude. A larger horizon changes completion scope and frontier selection; it does not create a larger lease.

## Authority

Horizon evaluation accepts only `project-graph-authority-v1` input.

The horizon inherits the graph definition authority:

```js
{
  kind: 'github',
  repository: 'owner/repo',
  revision: '<full commit SHA>',
  derivation: '<deterministic derivation contract>'
}
```

A prior horizon observation may be reused only when those exact authority coordinates still match. If repository revision or derivation identity changes, prior horizon evidence is stale and must not be transferred automatically.

The caller supplies only a typed target identity:

```js
{ kind: 'milestone', ref: 'v1-foundation' }
```

The caller does not supply target node membership, dependency edges, lifecycle truth, or completion.

## Authoritative horizon definitions

`transition` and `project` horizons are implicit:

- `transition:<node>` targets the named authoritative graph node;
- a `project` horizon targets every node in the authoritative graph.

Named `milestone`, `release`, and `portfolio` horizons are derived by the same repository-owned graph derivation that produces transition nodes. A deriver may return:

```js
{
  nodes: [/* transition nodes */],
  horizons: [
    {
      kind: 'milestone',
      ref: 'v1-foundation',
      target_node_ids: ['release-ready']
    }
  ]
}
```

`target_node_ids` are desired-state targets, not a manually maintained execution queue. Overcenter deterministically expands each target to its full prerequisite closure before evaluation.

GitHub milestone objects may be inputs to a repository-specific derivation, but GitHub milestone issue counts are not themselves proof that the Overcenter horizon is complete.

## Evaluation

For a selected horizon Overcenter:

1. validates the exact graph authority;
2. resolves the authoritative target definition;
3. expands target nodes through prerequisite closure;
4. evaluates only that scoped subgraph using the ordinary project lifecycle;
5. returns the in-scope READY frontier and completion state.

Example:

```text
milestone: public-v1
        |
        v
 release-ready
    /       \
 schema   validator       unrelated-future-work
   |         |                    |
   +---------+                    +-- outside horizon
```

If `schema` or `validator` is incomplete, they remain part of the milestone horizon because they are prerequisites of `release-ready`. `unrelated-future-work` does not prevent the milestone from completing.

## Completion

A horizon is complete only when every transition in its prerequisite-closed scope is `DONE`.

This is stronger than:

- every GitHub issue in a milestone being closed;
- every PR being merged;
- every Linear projection being terminal;
- an agent reporting that the goal is complete.

Those facts may contribute to transition lifecycle predicates, but completion is established by the authoritative graph evaluation.

## Concurrency and leases

Horizon scope must never become lease scope.

Several workers may execute different READY transitions inside the same milestone or project horizon at the same time. Each worker must independently acquire the exact work gate it executes. A worker abandoning one lease does not abandon the horizon.

```text
milestone horizon
   |
   +-- transition A READY ---- lease A
   +-- transition B READY ---- lease B
   +-- transition C WAITING
   +-- transition D OFF_NOMINAL
```

## Dynamic replanning

When execution discovers a missing prerequisite or invalid dependency, the graph is amended through the authority that owns the desired-state fact and then re-read.

A changed authoritative graph creates a new horizon observation. The target identity may remain the same, but completion and frontier are recomputed from the new exact revision.

## Non-goals

This contract does not introduce:

- milestone leases;
- an Overcenter milestone plan database;
- a Linear-backed milestone planner;
- copied GitHub issue-close counters as completion truth;
- scheduler-owned target membership;
- agent-maintained horizon membership;
- separate orchestration machinery for milestones, releases, or portfolios.

The same verified-transition runtime should scale upward by changing the authority-bound horizon only.
