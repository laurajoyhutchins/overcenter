# Semantic command descriptors

> Generated from the typed semantic descriptor source. Primary discovery comes first; advanced, operator, and compatibility tools remain discoverable without being ordinary-use defaults.

## Primary surface

### project.advance

Advance an authoritative project graph by repository-owned project identity only. The runtime adapter owns run creation or resumption, horizon selection, lease acquisition, settlement choreography, and continuation behind this primary semantic boundary.

- MCP name: `project.advance`
- Required fields: `project_ref`
- Semantic fields: `project_ref`
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

## Advanced surface

### github.release.create

Create an immutable lightweight Git tag at an exact observed Git commit and a GitHub Release for that tag. Fail closed on expected-state drift or conflicting existing state. Exact replay converges through durable idempotency evidence; no tag retargeting, release editing, deletion, asset upload, note generation, or commit inference is performed. This MCP tool exposes conceptual github.release.create using the underscore-safe transport name.

- MCP name: `github_release_create`
- Required fields: `repo`, `target_sha`, `tag_name`, `name`, `body`, `draft`, `prerelease`, `expected_state`, `idempotency_key`, `run_id`
- Semantic fields: `repo`, `target_sha`, `tag_name`, `name`, `body`, `draft`, `prerelease`, `expected_state`, `idempotency_key`, `run_id`
- Exposure: worker=yes, MCP=yes

## Operator surface

### orchestration.diagnose

Read current durable orchestration state and return the typed failure class, exact deterministic recovery operation, and escalation boundary. This is state inspection and recovery classification only; it does not plan or select work.

- MCP name: `orchestration.diagnose`
- Required fields: `run_id`
- Semantic fields: `run_id`, `work_ref`
- Exposure: worker=yes, MCP=yes

## Compatibility surface

### work.settle

Truthfully consume one valid work lease as completed, requeue, or blocked. Supply the non-secret lease_ref plus settlement semantics; lease capability lookup, run correlation, and deterministic retry identity are derived internally.

- MCP name: `work.settle`
- Required fields: `lease_ref`, `disposition`
- Semantic fields: `lease_ref`, `disposition`, `evidence`, `reason`, `promotion_condition`, `requeue_class`, `operating_condition`, `continuation`, `lifecycle_facts`
- Exposure: worker=yes, MCP=yes