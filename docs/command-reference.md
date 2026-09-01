# Command reference

This is the semantic product command map for Overcenter. **Ordinary MCP discovery exposes only the primary surface.** Advanced, operator, and compatibility capabilities can remain implemented behind worker/API boundaries without appearing as peer tools to an ordinary reasoning agent.

The executable descriptors in `src/semantic/semantic-command-descriptors.ts` are authoritative for semantic classification. Top-level `mcp/*.js` files are the authoritative ordinary MCP registration surface.

## Primary MCP surface

### `project.inspect`

Read authoritative repository-owned project state by `project_ref` and return the decision-relevant project frontier. Typical use: start or resume a project session.

### `project.define`

Create the canonical repository-owned project definition at an exact observed revision. The caller supplies project intent; Overcenter owns repository layout, validation, mutation fencing, retry identity, GitHub mutation, and readback.

### `project.amend`

Change canonical repository-owned project graph facts at an exact observed revision. Prefer this over hand-editing `.overcenter` definition files in the ordinary path.

### `project.advance`

Advance authoritative project work until deterministic progress is confirmed, bounded agent execution is required, the project is waiting/off nominal, or the target is complete.

When bounded agent execution is required, perform that judgment-heavy work and return the result through the same command using the returned `resume_ref` plus `execution_result`. Overcenter owns lease settlement, run terminalization, fresh authority acquisition, and continuation. There is no supported ordinary-agent decomposition of `project.advance` into work, orchestration, and provider primitives.

### `production.promote`

Promote the current verified development revision by repository identity. This is a deliberate production boundary, not an ordinary implementation step.

### `release.publish`

Publish one exact verified semantic release plan. Overcenter derives provider release bookkeeping and exact publication evidence behind the semantic boundary.

## Internal advanced capabilities

Capabilities such as `github.pull_request.mark_ready` and `github.release.create` remain typed worker/API operations for specialized internal workflows. They are **not registered in ordinary MCP discovery**.

## Internal operator capabilities

Diagnosis, maintenance, resume packets, and other recovery mechanisms remain part of the recovery kernel. They are **not registered in ordinary MCP discovery**. The desired external recovery model is a bounded recovery incident or small operator surface, not instructions for ordinary agents to reconstruct orchestration state.

## Internal compatibility capabilities

Legacy work settlement and related migration paths can remain implemented while callers migrate. They are **not registered in ordinary MCP discovery** and should not teach new callers manual choreography.

## Failure preserves the abstraction

For ordinary project execution:

```text
project.advance
      |
      +--> advanced / complete
      |
      +--> agent execution required
      |       perform bounded work
      |       project.advance(... execution_result ...)
      |
      +--> deterministic execution fault
      |       Overcenter diagnoses/reconciles internally when safe
      |
      +--> cannot safely recover
              bounded recovery condition
              operator/recovery boundary
              project.advance again
```

If `project.advance` itself is unavailable because the deployed Overcenter runtime is broken, treat that as a product incident. Do not manually reproduce `project.advance` from kernel primitives.

## Why the repository still contains lower-level APIs and libraries

The execution kernel needs precise GitHub, orchestration, work, verification, recovery, and integration operations. Those are implementation capabilities and test seams. Removing them from ordinary MCP discovery does not require deleting the engine.

A useful rule is:

```text
ordinary project intent  -> primary semantic MCP commands
specialized exact effect -> internal advanced capability
failure/recovery         -> internal operator/recovery capability
legacy choreography      -> internal compatibility capability
```

## Related documentation

- [`agent-session-contract.md`](agent-session-contract.md) describes the normal agent loop.
- [`operator-recovery.md`](operator-recovery.md) describes recovery stop conditions.
- [`architecture/ontology-and-authority.md`](architecture/ontology-and-authority.md) defines the authority model and vocabulary.
- [`architecture/recovery-kernel-and-self-healing.md`](architecture/recovery-kernel-and-self-healing.md) describes the approved recovery architecture.
- [`README.md`](README.md) is the documentation landing page.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) covers repository contribution and verification practices.