# Primary agent session contract

This document defines the ordinary way a reasoning agent should use Overcenter. The ordinary MCP discovery surface is intentionally limited to primary semantic commands.

The goal is simple: agents make the judgments that require reasoning, while Overcenter owns deterministic execution correctness, authority, retry identity, settlement, evidence, and recovery.

## The normal loop

```text
project.inspect
      |
      v
what requires judgment now?
      |
      +-- project definition is wrong/incomplete --> project.amend
      |
      +-- project can advance --------------------> project.advance
      |
      +-- agent execution is required -----------> perform bounded work
      |                                             then project.advance again
      |
      v
fresh authoritative project state
```

A normal agent session should begin from authoritative project state, not from a remembered task list, a Linear board, or a previous chat transcript.

## 1. Identify the project

Use the repository-owned project identity:

```text
github:owner/repository
```

The `project_ref` identifies the project. It does not identify a run, lease, Linear project, branch, or deployment.

## 2. Inspect before deciding

Start with:

```text
project.inspect({ project_ref })
```

`project.inspect` rereads the authoritative repository-owned project graph and returns the current decision-relevant frontier. The caller does not supply graph nodes, lifecycle state, or a guessed Git revision.

Treat the result as a fresh observation. Do not substitute an earlier transcript or cached frontier when the repository authority has moved.

### If there is no READY work

Do not invent work merely to keep the session busy.

The project may be complete, waiting on dependencies, blocked by an off-nominal condition, or awaiting a graph amendment. Inspect the authoritative result and act only on facts it establishes.

## 3. Amend desired state when judgment discovers new structure

If investigation shows that the project definition itself is incomplete or wrong, use:

```text
project.amend({
  project_ref,
  expected_revision,
  amendment
})
```

Typical reasons include a missing prerequisite, a wrong dependency relationship, newly discovered desired work, or obsolete future work.

The agent supplies semantic graph intent. Overcenter owns the repository layout, canonicalization, validation, exact-revision fence, GitHub mutation, retry identity, and authoritative readback.

Do not hand-edit `.overcenter` files in the ordinary path when the semantic authoring command can express the change. If a repository has been adopted but has no project definition yet, `project.define` is the corresponding bootstrap operation.

## 4. Ask Overcenter to advance work

When the authoritative graph is correct and work can proceed, use:

```text
project.advance({ project_ref })
```

The primary contract is intentionally project-level. Overcenter owns run creation or resumption, target selection, lease acquisition, deterministic progression, settlement choreography, and continuation behind this boundary.

A caller should not choose a work lease, manufacture idempotency keys, recompute the frontier, or decompose `project.advance` into internal orchestration commands.

### Possible outcomes

Conceptually, advancement ends in one of these states:

- **confirmed progress**: deterministic work completed and fresh authority proves the transition state;
- **agent execution required**: a specific transition requires reasoning work under bounded execution authority;
- **waiting**: no transition in scope can currently advance;
- **off nominal / blocked**: deterministic facts require recovery, correction, or explicit judgment rather than blind continuation;
- **complete**: the selected project target is authoritatively complete.

Exact machine-readable response names are defined by the current command implementation.

## 5. When agent execution is required

An agent-execution packet is an execution boundary, not permission to improvise outside the transition.

The agent should perform only the bounded judgment-heavy work required by that transition, retain concrete verification evidence, and stop if authority becomes stale or mutation certainty becomes ambiguous. When the bounded work is ready to report, return through the same semantic command:

```text
project.advance({
  project_ref,
  resume_ref,
  execution_result: {
    disposition: "completed",
    evidence: [...]
  }
})
```

Use `requeue` or `blocked` instead of `completed` when that is the truthful outcome. Overcenter consumes the resumed execution result, settles the exact active authority internally, finishes the prior run, reacquires fresh project authority, and continues through `project.advance`.

Do not call `work.settle`, `orchestration.finish`, or other kernel choreography in the ordinary agent path. Those mechanisms may remain available behind internal or operator boundaries, but they are not a manual fallback implementation of `project.advance`.

`resume_ref` is currently a bounded continuation coordinate. It is not an invitation to reason about run internals, and it may disappear from ordinary vocabulary when Overcenter can derive the unique continuation safely from `project_ref` alone.

## 6. Failure preserves the abstraction

Execution-correctness failures that are mechanically recoverable belong behind `project.advance`: expired coordination state, known journal residue, safely retryable reads, and uniquely reconcilable interrupted work should not turn the reasoning agent into an operator.

If Overcenter cannot safely determine what happened, ordinary execution must fail closed with a bounded recovery condition rather than exposing the gearbox. If `project.advance` itself is unavailable because the deployed product is broken, that is an Overcenter runtime incident, not permission to manually reproduce it from lower-level commands.

## 7. Evidence before completion claims

A successful tool call is not enough to say the project transition is done.

The evidence chain should distinguish:

```text
intent
  -> execution authority
  -> external effect
  -> verification
  -> settlement
  -> fresh authoritative confirmation
```

If an external mutation may have happened but Overcenter cannot prove whether it did, preserve that uncertainty and reconcile it. Do not blind-retry the effect.

## 8. Fresh sessions resume from software state

A new agent session should not need the old agent's private scratchpad to continue ordinary work.

The preferred restart sequence is:

```text
project.inspect
      |
      v
fresh frontier / authoritative state
      |
      v
project.advance or project.amend
```

Runs, leases, journals, receipts, and recovery state exist so disposable sessions can resume safely. They are supporting mechanisms, not conceptual prerequisites for every agent prompt.

## Ordinary MCP discovery

Ordinary MCP discovery exposes only the primary semantic product surface:

- `project.inspect`
- `project.define`
- `project.amend`
- `project.advance`
- `production.promote`
- `release.publish`

Advanced GitHub effects, operator recovery mechanisms, compatibility commands, leases, journals, settlement primitives, and other kernel operations may still exist as internal worker/API capabilities. Their existence does not make them peer product APIs for ordinary agents.

## What the agent should not maintain

In the ordinary path, the agent should not manually maintain READY / WAITING / DONE state, lease ownership tables, run-to-transition correlation, retry keys, settlement bookkeeping, copied GitHub head state, Linear status as execution truth, a shadow project graph, or recovery recipes for already-classified deterministic failures.

If agents repeatedly perform the same inspect, claim, retry, reconcile, settle, and frontier-recompute ceremony, that is pressure to move the ceremony behind a semantic software boundary.

## When to stop and return judgment

Stop rather than guessing when desired project state is genuinely ambiguous, materially different product choices are both valid, a safety or policy decision requires explicit owner judgment, necessary authority is unavailable, a mutation is indeterminate with no deterministic reconciliation path, or completing the transition would require changing its meaning.

The objective is not maximum autonomous motion. It is verified project transitions with correct authority and recoverable evidence.

## Related documentation

- [`architecture/ontology-and-authority.md`](architecture/ontology-and-authority.md) defines the canonical vocabulary and source-of-truth boundaries.
- [`project-graph-authority-contract.md`](project-graph-authority-contract.md) defines authoritative graph derivation.
- [`project-horizon-authority-contract.md`](project-horizon-authority-contract.md) defines authority-bound target scopes.
- [`architecture/recovery-kernel-and-self-healing.md`](architecture/recovery-kernel-and-self-healing.md) defines deterministic diagnosis and recovery boundaries.
- [`command-reference.md`](command-reference.md) lists the current semantic product surface and internal capability classes.

The top-level `mcp/` files are authoritative for ordinary MCP discovery. Typed descriptors and internal API/lib contracts remain authoritative for the non-discoverable runtime capabilities they describe.