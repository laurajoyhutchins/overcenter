# Semantic command descriptors

> Generated from the typed semantic descriptor source. Do not edit command metadata here by hand.

## github.release.create

Create an immutable lightweight Git tag at an exact observed Git commit and a GitHub Release for that tag. Fail closed on expected-state drift or conflicting existing state. Exact replay converges through durable idempotency evidence; no tag retargeting, release editing, deletion, asset upload, note generation, or commit inference is performed. This MCP tool exposes conceptual github.release.create using the underscore-safe transport name.

- MCP name: `github_release_create`
- Required fields: `repo`, `target_sha`, `tag_name`, `name`, `body`, `draft`, `prerelease`, `expected_state`, `idempotency_key`, `run_id`
- Semantic fields: `repo`, `target_sha`, `tag_name`, `name`, `body`, `draft`, `prerelease`, `expected_state`, `idempotency_key`, `run_id`
- Exposure: worker=yes, MCP=yes

## orchestration.diagnose

Read current durable orchestration state and return the typed failure class, exact deterministic recovery operation, and escalation boundary. This is state inspection and recovery classification only; it does not plan or select work.

- MCP name: `orchestration.diagnose`
- Required fields: `run_id`
- Semantic fields: `run_id`, `work_ref`
- Exposure: worker=yes, MCP=yes

## work.settle

Truthfully consume one valid work lease as completed, requeue, or blocked. Supply the non-secret lease_ref plus settlement semantics; lease capability lookup, run correlation, and deterministic retry identity are derived internally.

- MCP name: `work.settle`
- Required fields: `lease_ref`, `disposition`
- Semantic fields: `lease_ref`, `disposition`, `evidence`, `reason`, `promotion_condition`, `requeue_class`, `operating_condition`, `continuation`, `lifecycle_facts`
- Exposure: worker=yes, MCP=yes

