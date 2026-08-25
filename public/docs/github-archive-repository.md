# GitHub archive repository

`github.archive_repository` is a narrow repository-retirement mutation. Hatchable MCP tool filenames cannot contain dots, so the MCP transport name is `github_archive_repository`.

Use it only after higher-level retirement preconditions are satisfied. The command itself does not decide whether a repository should be retired. It performs exactly one GitHub state transition and proves the result.

## Request

```json
{
  "repo": "owner/repo",
  "expected_repository_id": 123456789,
  "expected_archived": false
}
```

The immutable GitHub repository id is required so a renamed repository or a later repository reusing an old coordinate cannot inherit stale retirement authority. `expected_archived` must be exactly `false`; callers cannot use this command as a generic repository-settings mutation.

An optional `run_id` is accepted by the MCP/API correlation layer and is removed before domain validation.

## Mutation and confirmation

The command first reads the repository from GitHub and verifies the immutable repository id. If GitHub already reports `archived: true`, the command returns `already_archived` without writing anything.

Otherwise it sends one repository update whose body is exactly:

```json
{ "archived": true }
```

It then rereads the repository. Success is reported only after GitHub authoritatively reports `archived: true` for the same immutable repository id.

A transport failure after mutation dispatch is never blindly replayed. The command first reconciles by rereading GitHub. If the repository is confirmed archived, the result is `archived_after_reconcile`; otherwise the command returns `REPOSITORY_ARCHIVE_INDETERMINATE` with `may_have_mutated: true` so the caller reconciles external state before retrying.

## Authentication

The command uses the installed Busbar GitHub App with the command-owned `archive_repository` permission profile. That profile requests only `administration: write` and has no fallback mutation transport.

## Relationship to Busbar lifecycle

GitHub remains authoritative for repository archival. Busbar's existing repository lifecycle observation treats `archived: true` as authoritative evidence for the `ARCHIVED` disposition, which de-energizes ordinary work, issue discovery, Linear projection, Fast Forward, and scheduled-worker targeting.

Higher-level retirement can therefore compose existing operations around this primitive rather than embedding cleanup policy inside it:

```text
verify retirement preconditions
        |
        v
github.archive_repository
        |
        v
confirm GitHub archived:true
        |
        v
observe / reconcile Busbar lifecycle
        |
        v
ARCHIVED: ordinary execution inhibited
```

## Non-goals

This command does not close pull requests, close issues, delete branches, delete Actions artifacts, mutate Linear, choose a successor repository, or unarchive repositories. Those are separate transitions with separate authority and ordering.
