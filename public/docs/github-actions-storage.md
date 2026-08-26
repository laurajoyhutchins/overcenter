# GitHub Actions storage administration

`github.actions_storage` is a narrow repository-scoped administration surface for GitHub Actions artifacts and dependency caches.

It supports exactly four public operations:

- `inspect` lists the repository's Actions artifacts and dependency caches. It reports artifact bytes, cache bytes, and their combined Actions storage total as distinct fields. It requests GitHub App `Actions: read` only.
- `delete_artifacts` deletes only the exact artifact IDs supplied by the caller. It requests `Actions: write` only. Missing IDs are idempotent success; the command never chooses artifact deletion candidates itself.
- `delete_caches` deletes only the exact cache IDs supplied by the caller. It first observes the repository cache inventory so reclaimed-byte evidence is tied to a known cache entry, then deletes by immutable cache ID. Missing IDs are idempotent success. It requests `Actions: write` only.
- `set_retention` reads, updates, and rereads repository artifact/log retention. It requests `Administration: write` only and verifies the resulting value.

The command is admin-gated. GitHub installation tokens are short-lived, command-owned, hidden from callers, and revoked after use by the shared GitHub App transport.

Deletion is intentionally two-stage: inspect first, make the deletion decision outside the transport, then submit immutable artifact or cache IDs. This prevents a broad age, key, or name selector from turning a policy mistake into an unbounded destructive operation.

Dependency-cache storage is reported separately from artifact storage because GitHub exposes caches through a distinct Actions cache API and lifecycle. The command does not treat cache bytes as package-storage evidence or claim that repository cache totals explain account-level package/storage billing.