# GitHub Actions storage administration

`github.actions_storage` is a narrow repository-scoped administration surface for GitHub Actions artifact storage.

It supports exactly three operations:

- `inspect` lists the repository's Actions artifacts and reports live/expired counts and bytes. It requests GitHub App `Actions: read` only.
- `delete_artifacts` deletes only the exact artifact IDs supplied by the caller. It requests `Actions: write` only. Missing IDs are idempotent success; the command never chooses deletion candidates itself.
- `set_retention` reads, updates, and rereads repository artifact/log retention. It requests `Administration: write` only and verifies the resulting value.

The command is admin-gated. GitHub installation tokens are short-lived, command-owned, hidden from callers, and revoked after use by the shared GitHub App transport.

Deletion is intentionally two-stage: inspect first, make the deletion decision outside the transport, then submit immutable artifact IDs. This prevents a broad age or name selector from turning a policy mistake into an unbounded destructive operation.