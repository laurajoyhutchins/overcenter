# GitHub Delete Branch

`github.delete_branch` is a narrow, branch-only GitHub mutation primitive.

Surfaces:

- MCP: `github_delete_branch`
- HTTP: `POST /api/github-delete-branch`

Input:

```json
{
  "repo": "owner/repo",
  "branch": "feat/example",
  "expected_head": "0123456789abcdef0123456789abcdef01234567"
}
```

The command requires a full 40-character `expected_head`. It queries the repository and branch, rejects the default branch, and fails closed if the branch is still the head or base of any open pull request. That lifecycle check prevents deleting active work and stacked-PR dependencies without introducing a second stack model. It then uses GitHub GraphQL `updateRefs` with:

- `name = refs/heads/<branch>`
- `beforeOid = expected_head`
- `afterOid = 0000000000000000000000000000000000000000`
- `force = false`

GitHub applies the ref update atomically. A concurrent head move therefore cannot be deleted accidentally: the mutation is rejected when `beforeOid` no longer matches.

Outcomes:

- `deleted`: the exact approved head was deleted.
- `already_absent`: the branch was already absent when authoritatively observed.
- `HEAD_MISMATCH`: the branch exists at a different head.
- `GITHUB_REF_REJECTED`: GitHub policy, rules, or default-branch protection rejected deletion.
- `BRANCH_DELETE_INDETERMINATE`: mutation transport failed after dispatch; retrying the same request is safe because the command is exact-head fenced and absence is idempotent.

The command accepts only branch names. It does not expose arbitrary ref or tag deletion.