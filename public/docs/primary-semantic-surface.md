# Primary agent surface

> Generated from authoritative semantic command metadata. Ordinary agents should start here; advanced, operator, and compatibility commands remain available but are intentionally omitted from this entry surface.

## project.amend

Amend canonical repository-owned project graph facts at an exact observed Git revision using semantic transition intent. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.

- MCP name: `project.amend`
- Required caller fields: `project_ref`, `expected_revision`, `amendment`

## project.define

Define canonical repository-owned project graph facts at an exact observed Git revision. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.

- MCP name: `project.define`
- Required caller fields: `project_ref`, `expected_revision`, `definition`

## Advancement boundary

`orchestration.advance` is not yet classified as primary because its current caller contract requires a pre-existing `run_id`. The primary surface must not make run, horizon, lease, or settlement choreography an ordinary agent prerequisite. A future intent-level project advancement boundary should compose that machinery internally before it is promoted here.
