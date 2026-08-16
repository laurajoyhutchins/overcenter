# GitHub apply changeset

`github.apply_changeset` is the conceptual command name. Hatchable MCP tool filenames cannot contain dots, so this project exposes the command as `github_apply_changeset`.

Use it when an agent has a complete declared repository changeset and needs one coherent Git commit instead of one Contents API commit per file.

## Authentication

The deployed command authenticates as the installed **Hatchable Portfolio Control Plane GitHub App**, not as the project owner's user account and not through a broad OAuth `repo` token. For each operation, Hatchable mints a short-lived GitHub App installation token narrowed to the requested repository with `contents: write` (plus GitHub's implicit `metadata: read`), uses it for the bounded Git Data operation, does not persist or return it, and attempts immediate revocation in `finally`.

The GitHub App itself must be installed on the target repository. Repository selection at GitHub installation time is the outer authorization boundary. The current signing implementation is a proof-of-concept adapter pending native Hatchable `auth = "github_app"` support; application code must not grow a second credential model around it.

## Request

Provide exactly one of `base_ref` or `base_sha`.

```json
{
  "repo": "owner/repo",
  "base_ref": "main",
  "branch": "agent/example-change",
  "expected_head": "0123456789abcdef0123456789abcdef01234567",
  "changes": [
    { "path": "README.md", "operation": "update", "content": "complete UTF-8 text" },
    { "path": "docs/new.md", "operation": "create", "content": "complete UTF-8 text" },
    { "path": "obsolete.md", "operation": "delete" }
  ],
  "commit_message": "Update documentation",
  "idempotency_key": "agent-run-123:docs-update"
}
```

Root fields: `repo`, exactly one of `base_ref`/`base_sha`, `branch`, optional `expected_head`, non-empty `changes`, `commit_message`, optional `idempotency_key`. Unknown fields are rejected.

Each change has a repository-relative `path` and `operation` of `create`, `update`, or `delete`. `create` and `update` require complete text `content`; `delete` forbids `content`. Duplicate paths and traversal-like paths are rejected. This version is text-only and updates/deletes regular files (`100644`/`100755`) only.

## Branch and concurrency semantics

For a new target branch, the command resolves the supplied base exactly and builds one commit on that commit. If `expected_head` is supplied, it must equal that resolved base commit.

For an existing target branch, the command builds on the branch's current head. `expected_head` should be supplied for agent writes and must equal that head. The supplied base is still resolved, but it never causes an existing target branch to be rebased or reset.

Immediately before the final ref mutation, the command reads the branch again. Existing branches must still equal the original head; new branches must still be absent. Any race fails closed. Ref updates use `force: false`.

## Atomicity boundary

The command creates Git objects before it mutates the branch ref: blobs, one tree, one commit, then one branch create/update. GitHub may retain unreachable objects if the final ref operation fails. The branch itself never receives a partial subset of the changeset: it either remains unchanged or points to the single complete changeset commit.

## Idempotency

`idempotency_key` is optional but recommended for every mutation. Receipts are keyed by `(repo, idempotency_key)` and include an SHA-256 of the canonical semantic request.

Reusing a key with different input returns `IDEMPOTENCY_CONFLICT`. Reusing a key after success returns the exact stored receipt with `idempotent_replay: true`. The commit SHA is checkpointed before the ref mutation; if a transport failure happens after GitHub moved the ref but before the caller receives a response, a retry recognizes that exact prepared commit and completes the receipt without creating another logical commit.

## Success receipt

```json
{
  "ok": true,
  "repo": "owner/repo",
  "branch": "agent/example-change",
  "base_sha": "...",
  "old_head": null,
  "new_head": "...",
  "commit_sha": "...",
  "tree_sha": "...",
  "created_branch": true,
  "precondition_verified": true,
  "changed_paths": [
    { "path": "README.md", "operation": "update" }
  ],
  "idempotency_key": "agent-run-123:docs-update",
  "idempotent_replay": false
}
```

`base_sha` is the actual parent of the new commit. For an existing target branch this is that branch's pre-mutation head.

## Conflict receipt

```json
{
  "ok": false,
  "error": "HEAD_MISMATCH",
  "message": "expected_head does not match the commit the changeset would build on",
  "expected_head": "...",
  "actual_head": "...",
  "branch": "agent/example-change",
  "phase": "preflight"
}
```

Other explicit failures include `BRANCH_CREATION_RACE`, `CREATE_TARGET_EXISTS`, `UPDATE_TARGET_MISSING`, `DELETE_TARGET_MISSING`, `DUPLICATE_PATH`, `INVALID_PATH`, `GITHUB_PERMISSION_DENIED`, `GITHUB_REF_REJECTED`, `IDEMPOTENCY_CONFLICT`, `GITHUB_APP_SETUP_REQUIRED`, `GITHUB_APP_INSTALLATION_NOT_FOUND`, and `GITHUB_APP_PERMISSION_DENIED`.

## Non-goals

This command does not create pull requests, merge, rebase, force-push, wait for CI, mutate issues, maintain a local repository, mirror repository state, or expose a generic GitHub REST proxy. GitHub remains authoritative; Hatchable stores only exact idempotency receipts needed to make retries safe.