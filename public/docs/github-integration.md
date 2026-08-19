# GitHub integration gate

`github.integration.reconcile` is the single deterministic integration primitive for same-repository pull requests.

It does not create a second queue, dependency graph, or repository lock. GitHub remains authoritative for pull requests, stacks, checks, branch rules, and merge state.

## Request

```json
{
  "repo": "owner/repo",
  "pull_request": 123,
  "expected_head": "<40-char SHA>",
  "apply": false
}
```

Set `apply: false` to inspect readiness without mutation or any GitHub write-capability token. Set `apply: true` only after reading the exact current PR head.

To poll an asynchronous merge request, send the same repository, PR number, and expected head plus:

```json
{
  "merge_request_uuid": "<GitHub request UUID>"
}
```

## Invariants

- Every mutating request is fenced by the exact PR head SHA.
- The target branch must have the managed portfolio branch policy configured.
- Required checks, reviews, thread resolution, mergeability, and strict current-base policy are read from GitHub before integration.
- Cross-repository pull requests are not automatically integrated.
- Normal integration is squash-only.
- Repository auto-merge remains disabled so this gate is the one mechanical integration path.

## Standalone pull requests

If a standalone PR is behind its base, `apply: true` first attempts GitHub `update-branch` with `expected_head_sha`. That optional convenience requires GitHub App `Pull requests: write`. If the installation does not grant it, the command remains successful with `outcome: needs_update` and returns an isolated-worktree update recipe instead of blocking integration as a whole. After either update path, the worker must read the new head and allow required verification to run before asking for integration again.

A ready standalone PR is submitted through GitHub's asynchronous merge API with:

```text
sha          = exact expected head
merge_method = squash
merge_action = direct_merge
```

## Stacked pull requests

A stack is repository dependency truth. The integration gate does not copy the stack into Hatchable.

A stale stack is never repaired with ordinary `update-branch`, because that would introduce merge ancestry that violates native stack linear-history requirements. The result is `stack_rebase_required`; the stack must be repaired with GitHub's cascading stack rebase (`gh stack rebase`, then `gh stack push`) and reread.

A ready stack is submitted through the same asynchronous merge API. GitHub applies stack branch rules and merges the contiguous ready portion atomically. The gate therefore does not implement its own temporary merge refs or speculative queue database.

## Outcomes

Common successful outcomes:

- `ready`: exact current candidate is ready; no mutation was requested.
- `needs_update`: standalone candidate is behind; no mutation was requested.
- `updated_for_recheck`: GitHub accepted an exact-head standalone branch update; reread and reverify.
- `stack_rebase_required`: repair the native stack before integration.
- `waiting`: checks, reviews, draft status, or mergeability are not ready.
- `merge_submitted`: GitHub accepted an asynchronous merge request.
- `merge_pending`: an asynchronous merge is still pending.
- `merged`: GitHub reports the asynchronous request merged.
- `already_merged`: idempotent terminal observation.

## Failure and recovery

`GITHUB_INTEGRATION_RECOMPUTE_REQUIRED` means repository authority moved. Refresh the PR/base state and recompute from current GitHub authority.

`GITHUB_INTEGRATION_INDETERMINATE` means transport certainty was lost after a potentially mutating request. Do not blindly retry. Re-read GitHub and reconcile the external effect first.

The integration gate serializes only final repository integration. Agents may continue independent implementation in separate branches/worktrees and express genuine unmerged dependencies through native GitHub stacks.