# GitHub pull request ready-for-review command

`github.pull_request.mark_ready` is the Overcenter mutation for graduating one exact draft pull request to ready-for-review state.

Surfaces:

- MCP: `github_pull_request_mark_ready`
- HTTP: `POST /api/github-pull-request-mark-ready`

## Request

The semantic request contains only the target repository, pull request number, exact current head SHA, and optional orchestration `run_id` correlation:

```json
{
  "repo": "owner/repo",
  "pull_request": 54,
  "expected_head": "0123456789abcdef0123456789abcdef01234567"
}
```

The command rereads GitHub before mutation and refuses a stale head, a closed pull request, or a target that GitHub says the installation actor cannot update and did not author. An already-ready pull request is an idempotent success without mutation.

## Authentication and authority

The command authenticates only as the installed Overcenter GitHub App. It mints a short-lived installation token narrowed to `contents: write` plus `pull_requests: write`, does not expose or persist the token, and uses no alternate user OAuth or connector identity.

GitHub actor authorization is a separate boundary from installation permission scope. The preflight reads `viewerCanUpdate` and `viewerDidAuthor` through the same installation identity. When both are false, the command returns `GITHUB_PULL_REQUEST_READY_ACTOR_UNAUTHORIZED` before mutation with `may_have_mutated: false`.

This distinction matters for user-authored drafts. A GitHub App can possess the required repository permission scopes while GitHub still refuses the ready-for-review transition for that particular installation actor.

## Mutation safety

The mutation is exact-head fenced and fail-closed. It does not automatically replay the GraphQL mutation after uncertain transport.

If transport certainty is lost after the mutation may have occurred, the command rereads authoritative pull-request state. It reports success only when GitHub proves the same exact head is now open and not draft. Otherwise it returns `GITHUB_PULL_REQUEST_READY_INDETERMINATE` with `may_have_mutated: true` so recovery reconciles state rather than blindly retrying.

Definite GitHub mutation refusal remains distinct from actor preflight refusal and is reported as a permission error.

## Workflow rule

Workers should use this control-plane command instead of a separate GitHub connector for draft graduation. A workflow that creates a draft must not assume the Overcenter GitHub App can later graduate a PR authored by another principal. Future PR-creation flows should preserve a known authorized path out of draft state, or avoid draft state when that path does not exist.