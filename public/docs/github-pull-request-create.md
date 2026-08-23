# GitHub pull request creation command

`github.pull_request.create` creates one same-repository pull request through the Busbar GitHub App while preserving exact branch authority and actor continuity.

Surfaces:

- MCP: `github_pull_request_create`
- HTTP: `POST /api/github-pull-request-create`

Required semantic input:

- `repo`: `owner/repo`
- `base`, `head`: same-repository branch names
- `expected_base`, `expected_head`: exact 40-character commit SHAs observed immediately before the request
- `title`
- `draft`: explicit boolean
- optional `body` and `run_id`

The command first rereads both branch refs and refuses stale coordinates. It then searches for an already-open pull request at the exact head/base pair. An existing exact PR is returned as `already_exists` without another mutation.

Creation uses one GitHub App installation token with the command-owned `pull_request_create` profile (`contents: read`, `pull_requests: write`). The command never falls back to user OAuth or a separate connector identity.

A lost or ambiguous create response is never blindly retried. The command rereads open pull requests for the exact head/base coordinate. If GitHub proves the intended PR exists, the result converges to `created` or `already_exists`; otherwise it returns `GITHUB_PULL_REQUEST_CREATE_INDETERMINATE` with `may_have_mutated: true`.

Successful responses include `author_login` plus `actor_continuity` from a same-installation GraphQL read (`viewer_did_author`, `viewer_can_update`). This evidence is the bridge to `github.pull_request.mark_ready`: workflows may rely on automatic draft graduation only after the App identity is proven authorized for that PR.