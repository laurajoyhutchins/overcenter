# GitHub App capabilities

`POST /api/github-capabilities` and MCP `github_capabilities` provide a read-only projection of the GitHub App capabilities available for one repository.

The projection exists to answer a runtime question: can the installed app currently mint the fixed command-owned permission profile needed by a control-plane capability? It does not grant authority, select work, mutate GitHub, or turn a permission failure into durable project truth.

## Request

```json
{
  "repo": "owner/repository"
}
```

## Fallback taxonomy

Every command-owned GitHub App capability has exactly one centrally governed fallback class:

- `equivalent_fallback`: an alternate procedure preserves the same authority and safety properties. Currently this applies only to standalone PR `integration_update`, which may recover through an isolated worktree update before exact-head reread and verification.
- `degraded_observation`: optional evidence may be reported unavailable or incomplete. Missing evidence is never treated as satisfaction. This applies to optional pull-request review, checks, and commit-status observations inside the review packet.
- `fail_closed`: there is no approved substitute transport. The operation stops rather than routing around the missing permission. Repository writes, native stack mutation, policy administration, destructive cleanup, Actions mutation, and GitHub-to-Linear source identity use this class.

The taxonomy is command-owned. Callers cannot supply arbitrary permissions, fallback classes, or alternate transports.

## Review packet

The coherent review packet base identity path is read-only and requests only:

```json
{
  "pull_requests": "read",
  "metadata": "read"
}
```

Specialized optional evidence remains isolated to narrower read profiles for pull-request observations, checks, and commit statuses.

## Usage

Do not call the capability projection before every GitHub operation. Use it when a GitHub App capability is uncertain, after a structured permission/setup failure, or during operator diagnostics. Normal commands remain responsible for their own exact permission profile and fail-safe behavior.