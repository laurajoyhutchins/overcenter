# GitHub Execution Authority Implementation Plan

1. Add a RED regression to the canonical GitHub integration registry proving a changeset without execution authority currently reaches mutation.
2. Add `lib/execution-authority.js` as a read-only assertion over existing lease, slot, and run state with injected storage/clock seams for deterministic tests.
3. Extend `github.apply_changeset` normalization with `lease_token`, excluding the token from semantic changeset idempotency identity and all durable/safe projections.
4. Gate every new or unfinished changeset effect before GitHub mutation; preserve already-succeeded exact replay without requiring a live lease.
5. Add table-driven regressions for invalid/expired/non-owning lease, inactive run, wrong repository, wrong gate, valid lease, replay behavior, and secret redaction.
6. Run focused regression verification, then canonical Busbar regression verification on the exact candidate head. Inspect any failure rather than weakening the fence.
7. Commit an exact candidate and open a draft PR for GitHub #46. Do not expand this PR into other GitHub mutation commands or GitHub ruleset enforcement.