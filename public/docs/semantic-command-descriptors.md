# Semantic command descriptors

> Generated from the typed semantic descriptor source. Only the primary product surface is MCP-discoverable to ordinary agents; advanced, operator, and compatibility commands remain runtime capabilities without top-level MCP registration.

## Primary surface

### production.promote

Promote the current verified development revision by repository identity only. The runtime host derives provider-specific branch heads, exact-revision evidence, retry identity, and production readback behind this primary semantic boundary.

- MCP name: `production.promote`
- Required fields: `repo`
- Semantic fields: `repo`
- Exposure: worker=yes, MCP=yes

### project.advance

Advance authoritative repository-owned project work in an independent agent session. Omit transition_id for deterministic best-available selection, or nominate one exact transition without fallback. Resume by passing the durable resume_ref returned by a prior call; when agent execution is complete, return its bounded execution_result through this same command. Overcenter owns run identity, lease acquisition, settlement, exact authority, recovery, and continuation.

- MCP name: `project.advance`
- Required fields: `project_ref`
- Semantic fields: `project_ref`, `transition_id`, `resume_ref`, `execution_result`
- Exposure: worker=yes, MCP=yes

### project.amend

Amend canonical repository-owned project graph facts at an exact observed Git revision using semantic transition intent. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.

- MCP name: `project.amend`
- Required fields: `project_ref`, `expected_revision`, `amendment`
- Semantic fields: `project_ref`, `expected_revision`, `amendment`
- Exposure: worker=yes, MCP=yes

### project.define

Define canonical repository-owned project graph facts at an exact observed Git revision. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.

- MCP name: `project.define`
- Required fields: `project_ref`, `expected_revision`, `definition`
- Semantic fields: `project_ref`, `expected_revision`, `definition`
- Exposure: worker=yes, MCP=yes

### project.inspect

Inspect authoritative repository-owned project state by project identity only. The runtime adapter derives the exact GitHub authority revision and graph frontier while keeping repository layout and host-specific runtime coordinates outside the primary semantic intent.

- MCP name: `project.inspect`
- Required fields: `project_ref`
- Semantic fields: `project_ref`
- Exposure: worker=yes, MCP=yes

### release.publish

Publish one exact verified semantic release plan. The caller supplies only the plan and release notes; Overcenter revalidates current Git authority and repository-owned transition impacts, derives provider release bookkeeping, invokes the immutable release primitive, and returns verified publication evidence.

- MCP name: `release.publish`
- Required fields: `plan`, `body`
- Semantic fields: `plan`, `body`
- Exposure: worker=yes, MCP=yes

## Advanced surface

_No MCP-exposed commands._

## Operator surface

_No MCP-exposed commands._

## Compatibility surface

_No MCP-exposed commands._