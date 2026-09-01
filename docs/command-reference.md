# Command reference

This is the public semantic command map for Overcenter. It is intentionally smaller than the full internal MCP and API inventory.

Use the **primary** surface for ordinary project work. Reach for advanced or operator commands only when the task genuinely requires their narrower capability. Compatibility commands exist to support migration and lower-level recovery paths; they should not teach new callers the preferred workflow.

The executable descriptors in `lib/semantic-command-descriptors.js` and the corresponding `mcp/` contracts are authoritative for exact current schemas.

## Primary

### `project.inspect`

Read authoritative repository-owned project state by `project_ref` and return the decision-relevant project frontier.

Typical use: start or resume a project session.

```text
project.inspect({ project_ref })
```

Callers do not supply a graph, lifecycle state, or Git revision. Overcenter derives the exact authority coordinate.

### `project.define`

Create the canonical repository-owned project definition at an exact observed revision.

Typical use: adopt a repository that does not yet have an Overcenter project definition.

The caller supplies project intent. Overcenter owns repository layout, validation, mutation fencing, retry identity, GitHub mutation, and readback.

### `project.amend`

Change canonical repository-owned project graph facts at an exact observed revision.

Typical use: add a newly discovered transition or prerequisite, correct a dependency, or remove obsolete future work.

Prefer this over hand-editing `.overcenter` definition files in the ordinary path.

### `project.advance`

Advance an authoritative project using only its `project_ref` until deterministic work is confirmed, reasoning work is required, the project is waiting or off nominal, or the target is complete.

Typical use: the normal execution step after `project.inspect`.

Overcenter owns run creation or resumption, horizon selection, lease acquisition, settlement choreography, and continuation behind this boundary.

### `production.promote`

Promote the current verified development revision by repository identity.

Typical use: a deliberate production/release boundary, not an ordinary implementation step.

Overcenter derives provider-specific branch heads, exact-revision evidence, retry identity, and production readback.

## Advanced

### `github.release.create`

Create an immutable lightweight Git tag at an exact observed commit and a GitHub Release for that tag. Existing state is fenced and exact replay converges through idempotency evidence.

Use this when the GitHub release object itself is the intended effect. It does not infer a target commit, retarget tags, edit releases, generate notes, or upload assets.

## Operator

### `orchestration.diagnose`

Read durable orchestration state and return the typed failure class, deterministic recovery operation when one is known, and the boundary where escalation is required.

This is diagnosis, not project planning or work selection.

## Compatibility

### `work.settle`

Consume one valid work lease with an explicit completed, requeue, or blocked disposition.

This remains available for lower-level and migration paths. New project-level callers should prefer semantic flows that let Overcenter own settlement choreography rather than teaching agents to maintain it manually.

## What about the other MCP commands?

The repository contains lower-level GitHub, orchestration, work, verification, recovery, and integration commands. They are supporting mechanisms, specialized capabilities, or compatibility surfaces rather than the conceptual entry point for ordinary agent work.

A useful rule is:

```text
ordinary project intent  -> primary semantic commands
specialized exact effect -> advanced command
failure/recovery         -> operator command
legacy choreography      -> compatibility command
```

Do not choose a lower-level command merely because it exposes more fields. Prefer the highest semantic boundary that preserves the authority, evidence, and control you actually need.

## Related documentation

- [`agent-session-contract.md`](agent-session-contract.md) describes the normal agent loop.
- [`architecture/ontology-and-authority.md`](architecture/ontology-and-authority.md) defines the authority model and vocabulary.
- [`README.md`](README.md) is the documentation landing page.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) covers repository contribution and verification practices.