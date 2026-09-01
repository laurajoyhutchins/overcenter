# Overcenter ontology and authority

Overcenter is a transaction, evidence, and recovery layer for agent-driven software work. Its central design rule is:

> Reasoning agents make judgments. Deterministic software owns execution correctness.

This document defines the vocabulary and authority boundaries used by the rest of the project. It is the conceptual layer between the public README and the lower-level graph, horizon, command, and recovery contracts.

## The model in one picture

```text
repository-owned desired state
          |
          v
   authoritative project graph
          |
          +---- READY frontier ----+
          |                        |
          v                        v
 deterministic operator       reasoning agent
          |                        |
          +---------+--------------+
                    |
                    v
             verified effects
                    |
                    v
          fresh authoritative read
```

Overcenter does not make a task tracker, agent transcript, scheduler, or hosting platform into project truth. It coordinates work against exact authority coordinates and records enough evidence to recover safely when a worker disappears or an effect becomes ambiguous.

## Core terms

### Project

A **project** is the repository-scoped desired state and its executable transition graph. A project is identified by `project_ref`, such as `github:owner/repo`.

A project is not a Linear project, an orchestration run, a queue, or an agent conversation. Those may refer to a project, but they do not define it.

### Project definition

A **project definition** is repository-owned desired-state data from which Overcenter deterministically derives the project graph. For the GitHub-backed model, the definition is bound to an exact repository revision and a named derivation contract.

Definition facts answer what transitions should exist and how they depend on one another. They do not contain runtime observations such as READY state, active leases, check results, or settlements.

### Transition

A **transition** is one desired verified state change in the project graph. It has a stable identity, dependency relationships, and an executor declaration.

A transition is not synonymous with a GitHub issue, pull request, Linear issue, or agent task. Those objects can contribute evidence or projection, but transition identity belongs to the repository-owned project definition.

### Graph

The **project graph** is a deterministic derivation of repository-owned definition facts plus current authority-owned observations. It contains transitions, dependencies, lifecycle state, and optional named horizon targets.

The graph is not persisted as an independent execution-plan database. When authoritative facts change, Overcenter rereads them and derives a new graph observation.

### Frontier

The **frontier** is the set of transitions that are READY for execution in the current authoritative graph or selected horizon.

The frontier is derived state. Agents and task trackers do not author it.

### Horizon

A **horizon** is an authority-bound target view over a project graph. It answers what subset of verified transitions matters for the current goal and whether that target is complete.

Supported target shapes include one transition, a project, and repository-defined named milestone, release, or portfolio targets. A horizon changes completion scope, not lease scope.

### Lifecycle

Every transition passes through the same bounded execution lifecycle:

```text
ENABLE -> ACQUIRE -> EXECUTE -> COMMIT -> CONFIRM
```

These are phases inside a transition. They are not worker classes or canonical Linear lanes.

- **ENABLE** establishes that prerequisites and execution conditions are satisfied.
- **ACQUIRE** obtains exclusive authority for the exact executable transition.
- **EXECUTE** performs deterministic work or hands the bounded judgment task to an agent.
- **COMMIT** persists an intended effect through the system that owns that fact.
- **CONFIRM** rereads authoritative state and proves that the intended transition is actually complete.

### Executor

An **executor** describes who or what performs the EXECUTE phase for a transition.

- An **operator** is deterministic software registered to perform a bounded operation.
- An **agent** is used when the work genuinely requires reasoning, interpretation, design, debugging, synthesis, or another judgment-heavy activity.

Executor identity comes from the transition definition, not from lifecycle phase names.

### Run

A **run** is a durable Overcenter execution session with bounded scope, budget, continuation identity, and optional project horizon target.

Runs are disposable orchestration containers. They are not project truth. A later worker may resume the same project from durable Overcenter state without possessing the original agent transcript.

### Lease

A **lease** is exclusive, time-bounded execution authority for one exact work subject, typically one project transition. It is the fencing boundary that prevents two workers from safely believing they both own the same mutation authority.

A horizon never becomes a lease. Several different READY transitions may be leased concurrently.

### Command

A **semantic command** is an intent-level operation exposed by Overcenter, such as `project.inspect`, `project.amend`, or `project.advance`.

Primary commands should ask callers for intent, authoritative observations that cannot safely be derived, and judgment-dependent content. Overcenter should derive mechanical bookkeeping such as run correlation, lease lookup, retry identity, evidence structure, and recovery metadata whenever it can do so deterministically.

### Effect

An **effect** is an externally observable mutation or action performed through a semantic command, for example a GitHub changeset, pull request, settlement, or production promotion.

Command success and resulting-state verification are different facts. An effect is not considered a completed project transition merely because an API call returned success.

### Evidence

**Evidence** is durable, bounded information proving what was observed or performed at exact authority coordinates. Evidence may include command outcomes, exact revisions, checks, mutation certainty, provider receipts, or authoritative readback.

Evidence should be sufficient for a fresh worker to resume or diagnose work without reconstructing truth from prose transcripts.

### Receipt

A **receipt** is a durable machine-readable record summarizing an Overcenter operation or run and its evidence chain. Receipts preserve what happened; they do not become a second authority for facts owned by GitHub or another provider.

### Settlement

**Settlement** consumes an execution lease with an explicit disposition such as completed, requeued, or blocked. Settlement is Overcenter-owned coordination truth.

A completed settlement must still agree with fresh authoritative project state before Overcenter claims that the transition is DONE.

### Projection

A **projection** is a convenient representation of authoritative state in another system. Linear issues and operator dashboards are examples.

A projection may make work easier to see or route. It must not silently become the source of graph definition, lifecycle truth, completion, or execution authority.

### Authority coordinate

An **authority coordinate** identifies the exact version of a fact that Overcenter is allowed to rely on. For repository-owned graph definition this includes at least repository identity, exact Git revision, and derivation contract.

Evidence from one authority coordinate is not automatically transferable to a later coordinate.

## Authority boundaries

Overcenter deliberately splits responsibility instead of creating one giant source of truth.

| System | Authoritative for | Not authoritative for |
| --- | --- | --- |
| **GitHub** | Repository content, refs, repository-owned project definitions, and GitHub-native facts | Overcenter runs, leases, settlements, or recovery state |
| **Overcenter** | Runs, leases, execution authority, command journals, mutation certainty, settlements, receipts, and recovery state | Repository source or provider-owned facts |
| **Linear**, when configured | A projection of actionable or judgment-requiring work | Graph definition, dependencies, lifecycle truth, completion, evidence, or execution authority |
| **Runtime host** | The physical execution environment and host-owned deployment facts | Repository desired state or orchestration authority merely because code runs there |
| **External providers** | Facts they natively own, such as their own object or execution state | Overcenter project definition unless explicitly adopted through a repository-owned derivation |

The current reference runtime is hosted on Hatchable, but hosting does not grant project authority. The architecture is intended to keep the runtime replaceable.

## Definition versus observation

A useful pressure test is whether a fact describes **desired state** or **current observed state**.

```text
repository definition                    authority-owned observation
---------------------                    ---------------------------
transition exists                        transition has active lease
A requires B                             GitHub head is <sha>
executor is agent                        required check succeeded
release target includes C                settlement was completed
```

Definition facts belong in repository-owned project source. Observations remain with the system that owns them and are read when the graph is evaluated. Copying observations into project definition creates shadow authority and stale-state hazards.

## Normal execution

A normal graph-native loop is conceptually:

```text
project.inspect
      |
      v
 authoritative frontier
      |
      +-- deterministic transition --> project.advance --> confirmed state
      |
      +-- judgment required ----------> agent executes under lease
                                             |
                                             v
                                        verified effect
                                             |
                                             v
                                      authoritative readback
```

Agents should not normally choreograph `start -> claim -> retry -> reconcile -> settle -> recompute frontier` themselves. Those mechanics belong behind semantic boundaries as the software becomes capable of deriving them safely.

## Fail-closed rules

Overcenter treats uncertainty as a state to preserve, not a gap to fill with optimism.

- **Stale authority:** if an exact revision or authority observation changed, do not silently reuse prior execution authority.
- **Ambiguous mutation:** if Overcenter cannot prove whether an external effect occurred, do not blind-retry it.
- **Unavailable authority:** unavailable data is `unknown`, not fabricated success or failure.
- **Missing evidence:** do not claim completion that cannot be proven from durable evidence and fresh authoritative state.
- **Lease expiry:** expired execution authority cannot be used to commit a late mutation.
- **Projection drift:** repair or regenerate projections from authority; do not repair authority from projections.

## What should not become authority

The following are useful context but are intentionally non-authoritative unless a specific contract says otherwise:

- chat transcripts and agent memory;
- issue or pull-request prose;
- scheduler prompts;
- Linear fields and status;
- a mutable runtime workspace;
- dashboard state;
- cached or copied project graphs;
- an agent's statement that work is done.

They can suggest a change or trigger an authoritative read. They do not replace one.

## Related contracts

- [`project-graph-authority-contract.md`](../project-graph-authority-contract.md) defines authoritative graph derivation in detail.
- [`project-horizon-authority-contract.md`](../project-horizon-authority-contract.md) defines authority-bound target scopes and completion.
- [`execution-evidence-v1-design.md`](../execution-evidence-v1-design.md) describes the execution-evidence data product.
- [`recovery-kernel-and-self-healing.md`](recovery-kernel-and-self-healing.md) describes deterministic diagnosis and recovery boundaries.

When a lower-level normative contract conflicts with this overview, the lower-level contract and executable command implementation are authoritative for runtime behavior.