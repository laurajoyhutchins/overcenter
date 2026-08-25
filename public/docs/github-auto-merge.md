# `github.auto_merge.ensure`

Idempotent repository-policy command for ensuring GitHub auto-merge is enabled or disabled for one repository.

Surfaces:

- MCP: `github_auto_merge_ensure`
- HTTP: `POST /api/github-auto-merge-ensure`

## Request

```json
{
  "repo": "owner/repo",
  "enabled": true,
  "expected_state": false
}
```

`expected_state` is optional. When present, it is an optimistic-concurrency fence: Busbar refuses to mutate if the authoritative repository state no longer matches the caller's observation.

This command performs desired-state assignment, not a toggle. Repeating the same request is therefore safe: if GitHub already reports the requested state, Busbar returns a verified `already_compliant` success without mutation.

## Mutation safety

Busbar reads the repository before mutation and writes only GitHub's `allow_auto_merge` repository field. It rereads the repository after mutation and reports success only when GitHub proves the desired state.

A lost or uncertain mutation response is never blindly replayed. Busbar rereads authoritative state first. If the desired state is already present, the command reports `reconciled_after_indeterminate_write`; otherwise it returns `GITHUB_AUTO_MERGE_INDETERMINATE` with `may_have_mutated: true` so normal recovery reconciles external state.

## Policy ownership

`github.auto_merge.ensure` is the sole Busbar owner of repository auto-merge enablement. The aggregate branch-policy reconciler intentionally does not manage `allow_auto_merge`, preventing two deterministic controllers from fighting over the same setting.

The command uses Busbar's existing repository-policy GitHub App capability and fails closed if the installation lacks repository administration authority.
