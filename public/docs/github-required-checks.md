# `github.required_checks.ensure`

Narrow GitHub administration transport for ensuring selected verification checks are required on one branch.

## Request

```json
{
  "repo": "owner/repo",
  "branch": "main",
  "expected_head": "<40-character commit SHA>",
  "required_checks": ["check-a", "check-b"]
}
```

The command is additive. It never removes unrelated required checks or changes unrelated repository settings.

## Authority and verification

GitHub remains authoritative. The command:

1. verifies the exact branch head;
2. resolves each requested check from check runs on that exact head, including its GitHub App integration identity;
3. reads effective branch rules and classic protection;
4. rereads the protection state immediately before mutation and fails closed if it changed;
5. uses the existing mechanism when safe, otherwise creates a branch-targeted repository ruleset;
6. rereads GitHub after mutation;
7. succeeds only when the effective branch configuration contains every requested check.

A successful mutation response from GitHub is not sufficient by itself.

## Permissions

The command-owned GitHub App token profile is fixed to:

- `Administration: write`, required by GitHub to create or update repository rulesets or required-status-check protection;
- `Checks: read`, used to resolve exact check identities.

Callers cannot request broader permissions.

## Expected rejections

Normal non-success states are structured through `command-response-v1`, including stale branch heads, unknown or ambiguous check identities, missing app permission, concurrent protection changes, unsafe mixed protection, and failed post-mutation verification.