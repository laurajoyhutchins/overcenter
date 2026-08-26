# Project Graph Authority Contract

## Purpose

Overcenter derives a project execution graph from authoritative facts. The graph is not an independently maintained queue, plan database, or Linear projection.

`readProjectGraph(project_ref)` is a deterministic derivation boundary. It resolves a project reference to exact authority coordinates, reads the facts owned by those systems, derives transition nodes and dependency predicates, and returns both the graph and the authority identity needed for confirmation.

## Authority model

A graph read separates definition from observation.

### Repository-owned definition

GitHub owns repository content and repository-scoped desired state. A project graph definition may therefore be derived from repository facts at an exact revision, including repository contracts, current implementation state, pull requests, checks, and other GitHub-owned coordinates.

The reader must bind every repository-derived graph read to:

- repository identity;
- exact revision or exact pull-request head where applicable;
- the deterministic derivation contract/version used to interpret those facts.

PR prose, issue prose, scheduler prompts, and Linear fields are not graph-definition authority.

### System-owned observations

Lifecycle predicates are observations of the systems that own the underlying facts. Examples include exact GitHub head/check/review state, Overcenter lease or settlement state, and retained-object identity from the retained-source authority.

Overcenter must derive these observations when evaluating the graph. It must not persist a shadow copy merely to make the graph executable.

Linear may project READY transitions that require human or agent judgment. Linear does not define nodes, dependencies, lifecycle truth, or completion.

## Reader contract

`readProjectGraph({ project_ref })` returns an object containing:

```js
{
  schema: 'project-graph-authority-v1',
  project_ref: '...',
  authority: {
    definition: {
      kind: 'github',
      repository: 'owner/repo',
      revision: '<full SHA>',
      derivation: '<deterministic contract/version>'
    },
    observations: [
      // typed exact authority coordinates used by lifecycle predicates
    ]
  },
  nodes: [/* evaluateProjectGraph-compatible transitions */]
}
```

The reader fails closed when `project_ref` cannot resolve uniquely, an exact repository revision cannot be established, a required authority observation is unavailable or ambiguous, or the derivation contract cannot represent a required transition.

The reader does not accept caller-supplied nodes, dependency edges, lifecycle truth, or authority coordinates as substitutes for authoritative reads.

## Commit and confirm

A graph amendment is a desired-state change, not proof that the new graph is authoritative.

`COMMIT` persists only through the system that owns the amended fact. `CONFIRM` then rereads the declared authority and derives the graph again. A transition or dynamic replan is confirmed only when the refreshed graph carries `project-graph-authority-v1` identity and the resulting authority coordinates establish the committed state.

A changed GitHub revision, changed retained-object identity, or other changed authority coordinate creates a new graph observation. Evidence from the prior coordinate is not transferred automatically.

## Non-goals

This contract does not introduce:

- an Overcenter project-plan database;
- an agent-maintained graph manifest;
- a Linear-backed planner;
- a scheduler-owned graph;
- a compatibility queue;
- duplicated lifecycle/evidence state.

If a graph fact can be deterministically derived from an authoritative system, Overcenter derives it rather than asking an agent to maintain it.

## Next binding

The runtime binding for `readProjectGraph(project_ref)` must implement this contract and return the authority envelope together with the derived nodes. Controller confirmation must reject refreshed graph state that lacks or contradicts that envelope.