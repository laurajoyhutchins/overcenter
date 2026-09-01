# Primary agent session contract

This document defines the ordinary way a reasoning agent should use Overcenter. It is intentionally smaller than the full command surface.

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
                                                     under returned authority
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

Typical reasons include:

- a missing prerequisite was discovered;
- two transitions have the wrong dependency relationship;
- a new desired verified transition is required;
- obsolete future work should be removed before it executes.

The agent supplies semantic graph intent. Overcenter owns the repository layout, canonicalization, validation, exact-revision fence, GitHub mutation, retry identity, and authoritative readback.

Do not hand-edit `.overcenter` files in the ordinary path when the semantic authoring command can express the change.

If a repository has been adopted but has no project definition yet, `project.define` is the corresponding bootstrap operation.

## 4. Ask Overcenter to advance deterministic work

When the authoritative graph is correct and work can proceed, use:

```text
project.advance({ project_ref })
```

The primary contract is intentionally project-level. Overcenter owns run creation or resumption, target selection, lease acquisition, and deterministic progression behind this boundary.

A caller should not choose a work lease, manufacture idempotency keys, or recompute the frontier before calling `project.advance`.

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

The agent should:

1. preserve the exact transition and lease authority returned by Overcenter;
2. perform only the bounded judgment-heavy work required by that transition;
3. use Overcenter semantic mutation commands for effects that Overcenter owns;
4. retain concrete verification evidence;
5. stop if authority becomes stale, mutation certainty becomes ambiguous, or the task expands beyond the transition's meaning;
6. allow Overcenter to settle and confirm against fresh authority rather than declaring completion from the agent's own confidence.

The lease is non-secret authority metadata. It is still exact and time-bounded. Do not reuse it for another transition or after it is no longer valid.

## 6. Evidence before completion claims

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

## 7. Fresh sessions resume from software state

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

When an advanced recovery path is genuinely required, use the operator or diagnostic surface rather than reconstructing it from chat history.

## Primary versus advanced commands

Overcenter classifies commands by intended audience:

- **primary** commands express ordinary project intent;
- **advanced** commands expose exact lower-level capabilities for specialized workflows;
- **operator** commands diagnose or recover the system;
- **compatibility** commands support migration paths and should not teach new callers the preferred architecture.

The current primary semantic vocabulary includes:

- `project.inspect`
- `project.define`
- `project.amend`
- `project.advance`
- `production.promote`

Not every primary command belongs in every session. Production promotion, for example, is a release boundary rather than an ordinary implementation step.

## What the agent should not maintain

Do not make the reasoning agent the durable owner of mechanically knowable coordination state.

In the ordinary path, the agent should not manually maintain:

- READY / WAITING / DONE state;
- lease ownership tables;
- run-to-transition correlation;
- idempotency or retry keys when Overcenter can derive them;
- settlement bookkeeping;
- copied GitHub head state;
- Linear status as execution truth;
- a shadow project graph;
- recovery recipes for already-classified deterministic failures.

If agents repeatedly perform the same inspect, claim, retry, reconcile, settle, and frontier-recompute ceremony, that is pressure to move the ceremony behind a semantic software boundary.

## When to stop and return judgment to the user

Stop rather than guessing when:

- desired project state is genuinely ambiguous;
- two materially different product choices are both valid and authority cannot resolve them;
- a safety or policy decision requires explicit owner judgment;
- the authoritative system is unavailable and the missing fact is necessary for a safe mutation;
- a mutation is indeterminate and no deterministic reconciliation path can resolve it;
- completing the transition would require changing its meaning rather than executing it.

The objective is not maximum autonomous motion. It is verified project transitions with correct authority and recoverable evidence.

## Related documentation

- [`architecture/ontology-and-authority.md`](architecture/ontology-and-authority.md) defines the canonical vocabulary and source-of-truth boundaries.
- [`project-graph-authority-contract.md`](project-graph-authority-contract.md) defines authoritative graph derivation.
- [`project-horizon-authority-contract.md`](project-horizon-authority-contract.md) defines authority-bound target scopes.
- [`architecture/recovery-kernel-and-self-healing.md`](architecture/recovery-kernel-and-self-healing.md) defines deterministic diagnosis and recovery boundaries.

The executable `mcp/` command contracts remain authoritative for exact current schemas and machine-readable outcomes.